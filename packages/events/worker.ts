import { randomUUID } from 'node:crypto';
import type { PrismaClient, Prisma } from '@prisma/client';
import type { Actor, NormalizedEvent, Provider, Route, Scope } from '../core/contracts.ts';
import { AtlasError, assertPermission, domainOf, priorityOf, safeErrorCode, severityRank } from '../core/contracts.ts';
import type { DecisionConfig, DecisionProvider } from '../decisions/provider.ts';
import { defaultDecisionConfig } from '../decisions/provider.ts';
import { clientAuditData } from '../audit/prisma.ts';
import { withScope } from '../graph/scoped-db.ts';
import { callProvider, draftDecision, finalRoute } from './decision.ts';
import type { RunDraft } from './decision.ts';
import { payloadHash } from './identity.ts';
import { assertStorableEvent } from './inbox.ts';

/**
 * Durable worker (task 1.6), docs/03 "Event inbox и worker" with the reference pipeline's contract:
 *   claim (lease, FOR UPDATE SKIP LOCKED) → phase 1 once per event: resolve the device, decide (provider called outside any
 *   transaction), store the runs NOT applied together with the prepared decision → phase 2 in ONE transaction: applied flag,
 *   observation, audit row, inbox completion. A retry reuses the stored decision and never calls the provider again; a
 *   crashed worker's lease expires and the event is claimed again. TRANSIENT failures retry with backoff up to maxAttempts,
 *   PERMANENT or unknown ones are dead-lettered with an audit row. Nothing is ever dropped.
 */
export interface WorkerOptions {
  workerId: string; provider: DecisionProvider; config?: DecisionConfig;
  leaseMs?: number; maxAttempts?: number; batchSize?: number; retryDelayMs?: (attempt: number) => number;
  /** Test seam: runs inside the final transaction just before it commits. Production leaves it unset. */
  beforeFinalCommit?: (eventKey: string) => Promise<void>;
}
interface PreparedDecision { entityId: string | null; route: Route; confidence: number; provider: Provider; promptVersion: string; reasonCodes: string[]; appliedRunId: string; shadowPending: boolean }
export interface ClaimedEvent { id: string; eventKey: string; conflictOfEventKey: string | null; normalized: unknown; attempts: number; prepared: PreparedDecision | null }
export interface ProcessOutcome { eventKey: string; status: 'PROCESSED' | 'RETRY' | 'DEAD_LETTER' | 'ALREADY_FINISHED'; safeErrorCode: string | null; observationId: string | null }

const defaults = { leaseMs: 60_000, maxAttempts: 3, batchSize: 10, retryDelayMs: (attempt: number) => Math.min(15 * 60_000, 30_000 * 2 ** (attempt - 1)) };
const ids = (scope: Scope) => ({ workspaceId: scope.workspaceId, clientId: scope.clientId });
/** Database availability, pool exhaustion and serialization conflicts are TRANSIENT; any other unknown error is PERMANENT. */
const TRANSIENT_DB = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2034']);
function classify(error: unknown): AtlasError {
  if (error instanceof AtlasError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && TRANSIENT_DB.has(code) ? new AtlasError('DATABASE_UNAVAILABLE', 'TRANSIENT') : new AtlasError('UNEXPECTED_ERROR', 'PERMANENT');
}

/** Claims due events of one client for this worker; attempts are counted on claim, so a crash still uses up an attempt. */
export async function claimEvents(db: PrismaClient, actor: Actor, scope: Scope, workerId: string, now: Date, leaseMs = defaults.leaseMs,
  limit = defaults.batchSize): Promise<ClaimedEvent[]> {
  assertPermission(actor, scope, 'events:ingest');
  const until = new Date(now.getTime() + leaseMs);
  const rows = await withScope(db, actor, [scope.clientId], tx => tx.$queryRaw<{ id: string; eventKey: string; conflictOfEventKey: string | null; normalized: unknown;
    attempts: number; preparedDecision: unknown }[]>`
    UPDATE "RawEvent" SET "leaseOwner" = ${workerId}, "leaseExpiresAt" = ${until}, attempts = attempts + 1
    WHERE ("workspaceId", "clientId", id) IN (
      SELECT "workspaceId", "clientId", id FROM "RawEvent"
      WHERE "workspaceId" = ${scope.workspaceId} AND "clientId" = ${scope.clientId} AND status IN ('RECEIVED', 'RETRY')
        AND "nextAttemptAt" <= ${now} AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < ${now})
      ORDER BY "nextAttemptAt", "receivedAt", id LIMIT ${limit} FOR UPDATE SKIP LOCKED)
    RETURNING id, "eventKey", "conflictOfEventKey", normalized, attempts, "preparedDecision"`);
  return rows.map(r => ({ id: r.id, eventKey: r.eventKey, conflictOfEventKey: r.conflictOfEventKey, normalized: r.normalized, attempts: Number(r.attempts),
    prepared: (r.preparedDecision ?? null) as PreparedDecision | null }));
}

/** Device of the event through CONFIRMED links; a QUARANTINED link of that agent is an unresolved conflict (CONFLICT evidence). */
async function resolveDevice(tx: Prisma.TransactionClient, scope: Scope, event: NormalizedEvent): Promise<{ entityId: string | null; conflictCode: string | null }> {
  const ref = event.externalDevice;
  if (!ref || ref.resourceType !== 'agent') return { entityId: null, conflictCode: null };
  const external = await tx.externalEntity.findUnique({ where: { workspaceId_clientId_connectionId_resourceType_externalId:
    { ...ids(scope), connectionId: event.connectionId, resourceType: 'agent', externalId: ref.externalId } }, select: { id: true } });
  if (!external) return { entityId: null, conflictCode: null };
  const links = await tx.entityLink.findMany({ where: { ...ids(scope), externalEntityId: external.id, entityKind: 'DEVICE', status: { in: ['CONFIRMED', 'QUARANTINED'] } },
    select: { status: true, entityId: true } });
  if (links.some(l => l.status === 'QUARANTINED')) return { entityId: null, conflictCode: 'AMBIGUOUS_DEVICE_LINK' };
  return { entityId: links.find(l => l.status === 'CONFIRMED')?.entityId ?? null, conflictCode: null };
}

function runData(scope: Scope, claimed: ClaimedEvent, event: NormalizedEvent, run: RunDraft, config: DecisionConfig, id: string) {
  return { ...ids(scope), id, eventId: claimed.id, provider: run.provider, mode: run.mode, applied: false,
    requestedModel: run.result?.requestedModel ?? run.details.requestedModel ?? null, responseModel: run.result?.responseModel ?? run.details.responseModel ?? null,
    promptVersion: run.result?.promptVersion ?? config.promptVersion, inputHash: payloadHash(event), status: run.result ? 'OK' : 'FAILED',
    result: run.result ? { route: run.result.route, confidence: run.result.confidence, reasonCodes: run.result.reasonCodes } : undefined,
    latencyMs: run.latencyMs, safeErrorCode: run.error };
}

/** Phase 1, once per event. The stored decision is returned as is on every later attempt; the provider is not called. */
export async function prepareEvent(db: PrismaClient, actor: Actor, scope: Scope, claimed: ClaimedEvent, options: WorkerOptions): Promise<PreparedDecision> {
  if (claimed.prepared) return claimed.prepared;
  const config = options.config ?? defaultDecisionConfig;
  assertStorableEvent(claimed.normalized);
  const event = claimed.normalized;
  const resolution = await withScope(db, actor, [scope.clientId], tx => resolveDevice(tx, scope, event));
  const draft = await draftDecision(options.provider, config, event);
  const { route, reasonCodes } = finalRoute({ classification: draft.classification, entityId: resolution.entityId, linkConflictCode: resolution.conflictCode,
    conflictOfEventKey: claimed.conflictOfEventKey, sourceSeverity: event.sourceSeverity, confidenceThreshold: config.confidenceThreshold });
  return withScope(db, actor, [scope.clientId], async tx => {
    const [row] = await tx.$queryRaw<{ preparedDecision: unknown }[]>`SELECT "preparedDecision" FROM "RawEvent"
      WHERE "workspaceId" = ${scope.workspaceId} AND "clientId" = ${scope.clientId} AND id = ${claimed.id} FOR UPDATE`;
    if (row?.preparedDecision) return row.preparedDecision as PreparedDecision; // a concurrent worker decided first
    const runIds = draft.runs.map(() => randomUUID());
    for (const [i, run] of draft.runs.entries()) await tx.decisionRun.create({ data: runData(scope, claimed, event, run, config, runIds[i]!), select: { id: true } });
    const prepared: PreparedDecision = { entityId: resolution.entityId, route, confidence: draft.classification.confidence, provider: draft.classification.provider,
      promptVersion: draft.classification.promptVersion, reasonCodes, appliedRunId: runIds[draft.appliedRun]!, shadowPending: draft.shadowPending };
    await tx.rawEvent.update({ where: { workspaceId_clientId_id: { ...ids(scope), id: claimed.id } }, data: { preparedDecision: prepared as unknown as Prisma.InputJsonValue }, select: { id: true } });
    return prepared;
  });
}

/** Phase 2: applied flag, observation, audit row and inbox completion in ONE transaction, serialized per event. */
async function commitEvent(db: PrismaClient, actor: Actor, scope: Scope, claimed: ClaimedEvent, prepared: PreparedDecision, options: WorkerOptions): Promise<string | null> {
  assertStorableEvent(claimed.normalized);
  const event = claimed.normalized;
  return withScope(db, actor, [scope.clientId], async tx => {
    const [row] = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM "RawEvent"
      WHERE "workspaceId" = ${scope.workspaceId} AND "clientId" = ${scope.clientId} AND id = ${claimed.id} FOR UPDATE`;
    if (!row || row.status === 'PROCESSED' || row.status === 'DEAD_LETTER') return null;
    if (options.beforeFinalCommit) await options.beforeFinalCommit(claimed.eventKey);
    const applied = await tx.decisionRun.updateMany({ where: { ...ids(scope), id: prepared.appliedRunId, eventId: claimed.id }, data: { applied: true } });
    if (applied.count !== 1) throw new AtlasError('APPLIED_RUN_MISSING', 'PERMANENT');
    const observationId = randomUUID();
    const priority = priorityOf(event.sourceSeverity);
    await tx.observation.create({ data: { ...ids(scope), id: observationId, eventId: claimed.id, entityId: prepared.entityId, decisionRunId: prepared.appliedRunId,
      domain: domainOf(event.kind), severity: event.sourceSeverity, severityRank: severityRank[event.sourceSeverity], priority, route: prepared.route,
      confidence: prepared.confidence, provider: prepared.provider, promptVersion: prepared.promptVersion, reasonCodes: prepared.reasonCodes, status: 'OPEN' }, select: { id: true } });
    await tx.auditEvent.create({ data: clientAuditData(scope, actor.id, 'observation.created', randomUUID(), { observationId, eventKey: claimed.eventKey,
      route: prepared.route, priority, provider: prepared.provider, reasonCodes: prepared.reasonCodes.join(','), decisionRunId: prepared.appliedRunId,
      ...(claimed.conflictOfEventKey ? { conflictOfEventKey: claimed.conflictOfEventKey } : {}) }), select: { id: true } });
    await tx.rawEvent.update({ where: { workspaceId_clientId_id: { ...ids(scope), id: claimed.id } },
      data: { status: 'PROCESSED', leaseOwner: null, leaseExpiresAt: null, lastErrorCode: null }, select: { id: true } });
    return observationId;
  });
}

/** Shadow (docs/04): after the baseline is committed, the AI result is stored as a run that is never applied. Best effort. */
async function runShadow(db: PrismaClient, actor: Actor, scope: Scope, claimed: ClaimedEvent, options: WorkerOptions): Promise<void> {
  assertStorableEvent(claimed.normalized);
  const event = claimed.normalized;
  const call = await callProvider(options.provider, event);
  const run: RunDraft = { provider: options.provider.provider, mode: 'shadow', result: call.result, error: call.error, latencyMs: call.latencyMs, details: call.details };
  await withScope(db, actor, [scope.clientId], tx => tx.decisionRun.create({ data: runData(scope, claimed, event, run, options.config ?? defaultDecisionConfig, randomUUID()), select: { id: true } }));
}

async function recordFailure(db: PrismaClient, actor: Actor, scope: Scope, claimed: ClaimedEvent, error: unknown, options: WorkerOptions, now: Date): Promise<'RETRY' | 'DEAD_LETTER'> {
  const failure = classify(error);
  const retry = failure.kind === 'TRANSIENT' && claimed.attempts < (options.maxAttempts ?? defaults.maxAttempts);
  const status = retry ? 'RETRY' : 'DEAD_LETTER';
  const delay = (options.retryDelayMs ?? defaults.retryDelayMs)(claimed.attempts);
  await withScope(db, actor, [scope.clientId], async tx => {
    const updated = await tx.rawEvent.updateMany({ where: { ...ids(scope), id: claimed.id, status: { in: ['RECEIVED', 'RETRY'] } },
      data: { status, lastErrorCode: failure.code, leaseOwner: null, leaseExpiresAt: null, ...(retry ? { nextAttemptAt: new Date(now.getTime() + delay) } : {}) } });
    if (updated.count === 1) {
      await tx.auditEvent.create({ data: clientAuditData(scope, actor.id, retry ? 'event.retry_scheduled' : 'event.dead_lettered', randomUUID(),
        { eventKey: claimed.eventKey, safeErrorCode: failure.code, attempts: String(claimed.attempts), inboxStatus: status }), select: { id: true } });
    }
  });
  return status;
}

/** One claimed event through both phases; any failure becomes RETRY or DEAD_LETTER with its reason. */
export async function processClaimed(db: PrismaClient, actor: Actor, scope: Scope, claimed: ClaimedEvent, options: WorkerOptions, now: Date = new Date()): Promise<ProcessOutcome> {
  try {
    const prepared = await prepareEvent(db, actor, scope, claimed, options);
    const observationId = await commitEvent(db, actor, scope, claimed, prepared, options);
    if (observationId === null) return { eventKey: claimed.eventKey, status: 'ALREADY_FINISHED', safeErrorCode: null, observationId: null };
    if (prepared.shadowPending) await runShadow(db, actor, scope, claimed, options).catch(() => undefined);
    return { eventKey: claimed.eventKey, status: 'PROCESSED', safeErrorCode: null, observationId };
  } catch (error) {
    const status = await recordFailure(db, actor, scope, claimed, error, options, now);
    return { eventKey: claimed.eventKey, status, safeErrorCode: safeErrorCode(classify(error)), observationId: null };
  }
}

/** One worker pass over a client: claim due events, process each. Workers on other processes take disjoint batches. */
export async function processPending(db: PrismaClient, actor: Actor, scope: Scope, options: WorkerOptions, now: Date = new Date()): Promise<ProcessOutcome[]> {
  const claimed = await claimEvents(db, actor, scope, options.workerId, now, options.leaseMs ?? defaults.leaseMs, options.batchSize ?? defaults.batchSize);
  const outcomes: ProcessOutcome[] = [];
  for (const event of claimed) outcomes.push(await processClaimed(db, actor, scope, event, options, now));
  return outcomes;
}
