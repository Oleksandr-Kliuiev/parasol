import { randomUUID } from 'node:crypto';
import type { PrismaClient, Prisma } from '@prisma/client';
import type { Actor, Scope } from '../core/contracts.ts';
import { AtlasError, safeErrorCode } from '../core/contracts.ts';
import { m365Limits, signInsUrl } from '../../connectors/microsoft365/contract.ts';
import type { M365GraphSession } from '../../connectors/microsoft365/connector.ts';
import { parseM365SignInPage } from '../../connectors/microsoft365/signin-dto.ts';
import { withScope } from '../graph/scoped-db.ts';
import { assertM365Permissions } from './authority.ts';
import { openSession, systemClock } from './io.ts';
import type { Clock, M365Io } from './io.ts';
import { signInVersion, splitBounds, windowPosition } from './signin-rows.ts';
import type { SignInVersion } from './signin-rows.ts';
import { assertRootClaim, claimRootAttempt, lockAttempt, publishRootAttempt, recordRootFailure } from './windows.ts';
import type { RootClaim, RootFailure } from './windows.ts';
import { recordUnlessDenied, withDenialAudit } from './denial.ts';

/**
 * Sign-in leaf traversal of one root attempt (docs/stage2/03_CONNECTOR_SYNC.md §5). Leaves are read in time order; a
 * restart is always a new attempt from the first page (no nextLink or token is ever stored). Per page, in one short
 * transaction: request → attempt → leaf locked, claim checked after the locks, the durable counters consumed (request
 * ≤250,000 rows, attempt ≤100,000, leaf ≤20 pages/≤10,000 rows — rows at the exact upper bound included) and the immutable
 * evidence versions upserted (same ID+hash deduplicates; changed content is a new version). Memberships are written only
 * when the whole leaf has been read, together with leaf COMPLETE, so a leaf that hits its cap and is split leaves no
 * membership behind (SPLIT is a container, never published evidence). A leaf over its cap is split into two
 * nonoverlapping halves of at least one minute; leaf caps (≤60 per root, ≤1,500 per request) are consumed durably. An
 * unsplittable capped leaf, a row outside [from, to] or any other failure ends the attempt: nothing of it is published.
 *
 * Counters (review F5). Retrieval counters — M365SyncRequest.totalStagedRows and M365WindowAttempt.stagedRows — count
 * every row Graph returned for the attempt: staged versions, duplicates, exact-upper-bound rows and the rows of a page that
 * crossed the leaf row cap (validated, not staged); they bound the request (≤250,000) and root (≤100,000). Leaf counters
 * (pagesRead ≤20, rowCount ≤10,000) count only the pages accepted into that leaf. Every returned row is validated against
 * the current leaf's bounds BEFORE the cap decision, so an out-of-window row on a cap-crossing page fails the attempt. A
 * malformed page fails the attempt before anything of it is counted or staged.
 */
export interface LeafLimits { maxPagesPerLeaf: number; maxRowsPerLeaf: number }
/** Leaf caps: the configured hard bounds, or lower values within them (03 §4: configurable within hard bounds). */
export function leafLimits(lower: Partial<LeafLimits> = {}): LeafLimits {
  const limits = { maxPagesPerLeaf: lower.maxPagesPerLeaf ?? m365Limits.signIns.maxPagesPerLeaf, maxRowsPerLeaf: lower.maxRowsPerLeaf ?? m365Limits.signIns.maxRowsPerLeaf };
  const within = (v: number, max: number) => Number.isSafeInteger(v) && v >= 1 && v <= max;
  if (!within(limits.maxPagesPerLeaf, m365Limits.signIns.maxPagesPerLeaf) || !within(limits.maxRowsPerLeaf, m365Limits.signIns.maxRowsPerLeaf)) {
    throw new AtlasError('M365_LIMIT_INVALID', 'VALIDATION');
  }
  return Object.freeze(limits);
}
const L = m365Limits.signIns;
const keyOf = (claim: RootClaim) => ({ workspaceId: claim.pin.workspaceId, clientId: claim.pin.clientId, connectionId: claim.pin.connectionId,
  windowId: claim.windowId, attemptId: claim.attemptId });
const attemptKey = (claim: RootClaim) => ({ workspaceId_clientId_connectionId_windowId_id: { workspaceId: claim.pin.workspaceId, clientId: claim.pin.clientId,
  connectionId: claim.pin.connectionId, windowId: claim.windowId, id: claim.attemptId } });
const limit = (name: string) => new AtlasError('SYNC_LIMIT_EXCEEDED', 'PERMANENT', { limit: name });
interface Leaf { id: string; fromInclusive: Date; toExclusive: Date }

async function lockLeaf(db: PrismaClient, actor: Actor, claim: RootClaim, leafId: string, clock: Clock, withRequest: boolean,
  body: (tx: Prisma.TransactionClient, leaf: { state: string; pagesRead: number; rowCount: number; from: Date; to: Date },
    counters: { attemptRows: number; attemptLeaves: number; requestRows: number; requestLeaves: number }) => Promise<void>): Promise<void> {
  const k = keyOf(claim);
  await withScope(db, actor, [k.clientId], async tx => {
    const [request] = withRequest ? await tx.$queryRaw<{ rows: number; leaves: number }[]>`SELECT "totalStagedRows" AS rows, "totalLeaves" AS leaves
      FROM "M365SyncRequest" WHERE "workspaceId" = ${k.workspaceId} AND "clientId" = ${k.clientId} AND "connectionId" = ${k.connectionId}
        AND id = ${claim.requestId} FOR UPDATE` : [{ rows: 0, leaves: 0 }];
    await lockAttempt(tx, claim);
    const [leaf] = await tx.$queryRaw<{ state: string; pagesRead: number; rowCount: number; from: Date; to: Date }[]>`SELECT state, "pagesRead", "rowCount",
      "fromInclusive" AS from, "toExclusive" AS to FROM "M365WindowLeaf" WHERE "workspaceId" = ${k.workspaceId} AND "clientId" = ${k.clientId}
        AND "connectionId" = ${k.connectionId} AND "windowId" = ${k.windowId} AND "attemptId" = ${k.attemptId} AND id = ${leafId} FOR UPDATE`;
    await assertRootClaim(tx, claim, clock()); // after every lock
    if (!leaf) throw new AtlasError('M365_CLAIM_LOST', 'PERMANENT');
    const attempt = await tx.m365WindowAttempt.findUniqueOrThrow({ where: attemptKey(claim), select: { stagedRows: true, leafCount: true } });
    await body(tx, leaf, { attemptRows: attempt.stagedRows, attemptLeaves: attempt.leafCount, requestRows: Number(request!.rows), requestLeaves: Number(request!.leaves) });
  });
}

async function startLeaf(db: PrismaClient, actor: Actor, claim: RootClaim, leafId: string, clock: Clock): Promise<void> {
  await lockLeaf(db, actor, claim, leafId, clock, false, async (tx, leaf) => {
    if (leaf.state !== 'PENDING') throw new AtlasError('M365_CLAIM_LOST', 'PERMANENT');
    await tx.m365WindowLeaf.update({ where: { workspaceId_clientId_connectionId_windowId_attemptId_id: { ...keyOf(claim), id: leafId } }, data: { state: 'RUNNING' },
      select: { id: true } });
  });
}

/**
 * One received page: the retrieval counters are consumed for every received row (exact-upper-bound rows included). With
 * `intoLeaf` the page is also counted in the leaf and its kept versions upserted; without it (a cap-crossing page) only
 * the request/root retrieval budget is consumed.
 */
export async function stageSignInPage(db: PrismaClient, actor: Actor, claim: RootClaim, leafId: string, received: number, versions: readonly SignInVersion[],
  clock: Clock = systemClock, intoLeaf = true): Promise<void> {
  const k = keyOf(claim);
  await lockLeaf(db, actor, claim, leafId, clock, true, async (tx, leaf, c) => {
    if (leaf.state !== 'RUNNING') throw new AtlasError('M365_CLAIM_LOST', 'PERMANENT');
    if (c.requestRows + received > L.maxRowsPerRequest) throw limit('requestRows');
    if (c.attemptRows + received > L.maxRowsPerRoot) throw limit('rootRows');
    await tx.m365SyncRequest.update({ where: { workspaceId_clientId_connectionId_id: { workspaceId: k.workspaceId, clientId: k.clientId, connectionId: k.connectionId,
      id: claim.requestId } }, data: { totalStagedRows: { increment: received } }, select: { id: true } });
    await tx.m365WindowAttempt.update({ where: attemptKey(claim),
      data: { stagedRows: { increment: received } }, select: { id: true } });
    if (!intoLeaf) return;
    await tx.m365WindowLeaf.update({ where: { workspaceId_clientId_connectionId_windowId_attemptId_id: { ...k, id: leafId } },
      data: { pagesRead: { increment: 1 }, rowCount: { increment: received } }, select: { id: true } });
    if (versions.length === 0) return;
    const now = clock();
    const rows = versions.map(v => ({ s: v.sourceId, h: v.contentHash,
      d: v.dto, o: v.occurredAt.toISOString(), u: v.userId, v: v.deviceId, x: v.expiresAt.toISOString() }));
    await tx.$executeRaw`INSERT INTO "M365SignInEvidence" ("workspaceId", "clientId", "connectionId", id, "sourceId", "contentHash", "dtoVersion", dto, "occurredAt",
        "userId", "deviceId", "firstSeenAt", "lastSeenAt", "expiresAt")
      SELECT ${k.workspaceId}, ${k.clientId}, ${k.connectionId}, gen_random_uuid()::text, r.s, r.h, 'm365-signin-v1', r.d, r.o::timestamptz AT TIME ZONE 'UTC',
        r.u, r.v, ${now}, ${now}, r.x::timestamptz AT TIME ZONE 'UTC'
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS r(s text, h text, d jsonb, o text, u text, v text, x text)
      ON CONFLICT ("workspaceId", "clientId", "connectionId", "sourceId", "contentHash") DO NOTHING`;
  });
}

/** Leaf over its cap: SPLIT container plus two PENDING halves, consuming the root and request leaf caps durably. */
export async function splitLeaf(db: PrismaClient, actor: Actor, claim: RootClaim, leafId: string, clock: Clock = systemClock): Promise<void> {
  const k = keyOf(claim);
  await lockLeaf(db, actor, claim, leafId, clock, true, async (tx, leaf, c) => {
    if (leaf.state !== 'RUNNING') throw new AtlasError('M365_CLAIM_LOST', 'PERMANENT');
    const halves = splitBounds(leaf.from, leaf.to);
    if (!halves) throw limit('minLeaf');
    if (c.attemptLeaves + 2 > L.maxLeavesPerRoot) throw limit('rootLeaves');
    if (c.requestLeaves + 2 > L.maxLeavesPerRequest) throw limit('requestLeaves');
    await tx.m365WindowLeaf.update({ where: { workspaceId_clientId_connectionId_windowId_attemptId_id: { ...k, id: leafId } }, data: { state: 'SPLIT' }, select: { id: true } });
    for (const [from, to] of halves) {
      await tx.m365WindowLeaf.create({ data: { ...k, id: randomUUID(), parentLeafId: leafId, fromInclusive: from, toExclusive: to }, select: { id: true } });
    }
    await tx.m365WindowAttempt.update({ where: attemptKey(claim), data: { leafCount: { increment: 2 } },
      select: { id: true } });
    await tx.m365SyncRequest.update({ where: { workspaceId_clientId_connectionId_id: { workspaceId: k.workspaceId, clientId: k.clientId, connectionId: k.connectionId,
      id: claim.requestId } }, data: { totalLeaves: { increment: 2 } }, select: { id: true } });
  });
}

/** The fully read leaf: its memberships (exactly the versions it returned) and COMPLETE, in one transaction. */
export async function completeLeaf(db: PrismaClient, actor: Actor, claim: RootClaim, leafId: string, versions: readonly { sourceId: string; contentHash: string }[],
  clock: Clock = systemClock): Promise<void> {
  const k = keyOf(claim);
  await lockLeaf(db, actor, claim, leafId, clock, false, async (tx, leaf) => {
    if (leaf.state !== 'RUNNING') throw new AtlasError('M365_CLAIM_LOST', 'PERMANENT');
    if (versions.length > 0) {
      await tx.$executeRaw`INSERT INTO "M365WindowEvidence" ("workspaceId", "clientId", "connectionId", "windowId", "attemptId", "leafId", "evidenceId")
        SELECT e."workspaceId", e."clientId", e."connectionId", ${k.windowId}, ${k.attemptId}, ${leafId}, e.id FROM "M365SignInEvidence" e
        JOIN jsonb_to_recordset(${JSON.stringify(versions.map(v => ({ s: v.sourceId, h: v.contentHash })))}::jsonb) AS r(s text, h text)
          ON e."sourceId" = r.s AND e."contentHash" = r.h
        WHERE e."workspaceId" = ${k.workspaceId} AND e."clientId" = ${k.clientId} AND e."connectionId" = ${k.connectionId}
        ON CONFLICT DO NOTHING`;
    }
    await tx.m365WindowLeaf.update({ where: { workspaceId_clientId_connectionId_windowId_attemptId_id: { ...k, id: leafId } }, data: { state: 'COMPLETE' }, select: { id: true } });
  });
}

/** Reads one RUNNING leaf; returns its versions when complete, or 'SPLIT' when it exceeded its page/row cap. */
export async function readLeaf(db: PrismaClient, actor: Actor, claim: RootClaim, session: M365GraphSession, leaf: Leaf, clock: Clock,
  limits: LeafLimits = leafLimits()): Promise<SignInVersion[] | 'SPLIT'> {
  const traversal = session.traverse('signIns', signInsUrl(leaf.fromInclusive, leaf.toExclusive));
  const kept = new Map<string, SignInVersion>(); let rows = 0;
  for (;;) {
    if (traversal.pages >= limits.maxPagesPerLeaf) return 'SPLIT'; // the next page is never requested
    // The persisted hard deadline, lease and sequence are checked before every request (session claim check).
    const page = await traversal.next();
    if (!page) break;
    const dtos = parseM365SignInPage(page.body);
    // Every returned row against THIS leaf's bounds first — a cap-crossing page cannot hide an invalid row behind a split
    const versions: SignInVersion[] = [];
    for (const dto of dtos) {
      const position = windowPosition(dto.createdDateTime, leaf.fromInclusive, leaf.toExclusive);
      if (position === 'OUTSIDE') throw new AtlasError('M365_SIGNIN_OUT_OF_WINDOW', 'PERMANENT');
      if (position === 'UPPER_BOUND') continue; // Graph's inclusive `le`: validated, discarded, still counted
      versions.push(signInVersion(dto));
    }
    if (rows + dtos.length > limits.maxRowsPerLeaf) {
      // Retrieved, so it consumes the request/root budget; not staged, not counted in the capped leaf.
      await stageSignInPage(db, actor, claim, leaf.id, dtos.length, [], clock, false);
      return 'SPLIT';
    }
    rows += dtos.length;
    await stageSignInPage(db, actor, claim, leaf.id, dtos.length, versions, clock);
    for (const v of versions) kept.set(`${v.contentHash}\u0000${v.sourceId}`, v);
    if (page.nextLink === null) break;
  }
  return [...kept.values()];
}

/** Every leaf of the attempt until none is PENDING; throws on any failure (the caller records it). */
export interface SignInRunOptions { leafLimits?: Partial<LeafLimits> }
export async function runRootAttempt(db: PrismaClient, actor: Actor, claim: RootClaim, io: M365Io, clock: Clock = systemClock,
  options: SignInRunOptions = {}): Promise<void> {
  const limits = leafLimits(options.leafLimits);
  const session = openSession(db, actor, claim.pin, io, clock, tx => assertRootClaim(tx, claim, clock()));
  const k = keyOf(claim);
  for (;;) {
    const leaf = await withScope(db, actor, [k.clientId], tx => tx.m365WindowLeaf.findFirst({ where: { ...k, state: 'PENDING' },
      orderBy: [{ fromInclusive: 'asc' }, { toExclusive: 'asc' }], select: { id: true, fromInclusive: true, toExclusive: true } }));
    if (!leaf) return;
    await startLeaf(db, actor, claim, leaf.id, clock);
    const outcome = await readLeaf(db, actor, claim, session, leaf, clock, limits);
    if (outcome === 'SPLIT') await splitLeaf(db, actor, claim, leaf.id, clock);
    else await completeLeaf(db, actor, claim, leaf.id, outcome, clock);
  }
}

export interface RootResult {
  windowId: string; rootFrom: Date; outcome: 'PUBLISHED' | 'RETRY' | 'FAILED' | 'DONE' | 'HELD' | 'NOT_DUE' | 'NOT_YET_COLLECTABLE';
  attemptSeq: number | null; safeErrorCode: string | null; retryAt: Date | null; evidenceCount: number | null;
  /** Root-job budget after this pass (with FAILED: used == max means the chain is exhausted; the code tells the cause). */
  attemptsUsed: number | null; maxAttempts: number | null;
}
/**
 * One operator pass over a request: every root job that is due is claimed, read and published (or its failure recorded);
 * nothing sleeps — a RETRY is picked up by a later pass at or after its persisted retryAt.
 */
export function runM365SignInRequest(db: PrismaClient, actor: Actor, scope: Scope, connectionId: string, requestId: string, io: M365Io,
  clock: Clock = systemClock, options: SignInRunOptions = {}): Promise<RootResult[]> {
  // Public boundary: a denial before the claim, during I/O, before publication or while recording ends the whole pass and
  // is audited once in the workspace security audit (denial.ts); no later root is claimed or read.
  return withDenialAudit(db, actor, scope, 'm365.signin_sync_denied', () => runPass(db, actor, scope, connectionId, requestId, io, clock, options));
}
async function runPass(db: PrismaClient, actor: Actor, scope: Scope, connectionId: string, requestId: string, io: M365Io, clock: Clock,
  options: SignInRunOptions): Promise<RootResult[]> {
  assertM365Permissions(actor, scope, 'sync', connectionId);
  leafLimits(options.leafLimits); // invalid limits are refused before any claim
  const jobs = await withScope(db, actor, [scope.clientId], tx => tx.m365SyncRootJob.findMany({ where: { ...scope, connectionId, requestId },
    select: { windowId: true, window: { select: { rootFrom: true } } }, orderBy: { window: { rootFrom: 'asc' } } }));
  if (jobs.length === 0) throw new AtlasError('M365_JOB_NOT_FOUND', 'VALIDATION');
  const results: RootResult[] = [];
  for (const job of jobs) {
    const base = { windowId: job.windowId, rootFrom: job.window.rootFrom };
    const outcome = await claimRootAttempt(db, actor, scope, connectionId, requestId, job.windowId, clock);
    if ('skipped' in outcome) {
      results.push({ ...base, outcome: outcome.skipped, attemptSeq: null, safeErrorCode: outcome.safeErrorCode, retryAt: outcome.retryAt, evidenceCount: null,
        attemptsUsed: outcome.attemptsUsed, maxAttempts: outcome.maxAttempts });
      continue;
    }
    const claim = outcome.claimed;
    try {
      await runRootAttempt(db, actor, claim, io, clock, options);
      const { evidenceCount } = await publishRootAttempt(db, actor, claim, clock);
      results.push({ ...base, outcome: 'PUBLISHED', attemptSeq: claim.attemptSeq, safeErrorCode: null, retryAt: null, evidenceCount,
        attemptsUsed: claim.attemptsUsed, maxAttempts: claim.maxAttempts });
    } catch (error) {
      const failure = await recordUnlessDenied<RootFailure>(error, () => recordRootFailure(db, actor, claim, error, clock),
        { recorded: false, jobState: null, retryAt: null, attemptsUsed: claim.attemptsUsed, maxAttempts: claim.maxAttempts });
      results.push({ ...base, outcome: failure.jobState ?? 'FAILED', attemptSeq: claim.attemptSeq, safeErrorCode: safeErrorCode(error), retryAt: failure.retryAt,
        evidenceCount: null, attemptsUsed: failure.attemptsUsed, maxAttempts: failure.maxAttempts });
    }
  }
  return results;
}
