import type { PrismaClient, Prisma } from '@prisma/client';
import type { Actor } from '../core/contracts.ts';
import { withScope, uniqueViolation } from '../graph/scoped-db.ts';

/**
 * Order of read attempts of one connection × resource (review B3). Reads of the same resource may overlap; the outcome of
 * the attempt that BEGAN later is the current state, whichever finishes last. An attempt takes the next number before it
 * reads (none while the resource has no state yet). Its outcome — state, snapshot — is recorded only if no attempt that
 * began later has been recorded and its time is not older than the recorded one, so neither the data nor its times ever
 * go back. Evidence the attempt read (events) is stored either way.
 */
export interface SyncKey { workspaceId: string; clientId: string; connectionId: string; resourceType: string }
export interface Attempt { seq: number | null; startedAt: Date }

export async function beginAttempt(db: PrismaClient, actor: Actor, key: SyncKey, startedAt: Date): Promise<Attempt> {
  const rows = await withScope(db, actor, [key.clientId], tx => tx.$queryRaw<{ attemptSeq: number }[]>`
    UPDATE "SyncState" SET "attemptSeq" = "attemptSeq" + 1
    WHERE "workspaceId" = ${key.workspaceId} AND "clientId" = ${key.clientId} AND "connectionId" = ${key.connectionId} AND "resourceType" = ${key.resourceType}
    RETURNING "attemptSeq"`);
  return { seq: rows[0] ? Number(rows[0].attemptSeq) : null, startedAt };
}

/**
 * Commits one attempt in ONE transaction under the state row's lock: `always` runs in every case, `record` only while
 * this attempt is the latest (it receives the number to store as recordedSeq). Two first outcomes racing to create the
 * state row are decided once more, against the winner's row. `recorded` tells whether this outcome is the current state.
 * A `record` that upserts sets attemptSeq = recordedSeq in its create branch: PostgreSQL checks the proposed INSERT row
 * against SyncState_attempt_order_check before ON CONFLICT turns it into the update.
 */
export async function commitAttempt<T>(db: PrismaClient, actor: Actor, key: SyncKey, attempt: Attempt,
  record: (tx: Prisma.TransactionClient, recordedSeq: number) => Promise<unknown>,
  always: (tx: Prisma.TransactionClient) => Promise<T>): Promise<{ recorded: boolean; value: T }> {
  const run = () => withScope(db, actor, [key.clientId], async tx => {
    const [row] = await tx.$queryRaw<{ recordedSeq: number; lastSyncAt: Date | null }[]>`SELECT "recordedSeq", "lastSyncAt" FROM "SyncState"
      WHERE "workspaceId" = ${key.workspaceId} AND "clientId" = ${key.clientId} AND "connectionId" = ${key.connectionId} AND "resourceType" = ${key.resourceType}
      FOR UPDATE`;
    const recorded = !row || (attempt.seq !== null && attempt.seq > Number(row.recordedSeq)
      && (row.lastSyncAt === null || attempt.startedAt.getTime() >= row.lastSyncAt.getTime()));
    if (recorded) await record(tx, attempt.seq ?? 0);
    return { recorded, value: await always(tx) };
  });
  try { return await run(); }
  catch (error) { if (uniqueViolation(error) === null) throw error; return run(); }
}

export const nothing = async (): Promise<void> => undefined;
