import { randomUUID } from 'node:crypto';
import type { PrismaClient, Prisma } from '@prisma/client';
import type { Actor, Scope } from '../core/contracts.ts';
import { AtlasError, assertPermission } from '../core/contracts.ts';
import type { DecisionConfig, DecisionProvider } from '../decisions/provider.ts';
import type { DecisionGuard } from '../decisions/guard.ts';
import { withScope } from '../graph/scoped-db.ts';
import { callProvider, decisionRunData } from './decision.ts';
import type { RunDraft } from './decision.ts';
import { assertStorableEvent } from './inbox.ts';
import { queueClock } from './clock.ts';

/**
 * Shadow jobs (task 1.7, docs/04): the AI call of shadow mode, apart from the baseline. A job is created in the final
 * transaction of the event's baseline, so the observation — CRITICAL included — exists before any AI call starts and never
 * waits for one. Jobs are claimed like the inbox (picked once in a MATERIALIZED CTE, SKIP LOCKED, lease, own claim token).
 * Every provider call becomes a DecisionRun with applied = false; the observation is never changed.
 *   TRANSIENT failure → RETRY with backoff while the per-event call budget lasts (budget.maxProviderCallsPerEvent; the
 *   per-call deadline holds for each call); PERMANENT → FAILED; a job out of budget whose last claim never reported back →
 *   FAILED (ATTEMPTS_EXHAUSTED); an open circuit or a spent minute budget → SKIPPED with that code, no call made.
 */
export interface ShadowOptions {
  workerId: string; provider: DecisionProvider; config: DecisionConfig; guard?: DecisionGuard;
  leaseMs?: number; batchSize?: number; retryDelayMs?: (attempt: number) => number;
}
export interface ShadowOutcome { eventId: string; status: 'DONE' | 'RETRY' | 'FAILED' | 'SKIPPED' | 'CLAIM_LOST'; safeErrorCode: string | null }
interface ClaimedJob { eventId: string; attempts: number; claimToken: string }

const defaults = { leaseMs: 60_000, batchSize: 10, retryDelayMs: (attempt: number) => Math.min(15 * 60_000, 30_000 * 2 ** (attempt - 1)) };
const ids = (scope: Scope) => ({ workspaceId: scope.workspaceId, clientId: scope.clientId });

async function claimJobs(db: PrismaClient, actor: Actor, scope: Scope, options: ShadowOptions, now?: Date) {
  const maxAttempts = options.config.budget.maxProviderCallsPerEvent;
  const limit = options.batchSize ?? defaults.batchSize;
  return withScope(db, actor, [scope.clientId], async tx => {
    const instant = await queueClock(tx, now);
    const until = new Date(instant.getTime() + (options.leaseMs ?? defaults.leaseMs));
    const exhausted = await tx.$queryRaw<{ eventId: string }[]>`
      WITH picked AS MATERIALIZED (
        SELECT "workspaceId", "clientId", "eventId" FROM "ShadowJob"
        WHERE "workspaceId" = ${scope.workspaceId} AND "clientId" = ${scope.clientId} AND status IN ('PENDING', 'RETRY') AND attempts >= ${maxAttempts}
          AND "nextAttemptAt" <= ${instant} AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < ${instant})
        ORDER BY "nextAttemptAt", "eventId" LIMIT ${limit} FOR UPDATE SKIP LOCKED)
      UPDATE "ShadowJob" j SET status = 'FAILED', "lastErrorCode" = 'ATTEMPTS_EXHAUSTED', "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "claimToken" = NULL,
        "finishedAt" = ${instant}
      FROM picked p WHERE j."workspaceId" = p."workspaceId" AND j."clientId" = p."clientId" AND j."eventId" = p."eventId"
      RETURNING j."eventId"`;
    const claimed = await tx.$queryRaw<ClaimedJob[]>`
      WITH picked AS MATERIALIZED (
        SELECT "workspaceId", "clientId", "eventId" FROM "ShadowJob"
        WHERE "workspaceId" = ${scope.workspaceId} AND "clientId" = ${scope.clientId} AND status IN ('PENDING', 'RETRY') AND attempts < ${maxAttempts}
          AND "nextAttemptAt" <= ${instant} AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < ${instant})
        ORDER BY "nextAttemptAt", "eventId" LIMIT ${limit} FOR UPDATE SKIP LOCKED)
      UPDATE "ShadowJob" j SET "leaseOwner" = ${options.workerId}, "leaseExpiresAt" = ${until}, "claimToken" = gen_random_uuid(), attempts = j.attempts + 1
      FROM picked p WHERE j."workspaceId" = p."workspaceId" AND j."clientId" = p."clientId" AND j."eventId" = p."eventId"
      RETURNING j."eventId", j.attempts, j."claimToken"::text AS "claimToken"`;
    const events = claimed.length === 0 ? [] : await tx.rawEvent.findMany({ where: { ...ids(scope), id: { in: claimed.map(j => j.eventId) } },
      select: { id: true, normalized: true } });
    return { exhausted, claimed: claimed.map(j => ({ ...j, attempts: Number(j.attempts) })), events: new Map(events.map(e => [e.id, e.normalized])) };
  });
}

/** Ends this claim of the job; refused (CLAIM_LOST) if another worker has taken it over meanwhile. */
async function finishJob(tx: Prisma.TransactionClient, scope: Scope, job: ClaimedJob, status: 'DONE' | 'RETRY' | 'FAILED' | 'SKIPPED', code: string | null,
  nextAttemptAt: Date | null, now: Date): Promise<boolean> {
  const updated = await tx.shadowJob.updateMany({ where: { ...ids(scope), eventId: job.eventId, claimToken: job.claimToken, status: { in: ['PENDING', 'RETRY'] } },
    data: { status, lastErrorCode: status === 'DONE' ? null : code, leaseOwner: null, leaseExpiresAt: null, claimToken: null,
      ...(nextAttemptAt ? { nextAttemptAt } : {}), ...(status === 'RETRY' ? {} : { finishedAt: now }) } });
  return updated.count === 1;
}

async function processJob(db: PrismaClient, actor: Actor, scope: Scope, job: ClaimedJob, normalized: unknown, options: ShadowOptions, now?: Date): Promise<ShadowOutcome> {
  const end = (status: 'FAILED' | 'SKIPPED', code: string) => withScope(db, actor, [scope.clientId], async tx =>
    finishJob(tx, scope, job, status, code, null, await queueClock(tx, now)))
    .then(ok => ({ eventId: job.eventId, status: ok ? status : 'CLAIM_LOST' as const, safeErrorCode: code }));
  try { assertStorableEvent(normalized); } catch { return end('FAILED', 'INVALID_EVENT'); }
  const event = normalized;
  const admission = options.guard ? options.guard.admit() : { allowed: true as const };
  if (!admission.allowed) return end('SKIPPED', admission.reason);
  const call = await callProvider(options.provider, event);
  options.guard?.record(call.error);
  const maxAttempts = options.config.budget.maxProviderCallsPerEvent;
  const status = call.result ? 'DONE' : call.kind === 'TRANSIENT' && job.attempts < maxAttempts ? 'RETRY' : 'FAILED';
  const run: RunDraft = { provider: options.provider.provider, mode: 'shadow', result: call.result, error: call.error, latencyMs: call.latencyMs, details: call.details };
  const recorded = await withScope(db, actor, [scope.clientId], async tx => {
    // The run is stored only by the current claim, together with the job's outcome
    const [held] = await tx.$queryRaw<{ eventId: string }[]>`SELECT "eventId" FROM "ShadowJob"
      WHERE "workspaceId" = ${scope.workspaceId} AND "clientId" = ${scope.clientId} AND "eventId" = ${job.eventId}
        AND "claimToken" = ${job.claimToken}::uuid AND status IN ('PENDING', 'RETRY') FOR UPDATE`;
    if (!held) return false;
    const instant = await queueClock(tx, now);
    const nextAttemptAt = status === 'RETRY' ? new Date(instant.getTime() + (options.retryDelayMs ?? defaults.retryDelayMs)(job.attempts)) : null;
    await tx.decisionRun.create({ data: decisionRunData(scope, job.eventId, event, run, options.config, randomUUID()), select: { id: true } });
    return finishJob(tx, scope, job, status, call.error, nextAttemptAt, instant);
  });
  return { eventId: job.eventId, status: recorded ? status : 'CLAIM_LOST', safeErrorCode: call.error };
}

/** One pass of the shadow runner over a client: fail exhausted jobs, claim due ones, make each call once. */
export async function processShadowJobs(db: PrismaClient, actor: Actor, scope: Scope, options: ShadowOptions, now?: Date): Promise<ShadowOutcome[]> {
  assertPermission(actor, scope, 'events:ingest');
  if (options.provider.mode !== 'shadow') throw new AtlasError('SHADOW_PROVIDER_REQUIRED', 'PERMANENT');
  const { exhausted, claimed, events } = await claimJobs(db, actor, scope, options, now);
  const outcomes: ShadowOutcome[] = exhausted.map(j => ({ eventId: j.eventId, status: 'FAILED', safeErrorCode: 'ATTEMPTS_EXHAUSTED' }));
  for (const job of claimed) outcomes.push(await processJob(db, actor, scope, job, events.get(job.eventId), options, now));
  return outcomes;
}
