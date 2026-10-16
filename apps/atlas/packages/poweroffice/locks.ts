import type { Prisma } from '@prisma/client';
import { UUID_PATTERN } from './contracts.ts';

/**
 * Row locks of the approved Stage 4 matrix (docs/stage4/03_DATA_AND_CONCURRENCY.md "Protected reads and lock order"), all
 * taken AFTER the workspace fence by the runtime role: State FOR SHARE (status/summary reads) or FOR UPDATE (sync, page,
 * publication, failure, recovery), the owned Attempt FOR UPDATE; Snapshots are only read plainly (no UPDATE privilege, so
 * no locking privilege). The grants of prisma/roles.sql support exactly these modes. Only sync admission may initialize a
 * missing State (INSERT ... ON CONFLICT DO NOTHING under the fence, then lock it); reads/recover/cleanup never do.
 */
export interface PowerOfficeKey { workspaceId: string; clientId: string; connectionId: string }
export interface StateRow {
  nextSequence: number; activeAttemptId: string | null; snapshotId: string | null; snapshotVersion: number | null;
  lastAttemptId: string | null; lastAttemptState: string | null; lastAttemptErrorCode: string | null;
  lastCompletedAttemptId: string | null; lastCompletedState: string | null; lastCompletedErrorCode: string | null;
  lastSuccessAt: Date | null; updatedAt: Date;
}
const STATE_COLUMNS = `"nextSequence", "activeAttemptId"::text AS "activeAttemptId", "snapshotId"::text AS "snapshotId", "snapshotVersion",
  "lastAttemptId"::text AS "lastAttemptId", "lastAttemptState", "lastAttemptErrorCode", "lastCompletedAttemptId"::text AS "lastCompletedAttemptId",
  "lastCompletedState", "lastCompletedErrorCode", "lastSuccessAt", "updatedAt"`;
const WHERE_KEY = `WHERE "workspaceId" = $1 AND "clientId" = $2 AND "connectionId" = $3`;

/** The connection's State locked FOR SHARE (reads) or FOR UPDATE (writes); null when it does not exist (never created here). */
export async function lockState(tx: Prisma.TransactionClient, key: PowerOfficeKey, mode: 'SHARE' | 'UPDATE'): Promise<StateRow | null> {
  const lock = mode === 'SHARE' ? 'FOR SHARE' : 'FOR UPDATE';
  const rows = await tx.$queryRawUnsafe<StateRow[]>(`SELECT ${STATE_COLUMNS} FROM public."PowerOfficeState" ${WHERE_KEY} ${lock}`,
    key.workspaceId, key.clientId, key.connectionId);
  return rows[0] ?? null;
}
/** Sync admission only: the empty State of this connection, created at most once (existing rows untouched). */
export async function initializeState(tx: Prisma.TransactionClient, key: PowerOfficeKey): Promise<void> {
  await tx.$executeRaw`INSERT INTO public."PowerOfficeState" ("workspaceId", "clientId", "connectionId") VALUES (${key.workspaceId}, ${key.clientId}, ${key.connectionId})
    ON CONFLICT ("workspaceId", "clientId", "connectionId") DO NOTHING`;
}
/** The owned attempt locked FOR UPDATE (after the State lock); false when it is not visible here. */
export async function lockAttempt(tx: Prisma.TransactionClient, key: PowerOfficeKey, attemptId: string): Promise<boolean> {
  if (!UUID_PATTERN.test(attemptId)) return false;
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM public."PowerOfficeAttempt"
    WHERE "workspaceId" = ${key.workspaceId} AND "clientId" = ${key.clientId} AND "connectionId" = ${key.connectionId} AND id = ${attemptId}::uuid FOR UPDATE`;
  return rows.length === 1;
}
