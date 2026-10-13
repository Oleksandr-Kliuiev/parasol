import { Prisma } from '@prisma/client';
import type { Scope } from '../core/contracts.ts';
import type { RootState, SignInCapability } from './coverage.ts';
import { floorMs, hourFloorMs, keyOfDate, msText, sqlDtoGuard, sqlDtoKey } from './time.ts';
import type { DbClock, TimeKey } from './time.ts';
import { transitionAt } from './cursor.ts';
import type { Transition } from './cursor.ts';

/**
 * Snapshot SQL of the sign-in reads (brief RC3). Only published memberships are readable: an item is an evidence version
 * that is a member of one of the contributing CURRENT published attempts (coverage.ts), unexpired at the snapshot clock
 * (query-time expiry, whether or not cleanup ever ran), with its seven-digit DTO time key in [from, to). Staging rows,
 * failed/running attempts and superseded attempts never select an item. Ordering and keyset use the SAME key expression
 * over the allowlisted DTO.createdDateTime (never TIMESTAMP(3) alone): occurredAt DESC, sourceId ASC, contentHash ASC,
 * with C collation so the order is byte (code point) order for every supported source ID. The indexed occurredAt
 * prefilter is widened to whole milliseconds before the exact key predicate. Malformed stored times are excluded by a
 * strict guard instead of raising a raw DTO error.
 */
export interface SelectionSpec {
  scope: Scope; connectionId: string; from: TimeKey; to: TimeKey; clock: DbClock;
  published: readonly { windowId: string; attemptId: string }[];
  /** Correlation routes: route (a) deviceId, route (b) assigned-person userId; absent → every eligible sign-in (sign-in list). */
  routes?: { deviceRef: string | null; userRef: string | null };
}
export interface EvidenceRow {
  id: string; sourceId: string; contentHash: string; userId: string | null; deviceId: string | null; dto: unknown; expiresAt: Date; k: TimeKey;
}
export interface Position { k: TimeKey; sourceId: string; contentHash: string }

const KEY = sqlDtoKey('e'); const GUARD = sqlDtoGuard('e');
const now = (clock: DbClock) => Prisma.sql`${msText(clock.now.getTime())}::timestamp(3)`;

/** Empty when nothing can be selected (no contributing attempt, or no resolved route). */
function selection(spec: SelectionSpec): Prisma.Sql | null {
  if (spec.published.length === 0) return null;
  const routes = spec.routes;
  const refs: Prisma.Sql[] = [];
  if (routes?.deviceRef) refs.push(Prisma.sql`e."deviceId" = ${routes.deviceRef}`);
  if (routes?.userRef) refs.push(Prisma.sql`e."userId" = ${routes.userRef}`);
  if (routes && refs.length === 0) return null;
  const { workspaceId, clientId } = spec.scope;
  const attempts = Prisma.join(spec.published.map(p => Prisma.sql`(${p.windowId}, ${p.attemptId})`));
  return Prisma.sql`SELECT e.id, e."sourceId", e."contentHash", e."userId", e."deviceId", e.dto, e."expiresAt", ${KEY} AS k
    FROM "M365SignInEvidence" e
    WHERE e."workspaceId" = ${workspaceId} AND e."clientId" = ${clientId} AND e."connectionId" = ${spec.connectionId}
      AND e."occurredAt" >= ${msText(floorMs(spec.from))}::timestamp(3) AND e."occurredAt" <= ${msText(floorMs(spec.to))}::timestamp(3)
      AND e."expiresAt" > ${now(spec.clock)} AND ${GUARD} AND ${KEY} >= ${spec.from} AND ${KEY} < ${spec.to}
      ${routes ? Prisma.sql`AND (${Prisma.join(refs, ' OR ')})` : Prisma.empty}
      AND EXISTS (SELECT 1 FROM "M365WindowEvidence" m WHERE m."workspaceId" = e."workspaceId" AND m."clientId" = e."clientId"
        AND m."connectionId" = e."connectionId" AND m."evidenceId" = e.id AND (m."windowId", m."attemptId") IN (${attempts}))`;
}

/** Deduplicated matching count of the whole snapshot selection and its earliest evidence expiry. */
export async function selectionStats(tx: Prisma.TransactionClient, spec: SelectionSpec): Promise<{ total: number; earliestExpiryMs: number | null }> {
  const sql = selection(spec);
  if (!sql) return { total: 0, earliestExpiryMs: null };
  const [row] = await tx.$queryRaw<{ total: bigint; earliest: Date | null }[]>`SELECT count(*) AS total, min(s."expiresAt") AS earliest FROM (${sql}) s`;
  return { total: Number(row!.total), earliestExpiryMs: row!.earliest ? row!.earliest.getTime() : null };
}
/** The tuple of an evidence ID INSIDE the reloaded eligible selection (never an unscoped row lookup), or null. */
export async function positionOf(tx: Prisma.TransactionClient, spec: SelectionSpec, evidenceId: string): Promise<Position | null> {
  const sql = selection(spec);
  if (!sql) return null;
  const [row] = await tx.$queryRaw<Position[]>`SELECT s.k, s."sourceId", s."contentHash" FROM (${sql}) s WHERE s.id = ${evidenceId}`;
  return row ?? null;
}
/** limit + 1 rows after the position, in the response order. */
export async function selectionPage(tx: Prisma.TransactionClient, spec: SelectionSpec, after: Position | null, limit: number): Promise<EvidenceRow[]> {
  const sql = selection(spec);
  if (!sql) return [];
  const keyset = after ? Prisma.sql`WHERE (s.k < ${after.k} OR (s.k = ${after.k} AND s."sourceId" COLLATE "C" > ${after.sourceId} COLLATE "C")
    OR (s.k = ${after.k} AND s."sourceId" COLLATE "C" = ${after.sourceId} COLLATE "C" AND s."contentHash" COLLATE "C" > ${after.contentHash} COLLATE "C"))` : Prisma.empty;
  return tx.$queryRaw<EvidenceRow[]>`SELECT s.* FROM (${sql}) s ${keyset}
    ORDER BY s.k DESC, s."sourceId" COLLATE "C" ASC, s."contentHash" COLLATE "C" ASC LIMIT ${limit + 1}`;
}

export interface ConflictContributor {
  sourceId: string; id: string;
  /**
   * Effective validity as a contributor: min(evidence expiresAt, the latest expiresAt among its still-valid published
   * memberships). It alone decides how long the contribution lasts; which of several memberships expires first does not.
   */
  validUntil: Date;
}
/**
 * Every unexpired version that is a member of a still-valid PUBLISHED attempt (publishedAt set, COMPLETE or SUPERSEDED,
 * unexpired), for the source IDs of the whole selection that have at least two such versions — wherever their time lies,
 * also outside the query interval. A source ID listed here is CONFLICTED. Staged-only and never-published versions cannot
 * appear. A contributor stops contributing when its evidence expires OR its last valid published membership expires,
 * whichever is first (several memberships: the latest one counts); that instant feeds the cursor expiry and fingerprint.
 */
export async function conflictContributors(tx: Prisma.TransactionClient, spec: SelectionSpec): Promise<ConflictContributor[]> {
  const sql = selection(spec);
  if (!sql) return [];
  const { workspaceId, clientId } = spec.scope;
  // The selection is materialized once; only source IDs with ANOTHER unexpired version (unique-index lookup) are examined
  // further, so the cost stays proportional to the selection instead of selection × versions.
  const rows = await tx.$queryRaw<{ sourceId: string; id: string; validUntil: Date }[]>`WITH sel AS MATERIALIZED (${sql}),
    candidates AS MATERIALIZED (SELECT DISTINCT s."sourceId" FROM sel s WHERE EXISTS (SELECT 1 FROM "M365SignInEvidence" o
      WHERE o."workspaceId" = ${workspaceId} AND o."clientId" = ${clientId} AND o."connectionId" = ${spec.connectionId} AND o."sourceId" = s."sourceId"
        AND o.id <> s.id AND o."expiresAt" > ${now(spec.clock)})),
    versions AS MATERIALIZED (SELECT v."sourceId", v.id, LEAST(v."expiresAt", p."membershipUntil") AS "validUntil"
      FROM candidates c JOIN "M365SignInEvidence" v
        ON v."workspaceId" = ${workspaceId} AND v."clientId" = ${clientId} AND v."connectionId" = ${spec.connectionId} AND v."sourceId" = c."sourceId"
      CROSS JOIN LATERAL (SELECT max(a."expiresAt") AS "membershipUntil"
          FROM "M365WindowEvidence" m JOIN "M365WindowAttempt" a ON a."workspaceId" = m."workspaceId" AND a."clientId" = m."clientId"
            AND a."connectionId" = m."connectionId" AND a."windowId" = m."windowId" AND a.id = m."attemptId"
          WHERE m."workspaceId" = v."workspaceId" AND m."clientId" = v."clientId" AND m."connectionId" = v."connectionId" AND m."evidenceId" = v.id
            AND a."publishedAt" IS NOT NULL AND a.state IN ('COMPLETE', 'SUPERSEDED') AND a."expiresAt" > ${now(spec.clock)}) p
      WHERE v."expiresAt" > ${now(spec.clock)} AND p."membershipUntil" IS NOT NULL)
    SELECT "sourceId", id, "validUntil" FROM versions
    WHERE "sourceId" IN (SELECT "sourceId" FROM versions GROUP BY "sourceId" HAVING count(*) > 1)
    ORDER BY "sourceId" COLLATE "C", id COLLATE "C"`;
  return rows.map(r => ({ sourceId: r.sourceId, id: r.id, validUntil: r.validUntil }));
}
/** Fingerprint part and cursor transitions of the contributors (each stops contributing AT its validUntil). */
export const contributorFingerprint = (contributors: readonly ConflictContributor[]) =>
  contributors.map(c => [c.sourceId, c.id, c.validUntil.getTime()]);
export const contributorTransitions = (contributors: readonly ConflictContributor[]): Transition[] => contributors.map(c => transitionAt(c.validUntil));

/** Root windows intersecting [from, to) with their current published attempt and the state of the newest started attempt. */
export async function loadRoots(tx: Prisma.TransactionClient, scope: Scope, connectionId: string, from: TimeKey, to: TimeKey): Promise<RootState[]> {
  const rows = await tx.$queryRaw<{ windowId: string; rootFrom: Date; started: number; published: number; recorded: number; status: string; code: string | null;
    latestState: string | null; attemptId: string | null; attemptState: string | null; coveredFrom: Date | null; coveredTo: Date | null; publishedAt: Date | null;
    expiresAt: Date | null }[]>`SELECT w.id AS "windowId", w."rootFrom", w."latestStartedSeq" AS started, w."latestPublishedSeq" AS published,
      w."latestRecordedSeq" AS recorded, w.status, w."safeErrorCode" AS code, l.state AS "latestState", a.id AS "attemptId", a.state AS "attemptState",
      a."coveredFrom", a."coveredTo", a."publishedAt", a."expiresAt"
    FROM "M365SignInWindow" w
    LEFT JOIN "M365WindowAttempt" a ON a."workspaceId" = w."workspaceId" AND a."clientId" = w."clientId" AND a."connectionId" = w."connectionId"
      AND a."windowId" = w.id AND a.id = w."publishedAttemptId"
    LEFT JOIN "M365WindowAttempt" l ON l."workspaceId" = w."workspaceId" AND l."clientId" = w."clientId" AND l."connectionId" = w."connectionId"
      AND l."windowId" = w.id AND l."attemptSeq" = w."latestStartedSeq"
    WHERE w."workspaceId" = ${scope.workspaceId} AND w."clientId" = ${scope.clientId} AND w."connectionId" = ${connectionId}
      AND w."rootFrom" >= ${msText(hourFloorMs(from))}::timestamp(3) AND w."rootFrom" <= ${msText(floorMs(to))}::timestamp(3)
    ORDER BY w."rootFrom"`;
  return rows.filter(r => keyOfDate(r.rootFrom) < to).map(r => ({ windowId: r.windowId, rootFrom: r.rootFrom, started: Number(r.started),
    published: Number(r.published), recorded: Number(r.recorded), status: r.status, safeErrorCode: r.code, latestState: r.latestState,
    attempt: r.attemptId ? { id: r.attemptId, state: r.attemptState!, coveredFrom: r.coveredFrom!, coveredTo: r.coveredTo!, publishedAt: r.publishedAt,
      expiresAt: r.expiresAt! } : null }));
}
/** The separately recorded sign-in capability of the connection (activation), or null when never recorded. */
export async function loadCapability(tx: Prisma.TransactionClient, scope: Scope, connectionId: string): Promise<SignInCapability | null> {
  const row = await tx.m365ResourceState.findUnique({ where: { workspaceId_clientId_connectionId_resourceType: { workspaceId: scope.workspaceId,
    clientId: scope.clientId, connectionId, resourceType: 'm365_signin' } }, select: { status: true, safeErrorCode: true } });
  return row ? { status: row.status, safeErrorCode: row.safeErrorCode } : null;
}
