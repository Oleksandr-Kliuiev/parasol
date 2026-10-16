import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Actor, NormalizedEvent, ObservationStatus, Scope, System } from '../core/contracts.ts';
import { AtlasError, assertPermission, safeErrorCode } from '../core/contracts.ts';
import { SCOPE_ID_PATTERN } from '../graph/scope-context.ts';
import { PrismaSecurityAudit } from '../audit/prisma.ts';
import { bindConnection } from '../connections/connections.ts';
import { confirmLink, listMappingReview, rejectLink } from '../graph/mapping.ts';
import { triageObservation } from '../observations/lifecycle.ts';
import type { TriageAction } from '../observations/lifecycle.ts';
import type { DecisionConfig } from '../decisions/provider.ts';
import { OpenAIDecisionProvider } from '../decisions/openai.ts';
import type { DecisionRuntime } from '../decisions/runtime.ts';
import { decisionTelemetry } from '../decisions/telemetry.ts';
import { callProvider } from '../events/decision.ts';
import { listInbox, requeueDeadLetter } from '../events/inbox.ts';
import type { SyncIo } from '../sync/snapshots.ts';
import { liveReadCheck } from './live-read.ts';
import type { LiveReadSummary } from './live-read.ts';
import { runShadowPass, runWorkerPass } from './worker-pass.ts';
import { m365Commands } from './m365.ts';
import type { M365OperatorDeps } from './m365.ts';
import { CURSOR_MAX_LENGTH } from '../correlation/parameters.ts';
import { onboardClient } from '../graph/onboarding.ts';

/**
 * Operator commands (task 1.10, docs/RUNBOOK.md): thin calls of the services as the authenticated actor, so permission,
 * validation and the client audit stay the services' own. The command boundary adds what the API boundary adds: a client
 * ID outside the identifier policy, a client out of scope or a missing permission is refused before any service call and
 * recorded in the workspace security audit (`ops.scope_denied`), never in a client's audit. A refusal throws; `ok: false`
 * means the command ran and reports a failure (a live check that did not pass).
 */
export interface OperatorContext {
  db: PrismaClient; actor: Actor; io: SyncIo; workerId: string;
  /** Stage 2 M365 composition (scripts/ops.ts); absent → the M365 sync/read/maintenance commands refuse with M365_NOT_CONFIGURED. */
  m365?: M365OperatorDeps;
  /** Decision settings (config/decisions.json with its overrides). */
  config(): DecisionConfig;
  /** Built on first use: only worker-once and shadow-once need the provider (and, in shadow or advisory mode, its key). */
  runtime(): DecisionRuntime;
}
export type Flags = Readonly<Record<string, string>>;
export interface Invocation { command: string; flags: Flags }
export interface CommandResult { ok: boolean; output: Record<string, unknown> }
interface Spec {
  required: readonly string[]; optional?: readonly string[];
  /** Flags allowed up to 512 ASCII characters (the shared cursor bound) instead of the generic 256 UTF-16 units. */
  long?: readonly string[];
  /** Mode/format rules of the flags, checked at parse time before any permission check, service call or I/O. */
  validate?(flags: Flags): void;
}
/** About one client: `--client` is required and the permissions are checked at the boundary before `run`. */
export interface ClientCommand extends Spec { permissions: readonly string[]; run(ctx: OperatorContext, scope: Scope, flags: Flags): Promise<CommandResult> }

const done = (output: object): CommandResult => ({ ok: true, output: { ...output } });
const invalidArguments = () => new AtlasError('INVALID_ARGUMENTS', 'VALIDATION');
/** Passed: active, healthy, identities read, every resource read (or explicitly unavailable upstream, as Atera alerts are). */
export const liveReadPassed = (s: LiveReadSummary): boolean => s.activation.status === 'ACTIVE' && s.health?.status === 'OK'
  && s.identities?.status === 'OK' && s.resources.every(r => r.status === 'OK' || r.status === 'UNAVAILABLE');
const TELEMETRY_MAX_MINUTES = 7 * 24 * 60;

const clientCommands: Readonly<Record<string, ClientCommand>> = {
  bind: { required: ['connection', 'system', 'tenant', 'secret-ref'], permissions: ['connections:manage'],
    run: async (ctx, scope, f) => done(await bindConnection(ctx.db, ctx.actor, scope,
      { connectionId: f.connection!, system: f.system as System, externalTenantId: f.tenant!, secretRef: f['secret-ref']! })) },
  'live-read': { required: ['connection'], permissions: ['connections:manage', 'events:ingest'],
    run: async (ctx, scope, f) => {
      const summary = await liveReadCheck(ctx.db, ctx.actor, scope, f.connection!, ctx.io);
      return { ok: liveReadPassed(summary), output: { ...summary } };
    } },
  mapping: { required: [], permissions: ['mapping:review'], run: async (ctx, scope) => done({ items: await listMappingReview(ctx.db, ctx.actor, scope) }) },
  'confirm-link': { required: ['link'], permissions: ['mapping:review'], run: async (ctx, scope, f) => done(await confirmLink(ctx.db, ctx.actor, scope, f.link!)) },
  'reject-link': { required: ['link'], optional: ['reason'], permissions: ['mapping:review'],
    run: async (ctx, scope, f) => done(await rejectLink(ctx.db, ctx.actor, scope, f.link!, f.reason ?? 'MANUAL_REJECT')) },
  // Client onboarding of canonical people/devices from source objects (packages/graph/onboarding.ts): --mode plan (default) or apply.
  onboard: { required: [], optional: ['mode'], permissions: ['mapping:review', 'context:read', 'm365:read'],
    run: async (ctx, scope, f) => {
      if (f.mode !== undefined && f.mode !== 'plan' && f.mode !== 'apply') throw invalidArguments();
      return done(await onboardClient(ctx.db, ctx.actor, scope, { apply: f.mode === 'apply' }));
    } },
  inbox: { required: [], permissions: ['context:read'], run: async (ctx, scope) => done({ items: await listInbox(ctx.db, ctx.actor, scope) }) },
  requeue: { required: ['event'], permissions: ['events:ingest'],
    run: async (ctx, scope, f) => { await requeueDeadLetter(ctx.db, ctx.actor, scope, f.event!); return done({ eventKey: f.event, inboxStatus: 'RECEIVED' }); } },
  triage: { required: ['observation', 'action'], optional: ['expected'], permissions: ['observations:triage'],
    run: async (ctx, scope, f) => done(await triageObservation(ctx.db, ctx.actor, scope, f.observation!, f.action as TriageAction,
      { expectedStatus: f.expected as ObservationStatus | undefined })) },
  telemetry: { required: [], optional: ['minutes'], permissions: ['context:read'],
    run: async (ctx, scope, f) => {
      const minutes = f.minutes === undefined ? 60 : /^[1-9]\d{0,4}$/.test(f.minutes) ? Number(f.minutes) : NaN;
      if (!(minutes <= TELEMETRY_MAX_MINUTES)) throw invalidArguments();
      return done(await decisionTelemetry(ctx.db, ctx.actor, scope, { since: new Date(Date.now() - minutes * 60_000), deadlineMs: ctx.config().deadlineMs }));
    } },
  ...m365Commands,
};
/**
 * Passes over every client the actor may ingest for: the baseline (`worker-once`) and the shadow experiment
 * (`shadow-once`) are separate commands, so neither waits for the other (review C2). The guard lives in this process only:
 * its circuit breaker and call budget act within one pass.
 */
const passes: Readonly<Record<string, (ctx: OperatorContext, runtime: DecisionRuntime) => Promise<unknown[]>>> = {
  'worker-once': (ctx, runtime) => runWorkerPass(ctx.db, ctx.actor, runtime, ctx.workerId),
  'shadow-once': (ctx, runtime) => runShadowPass(ctx.db, ctx.actor, runtime, ctx.workerId),
};
async function runPass(ctx: OperatorContext, command: string): Promise<CommandResult> {
  const runtime = ctx.runtime();
  const clients = await passes[command]!(ctx, runtime);
  return done({ workerId: ctx.workerId, configVersion: runtime.config.configVersion, mode: runtime.config.mode, guard: runtime.guard.snapshot(), clients });
}
/** `decisions-smoke` needs neither the database nor an actor: the process entry (scripts/ops.ts) runs it. */
export const OPERATOR_COMMANDS: readonly string[] = [...Object.keys(clientCommands), ...Object.keys(passes), 'decisions-smoke'];

function specOf(command: string | undefined): Spec | null {
  if (command === 'decisions-smoke' || (command !== undefined && Object.hasOwn(passes, command))) return { required: [] };
  if (command === undefined || !Object.hasOwn(clientCommands, command)) return null;
  const spec = clientCommands[command]!;
  return { required: ['client', ...spec.required], optional: spec.optional, long: spec.long, validate: spec.validate };
}
/** `<command> --name value …`: a known command, its flags only, each once, every value present. */
export function parseInvocation(argv: readonly string[]): Invocation {
  const [command, ...rest] = argv;
  const spec = specOf(command);
  if (!spec || rest.length % 2 !== 0) throw invalidArguments();
  const allowed = [...spec.required, ...(spec.optional ?? [])];
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const name = /^--([a-z][a-z-]{0,20})$/.exec(rest[i]!)?.[1]; const value = rest[i + 1]!;
    const long = !!name && (spec.long ?? []).includes(name);
    if (!name || !allowed.includes(name) || Object.hasOwn(flags, name) || value.length === 0 || value.length > (long ? CURSOR_MAX_LENGTH : 256)
      || (long && !/^[\x21-\x7e]+$/.test(value)) || value.startsWith('--')) throw invalidArguments();
    flags[name] = value;
  }
  if (spec.required.some(name => !Object.hasOwn(flags, name))) throw invalidArguments();
  try { spec.validate?.(flags); } catch { throw invalidArguments(); }
  return { command: command!, flags };
}

async function requireClient(ctx: OperatorContext, command: string, clientId: string, permissions: readonly string[]): Promise<Scope> {
  const scope = { workspaceId: ctx.actor.workspaceId, clientId };
  let reason = SCOPE_ID_PATTERN.test(clientId) ? null : 'INVALID_SCOPE_ID';
  try { if (!reason) for (const permission of permissions) assertPermission(ctx.actor, scope, permission); }
  catch (error) { reason = safeErrorCode(error); }
  if (!reason) return scope;
  await new PrismaSecurityAudit(ctx.db, ctx.actor).append({ workspaceId: ctx.actor.workspaceId, actorId: ctx.actor.id, eventType: 'ops.scope_denied',
    outcome: 'DENIED', requestedClientId: clientId, reasonCode: reason, correlationId: randomUUID(), metadata: { command } });
  throw new AtlasError(reason, 'SCOPE');
}

/** One parsed invocation as the authenticated actor; `decisions-smoke` is not run here. */
export async function runOperatorCommand(ctx: OperatorContext, invocation: Invocation): Promise<CommandResult> {
  if (Object.hasOwn(passes, invocation.command)) return runPass(ctx, invocation.command);
  const command = Object.hasOwn(clientCommands, invocation.command) ? clientCommands[invocation.command]! : null;
  const clientId = invocation.flags.client;
  if (!command || clientId === undefined) throw invalidArguments();
  return command.run(ctx, await requireClient(ctx, invocation.command, clientId, command.permissions), invocation.flags);
}

/**
 * Decisions live smoke test (docs/06 "Live-read onboarding gate"): one call with a compact synthetic input — no client data,
 * no database — under the reviewed configuration. A provider failure is a result with its safe code (`ok: false`); a
 * missing key throws OPENAI_KEY_REQUIRED before any request.
 */
export async function decisionsSmoke(config: DecisionConfig, apiKey: string, fetcher: typeof fetch = fetch): Promise<CommandResult> {
  const provider = new OpenAIDecisionProvider(apiKey, config, fetcher, 'advisory');
  const now = new Date().toISOString();
  const synthetic: NormalizedEvent = { workspaceId: 'synthetic', clientId: 'synthetic', source: 'atera', connectionId: 'synthetic', resourceType: 'alert',
    externalEventId: 'synthetic-1', revision: '1', externalDevice: null, occurredAt: now, receivedAt: now, kind: 'DISK_CAPACITY', sourceSeverity: 'MEDIUM',
    summary: 'Synthetic disk capacity check', facts: { diskPercent: 93 } };
  const call = await callProvider(provider, synthetic);
  return { ok: call.result !== null, output: { configVersion: config.configVersion, route: call.result?.route ?? null, confidence: call.result?.confidence ?? null,
    requestedModel: call.result?.requestedModel ?? call.details.requestedModel ?? config.model, responseModel: call.result?.responseModel ?? call.details.responseModel ?? null,
    inputTokens: call.result?.inputTokens ?? null, latencyMs: call.latencyMs, safeErrorCode: call.error } };
}
