import type { Prisma } from '@prisma/client';
import { isDbConflict } from '../graph/fence-errors.ts';
import { UUID_PATTERN, powerOfficeError } from './contracts.ts';
import type { AttemptState, InvoiceSummary, PowerOfficeErrorCode } from './contracts.ts';
import { powerOfficeAuditMetadata } from './audit.ts';
import type { PowerOfficeAuditInput } from './audit.ts';
import type { PowerOfficeKey } from './locks.ts';

/**
 * S4-B row statements on the three PowerOffice tables, always inside a caller's transaction that already holds the
 * workspace fence and (where written) the State/Attempt row locks of the approved order (03 "Protected reads and lock
 * order"). Times never come from the process: decisions and written instants use ONE DB clock read taken after all locks
 * (clock_timestamp() in UTC, truncated to the column's milliseconds, so it is never later than what the guards read).
 * Instants travel as SQL text and ISO strings, never through a local-time Date. The schema guards and deferred commit
 * invariants (migration 202610091210) remain the backstop of every rule here.
 */
type Tx = Prisma.TransactionClient;
const KEY = `"workspaceId" = $1 AND "clientId" = $2 AND "connectionId" = $3`;
const k = (key: PowerOfficeKey) => [key.workspaceId, key.clientId, key.connectionId] as const;
const ISO = (column: string) => `to_char(${column}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export interface AttemptRow {
  id: string; sequence: number; claimToken: string; allocatedSnapshotId: string; lifecycleVersion: number; actorId: string;
  state: AttemptState; safeErrorCode: string | null; asOf: string;
}
/** The attempt row locked FOR UPDATE (after the State lock); null when not visible. */
export async function lockAttemptRow(tx: Tx, key: PowerOfficeKey, attemptId: string): Promise<AttemptRow | null> {
  if (!UUID_PATTERN.test(attemptId)) return null;
  const rows = await tx.$queryRawUnsafe<AttemptRow[]>(`SELECT id::text AS id, sequence, "claimToken"::text AS "claimToken",
      "allocatedSnapshotId"::text AS "allocatedSnapshotId", "lifecycleVersion", "actorId", state, "safeErrorCode", ${ISO('"startedAt"')} AS "asOf"
    FROM public."PowerOfficeAttempt" WHERE ${KEY} AND id = $4::uuid FOR UPDATE`, ...k(key), attemptId);
  return rows[0] ?? null;
}

/** The DB clock read after all locks, against one attempt's stored deadlines; `at` is the truncated instant to write. */
export interface AttemptClock { readOpen: boolean; open: boolean; at: string }
export async function attemptClock(tx: Tx, key: PowerOfficeKey, attemptId: string): Promise<AttemptClock> {
  const rows = await tx.$queryRawUnsafe<AttemptClock[]>(`SELECT n.c < a."readDeadlineAt" AS "readOpen", n.c < a."deadlineAt" AS open,
      date_trunc('milliseconds', n.c)::text AS at
    FROM public."PowerOfficeAttempt" a, (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS c) n
    WHERE a."workspaceId" = $1 AND a."clientId" = $2 AND a."connectionId" = $3 AND a.id = $4::uuid`,
    ...k(key), attemptId);
  if (rows.length !== 1) throw powerOfficeError('POWEROFFICE_CLAIM_STALE');
  return rows[0]!;
}

/** Retained attempts of the connection (the 1000 cap counts every row, terminal or ACTIVE). */
export async function retainedAttempts(tx: Tx, key: PowerOfficeKey): Promise<number> {
  const rows = await tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM public."PowerOfficeAttempt" WHERE ${KEY}`, ...k(key));
  return rows[0]?.n ?? 0;
}

export interface NewClaim { attemptId: string; sequence: number; claimToken: string; allocatedSnapshotId: string; lifecycleVersion: number; actorId: string; correlationId: string }
/** Inserts the ACTIVE attempt at the DB clock (startedAt; +60 s read, +80 s total) and moves the State to it. */
export async function insertClaim(tx: Tx, key: PowerOfficeKey, claim: NewClaim): Promise<{ asOf: string }> {
  const rows = await tx.$queryRawUnsafe<{ asOf: string; at: string }[]>(`INSERT INTO public."PowerOfficeAttempt" ("workspaceId", "clientId", "connectionId", id,
      sequence, "claimToken", "allocatedSnapshotId", "lifecycleVersion", "actorId", "correlationId", "startedAt", "readDeadlineAt", "deadlineAt")
    SELECT $1, $2, $3, $4::uuid, $5, $6::uuid, $7::uuid, $8, $9, $10::uuid, t, t + interval '60 seconds', t + interval '80 seconds'
      FROM (SELECT date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS t) n
    RETURNING ${ISO('"startedAt"')} AS "asOf", "startedAt"::text AS at`,
    ...k(key), claim.attemptId, claim.sequence, claim.claimToken, claim.allocatedSnapshotId, claim.lifecycleVersion, claim.actorId, claim.correlationId);
  const updated = await tx.$executeRawUnsafe(`UPDATE public."PowerOfficeState" SET "nextSequence" = "nextSequence" + 1, "activeAttemptId" = $4::uuid,
      "lastAttemptId" = $4::uuid, "lastAttemptState" = 'ACTIVE', "lastAttemptErrorCode" = NULL, "updatedAt" = $5::timestamp(3)
    WHERE ${KEY} AND "nextSequence" = $6 AND "activeAttemptId" IS NULL`, ...k(key), claim.attemptId, rows[0]!.at, claim.sequence);
  if (rows.length !== 1 || updated !== 1) throw powerOfficeError('POWEROFFICE_DB_CONFLICT');
  return { asOf: rows[0]!.asOf };
}

/** Closes the ACTIVE attempt (FAILED/ABANDONED with a fixed code, or SUCCEEDED) and its State pointer/outcome tuples at `at`. */
export async function closeClaim(tx: Tx, key: PowerOfficeKey, attemptId: string, state: Exclude<AttemptState, 'ACTIVE'>, code: PowerOfficeErrorCode | null,
  at: string, snapshot: { id: string; lifecycleVersion: number } | null = null): Promise<void> {
  const attempt = await tx.$executeRawUnsafe(`UPDATE public."PowerOfficeAttempt" SET state = $5, "completedAt" = $6::timestamp(3), "safeErrorCode" = $7
    WHERE ${KEY} AND id = $4::uuid AND state = 'ACTIVE'`, ...k(key), attemptId, state, at, code);
  const published = snapshot === null ? '' : `, "snapshotId" = $8::uuid, "snapshotVersion" = $9, "lastSuccessAt" = $6::timestamp(3)`;
  const pointer = await tx.$executeRawUnsafe(`UPDATE public."PowerOfficeState" SET "activeAttemptId" = NULL, "lastAttemptState" = $5,
      "lastAttemptErrorCode" = $7, "lastCompletedAttemptId" = $4::uuid, "lastCompletedState" = $5, "lastCompletedErrorCode" = $7,
      "updatedAt" = $6::timestamp(3)${published}
    WHERE ${KEY} AND "activeAttemptId" = $4::uuid AND "lastAttemptId" = $4::uuid`,
    ...k(key), attemptId, state, at, code, ...(snapshot === null ? [] : [snapshot.id, snapshot.lifecycleVersion]));
  if (attempt !== 1 || pointer !== 1) throw powerOfficeError('POWEROFFICE_DB_CONFLICT');
}

/** The immutable snapshot of the claim's allocated ID: asOf = startedAt, the fact's business date, publishedAt = `at`, +24 h. */
export async function insertSnapshot(tx: Tx, key: PowerOfficeKey, attemptId: string, businessDate: string, summary: InvoiceSummary, at: string): Promise<void> {
  const inserted = await tx.$executeRawUnsafe(`INSERT INTO public."PowerOfficeSnapshot" ("workspaceId", "clientId", "connectionId", id, "attemptId",
      "lifecycleVersion", "asOf", "businessDate", "publishedAt", "expiresAt", summary)
    SELECT a."workspaceId", a."clientId", a."connectionId", a."allocatedSnapshotId", a.id, a."lifecycleVersion", a."startedAt", $5::date,
           $6::timestamp(3), $6::timestamp(3) + interval '24 hours', $7::jsonb
      FROM public."PowerOfficeAttempt" a WHERE a."workspaceId" = $1 AND a."clientId" = $2 AND a."connectionId" = $3 AND a.id = $4::uuid`,
    ...k(key), attemptId, businessDate, at, JSON.stringify(summary));
  if (inserted !== 1) throw powerOfficeError('POWEROFFICE_DB_CONFLICT');
}

/** The stored fact of a published attempt (plain protected read), or null when its snapshot is not present. */
export interface StoredFact { attemptId: string; lifecycleVersion: number; asOf: string; businessDate: string; summary: unknown }
export async function readSnapshotFact(tx: Tx, key: PowerOfficeKey, snapshotId: string): Promise<StoredFact | null> {
  const rows = await tx.$queryRawUnsafe<StoredFact[]>(`SELECT "attemptId"::text AS "attemptId", "lifecycleVersion", ${ISO('"asOf"')} AS "asOf",
      to_char("businessDate", 'YYYY-MM-DD') AS "businessDate", summary
    FROM public."PowerOfficeSnapshot" WHERE ${KEY} AND id = $4::uuid`, ...k(key), snapshotId);
  return rows[0] ?? null;
}

/**
 * One client audit row of a PowerOffice event: the six-key metadata factory only (audit.ts), never counts, amounts, dates,
 * company keys or source IDs. A positively known rollback stays raw (so the authority can mark it); any other audit failure
 * is the fixed POWEROFFICE_AUDIT_FAILED and rolls the whole transaction back.
 */
export async function insertAudit(tx: Tx, key: PowerOfficeKey, row: { id: string; actorId: string; correlationId: string; eventType: string },
  metadata: PowerOfficeAuditInput): Promise<void> {
  const safe = powerOfficeAuditMetadata(metadata);
  try {
    await tx.auditEvent.create({ data: { workspaceId: key.workspaceId, clientId: key.clientId, id: row.id, actorId: row.actorId,
      eventType: row.eventType, correlationId: row.correlationId, metadata: safe }, select: { id: true } });
  } catch (error) {
    if (isDbConflict(error)) throw error;
    throw powerOfficeError('POWEROFFICE_AUDIT_FAILED');
  }
}
