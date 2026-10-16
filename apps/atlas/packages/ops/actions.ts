import { PrismaClient } from '@prisma/client';
import { AtlasError } from '../core/contracts.ts';
import { assertRuntimeRole } from '../graph/scoped-db.ts';
import { actionComposition } from '../actions/policy.ts';
import type { ActionComposition } from '../actions/policy.ts';
import { actionCredential, actionFailure } from '../actions/authority.ts';
import type { ActionCredential } from '../actions/authority.ts';
import { exportStoredPreview, getAction, listActions, previewAction, requestAction } from '../actions/requests.ts';
import { approveAction, cancelAction, rejectAction, revokeApproval } from '../actions/approvals.ts';
import { executeAction } from '../actions/execution.ts';
import { verifyAction } from '../actions/verification.ts';
import { recoverAction } from '../actions/recovery.ts';
import { mockActionPorts } from '../actions/mock-port.ts';
import type { ActionPorts } from '../actions/mock-port.ts';

/**
 * Stage 3 action commands of the operator CLI (docs/stage3/02_CONTRACTS.md "Authority and command exposure"; RUNBOOK §9).
 * Routed by scripts/ops.ts before the Stage 1/2 parser, which stays unchanged. Each command authenticates the bearer
 * (ATLAS_OPERATOR_TOKEN) only as an opaque action credential — never an Actor DTO — and calls exactly one action service,
 * which re-reads the current credential/actor/membership inside its own fenced admission (one workspace denial audit,
 * never a CLI-level duplicate). Composition: DISABLED unless ATLAS_ACTIONS_MODE=MOCK; any transport/origin/port/script/
 * callback/LIVE variable refuses (policy.ts); the port is always the built-in synthetic store. No HTTP endpoint is added.
 *
 * Flags are strict: a known command, its own flags once each, bounded printable values. Private content and candidate
 * ticket IDs enter only through protected files (--input, --preview-file, --reconciliation-file); file paths are never
 * printed. Output: one JSON object of local IDs, states, times, hashes/versions, counts and fixed codes, synthetic:true.
 * Exit: 0 done (execute/verify: VERIFIED), 1 ran but the outcome is not VERIFIED, 2 usage/authentication/refusal.
 */
interface Context { db: PrismaClient; composition: ActionComposition; credential: ActionCredential; ports: ActionPorts; clientId: string }
type Flags = Readonly<Record<string, string>>;
interface ActionSpec { required: readonly string[]; optional?: readonly string[]; run(ctx: Context, f: Flags): Promise<{ ok: boolean; output: object }> }
const done = async (value: Promise<object>) => ({ ok: true, output: await value });
const verified = async (value: Promise<{ state: string }>) => { const output = await value; return { ok: output.state === 'VERIFIED', output }; };

const SPECS: Readonly<Record<string, ActionSpec>> = {
  'action-preview': { required: ['input', 'preview-file'],
    run: (c, f) => done(previewAction(c.db, c.composition, c.credential, c.clientId, f.input!, f['preview-file']!)) },
  'action-request': { required: ['input', 'hash'], run: (c, f) => done(requestAction(c.db, c.composition, c.credential, c.clientId, f.input!, f.hash!)) },
  'action-get': { required: ['request'], optional: ['preview-file'],
    run: (c, f) => done(f['preview-file'] === undefined ? getAction(c.db, c.composition, c.credential, c.clientId, f.request!)
      : exportStoredPreview(c.db, c.composition, c.credential, c.clientId, f.request!, f['preview-file'])) },
  'action-list': { required: [], optional: ['limit', 'cursor'],
    run: (c, f) => {
      if (f.limit !== undefined && !/^[1-9][0-9]{0,2}$/.test(f.limit)) throw new AtlasError('ACTION_INPUT_INVALID', 'VALIDATION');
      return done(listActions(c.db, c.composition, c.credential, c.clientId, { ...(f.limit ? { limit: Number(f.limit) } : {}), ...(f.cursor ? { cursor: f.cursor } : {}) }));
    } },
  'action-approve': { required: ['request', 'hash', 'preview-file'],
    run: (c, f) => done(approveAction(c.db, c.composition, c.credential, c.clientId, f.request!, f.hash!, f['preview-file']!)) },
  'action-reject': { required: ['request', 'hash'], run: (c, f) => done(rejectAction(c.db, c.composition, c.credential, c.clientId, f.request!, f.hash!)) },
  'action-revoke': { required: ['request', 'hash'], run: (c, f) => done(revokeApproval(c.db, c.composition, c.credential, c.clientId, f.request!, f.hash!)) },
  'action-cancel': { required: ['request'], run: (c, f) => done(cancelAction(c.db, c.composition, c.credential, c.clientId, f.request!)) },
  'action-execute': { required: ['request', 'hash'],
    run: (c, f) => verified(executeAction(c.db, c.composition, c.ports, c.credential, c.clientId, f.request!, f.hash!)) },
  'action-verify': { required: ['request'], optional: ['reconciliation-file'],
    run: (c, f) => verified(verifyAction(c.db, c.composition, c.ports, c.credential, c.clientId, f.request!, f['reconciliation-file'])) },
  'action-recover': { required: ['request'], run: (c, f) => done(recoverAction(c.db, c.composition, c.credential, c.clientId, f.request!)) },
};
export const ACTION_COMMANDS: readonly string[] = Object.keys(SPECS);
export const isActionCommand = (command: string | undefined): boolean => command !== undefined && Object.hasOwn(SPECS, command);

const VALUE = /^[\x20-\x7e]{1,1024}$/;
/** `<action-command> --client C --name value …`: known flags only, each once, every value present, bounded and printable. */
export function parseActionInvocation(argv: readonly string[]): { command: string; flags: Flags } {
  const [command, ...rest] = argv;
  const spec = command !== undefined && Object.hasOwn(SPECS, command) ? SPECS[command]! : null;
  if (!spec || rest.length % 2 !== 0) throw new AtlasError('INVALID_ARGUMENTS', 'VALIDATION');
  const allowed = ['client', ...spec.required, ...(spec.optional ?? [])];
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const name = /^--([a-z][a-z-]{0,24})$/.exec(rest[i]!)?.[1]; const value = rest[i + 1]!;
    if (!name || !allowed.includes(name) || Object.hasOwn(flags, name) || !VALUE.test(value) || value.startsWith('--')) throw new AtlasError('INVALID_ARGUMENTS', 'VALIDATION');
    flags[name] = value;
  }
  if (['client', ...spec.required].some(name => !Object.hasOwn(flags, name))) throw new AtlasError('INVALID_ARGUMENTS', 'VALIDATION');
  return { command: command!, flags };
}

/** Fixed public failure: action codes (plus the runtime self-check code); a busy claim adds only its boolean recovery hint. */
function failure(command: string, error: unknown): { code: number; output: Record<string, unknown> } {
  const fixed = error instanceof AtlasError && error.code === 'RUNTIME_ROLE_NOT_CONFINED' ? error : actionFailure(error);
  const hint = fixed.code === 'ACTION_VERIFICATION_BUSY' && error instanceof AtlasError ? { recoveryRequired: error.details.recoveryRequired === 'true' } : {};
  return { code: 2, output: { command, safeErrorCode: fixed.code, ...hint, synthetic: true } };
}

/** One action command in this process: composition, credential, confined runtime check, one service call. */
export async function runActionCli(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): Promise<{ code: number; output: Record<string, unknown> }> {
  let invocation: { command: string; flags: Flags };
  try { invocation = parseActionInvocation(argv); } catch {
    return { code: 2, output: { command: argv[0], error: 'INVALID_ARGUMENTS', commands: ACTION_COMMANDS, synthetic: true } };
  }
  const { command, flags } = invocation;
  let composition: ActionComposition; let credential: ActionCredential;
  try { composition = actionComposition(env); credential = actionCredential(env.ATLAS_OPERATOR_TOKEN ?? ''); } catch (error) { return failure(command, error); }
  if (!env.ATLAS_RUNTIME_DATABASE_URL) return { code: 2, output: { command, error: 'ATLAS_RUNTIME_DATABASE_URL is required', synthetic: true } };
  const db = new PrismaClient({ datasourceUrl: env.ATLAS_RUNTIME_DATABASE_URL });
  try {
    await assertRuntimeRole(db);
    const result = await SPECS[command]!.run({ db, composition, credential, ports: mockActionPorts(db), clientId: flags.client! }, flags);
    return { code: result.ok ? 0 : 1, output: { command, ...result.output, synthetic: true } }; // every envelope carries the marker
  } catch (error) {
    return failure(command, error);
  } finally { await db.$disconnect().catch(() => undefined); }
}
