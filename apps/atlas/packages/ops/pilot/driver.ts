import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, unlinkSync } from 'node:fs';
import type { PrismaClient } from '@prisma/client';
import type { Actor } from '../../core/contracts.ts';
import { AtlasError, safeErrorCode } from '../../core/contracts.ts';
import { PrismaSecurityAudit } from '../../audit/prisma.ts';
import { authenticateToken } from '../../auth/prisma-auth.ts';
import { assertRuntimeRole } from '../../graph/scoped-db.ts';
import { cursorKeyFromEnv, envCursorKey } from '../../correlation/cursor.ts';
import { openRuntimeDatabase } from '../../m365/maintenance.ts';
import type { RuntimeDatabase } from '../../m365/maintenance.ts';
import type { M365Io } from '../../m365/io.ts';
import { ClientCredentialsTokenProvider } from '../../../connectors/microsoft365/auth.ts';
import { EnvSecretResolver } from '../../../connectors/secrets.ts';
import { runOperatorCommand } from '../commands.ts';
import type { OperatorContext } from '../commands.ts';
import { admitPilotAuthority, assertCleanProcess, configPathOf, PILOT_GRANTS, readConfigFile, validatePilotConfig } from './config.ts';
import type { PilotCommand, PilotConfig } from './config.ts';
import { installFetchGuard } from './guard.ts';
import { Aliases, projectResult } from './project.ts';
import type { Json } from './project.ts';
import { openFileSink, openNewPrivateFile, writeDurably } from './receipts.ts';
import type { ReceiptSink, RunStatus } from './receipts.ts';
import { createRecorder } from './recorder.ts';
import type { Dispatch, Recorder, RecorderSnapshot } from './recorder.ts';

/**
 * S2-LIVE pilot driver (operational brief RC5; entry scripts/stage2-live-pilot.ts). One allowlisted accepted operator
 * command per process, in this order — every step fails closed and is reported only as a safe code:
 *   clean process → private config (allowlist, accepted flag parser, scope) → runtime env present → new output files →
 *   global fetch guard + recorder → runtime DB (accepted factory) → assertRuntimeRole → authenticate the operator token
 *   (immediately before the operation) → pilot authority admission → runOperatorCommand with the RECORDED transports →
 *   allowlisted projection → run-end receipt.
 * The command context gets the recorded Stage 1 HttpTransport, the recorded GraphTransport and ClientCredentialsTokenProvider
 * over the recorded AuthTransport, the real EnvSecretResolver and the accepted cursor key; its config()/runtime() callbacks
 * always refuse (no Decisions provider is ever built). The summary states factual outcomes only — never a gate verdict.
 */
export const PILOT_ID = 'atlas-stage2-live-pilot';
export interface PilotProcess { argv: readonly string[]; env: Readonly<Record<string, string | undefined>>; execArgv: readonly string[] }
/** Synthetic test mechanisms only; the entry point never passes them (production: captured native fetch + file sink). */
export interface PilotSeams { dispatch?: Dispatch; wrapSink?: (sink: ReceiptSink) => ReceiptSink; now?: () => Date }
export interface PilotSummary {
  pilot: typeof PILOT_ID; version: 1; command: PilotCommand | null; status: RunStatus; safeErrorCode: string | null;
  /** Fixed reminder for reviewers: a recorded operation outcome, not an L1–L4 verdict or acceptance. */
  evidence: 'OPERATION_OUTCOME_ONLY'; grants: readonly string[];
  recording: (Omit<RecorderSnapshot, 'halted'> & { runEndRecorded: boolean }) | null;
  result: Json | null; privateOutputWritten: boolean;
}
export interface PilotOutcome { exitCode: 0 | 1 | 2; summary: PilotSummary }

const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const codeOf = (error: unknown): string => { const c = safeErrorCode(error); return SAFE_CODE.test(c) ? c : 'UNEXPECTED_ERROR'; };

/** The command context of the pilot: recorded transports only; config/runtime refuse and mark the run incomplete. */
export function composePilotContext(db: PrismaClient, runtime: RuntimeDatabase, actor: Actor, recorder: Recorder,
  env: Readonly<Record<string, string | undefined>>): OperatorContext {
  const secrets = new EnvSecretResolver(env);
  let m365Io: M365Io | null = null;
  const refuse = (): never => { recorder.halt('CALLBACK_REFUSED'); throw new AtlasError('PILOT_CALLBACK_REFUSED', 'PERMANENT'); };
  return { db, actor, io: { transport: recorder.stage1, secrets }, workerId: 'pilot-no-worker',
    m365: { io: () => (m365Io ??= { graph: recorder.graph, tokens: new ClientCredentialsTokenProvider(recorder.auth), secrets }), runtime, env, cursorKey: envCursorKey(env) },
    config: refuse, runtime: refuse };
}

/**
 * Pilot authority admission with the safe audited denial of 02 §1 (authorized client, missing permission): only the pilot's
 * own extra refusal (PILOT_AUTHORITY_REFUSED: mapping/confirm-link without m365:read on the same membership) is appended
 * here — once, to the workspace security audit through the freshly authenticated actor on the confined runtime, in the shape
 * of the accepted command boundary (`ops.scope_denied`, requested client ID as text, PERMISSION_DENIED, `{ command }`),
 * never a client audit and no M365/object/tenant identifier. The accepted boundary audits its own refusals itself (no double
 * audit); the fixture-namespace refusal stays unaudited as before. An audit failure is SECURITY_AUDIT_FAILED (fail closed).
 */
async function admitAudited(db: PrismaClient, actor: Actor, config: PilotConfig): Promise<void> {
  try { admitPilotAuthority(actor, config); }
  catch (error) {
    if (!(error instanceof AtlasError) || error.code !== 'PILOT_AUTHORITY_REFUSED') throw error;
    try {
      await new PrismaSecurityAudit(db, actor).append({ workspaceId: actor.workspaceId, actorId: actor.id, eventType: 'ops.scope_denied', outcome: 'DENIED',
        requestedClientId: config.scope.clientId, reasonCode: 'PERMISSION_DENIED', correlationId: randomUUID(), metadata: { command: config.command } });
    } catch { throw new AtlasError('SECURITY_AUDIT_FAILED', 'PERMANENT'); }
    throw error;
  }
}

function refusedBeforeRecording(command: PilotCommand | null, error: unknown): PilotOutcome {
  return { exitCode: 2, summary: { pilot: PILOT_ID, version: 1, command, status: 'REFUSED', safeErrorCode: codeOf(error), evidence: 'OPERATION_OUTCOME_ONLY',
    grants: command ? PILOT_GRANTS[command] : [], recording: null, result: null, privateOutputWritten: false } };
}

/** Admission before any database or upstream I/O; throws a safe AtlasError. */
function admit(input: PilotProcess): PilotConfig {
  assertCleanProcess(input.env, input.execArgv);
  const config = validatePilotConfig(readConfigFile(configPathOf(input.argv)));
  if (!input.env.ATLAS_RUNTIME_DATABASE_URL || !input.env.ATLAS_OPERATOR_TOKEN) throw new AtlasError('PILOT_RUNTIME_ENVIRONMENT_MISSING', 'VALIDATION');
  // The shared cursor key (reference + ≥32 bytes) is checked in memory for the paged reads, never printed.
  if (config.command === 'm365-directory' || config.command === 'correlation') cursorKeyFromEnv(input.env);
  for (const path of [config.output.receipts, config.output.private]) if (path !== null && existsSync(path)) throw new AtlasError('PILOT_OUTPUT_EXISTS', 'PERMANENT');
  return config;
}

export async function runPilot(input: PilotProcess, seams: PilotSeams = {}): Promise<PilotOutcome> {
  let config: PilotConfig;
  try { config = admit(input); } catch (error) { return refusedBeforeRecording(null, error); }
  const now = seams.now ?? (() => new Date());
  let privateFd: number | null = null; let sink: ReceiptSink;
  try {
    privateFd = config.output.private === null ? null : openNewPrivateFile(config.output.private);
    const file = openFileSink(config.output.receipts);
    sink = seams.wrapSink ? seams.wrapSink(file) : file;
    sink.append({ v: 1, kind: 'run-start', at: now().toISOString(), command: config.command });
  } catch (error) {
    // Nothing was recorded or dispatched: remove the private file this run just created, so a retry does not collide.
    if (privateFd !== null) { closeSync(privateFd); try { unlinkSync(config.output.private!); } catch { /* best effort */ } }
    return refusedBeforeRecording(config.command, error);
  }

  let recorder: Recorder | null = null;
  const guard = installFetchGuard(() => recorder?.halt('UNRECORDED_FETCH'));
  recorder = createRecorder({ sink, dispatch: seams.dispatch ?? guard.dispatch, now });
  let status: RunStatus = 'REFUSED'; let errorCode: string | null = null; let result: Json | null = null;
  let output: Record<string, unknown> | null = null; let runtime: RuntimeDatabase | null = null;
  const aliases = new Aliases();
  try {
    runtime = openRuntimeDatabase(input.env.ATLAS_RUNTIME_DATABASE_URL!);
    await assertRuntimeRole(runtime.db);
    const actor = await authenticateToken(runtime.db, input.env.ATLAS_OPERATOR_TOKEN!);
    if (!actor) throw new AtlasError('OPERATOR_TOKEN_INVALID', 'SCOPE');
    await admitAudited(runtime.db, actor, config);
    status = 'COMMAND_ERROR';
    const commandResult = await runOperatorCommand(composePilotContext(runtime.db, runtime, actor, recorder, input.env), config.invocation);
    status = commandResult.ok ? 'COMMAND_OK' : 'COMMAND_NOT_OK';
    output = commandResult.output;
    result = projectResult(config.command, output, aliases, config.invocation.flags);
  } catch (error) {
    errorCode = codeOf(error);
    result = null;
  } finally {
    await runtime?.db.$disconnect().catch(() => undefined);
    guard.restore();
  }

  const snapshot = recorder.snapshot();
  let runEndRecorded = false;
  try {
    sink.append({ v: 1, kind: 'run-end', at: now().toISOString(), status, complete: snapshot.complete, dispatches: snapshot.dispatches,
      completions: snapshot.completions, refusals: Object.values(snapshot.refusals).reduce((n, x) => n + x, 0) });
    runEndRecorded = true;
  } catch { /* reported as incomplete below */ }
  try { sink.close(); } catch { runEndRecorded = false; }
  const privateOutputWritten = writePrivate(privateFd, aliases, output);
  const complete = snapshot.complete && runEndRecorded;
  const { halted: _halted, ...recording } = snapshot;
  const exitCode: 0 | 1 | 2 = !complete ? 1 : status === 'REFUSED' || status === 'COMMAND_ERROR' ? 2 : status === 'COMMAND_OK' && result !== null ? 0 : 1;
  return { exitCode, summary: { pilot: PILOT_ID, version: 1, command: config.command, status, safeErrorCode: errorCode, evidence: 'OPERATION_OUTCOME_ONLY',
    grants: PILOT_GRANTS[config.command], recording: { ...recording, complete, runEndRecorded }, result, privateOutputWritten } };
}

/** Optional PRIVATE operator file (0600, never public): alias → local ID and the next page cursor, for a later resume. */
function writePrivate(fd: number | null, aliases: Aliases, output: Record<string, unknown> | null): boolean {
  if (fd === null) return false;
  try {
    const nextCursor = typeof output?.nextCursor === 'string' ? output.nextCursor : null;
    writeDurably(fd, `${JSON.stringify({ v: 1, aliases: Object.fromEntries(aliases.privateEntries()), nextCursor })}\n`);
    return true;
  } catch { return false; } finally { closeSync(fd); }
}
