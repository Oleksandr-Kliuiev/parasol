import type { PgTestDatabase } from './pg-harness.ts';

/**
 * Owner-side reads of sign-in window state for the S2-B tests. TIMESTAMP(3) holds UTC; every time is read as epoch
 * milliseconds, because pg parses timestamp without time zone in the local zone.
 */
const ms = (column: string, alias = column) => `(extract(epoch FROM "${column}") * 1000)::float8 AS "${alias}"`;
const date = (v: number | null) => (v === null ? null : new Date(Number(v)));

export async function windowOf(pgdb: PgTestDatabase, windowId: string) {
  const w = (await pgdb.owner.query(`SELECT status, "safeErrorCode" AS code, "publishedAttemptId" AS pointer, "latestStartedSeq" AS started,
    "latestRecordedSeq" AS recorded, "latestPublishedSeq" AS published, ${ms('lastSuccessAt')}, ${ms('lastAttemptAt')} FROM "M365SignInWindow" WHERE id = $1`, [windowId])).rows[0];
  return { ...w, lastSuccessAt: date(w.lastSuccessAt), lastAttemptAt: date(w.lastAttemptAt) };
}
export async function attemptOf(pgdb: PgTestDatabase, attemptId: string) {
  const a = (await pgdb.owner.query(`SELECT id, state, "attemptSeq", "safeErrorCode" AS code, "evidenceCount", "leafCount", "stagedRows", ${ms('coveredFrom')},
    ${ms('coveredTo')}, ${ms('publishedAt')}, ${ms('expiresAt')} FROM "M365WindowAttempt" WHERE id = $1`, [attemptId])).rows[0];
  return { ...a, coveredFrom: date(a.coveredFrom)!, coveredTo: date(a.coveredTo)!, publishedAt: date(a.publishedAt)!, expiresAt: date(a.expiresAt)! };
}
export async function jobOf(pgdb: PgTestDatabase, requestId: string, windowId: string) {
  const j = (await pgdb.owner.query(`SELECT state, "attemptsUsed", ${ms('retryAt')}, "safeErrorCode" AS code FROM "M365SyncRootJob" WHERE "requestId" = $1 AND "windowId" = $2`,
    [requestId, windowId])).rows[0];
  return { state: j.state, attemptsUsed: j.attemptsUsed, retryAt: date(j.retryAt), code: j.code };
}
export async function requestOf(pgdb: PgTestDatabase, requestId: string) {
  return (await pgdb.owner.query(`SELECT "totalLeaves", "totalStagedRows", state FROM "M365SyncRequest" WHERE id = $1`, [requestId])).rows[0];
}
export async function evidenceOf(pgdb: PgTestDatabase, connectionId: string) {
  return (await pgdb.owner.query(`SELECT id, "sourceId", "contentHash", dto FROM "M365SignInEvidence" WHERE "connectionId" = $1 ORDER BY "sourceId", "contentHash"`, [connectionId])).rows;
}
/** Published memberships of a window: exactly the evidence IDs of its pointer attempt. */
export async function publishedMembers(pgdb: PgTestDatabase, windowId: string): Promise<string[]> {
  return (await pgdb.owner.query(`SELECT m."evidenceId" FROM "M365WindowEvidence" m JOIN "M365SignInWindow" w ON w.id = m."windowId" AND w."publishedAttemptId" = m."attemptId"
    WHERE m."windowId" = $1 ORDER BY 1`, [windowId])).rows.map(r => r.evidenceId);
}
