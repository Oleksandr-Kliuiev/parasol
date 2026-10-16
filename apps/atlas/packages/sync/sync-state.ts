import type { PrismaClient, Prisma } from '@prisma/client';
import type { Actor } from '../core/contracts.ts';
import { AtlasError } from '../core/contracts.ts';
import { withScope, uniqueViolation } from '../graph/scoped-db.ts';

/**
 * Order of read attempts of one connection × resource (review B3). Reads of the same resource may overlap; the outcome of
 * the attempt that BEGAN later is the current state, whichever finishes last. Before any vendor I/O an attempt takes the
 * next number atomically — the first attempt of a resource creates its state row as PENDING. Its outcome (state,
 * snapshot) is recorded only if no attempt that began later has been recorded and its time is not older than the
 * recorded one, so neither the data nor its times ever go back. Evidence the attempt read (events) is stored either way.
 */
export interface SyncKey { workspaceId: string; clientId: string; connectionId: string; resourceType: string }
export interface Attempt { seq: number; startedAt: Date }

export async function beginAttempt(db: PrismaClient, actor: Actor, key: SyncKey, startedAt: Date): Promise<Attempt> {
  const [row] = await withScope(db, actor, [key.clientId], tx => tx.$queryRaw<{ attemptSeq: number }[]>`
    INSERT INTO "SyncState" ("workspaceId", "clientId", "connectionId", "resourceType", status, "attemptSeq", "recordedSeq")
    VALUES (${key.workspaceId}, ${key.clientId}, ${key.connectionId}, ${key.resourceType}, 'PENDING', 1, 0)
    ON CONFLICT ("workspaceId", "clientId", "connectionId", "resourceType") DO UPDATE SET "attemptSeq" = "SyncState"."attemptSeq" + 1
    RETURNING "attemptSeq"`);
  if (!row) throw new AtlasError('SYNC_ATTEMPT_NOT_NUMBERED', 'PERMANENT');
  return { seq: Number(row.attemptSeq), startedAt };
}

/**
 * Commits one attempt in ONE transaction under the state row's lock: `always` runs in every case, `record` only while
 * this attempt is the latest (it receives the number to store as recordedSeq). An event-identity race with an overlapping
 * read (unique violation) is decided once more, against the winner's rows. `recorded` tells whether this outcome is the
 * current state.
 */
export async function commitAttempt<T>(db: PrismaClient, actor: Actor, key: SyncKey, attempt: Attempt,
  record: (tx: Prisma.TransactionClient, recordedSeq: number) => Promise<unknown>,
  always: (tx: Prisma.TransactionClient) => Promise<T>): Promise<{ recorded: boolean; value: T }> {
  const run = () => withScope(db, actor, [key.clientId], async tx => {
    const [row] = await tx.$queryRaw<{ recordedSeq: number; lastSyncAt: Date | null }[]>`SELECT "recordedSeq", "lastSyncAt" FROM "SyncState"
      WHERE "workspaceId" = ${key.workspaceId} AND "clientId" = ${key.clientId} AND "connectionId" = ${key.connectionId} AND "resourceType" = ${key.resourceType}
      FOR UPDATE`;
    if (!row) throw new AtlasError('SYNC_STATE_MISSING', 'PERMANENT'); // created by beginAttempt; the runtime role never deletes
    const recorded = attempt.seq > Number(row.recordedSeq) && (row.lastSyncAt === null || attempt.startedAt.getTime() >= row.lastSyncAt.getTime());
    if (recorded) await record(tx, attempt.seq);
    return { recorded, value: await always(tx) };
  });
  try { return await run(); }
  catch (error) { if (uniqueViolation(error) === null) throw error; return run(); }
}

export const nothing = async (): Promise<void> => undefined;
