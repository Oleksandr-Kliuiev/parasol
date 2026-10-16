import { randomUUID } from 'node:crypto';
import type { PrismaClient, Prisma } from '@prisma/client';
import type { Actor, NormalizedEvent, Provider, Route, Scope } from '../core/contracts.ts';
import { AtlasError, assertPermission, domainOf, priorityOf, safeErrorCode, severityRank } from '../core/contracts.ts';
import type { DecisionConfig, DecisionProvider } from '../decisions/provider.ts';
import { defaultDecisionConfig } from '../decisions/provider.ts';
import type { DecisionGuard } from '../decisions/guard.ts';
import { clientAuditData } from '../audit/prisma.ts';
import { withScope } from '../graph/scoped-db.ts';
import { decisionRunData, draftDecision, finalRoute } from './decision.ts';
import { assertStorableEvent } from './inbox.ts';
import { applyRevisionLifecycle } from '../observations/lifecycle.ts';
import { queueClock } from './clock.ts';

/**
 * Durable worker (task 1.6), docs/03 "Event inbox и worker" with the reference pipeline's contract:
 *   claim (lease + claim token, FOR UPDATE SKIP LOCKED) → phase 1 once per event: resolve the device, decide (provider
 *   called outside any transaction), store the runs NOT applied together with the prepared decision → phase 2 in ONE
 *   transaction: applied flag, observation, audit row, inbox completion. A retry reuses the stored decision and never calls
 *   the provider again; a crashed worker's lease expires and the event is claimed again. TRANSIENT failures retry with
 *   backoff up to maxAttempts, PERMANENT or unknown ones are dead-lettered with an audit row. Nothing is ever dropped.
 * Review B1: a worker changes the event only while its claim token is the current one; a worker whose lease was taken
 * over ends with CLAIM_LOST and changes nothing. Review B2: every claim uses up an attempt, also one that never reports
 * back; an event whose claims ran out (attempts = maxAttempts, lease expired) is dead-lettered at the next claim.
 */
export interface ClaimOptions { workerId: string; leaseMs?: number; maxAttempts?: number; batchSize?: number }
export interface WorkerOptions extends ClaimOptions {
  provider: DecisionProvider; config?: DecisionConfig; retryDelayMs?: (attempt: number) => number;
  /** Circuit breaker and call budget of the provider (task 1.7); the process shares one with its shadow job runner. */
  guard?: DecisionGuard;
  /** Test seam: runs inside the final transaction just before it commits (after every write of it). Production leaves it unset. */
  beforeFinalCommit?: (eventKey: string) => Promise<void>;
}
interface PreparedDecision { entityId: string | null; route: Route; confidence: number; provider: Provider; promptVersion: string; reasonCodes: string[]; appliedRunId: string;
  shadowPending: boolean; configVersion?: string }
export interface ClaimedEvent { id: string; eventKey: string; conflictOfEventKey: string | null; normalized: unknown; attempts: number; claimToken: string; prepared: PreparedDecision | null }
export interface ProcessOutcome { eventKey: string; status: 'PROCESSED' | 'RETRY' | 'DEAD_LETTER' | 'CLAIM_LOST'; safeErrorCode: string | null; observationId: string | null }
export interface ClaimResult { claimed: ClaimedEvent[]; deadLettered: ProcessOutcome[] }

const defaults = { leaseMs: 60_000, maxAttempts: 3, batchSize: 10, retryDelayMs: (attempt: number) => Math.min(15 * 60_000, 30_000 * 2 ** (attempt - 1)) };
const ids = (scope: Scope) => ({ workspaceId: scope.workspaceId, clientId: scope.clientId });
/** Database availability, pool exhaustion and serialization conflicts are TRANSIENT; any other unknown error is PERMANENT. */
const TRANSIENT_DB = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2034']);
function classify(error: unknown): AtlasError {
  if (error instanceof AtlasError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && TRANSIENT_DB.has(code) ? new AtlasError('DATABASE_UNAVAILABLE', 'TRANSIENT') : new AtlasError('UNEXPECTED_ERROR', 'PERMANENT');
}

/**
 * Claims due events of one client for this worker. Each claim gets its own token and uses up an attempt, so a crash
 * counts too. In the same transaction, due events that have used every attempt without an outcome (their last worker
 * died) are dead-lettered with an audit row (ATTEMPTS_EXHAUSTED): no provider call, no hidden pending rows. A stored
 * phase-1 decision stays with the event; an explicit requeue completes it without calling the provider again.
 */
export async function claimEvents(db: PrismaClient, actor: Actor, scope: Scope, options: ClaimOptions, now?: Date): Promise<ClaimResult> {
  assertPermission(actor, scope, 'events:ingest');
  const maxAttempts = options.maxAttempts ?? defaults.maxAttempts;
  const limit = options.batchSize ?? defaults.batchSize;
  // Each statement picks its rows in a MATERIALIZED CTE, evaluated exactly once: a LIMIT … FOR UPDATE SKIP LOCKED subquery
  // inside IN (…) may be re-run per row by the planner, skip the rows this statement already changed and exceed the batch.
  return withScope(db, actor, [scope.clientId], async tx => {
    // Due timestamps originate in PostgreSQL. Use its clock at the stored millisecond precision, not a potentially
    // behind/truncated process clock. Explicit clocks remain available for deterministic scheduling and recovery.
    const instant = await queueClock(tx, now);
    const until = new Date(instant.getTime() + (options.leaseMs ?? defaults.leaseMs));
    const exhausted = await tx.$queryRaw<{ eventKey: string; attempts: number }[]>`
      WITH picked AS MATERIALIZED (
        SELECT "workspaceId", "clientId", id FROM "RawEvent"
        WHERE "workspaceId" = ${scope.workspaceId} AND "clientId" = ${scope.clientId} AND status IN ('RECEIVED', 'RETRY') AND attempts >= ${maxAttempts}
          AND "nextAttemptAt" <= ${instant} AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < ${instant})
        ORDER BY "nextAttemptAt", "receivedAt", id LIMIT ${limit} FOR UPDATE SKIP LOCKED)
      UPDATE "RawEvent" r SET status = 'DEAD_LETTER', "lastErrorCode" = 'ATTEMPTS_EXHAUSTED', "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "claimToken" = NULL
      FROM picked p WHERE r."workspaceId" = p."workspaceId" AND r."clientId" = p."clientId" AND r.id = p.id
      RETURNING r."eventKey", r.attempts`;
    for (const row of exhausted) {
      await tx.auditEvent.create({ data: clientAuditData(scope, actor.id, 'event.dead_lettered', randomUUID(),
        { eventKey: row.eventKey, safeErrorCode: 'ATTEMPTS_EXHAUSTED', attempts: String(row.attempts), inboxStatus: 'DEAD_LETTER' }), select: { id: true } });
    }
    const rows = await tx.$queryRaw<{ id: string; eventKey: string; conflictOfEventKey: string | null; normalized: unknown; attempts: number;
      claimToken: string; preparedDecision: unknown }[]>`
      WITH picked AS MATERIALIZED (
        SELECT "workspaceId", "clientId", id FROM "RawEvent"
        WHERE "workspaceId" = ${scope.workspaceId} AND "clientId" = ${scope.clientId} AND status IN ('RECEIVED', 'RETRY') AND attempts < ${maxAttempts}
          AND "nextAttemptAt" <= ${instant} AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < ${instant})
        ORDER BY "nextAttemptAt", "receivedAt", id LIMIT ${limit} FOR UPDATE SKIP LOCKED)
      UPDATE "RawEvent" r SET "leaseOwner" = ${options.workerId}, "leaseExpiresAt" = ${until}, "claimToken" = gen_random_uuid(), attempts = r.attempts + 1
      FROM picked p WHERE r."workspaceId" = p."workspaceId" AND r."clientId" = p."clientId" AND r.id = p.id
      RETURNING r.id, r."eventKey", r."conflictOfEventKey", r.normalized, r.attempts, r."claimToken"::text AS "claimToken", r."preparedDecision"`;
    return {
      claimed: rows.map(r => ({ id: r.id, eventKey: r.eventKey, conflictOfEventKey: r.conflictOfEventKey, normalized: r.normalized, attempts: Number(r.attempts),
        claimToken: r.claimToken, prepared: (r.preparedDecision ?? null) as PreparedDecision | null })),
      deadLettered: exhausted.map(r => ({ eventKey: r.eventKey, status: 'DEAD_LETTER' as const, safeErrorCode: 'ATTEMPTS_EXHAUSTED', observationId: null })),
    };
  });
}

/** Locks the event row for a change by this claim: the token must still be the current one and the event still pending. */
async function lockClaim(tx: Prisma.TransactionClient, scope: Scope, claimed: ClaimedEvent): Promise<{ preparedDecision: unknown }> {
  const [row] = await tx.$queryRaw<{ preparedDecision: unknown }[]>`SELECT "preparedDecision" FROM "RawEvent"
    WHERE "workspaceId" = ${scope.workspaceId} AND "clientId" = ${scope.clientId} AND id = ${claimed.id}
      AND "claimToken" = ${claimed.claimToken}::uuid AND status IN ('RECEIVED', 'RETRY') FOR UPDATE`;
  if (!row) throw new AtlasError('CLAIM_LOST', 'CONFLICT');
  return row;
}

/** Device of the event through CONFIRMED links; a QUARANTINED link of that agent is an unresolved conflict (CONFLICT evidence). */
interface DeviceResolution { entityId: string | null; conflictCode: string | null }
async function resolveDevice(tx: Prisma.TransactionClient, scope: Scope, event: NormalizedEvent): Promise<DeviceResolution> {
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

/**
 * Phase 1, once per event. The stored decision is returned as is on every later attempt; the provider is not called.
 * A worker whose claim was taken over stops before the provider call, or at the latest when it would store the decision.
 */
export async function prepareEvent(db: PrismaClient, actor: Actor, scope: Scope, claimed: ClaimedEvent, options: WorkerOptions): Promise<PreparedDecision> {
  if (claimed.prepared) return claimed.prepared;
  const config = options.config ?? defaultDecisionConfig;
  assertStorableEvent(claimed.normalized);
  const event = claimed.normalized;
  const start: { stored: PreparedDecision } | { resolution: DeviceResolution } = await withScope(db, actor, [scope.clientId], async tx => {
    const row = await lockClaim(tx, scope, claimed);
    return row.preparedDecision ? { stored: row.preparedDecision as PreparedDecision } : { resolution: await resolveDevice(tx, scope, event) };
  });
  if ('stored' in start) return start.stored;
  const { resolution } = start;
  const draft = await draftDecision(options.provider, config, event, options.guard);
  const { route, reasonCodes } = finalRoute({ classification: draft.classification, entityId: resolution.entityId, linkConflictCode: resolution.conflictCode,
    conflictOfEventKey: claimed.conflictOfEventKey, sourceSeverity: event.sourceSeverity, confidenceThreshold: config.confidenceThreshold });
  return withScope(db, actor, [scope.clientId], async tx => {
    const row = await lockClaim(tx, scope, claimed);
    if (row.preparedDecision) return row.preparedDecision as PreparedDecision; // stored by an earlier claim of this event
    const runIds = draft.runs.map(() => randomUUID());
    for (const [i, run] of draft.runs.entries()) await tx.decisionRun.create({ data: decisionRunData(scope, claimed.id, event, run, config, runIds[i]!), select: { id: true } });
    const prepared: PreparedDecision = { entityId: resolution.entityId, route, confidence: draft.classification.confidence, provider: draft.classification.provider,
      promptVersion: draft.classification.promptVersion, reasonCodes, appliedRunId: runIds[draft.appliedRun]!, shadowPending: draft.shadowPending,
      configVersion: config.configVersion };
    await tx.rawEvent.update({ where: { workspaceId_clientId_id: { ...ids(scope), id: claimed.id } }, data: { preparedDecision: prepared as unknown as Prisma.InputJsonValue }, select: { id: true } });
    return prepared;
  });
}

/**
 * Phase 2: applied flag, observation, audit row and inbox completion in ONE transaction, under this claim's row lock. In
 * shadow mode the same transaction creates the event's ShadowJob: the AI call runs later, apart from this worker (task 1.7).
 * The same transaction applies the revision lifecycle of the event's source object (task 1.8).
 */
async function commitEvent(db: PrismaClient, actor: Actor, scope: Scope, claimed: ClaimedEvent, prepared: PreparedDecision, options: WorkerOptions): Promise<string> {
  assertStorableEvent(claimed.normalized);
  const event = claimed.normalized;
  return withScope(db, actor, [scope.clientId], async tx => {
    await lockClaim(tx, scope, claimed);
    const applied = await tx.decisionRun.updateMany({ where: { ...ids(scope), id: prepared.appliedRunId, eventId: claimed.id }, data: { applied: true } });
    if (applied.count !== 1) throw new AtlasError('APPLIED_RUN_MISSING', 'PERMANENT');
    const observationId = randomUUID();
    const priority = priorityOf(event.sourceSeverity);
    await tx.observation.create({ data: { ...ids(scope), id: observationId, eventId: claimed.id, entityId: prepared.entityId, decisionRunId: prepared.appliedRunId,
      domain: domainOf(event.kind), severity: event.sourceSeverity, severityRank: severityRank[event.sourceSeverity], priority, route: prepared.route,
      confidence: prepared.confidence, provider: prepared.provider, promptVersion: prepared.promptVersion, reasonCodes: prepared.reasonCodes, status: 'OPEN' }, select: { id: true } });
    const correlationId = randomUUID();
    await tx.auditEvent.create({ data: clientAuditData(scope, actor.id, 'observation.created', correlationId, { observationId, eventKey: claimed.eventKey,
      route: prepared.route, priority, provider: prepared.provider, reasonCodes: prepared.reasonCodes.join(','), decisionRunId: prepared.appliedRunId,
      ...(claimed.conflictOfEventKey ? { conflictOfEventKey: claimed.conflictOfEventKey } : {}) }), select: { id: true } });
    // Revisions of the same source object (task 1.8): the newer one is current; a late one is superseded at once
    await applyRevisionLifecycle(tx, scope, actor.id, { id: observationId, connectionId: event.connectionId, resourceType: event.resourceType,
      externalEventId: event.externalEventId, revision: event.revision, priority, conflictOfEventKey: claimed.conflictOfEventKey }, correlationId, new Date());
    await tx.rawEvent.update({ where: { workspaceId_clientId_id: { ...ids(scope), id: claimed.id } },
      data: { status: 'PROCESSED', leaseOwner: null, leaseExpiresAt: null, claimToken: null, lastErrorCode: null }, select: { id: true } });
    if (prepared.shadowPending) {
      await tx.shadowJob.create({ data: { ...ids(scope), eventId: claimed.id, configVersion: prepared.configVersion ?? (options.config ?? defaultDecisionConfig).configVersion },
        select: { eventId: true } });
    }
    if (options.beforeFinalCommit) await options.beforeFinalCommit(claimed.eventKey);
    return observationId;
  });
}


/** RETRY or DEAD_LETTER with an audit row, only while this claim is current: a claim taken over records nothing (CLAIM_LOST). */
async function recordFailure(db: PrismaClient, actor: Actor, scope: Scope, claimed: ClaimedEvent, failure: AtlasError, options: WorkerOptions,
  now?: Date): Promise<'RETRY' | 'DEAD_LETTER' | 'CLAIM_LOST'> {
  const retry = failure.kind === 'TRANSIENT' && claimed.attempts < (options.maxAttempts ?? defaults.maxAttempts);
  const status = retry ? 'RETRY' : 'DEAD_LETTER';
  const delay = (options.retryDelayMs ?? defaults.retryDelayMs)(claimed.attempts);
  return withScope(db, actor, [scope.clientId], async tx => {
    const retryAt = retry ? new Date((await queueClock(tx, now)).getTime() + delay) : null;
    const updated = await tx.rawEvent.updateMany({ where: { ...ids(scope), id: claimed.id, claimToken: claimed.claimToken, status: { in: ['RECEIVED', 'RETRY'] } },
      data: { status, lastErrorCode: failure.code, leaseOwner: null, leaseExpiresAt: null, claimToken: null, ...(retryAt ? { nextAttemptAt: retryAt } : {}) } });
    if (updated.count !== 1) return 'CLAIM_LOST';
    await tx.auditEvent.create({ data: clientAuditData(scope, actor.id, retry ? 'event.retry_scheduled' : 'event.dead_lettered', randomUUID(),
      { eventKey: claimed.eventKey, safeErrorCode: failure.code, attempts: String(claimed.attempts), inboxStatus: status }), select: { id: true } });
    return status;
  });
}

/** One claimed event through both phases; a failure becomes RETRY or DEAD_LETTER with its reason, or CLAIM_LOST (no change) if the claim was taken over. */
export async function processClaimed(db: PrismaClient, actor: Actor, scope: Scope, claimed: ClaimedEvent, options: WorkerOptions, now?: Date): Promise<ProcessOutcome> {
  try {
    const prepared = await prepareEvent(db, actor, scope, claimed, options);
    const observationId = await commitEvent(db, actor, scope, claimed, prepared, options);
    return { eventKey: claimed.eventKey, status: 'PROCESSED', safeErrorCode: null, observationId };
  } catch (error) {
    const failure = classify(error);
    const status = failure.code === 'CLAIM_LOST' ? 'CLAIM_LOST' : await recordFailure(db, actor, scope, claimed, failure, options, now);
    return { eventKey: claimed.eventKey, status, safeErrorCode: safeErrorCode(failure), observationId: null };
  }
}

/**
 * One worker pass over a client: dead-letter exhausted events, claim due ones, process each. Workers on other processes
 * take disjoint batches.
 */
export async function processPending(db: PrismaClient, actor: Actor, scope: Scope, options: WorkerOptions, now?: Date): Promise<ProcessOutcome[]> {
  const { claimed, deadLettered } = await claimEvents(db, actor, scope, options, now);
  const outcomes: ProcessOutcome[] = [...deadLettered];
  for (const event of claimed) outcomes.push(await processClaimed(db, actor, scope, event, options, now));
  return outcomes;
}
