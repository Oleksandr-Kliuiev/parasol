import { randomUUID } from 'node:crypto';
import type { PrismaClient, Prisma } from '@prisma/client';
import type { Actor, Scope } from '../core/contracts.ts';
import { AtlasError, errorDetails, errorKind } from '../core/contracts.ts';
import { M365_CONFIG_VERSION, m365Limits } from '../../connectors/microsoft365/contract.ts';
import { clientAuditData } from '../audit/prisma.ts';
import { withScope } from '../graph/scoped-db.ts';
import { assertM365Permissions, lockAndCheck, lockForRecording, pinOf } from './authority.ts';
import type { M365Pin } from './authority.ts';
import { plusMs, systemClock } from './io.ts';
import type { Clock } from './io.ts';
import { retryDelayMs } from './signin-rows.ts';
import { withDenialAudit } from './denial.ts';

/**
 * Sign-in windows: durable request, root jobs and immutable attempts (docs/stage2/03_CONNECTOR_SYNC.md §5, 02 §3).
 * Lock order (shared with the triggers and the cleanup routine): Connection → request (only where request-wide counters
 * are consumed) → window (root) → root job → attempt → leaf. The clock is read after the locks.
 *  request  — server-generated ID; ≤24h within the retained period; ≤25 canonical UTC-hour roots; windows created in a
 *             later statement than the request, root jobs in a later one than the windows (parents always visible).
 *  claim    — consumes one unit of the root job's persistent budget (≤5) BEFORE a new attempt exists; a crashed attempt's
 *             expired claim was already counted. Bounds are fixed: [max(rootFrom, now−7d), min(rootTo, now−5m)]; new
 *             monotonic attemptSeq, claim token, 12m lease, 10m deadline; the root leaf in a later statement.
 *  publish  — ONE transaction: Connection fence, window still at this sequence, own unexpired claim before the deadline,
 *             no narrowing of prior unexpired coverage except at the retention boundary; attempt COMPLETE with counts, the
 *             window pointer, the predecessor SUPERSEDED, lastSeenAt of its evidence, root job COMPLETE and the audit row.
 *  failure  — own attempt FAILED; root job RETRY (retryAt persisted, Retry-After honoured exactly) or FAILED, and the window
 *             ERROR, only for an unexpired claim — an expired claim never writes for its successor.
 *  requeue  — explicit, audited, existing scoped FAILED root job → PENDING with a fresh budget.
 */
export interface RootClaim {
  readonly pin: M365Pin; readonly requestId: string; readonly windowId: string; readonly rootFrom: Date; readonly attemptId: string;
  readonly attemptSeq: number; readonly claimToken: string; readonly startedAt: Date; readonly deadlineAt: Date; readonly leaseExpiresAt: Date;
  readonly coveredFrom: Date; readonly coveredTo: Date; readonly rootLeafId: string;
  /** Budget of the root job after this claim was charged (informational; the job row is authoritative). */
  readonly attemptsUsed: number; readonly maxAttempts: number;
}
const HOUR = 3_600_000;
const L = m365Limits.signIns;
const ids = (pin: M365Pin) => ({ workspaceId: pin.workspaceId, clientId: pin.clientId, connectionId: pin.connectionId });

export interface SignInRequest { requestId: string; roots: { windowId: string; rootFrom: Date }[]; retrievalFrom: Date | null; retrievalTo: Date | null }
/** Public boundary: a permission/scope denial is audited once in the workspace security audit (denial.ts). */
export function createM365SignInRequest(db: PrismaClient, actor: Actor, scope: Scope, connectionId: string, from: Date, to: Date,
  clock: Clock = systemClock): Promise<SignInRequest> {
  return withDenialAudit(db, actor, scope, 'm365.signin_sync_denied', () => createRequest(db, actor, scope, connectionId, from, to, clock));
}
async function createRequest(db: PrismaClient, actor: Actor, scope: Scope, connectionId: string, from: Date, to: Date, clock: Clock): Promise<SignInRequest> {
  assertM365Permissions(actor, scope, 'sync', connectionId);
  if (!(from instanceof Date) || !(to instanceof Date) || !Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())
    || from >= to || to.getTime() - from.getTime() > L.maxRequestMs) throw new AtlasError('M365_INTERVAL_INVALID', 'VALIDATION');
  return withScope(db, actor, [scope.clientId], async tx => {
    const row = await lockAndCheck(tx, actor, scope, connectionId, 'sync');
    const now = clock();
    const floor = now.getTime() - L.retentionMs; const collectable = now.getTime() - L.collectionDelayMs;
    if (to.getTime() <= floor) throw new AtlasError('M365_INTERVAL_NOT_RETAINED', 'VALIDATION');
    if (from.getTime() >= collectable) throw new AtlasError('M365_INTERVAL_NOT_COLLECTABLE', 'VALIDATION');
    const roots: Date[] = [];
    for (let t = Math.floor(from.getTime() / HOUR) * HOUR; t < to.getTime(); t += HOUR) roots.push(new Date(t));
    if (roots.length > L.maxRootsPerRequest) throw new AtlasError('M365_INTERVAL_INVALID', 'VALIDATION');
    const retrievalFrom = Math.max(roots[0]!.getTime(), floor); const retrievalTo = Math.min(roots.at(-1)!.getTime() + HOUR, collectable);
    const requestId = randomUUID();
    const key = { workspaceId: scope.workspaceId, clientId: scope.clientId, connectionId };
    await tx.m365SyncRequest.create({ data: { ...key, id: requestId, requestedFrom: from, requestedTo: to, configVersion: M365_CONFIG_VERSION,
      retrievalFrom: retrievalFrom < retrievalTo ? new Date(retrievalFrom) : null, retrievalTo: retrievalFrom < retrievalTo ? new Date(retrievalTo) : null,
      rootCount: roots.length, createdBy: actor.id, createdAt: now }, select: { id: true } });
    await tx.m365SignInWindow.createMany({ data: roots.map(r => ({ ...key, id: randomUUID(), rootFrom: r, rootTo: new Date(r.getTime() + HOUR) })), skipDuplicates: true });
    const windows = await tx.m365SignInWindow.findMany({ where: { ...key, rootFrom: { in: roots } }, select: { id: true, rootFrom: true }, orderBy: { rootFrom: 'asc' } });
    await tx.m365SyncRootJob.createMany({ data: windows.map(w => ({ ...key, requestId, windowId: w.id, maxAttempts: L.maxAttempts, updatedAt: now })) });
    await tx.auditEvent.create({ data: clientAuditData(scope, actor.id, 'm365.signin_requested', randomUUID(), { connectionId, system: 'microsoft365', requestId,
      lifecycleVersion: String(row.lifecycleVersion) }), select: { id: true } });
    return { requestId, roots: windows.map(w => ({ windowId: w.id, rootFrom: w.rootFrom })), retrievalFrom: retrievalFrom < retrievalTo ? new Date(retrievalFrom) : null,
      retrievalTo: retrievalFrom < retrievalTo ? new Date(retrievalTo) : null };
  });
}

type Raw<T> = T[];
interface WindowLock { rootFrom: Date; rootTo: Date; started: number; pointer: string | null }
interface JobLock { attemptsUsed: number; maxAttempts: number; retryAt: Date | null; state: string; safeErrorCode: string | null }
const lockWindow = async (tx: Prisma.TransactionClient, pin: M365Pin, windowId: string) => (await tx.$queryRaw<Raw<WindowLock>>`
  SELECT "rootFrom", "rootTo", "latestStartedSeq" AS started, "publishedAttemptId" AS pointer FROM "M365SignInWindow"
  WHERE "workspaceId" = ${pin.workspaceId} AND "clientId" = ${pin.clientId} AND "connectionId" = ${pin.connectionId} AND id = ${windowId} FOR UPDATE`)[0];
const lockJob = async (tx: Prisma.TransactionClient, pin: M365Pin, requestId: string, windowId: string) => (await tx.$queryRaw<Raw<JobLock>>`
  SELECT "attemptsUsed", "maxAttempts", "retryAt", state, "safeErrorCode" FROM "M365SyncRootJob" WHERE "workspaceId" = ${pin.workspaceId} AND "clientId" = ${pin.clientId}
  AND "connectionId" = ${pin.connectionId} AND "requestId" = ${requestId} AND "windowId" = ${windowId} FOR UPDATE`)[0];
async function setJob(tx: Prisma.TransactionClient, pin: M365Pin, requestId: string, windowId: string, data: Prisma.M365SyncRootJobUpdateInput): Promise<void> {
  await tx.m365SyncRootJob.update({ where: { workspaceId_clientId_connectionId_requestId_windowId: { ...ids(pin), requestId, windowId } }, data, select: { windowId: true } });
}
/** The published attempt's fixed bounds and expiry (for the coverage-narrowing rule). */
async function publishedBounds(tx: Prisma.TransactionClient, pin: M365Pin, windowId: string, attemptId: string | null) {
  if (!attemptId) return null;
  return tx.m365WindowAttempt.findUnique({ where: { workspaceId_clientId_connectionId_windowId_id: { ...ids(pin), windowId, id: attemptId } },
    select: { coveredFrom: true, coveredTo: true, expiresAt: true } });
}
/** A new publication may narrow prior unexpired coverage only where the retention boundary has advanced. */
function narrows(prior: { coveredFrom: Date; coveredTo: Date; expiresAt: Date } | null, from: Date, to: Date, now: Date): boolean {
  if (!prior || prior.expiresAt.getTime() <= now.getTime()) return false;
  const floor = now.getTime() - L.retentionMs;
  return to.getTime() < prior.coveredTo.getTime() || from.getTime() > Math.max(prior.coveredFrom.getTime(), floor);
}

/**
 * A repeat pass reports the stored root outcome (review RC2-R3): COMPLETE → DONE/null; FAILED → FAILED with the stored safe
 * code (the original failure — with attemptsUsed == maxAttempts the chain is exhausted, the code still tells why); a live
 * claim → HELD; a RETRY before retryAt → NOT_DUE. None of these claims, charges budget, uses secrets or performs I/O.
 */
export type ClaimOutcome = { claimed: RootClaim } | { skipped: 'DONE' | 'HELD' | 'NOT_DUE' | 'NOT_YET_COLLECTABLE' | 'FAILED'; safeErrorCode: string | null;
  retryAt: Date | null; attemptsUsed: number; maxAttempts: number };

export async function claimRootAttempt(db: PrismaClient, actor: Actor, scope: Scope, connectionId: string, requestId: string, windowId: string,
  clock: Clock = systemClock): Promise<ClaimOutcome> {
  assertM365Permissions(actor, scope, 'sync', connectionId);
  return withScope(db, actor, [scope.clientId], async tx => {
    const row = await lockAndCheck(tx, actor, scope, connectionId, 'sync');
    const pin = pinOf(scope, connectionId, row, 'sync');
    const [request] = await tx.$queryRaw<Raw<{ totalLeaves: number }>>`SELECT "totalLeaves" FROM "M365SyncRequest" WHERE "workspaceId" = ${scope.workspaceId}
      AND "clientId" = ${scope.clientId} AND "connectionId" = ${connectionId} AND id = ${requestId} FOR UPDATE`;
    const window = await lockWindow(tx, pin, windowId);
    const job = await lockJob(tx, pin, requestId, windowId);
    if (!request || !window || !job) throw new AtlasError('M365_JOB_NOT_FOUND', 'VALIDATION');
    const now = clock();
    const skip = (skipped: Exclude<ClaimOutcome, { claimed: RootClaim }>['skipped'], safeErrorCode: string | null = null, retryAt: Date | null = null,
      attemptsUsed: number = job.attemptsUsed) => ({ skipped, safeErrorCode, retryAt, attemptsUsed, maxAttempts: job.maxAttempts });
    // Terminal outcome first: a finished root job changes nothing, not even expired-attempt maintenance.
    if (job.state === 'COMPLETE') return skip('DONE');
    if (job.state === 'FAILED') return skip('FAILED', job.safeErrorCode);
    // Expired claims of this root (a crashed worker of any request): closed here; their budget unit is already spent.
    const running = await tx.$queryRaw<Raw<{ id: string; requestId: string; leaseExpiresAt: Date }>>`SELECT id, "requestId", "leaseExpiresAt" FROM "M365WindowAttempt"
      WHERE "workspaceId" = ${scope.workspaceId} AND "clientId" = ${scope.clientId} AND "connectionId" = ${connectionId} AND "windowId" = ${windowId}
        AND state = 'RUNNING' FOR UPDATE`;
    for (const a of running.filter(r => r.leaseExpiresAt.getTime() <= now.getTime())) {
      await tx.m365WindowAttempt.update({ where: { workspaceId_clientId_connectionId_windowId_id: { ...ids(pin), windowId, id: a.id } },
        data: { state: 'FAILED', completedAt: now, claimToken: null, leaseExpiresAt: null, safeErrorCode: 'M365_CLAIM_EXPIRED' }, select: { id: true } });
    }
    if (running.some(r => r.requestId === requestId && r.leaseExpiresAt.getTime() > now.getTime())) return skip('HELD');
    if (job.state === 'RETRY' && job.retryAt && job.retryAt.getTime() > now.getTime()) return skip('NOT_DUE', null, job.retryAt);
    const fail = async (code: string) => { await setJob(tx, pin, requestId, windowId, { state: 'FAILED', retryAt: null, safeErrorCode: code, updatedAt: now }); return skip('FAILED', code); };
    // Budget spent by a crashed final claim: the original safe code is preserved when one exists.
    if (job.attemptsUsed >= job.maxAttempts) return fail(job.safeErrorCode ?? 'M365_ATTEMPTS_EXHAUSTED');
    const floor = now.getTime() - L.retentionMs;
    const coveredFrom = new Date(Math.max(window.rootFrom.getTime(), floor));
    const coveredTo = new Date(Math.min(window.rootTo.getTime(), now.getTime() - L.collectionDelayMs));
    if (coveredFrom.getTime() >= window.rootTo.getTime()) return fail('M365_INTERVAL_NOT_RETAINED');
    if (coveredTo.getTime() <= coveredFrom.getTime()) {
      // Not yet collectable: an explicit gap; no budget is consumed until at least one minute can be read.
      const retryAt = new Date(coveredFrom.getTime() + L.collectionDelayMs + L.minLeafMs);
      await setJob(tx, pin, requestId, windowId, { state: 'RETRY', retryAt, safeErrorCode: 'M365_NOT_YET_COLLECTABLE', updatedAt: now });
      return skip('NOT_YET_COLLECTABLE', 'M365_NOT_YET_COLLECTABLE', retryAt);
    }
    if (narrows(await publishedBounds(tx, pin, windowId, window.pointer), coveredFrom, coveredTo, now)) return fail('M365_COVERAGE_NARROWED');
    if (Number(request.totalLeaves) + 1 > L.maxLeavesPerRequest) return fail('SYNC_LIMIT_EXCEEDED');
    // Budget first, then the sequence, then (later statements) the attempt and its root leaf.
    await setJob(tx, pin, requestId, windowId, { attemptsUsed: job.attemptsUsed + 1, state: 'RUNNING', retryAt: null, safeErrorCode: null, updatedAt: now });
    const [seq] = await tx.$queryRaw<Raw<{ seq: number }>>`UPDATE "M365SignInWindow" SET "latestStartedSeq" = "latestStartedSeq" + 1,
      "lastAttemptAt" = GREATEST("lastAttemptAt", ${now}) WHERE "workspaceId" = ${scope.workspaceId} AND "clientId" = ${scope.clientId}
        AND "connectionId" = ${connectionId} AND id = ${windowId} RETURNING "latestStartedSeq" AS seq`;
    const claim: RootClaim = Object.freeze({ pin, requestId, windowId, rootFrom: window.rootFrom, attemptId: randomUUID(), attemptSeq: Number(seq!.seq),
      claimToken: randomUUID(), startedAt: now, deadlineAt: plusMs(now, L.attemptDeadlineMs), leaseExpiresAt: plusMs(now, L.leaseMs), coveredFrom, coveredTo,
      rootLeafId: randomUUID(), attemptsUsed: job.attemptsUsed + 1, maxAttempts: job.maxAttempts });
    await tx.m365WindowAttempt.create({ data: { ...ids(pin), windowId, id: claim.attemptId, rootFrom: window.rootFrom, requestId, attemptSeq: claim.attemptSeq,
      lifecycleVersion: pin.lifecycleVersion, coveredFrom, coveredTo, configVersion: M365_CONFIG_VERSION, claimToken: claim.claimToken,
      leaseExpiresAt: claim.leaseExpiresAt, deadlineAt: claim.deadlineAt, startedAt: now, expiresAt: plusMs(now, L.unpublishedRetentionMs) }, select: { id: true } });
    await tx.m365SyncRequest.update({ where: { workspaceId_clientId_connectionId_id: { ...ids(pin), id: requestId } }, data: { totalLeaves: { increment: 1 } }, select: { id: true } });
    await tx.m365WindowLeaf.create({ data: { ...ids(pin), windowId, attemptId: claim.attemptId, id: claim.rootLeafId, fromInclusive: coveredFrom, toExclusive: coveredTo },
      select: { id: true } });
    await tx.m365WindowAttempt.update({ where: { workspaceId_clientId_connectionId_windowId_id: { ...ids(pin), windowId, id: claim.attemptId } },
      data: { leafCount: 1 }, select: { id: true } });
    return { claimed: claim };
  });
}

/**
 * The claim is still current: own RUNNING attempt, unexpired lease, before its hard deadline, newest started sequence. No
 * locks. Lease and deadline come from the persisted attempt row; the caller-held descriptor's dates are never trusted.
 */
export async function assertRootClaim(tx: Prisma.TransactionClient, claim: RootClaim, now: Date): Promise<void> {
  const k = ids(claim.pin);
  const [a] = await tx.$queryRaw<Raw<{ state: string; claimToken: string | null; leaseExpiresAt: Date | null; deadlineAt: Date; started: number }>>`
    SELECT a.state, a."claimToken"::text AS "claimToken", a."leaseExpiresAt", a."deadlineAt", w."latestStartedSeq" AS started FROM "M365WindowAttempt" a
    JOIN "M365SignInWindow" w ON w."workspaceId" = a."workspaceId" AND w."clientId" = a."clientId" AND w."connectionId" = a."connectionId" AND w.id = a."windowId"
    WHERE a."workspaceId" = ${k.workspaceId} AND a."clientId" = ${k.clientId} AND a."connectionId" = ${k.connectionId} AND a."windowId" = ${claim.windowId}
      AND a.id = ${claim.attemptId}`;
  if (!a || a.state !== 'RUNNING' || a.claimToken !== claim.claimToken) throw new AtlasError('M365_CLAIM_LOST', 'PERMANENT');
  if (!a.leaseExpiresAt || now.getTime() >= a.leaseExpiresAt.getTime()) throw new AtlasError('M365_CLAIM_EXPIRED', 'PERMANENT');
  if (now.getTime() >= a.deadlineAt.getTime()) throw new AtlasError('SYNC_LIMIT_EXCEEDED', 'PERMANENT', { limit: 'deadline' });
  if (Number(a.started) !== claim.attemptSeq) throw new AtlasError('M365_ATTEMPT_SUPERSEDED', 'PERMANENT');
}
export const lockAttempt = (tx: Prisma.TransactionClient, claim: RootClaim) => tx.$queryRaw`SELECT 1 FROM "M365WindowAttempt"
  WHERE "workspaceId" = ${claim.pin.workspaceId} AND "clientId" = ${claim.pin.clientId} AND "connectionId" = ${claim.pin.connectionId}
    AND "windowId" = ${claim.windowId} AND id = ${claim.attemptId} FOR UPDATE`;

export interface PublishHooks { beforeCommit?(tx: Prisma.TransactionClient): Promise<void> }
export async function publishRootAttempt(db: PrismaClient, actor: Actor, claim: RootClaim, clock: Clock = systemClock,
  hooks: PublishHooks = {}): Promise<{ evidenceCount: number; leafCount: number }> {
  const k = ids(claim.pin); const windowId = claim.windowId;
  return withScope(db, actor, [k.clientId], async tx => {
    await lockAndCheck(tx, actor, claim.pin);
    const window = await lockWindow(tx, claim.pin, windowId);
    await lockJob(tx, claim.pin, claim.requestId, windowId);
    await lockAttempt(tx, claim);
    const now = clock();
    await assertRootClaim(tx, claim, now);
    if (!window) throw new AtlasError('M365_CLAIM_LOST', 'PERMANENT');
    // The attempt's fixed bounds as persisted at claim (immutable by trigger), not the descriptor's
    const own = await tx.m365WindowAttempt.findUniqueOrThrow({ where: { workspaceId_clientId_connectionId_windowId_id: { ...k, windowId, id: claim.attemptId } },
      select: { coveredFrom: true, coveredTo: true } });
    const prior = await publishedBounds(tx, claim.pin, windowId, window.pointer);
    if (narrows(prior, own.coveredFrom, own.coveredTo, now)) throw new AtlasError('M365_COVERAGE_NARROWED', 'PERMANENT');
    const where = { ...k, windowId, attemptId: claim.attemptId };
    const leafCount = await tx.m365WindowLeaf.count({ where });
    const evidenceCount = await tx.m365WindowEvidence.count({ where });
    // The triggers verify the exact COMPLETE partition, the counts, the newest sequence and the Connection fence.
    await tx.m365WindowAttempt.update({ where: { workspaceId_clientId_connectionId_windowId_id: { ...k, windowId, id: claim.attemptId } },
      data: { state: 'COMPLETE', completedAt: now, publishedAt: now, claimToken: null, leaseExpiresAt: null, evidenceCount, leafCount,
        expiresAt: plusMs(own.coveredTo, L.retentionMs) }, select: { id: true } });
    await tx.$executeRaw`UPDATE "M365SignInWindow" SET "publishedAttemptId" = ${claim.attemptId}, "latestPublishedSeq" = ${claim.attemptSeq},
      "latestRecordedSeq" = ${claim.attemptSeq}, status = 'OK', "safeErrorCode" = NULL, "lastAttemptAt" = GREATEST("lastAttemptAt", ${now}),
      "lastSuccessAt" = GREATEST("lastSuccessAt", ${now})
      WHERE "workspaceId" = ${k.workspaceId} AND "clientId" = ${k.clientId} AND "connectionId" = ${k.connectionId} AND id = ${windowId}`;
    if (window.pointer) {
      await tx.m365WindowAttempt.update({ where: { workspaceId_clientId_connectionId_windowId_id: { ...k, windowId, id: window.pointer } },
        data: { state: 'SUPERSEDED' }, select: { id: true } });
    }
    await tx.$executeRaw`UPDATE "M365SignInEvidence" e SET "lastSeenAt" = GREATEST(e."lastSeenAt", ${now}) FROM "M365WindowEvidence" m
      WHERE m."workspaceId" = ${k.workspaceId} AND m."clientId" = ${k.clientId} AND m."connectionId" = ${k.connectionId} AND m."windowId" = ${windowId}
        AND m."attemptId" = ${claim.attemptId} AND e."workspaceId" = m."workspaceId" AND e."clientId" = m."clientId" AND e."connectionId" = m."connectionId"
        AND e.id = m."evidenceId"`;
    await setJob(tx, claim.pin, claim.requestId, windowId, { state: 'COMPLETE', retryAt: null, safeErrorCode: null, updatedAt: now });
    await tx.auditEvent.create({ data: clientAuditData(claim.pin, actor.id, 'm365.signin_window_published', randomUUID(), { connectionId: k.connectionId,
      system: 'microsoft365', requestId: claim.requestId, attemptSeq: String(claim.attemptSeq), evidenceCount: String(evidenceCount), leafCount: String(leafCount) }),
    select: { id: true } });
    await hooks.beforeCommit?.(tx);
    return { evidenceCount, leafCount };
  });
}

export interface RootFailure { recorded: boolean; jobState: 'RETRY' | 'FAILED' | null; retryAt: Date | null; attemptsUsed: number | null; maxAttempts: number | null }
/** Records a failed attempt; job/window state only for an unexpired claim (never on behalf of a successor). */
export async function recordRootFailure(db: PrismaClient, actor: Actor, claim: RootClaim, error: unknown, clock: Clock = systemClock,
  jitter: number = Math.random()): Promise<RootFailure> {
  const k = ids(claim.pin); const windowId = claim.windowId;
  const code = error instanceof AtlasError ? error.code : 'UNEXPECTED_ERROR';
  return withScope(db, actor, [k.clientId], async tx => {
    await lockForRecording(tx, actor, claim.pin, k.connectionId);
    const window = await lockWindow(tx, claim.pin, windowId);
    const job = await lockJob(tx, claim.pin, claim.requestId, windowId);
    const [a] = await tx.$queryRaw<Raw<{ state: string; claimToken: string | null; leaseExpiresAt: Date | null }>>`SELECT state, "claimToken"::text AS "claimToken",
      "leaseExpiresAt" FROM "M365WindowAttempt" WHERE "workspaceId" = ${k.workspaceId} AND "clientId" = ${k.clientId} AND "connectionId" = ${k.connectionId}
        AND "windowId" = ${windowId} AND id = ${claim.attemptId} FOR UPDATE`;
    const now = clock();
    const none: RootFailure = { recorded: false, jobState: null, retryAt: null, attemptsUsed: job?.attemptsUsed ?? null, maxAttempts: job?.maxAttempts ?? null };
    if (!a || a.state !== 'RUNNING' || a.claimToken !== claim.claimToken) return none;
    await tx.m365WindowLeaf.updateMany({ where: { ...k, windowId, attemptId: claim.attemptId, state: { in: ['PENDING', 'RUNNING'] } }, data: { state: 'FAILED', safeErrorCode: code } });
    await tx.m365WindowAttempt.update({ where: { workspaceId_clientId_connectionId_windowId_id: { ...k, windowId, id: claim.attemptId } },
      data: { state: 'FAILED', completedAt: now, claimToken: null, leaseExpiresAt: null, safeErrorCode: code }, select: { id: true } });
    if (!a.leaseExpiresAt || now.getTime() >= a.leaseExpiresAt.getTime() || !window || !job) return none;
    const transient = errorKind(error) === 'TRANSIENT' && job.attemptsUsed < job.maxAttempts;
    const retryAt = transient ? plusMs(now, retryDelayMs(code, errorDetails(error).retryAfterSeconds, job.attemptsUsed, jitter)) : null;
    await setJob(tx, claim.pin, claim.requestId, windowId, { state: transient ? 'RETRY' : 'FAILED', retryAt, safeErrorCode: code, updatedAt: now });
    if (Number(window.started) === claim.attemptSeq) {
      await tx.$executeRaw`UPDATE "M365SignInWindow" SET "latestRecordedSeq" = ${claim.attemptSeq}, status = 'ERROR', "safeErrorCode" = ${code},
        "lastAttemptAt" = GREATEST("lastAttemptAt", ${now}) WHERE "workspaceId" = ${k.workspaceId} AND "clientId" = ${k.clientId}
          AND "connectionId" = ${k.connectionId} AND id = ${windowId}`;
    }
    await tx.auditEvent.create({ data: clientAuditData(claim.pin, actor.id, 'm365.signin_window_failed', randomUUID(), { connectionId: k.connectionId,
      system: 'microsoft365', requestId: claim.requestId, attemptSeq: String(claim.attemptSeq), attemptsUsed: String(job.attemptsUsed), safeErrorCode: code }),
    select: { id: true } });
    return { recorded: true, jobState: transient ? 'RETRY' : 'FAILED', retryAt, attemptsUsed: job.attemptsUsed, maxAttempts: job.maxAttempts };
  });
}

/** Explicit, audited requeue of an existing scoped FAILED root job: PENDING with a fresh finite budget (SQL allows only this reset). */
/** Public boundary: a permission/scope denial is audited once in the workspace security audit (denial.ts). */
export function requeueM365RootJob(db: PrismaClient, actor: Actor, scope: Scope, connectionId: string, requestId: string, windowId: string,
  clock: Clock = systemClock): Promise<{ requestId: string; windowId: string; state: 'PENDING'; attemptsUsed: 0 }> {
  return withDenialAudit(db, actor, scope, 'm365.signin_requeue_denied', () => requeue(db, actor, scope, connectionId, requestId, windowId, clock));
}
async function requeue(db: PrismaClient, actor: Actor, scope: Scope, connectionId: string, requestId: string, windowId: string,
  clock: Clock): Promise<{ requestId: string; windowId: string; state: 'PENDING'; attemptsUsed: 0 }> {
  assertM365Permissions(actor, scope, 'sync', connectionId);
  return withScope(db, actor, [scope.clientId], async tx => {
    const row = await lockAndCheck(tx, actor, scope, connectionId, 'sync');
    const pin = pinOf(scope, connectionId, row, 'sync');
    await lockWindow(tx, pin, windowId);
    const job = await lockJob(tx, pin, requestId, windowId);
    if (!job) throw new AtlasError('M365_JOB_NOT_FOUND', 'VALIDATION');
    if (job.state !== 'FAILED') throw new AtlasError('M365_JOB_NOT_REQUEUEABLE', 'VALIDATION');
    await setJob(tx, pin, requestId, windowId, { state: 'PENDING', attemptsUsed: 0, retryAt: null, safeErrorCode: null, updatedAt: clock() });
    await tx.auditEvent.create({ data: clientAuditData(scope, actor.id, 'm365.signin_requeued', randomUUID(), { connectionId, system: 'microsoft365', requestId,
      attemptsUsed: String(job.attemptsUsed) }), select: { id: true } });
    return { requestId, windowId, state: 'PENDING', attemptsUsed: 0 };
  });
}
