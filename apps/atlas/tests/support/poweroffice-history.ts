import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { PoKey } from './poweroffice-fixtures.ts';

/**
 * TEST-ONLY writers of PowerOffice history rows, executed by the CALLER's connection inside the caller's explicit transaction
 * (normally the confined runtime under inTx, after the workspace fence). They produce the row shapes the schema guards and
 * commit invariants require; the real claim/publication/failure services are S4-B. ageConnection is a superuser-only
 * fixture that moves a connection's stored times into the past (replica mode, all times shifted together so CHECKs and the
 * composite asOf→startedAt key stay consistent) to exercise expiry/30-day retention without real waits.
 */
export interface Claimed { id: string; allocatedSnapshotId: string; sequence: number; lifecycleVersion: number }
const NOW = `date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')`;
// Times travel as SQL text (timestamp without time zone = UTC), never through a local-time JS Date.
const KEY = `"workspaceId" = $1 AND "clientId" = $2 AND "connectionId" = $3`;
const k = (key: PoKey) => [key.workspaceId, key.clientId, key.connectionId];

export async function lockFence(c: pg.Client, workspaceId: string, mode: 'SHARE' | 'UPDATE' = 'UPDATE'): Promise<void> {
  const rows = await c.query(`SELECT version FROM public."ActionAuthorityFence" WHERE "workspaceId" = $1 FOR ${mode === 'SHARE' ? 'SHARE' : 'UPDATE'}`, [workspaceId]);
  if (rows.rowCount !== 1) throw new Error('fence row not visible');
}
/** Fence → State (initialized when missing) → new ACTIVE attempt at the DB clock → State pointer/sequence. */
export async function claimAttempt(c: pg.Client, key: PoKey, actorId: string, lifecycleVersion = 1): Promise<Claimed> {
  await lockFence(c, key.workspaceId);
  await c.query(`INSERT INTO public."PowerOfficeState" ("workspaceId", "clientId", "connectionId") VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, k(key));
  const state = (await c.query(`SELECT "nextSequence" AS n FROM public."PowerOfficeState" WHERE ${KEY} FOR UPDATE`, k(key))).rows[0];
  const id = randomUUID(); const allocated = randomUUID();
  await c.query(`INSERT INTO public."PowerOfficeAttempt" ("workspaceId", "clientId", "connectionId", id, sequence, "claimToken", "allocatedSnapshotId",
      "lifecycleVersion", "actorId", "correlationId", "startedAt", "readDeadlineAt", "deadlineAt")
    SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, t, t + interval '60 seconds', t + interval '80 seconds' FROM (SELECT ${NOW} AS t) n`,
    [...k(key), id, state.n, randomUUID(), allocated, lifecycleVersion, actorId, randomUUID()]);
  await c.query(`UPDATE public."PowerOfficeState" SET "nextSequence" = "nextSequence" + 1, "activeAttemptId" = $4, "lastAttemptId" = $4,
    "lastAttemptState" = 'ACTIVE', "lastAttemptErrorCode" = NULL, "updatedAt" = ${NOW} WHERE ${KEY}`, [...k(key), id]);
  return { id, allocatedSnapshotId: allocated, sequence: state.n, lifecycleVersion };
}
/** Fence → State → attempt locks, then snapshot + SUCCEEDED + pointer + lastCompleted + lastSuccessAt in the same transaction. */
export async function publishAttempt(c: pg.Client, key: PoKey, claim: Claimed, summary: unknown): Promise<void> {
  await lockFence(c, key.workspaceId);
  await c.query(`SELECT 1 FROM public."PowerOfficeState" WHERE ${KEY} FOR UPDATE`, k(key));
  await c.query(`SELECT 1 FROM public."PowerOfficeAttempt" WHERE ${KEY} AND id = $4 FOR UPDATE`, [...k(key), claim.id]);
  const t = (await c.query(`SELECT (${NOW})::text AS t`)).rows[0].t as string;
  await insertSnapshot(c, key, claim, summary, t);
  await c.query(`UPDATE public."PowerOfficeAttempt" SET state = 'SUCCEEDED', "completedAt" = $5 WHERE ${KEY} AND id = $4`, [...k(key), claim.id, t]);
  await c.query(`UPDATE public."PowerOfficeState" SET "activeAttemptId" = NULL, "lastAttemptState" = 'SUCCEEDED', "lastAttemptErrorCode" = NULL,
    "lastCompletedAttemptId" = $4, "lastCompletedState" = 'SUCCEEDED', "lastCompletedErrorCode" = NULL, "snapshotId" = $5, "snapshotVersion" = $6,
    "lastSuccessAt" = $7, "updatedAt" = $7 WHERE ${KEY}`, [...k(key), claim.id, claim.allocatedSnapshotId, claim.lifecycleVersion, t]);
}
/** The snapshot row alone (asOf = startedAt, Oslo business date, 24 h expiry) published at `t`. */
export async function insertSnapshot(c: pg.Client, key: PoKey, claim: Claimed, summary: unknown, t: string, id = claim.allocatedSnapshotId): Promise<void> {
  await c.query(`INSERT INTO public."PowerOfficeSnapshot" ("workspaceId", "clientId", "connectionId", id, "attemptId", "lifecycleVersion", "asOf",
      "businessDate", "publishedAt", "expiresAt", summary)
    SELECT a."workspaceId", a."clientId", a."connectionId", $5, a.id, a."lifecycleVersion", a."startedAt",
           ((a."startedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Oslo')::date, $6::timestamp(3), $6::timestamp(3) + interval '24 hours', $7::jsonb
      FROM public."PowerOfficeAttempt" a WHERE a."workspaceId" = $1 AND a."clientId" = $2 AND a."connectionId" = $3 AND a.id = $4`,
    [...k(key), claim.id, id, t, JSON.stringify(summary)]);
}
/** Fence → State → attempt, then FAILED (or ABANDONED at/after its deadline) with a fixed code and lastCompleted. */
export async function closeAttempt(c: pg.Client, key: PoKey, claim: Claimed, state: 'FAILED' | 'ABANDONED', code: string): Promise<void> {
  await lockFence(c, key.workspaceId);
  await c.query(`SELECT 1 FROM public."PowerOfficeState" WHERE ${KEY} FOR UPDATE`, k(key));
  await c.query(`SELECT 1 FROM public."PowerOfficeAttempt" WHERE ${KEY} AND id = $4 FOR UPDATE`, [...k(key), claim.id]);
  const t = (await c.query(`SELECT (${NOW})::text AS t`)).rows[0].t as string;
  await c.query(`UPDATE public."PowerOfficeAttempt" SET state = $5, "completedAt" = $6, "safeErrorCode" = $7 WHERE ${KEY} AND id = $4`,
    [...k(key), claim.id, state, t, code]);
  await c.query(`UPDATE public."PowerOfficeState" SET "activeAttemptId" = NULL, "lastAttemptState" = $5, "lastAttemptErrorCode" = $6,
    "lastCompletedAttemptId" = $4, "lastCompletedState" = $5, "lastCompletedErrorCode" = $6, "updatedAt" = $7 WHERE ${KEY}`,
    [...k(key), claim.id, state, code, t]);
}
/** Superuser fixture: every stored time of one connection moves `interval` into the past (row/constraint triggers off). */
export async function ageConnection(admin: pg.Client, key: PoKey, interval: string): Promise<void> {
  await admin.query('BEGIN');
  try {
    await admin.query(`SET LOCAL session_replication_role = replica`);
    await admin.query(`UPDATE public."PowerOfficeAttempt" SET "startedAt" = "startedAt" - $4::interval, "readDeadlineAt" = "readDeadlineAt" - $4::interval,
      "deadlineAt" = "deadlineAt" - $4::interval, "completedAt" = "completedAt" - $4::interval WHERE ${KEY}`, [...k(key), interval]);
    await admin.query(`UPDATE public."PowerOfficeSnapshot" SET "asOf" = "asOf" - $4::interval, "publishedAt" = "publishedAt" - $4::interval,
      "expiresAt" = "expiresAt" - $4::interval, "businessDate" = ((("asOf" - $4::interval) AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Oslo')::date WHERE ${KEY}`,
      [...k(key), interval]);
    await admin.query(`UPDATE public."PowerOfficeState" SET "lastSuccessAt" = "lastSuccessAt" - $4::interval, "updatedAt" = "updatedAt" - $4::interval WHERE ${KEY}`,
      [...k(key), interval]);
    await admin.query('COMMIT');
  } catch (error) { await admin.query('ROLLBACK').catch(() => undefined); throw error; }
}
export const SUMMARY = Object.freeze({ totalCount: 3, currencies: [
  { currency: 'EUR', count: 1, openInvoiceCount: 1, overdueInvoiceCount: 0, creditNoteCount: 0, outstandingInvoiceAmount: '10.00', outstandingCreditAmount: '0.00' },
  { currency: 'NOK', count: 2, openInvoiceCount: 1, overdueInvoiceCount: 1, creditNoteCount: 1, outstandingInvoiceAmount: '1250.50', outstandingCreditAmount: '99.99' }] });
export const EMPTY = Object.freeze({ totalCount: 0, currencies: [] });
