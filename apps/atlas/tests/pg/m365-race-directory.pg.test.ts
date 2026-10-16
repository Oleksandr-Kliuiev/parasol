import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { seedGraph } from '../sql-invariants.ts';
import type { SqlRunner } from '../sql-invariants.ts';
import { guid, seedM365 } from '../m365-sql-invariants.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { beginScoped, inFlight, openSession, rollbackQuietly, waitUntilBlocked } from '../support/pg-race.ts';
import type { Session } from '../support/pg-race.ts';

// Review S2-A-rc1 F2, directory half, on PostgreSQL 17 with two real runtime sessions (production grants). Every ordering
// is forced by observing the loser WAITING on a lock (pg_locks), never by timing. A published generation can never gain a
// late object or lose its mirrors; publication and disable/cleanup/newer claims serialize on the Connection → state →
// generation order, and a loser waits and revalidates, or fails.
const pgdb = await createTestDatabase();
const owner = pgdb.owner;
const asRunner = (c: pg.Client): SqlRunner => ({ exec: sql => c.query(sql).then(() => undefined), query: async (sql, params) => (await c.query(sql, params)).rows as never });
await seedGraph(asRunner(owner));
await seedM365(asRunner(owner));
const sessions: Session[] = [];
const open = async (url = pgdb.runtimeUrl) => { const s = await openSession(url); sessions.push(s); return s; };
const [A, B, C] = [await open(), await open(), await open()];
const runner = await open(pgdb.runnerUrl);
after(async () => { for (const s of sessions) await s.client.end().catch(() => undefined); await pgdb.drop(); });

const USER = guid('a');
const userDto = JSON.stringify({ id: USER, displayName: 'Synthetic', userPrincipalName: null, userType: 'MEMBER', accountEnabled: true });
const version = async () => Number((await owner.query(`SELECT "lifecycleVersion" AS v FROM "Connection" WHERE id = 'm1'`)).rows[0].v);
let seq = 0;
/** A fresh STAGING generation as the newest started attempt (owner, committed). */
async function stage(): Promise<{ gen: string; seq: number }> {
  seq += 1; const gen = `race-gen-${seq}`;
  await owner.query(`INSERT INTO "M365ResourceState" ("workspaceId","clientId","connectionId","resourceType","latestStartedSeq") VALUES ('w','c1','m1','m365_user',$1)
    ON CONFLICT ("workspaceId","clientId","connectionId","resourceType") DO UPDATE SET "latestStartedSeq" = EXCLUDED."latestStartedSeq",
    "attemptsUsed" = "M365ResourceState"."attemptsUsed" + (EXCLUDED."latestStartedSeq" - "M365ResourceState"."latestStartedSeq")`, [seq]);
  await owner.query(`INSERT INTO "M365DirectoryGeneration" ("workspaceId","clientId","connectionId","resourceType","id","attemptSeq","lifecycleVersion","claimToken",
    "leaseExpiresAt","expiresAt") VALUES ('w','c1','m1','m365_user',$1,$2,$3,gen_random_uuid(),now() + interval '10 minutes',now() + interval '23 hours')`,
    [gen, seq, await version()]);
  return { gen, seq };
}
const insertObject = (s: Session, gen: string) => s.client.query(`INSERT INTO "M365DirectoryObject" VALUES ('w','c1','m1','m365_user',$1,$2,NULL,NULL,$3)`, [gen, USER, userDto]);
/** Publication in the approved lock order: Connection (SHARE) → state → generation; then the generation and the pointer. */
async function lockForPublication(s: Session, gen: string): Promise<void> {
  await s.client.query(`SELECT id FROM "Connection" WHERE id = 'm1' FOR SHARE`);
  await s.client.query(`SELECT 1 FROM "M365ResourceState" WHERE "connectionId" = 'm1' AND "resourceType" = 'm365_user' FOR UPDATE`);
  await s.client.query(`SELECT 1 FROM "M365DirectoryGeneration" WHERE id = $1 FOR UPDATE`, [gen]);
}
async function publish(s: Session, gen: string, at: number, rowCount = 0): Promise<void> {
  await s.client.query(`UPDATE "M365DirectoryGeneration" SET state = 'PUBLISHED', "completedAt" = now(), "claimToken" = NULL, "leaseExpiresAt" = NULL,
    "rowCount" = $2, "expiresAt" = now() + interval '23 hours' WHERE id = $1`, [gen, rowCount]);
  await s.client.query(`UPDATE "M365ResourceState" SET "activeGenerationId" = $1, "latestPublishedSeq" = $2, "latestRecordedSeq" = $2, status = 'OK', "attemptsUsed" = 0,
    "lastAttemptAt" = now(), "lastSuccessAt" = now() WHERE "connectionId" = 'm1' AND "resourceType" = 'm365_user'`, [gen, at]);
}
const shape = async (gen: string) => (await owner.query(`SELECT g.state, g."rowCount",
  (SELECT count(*)::int FROM "M365DirectoryObject" o WHERE o."generationId" = g.id) AS rows,
  (SELECT count(*)::int FROM "M365DirectoryObject" o WHERE o."generationId" = g.id AND o."externalEntityId" IS NULL) AS unmirrored
  FROM "M365DirectoryGeneration" g WHERE g.id = $1`, [gen])).rows[0];
const reactivate = () => owner.query(`UPDATE "Connection" SET status = 'ACTIVE', "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = 'm1'`);

test('object insertion before publication: publication waits for the writer, then sees its object and refuses the stale count', async () => {
  const { gen, seq: at } = await stage();
  await beginScoped(A); await insertObject(A, gen); // A holds the generation in SHARE mode
  await beginScoped(B);
  const pub = inFlight(async () => { await lockForPublication(B, gen); await publish(B, gen, at, 0); });
  await waitUntilBlocked(owner, B.pid);
  await A.client.query('COMMIT');
  await assert.rejects(pub.result(), /rowCount must equal the staged objects/);
  await rollbackQuietly(B);
  assert.deepEqual(await shape(gen), { state: 'STAGING', rowCount: 0, rows: 1, unmirrored: 1 }, 'nothing was published around the late object');
});

test('publication before object insertion: the writer waits, then finds the generation published and is refused', async () => {
  const { gen, seq: at } = await stage();
  await beginScoped(B); await lockForPublication(B, gen); await publish(B, gen, at, 0);
  await beginScoped(A);
  const ins = inFlight(() => insertObject(A, gen));
  await waitUntilBlocked(owner, A.pid);
  await B.client.query('COMMIT');
  await assert.rejects(ins.result(), /published directory membership is immutable/);
  await rollbackQuietly(A);
  assert.deepEqual(await shape(gen), { state: 'PUBLISHED', rowCount: 0, rows: 0, unmirrored: 0 }, 'the published snapshot never gains a late object');
});

test('disable first: a direct publisher fails at once; a publisher in lock order waits, revalidates and is refused', async () => {
  const { gen, seq: at } = await stage();
  await beginScoped(A);
  await A.client.query(`SELECT id FROM "Connection" WHERE id = 'm1' FOR NO KEY UPDATE`);
  await A.client.query(`UPDATE "Connection" SET status = 'DISABLED', "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = 'm1'`);
  await beginScoped(C);
  await assert.rejects(publish(C, gen, at), /lock the Connection|55P03/, 'out of order: no wait, no publication under an uncommitted disable');
  await rollbackQuietly(C);
  await beginScoped(B);
  const pub = inFlight(async () => { await lockForPublication(B, gen); await publish(B, gen, at); });
  await waitUntilBlocked(owner, B.pid);
  await A.client.query('COMMIT');
  await assert.rejects(pub.result(), /ACTIVE connection of the claimed lifecycleVersion/);
  await rollbackQuietly(B);
  assert.equal((await shape(gen)).state, 'STAGING');
  await reactivate();
});

test('publication first: the disable waits for it; the publication stands and the connection then ends DISABLED', async () => {
  const { gen, seq: at } = await stage();
  await beginScoped(B); await lockForPublication(B, gen); await publish(B, gen, at);
  await beginScoped(A);
  const disable = inFlight(async () => {
    await A.client.query(`SELECT id FROM "Connection" WHERE id = 'm1' FOR NO KEY UPDATE`);
    await A.client.query(`UPDATE "Connection" SET status = 'DISABLED', "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = 'm1'`);
  });
  await waitUntilBlocked(owner, A.pid);
  await B.client.query('COMMIT');
  await disable.result(); await A.client.query('COMMIT');
  assert.equal((await shape(gen)).state, 'PUBLISHED');
  assert.equal((await owner.query(`SELECT status FROM "Connection" WHERE id = 'm1'`)).rows[0].status, 'DISABLED');
  await reactivate();
});

test('newest-attempt fence: a claim of a newer attempt makes the older publisher wait, then refuses it; out of order it fails at once', async () => {
  const { gen, seq: at } = await stage();
  await beginScoped(C); // the claimant of the next attempt, in lock order: state, then the new generation
  await C.client.query(`SELECT 1 FROM "M365ResourceState" WHERE "connectionId" = 'm1' AND "resourceType" = 'm365_user' FOR UPDATE`);
  await C.client.query(`UPDATE "M365ResourceState" SET "latestStartedSeq" = $1, "attemptsUsed" = "attemptsUsed" + 1 WHERE "connectionId" = 'm1' AND "resourceType" = 'm365_user'`, [at + 1]);
  await C.client.query(`INSERT INTO "M365DirectoryGeneration" ("workspaceId","clientId","connectionId","resourceType","id","attemptSeq","lifecycleVersion","claimToken",
    "leaseExpiresAt","expiresAt") VALUES ('w','c1','m1','m365_user',$1,$2,$3,gen_random_uuid(),now() + interval '10 minutes',now() + interval '23 hours')`,
    [`race-gen-${at + 1}`, at + 1, await version()]);
  await beginScoped(A);
  await assert.rejects(publish(A, gen, at), /lock the resource state|55P03/, 'a direct publisher never waits behind the claim');
  await rollbackQuietly(A);
  await beginScoped(B);
  const pub = inFlight(async () => { await lockForPublication(B, gen); await publish(B, gen, at); });
  await waitUntilBlocked(owner, B.pid);
  await C.client.query('COMMIT'); seq = at + 1;
  await assert.rejects(pub.result(), /only the newest started directory attempt publishes/);
  await rollbackQuietly(B);
  assert.equal((await shape(gen)).state, 'STAGING');
});

test('the ordinary path under production runtime grants: staged object, then ordered publication filling its mirror', async () => {
  const { gen, seq: at } = await stage();
  await beginScoped(A); await insertObject(A, gen); await A.client.query('COMMIT');
  await beginScoped(B);
  await lockForPublication(B, gen);
  await B.client.query(`INSERT INTO "ExternalEntity" VALUES ('w','c1','race-mirror','m1','m365_user',$1,'{}',now())
    ON CONFLICT ("workspaceId","clientId","connectionId","resourceType","externalId") DO NOTHING`, [USER]);
  const mirror = (await B.client.query(`SELECT id FROM "ExternalEntity" WHERE "connectionId" = 'm1' AND "externalId" = $1`, [USER])).rows[0].id;
  await B.client.query(`UPDATE "M365DirectoryObject" SET "externalEntityId" = $2 WHERE "generationId" = $1`, [gen, mirror]);
  await publish(B, gen, at, 1);
  await B.client.query('COMMIT');
  assert.deepEqual(await shape(gen), { state: 'PUBLISHED', rowCount: 1, rows: 1, unmirrored: 0 });
  // A mirror cannot be filled behind a publisher's back: out of order, the object UPDATE fails instead of waiting
  const next = await stage();
  await beginScoped(A); await insertObject(A, next.gen); await A.client.query('COMMIT');
  await beginScoped(B); await lockForPublication(B, next.gen);
  await beginScoped(C);
  await assert.rejects(C.client.query(`UPDATE "M365DirectoryObject" SET "externalEntityId" = $2 WHERE "generationId" = $1`, [next.gen, mirror]),
    /lock its generation first|55P03/);
  await rollbackQuietly(C); await rollbackQuietly(B);
});

const cleanup = (s: Session) => s.client.query(`BEGIN; SELECT set_config('app.workspace_id', 'w', true), set_config('app.client_ids', 'c1', true),
  set_config('app.actor_id', 'm365-op', true); SELECT atlas_m365_cleanup('corr-race-cleanup');`);

test('cleanup contention: cleanup waits for a running publication; a publication waits for, or fails against, a running cleanup', async () => {
  const first = await stage();
  await beginScoped(B); await lockForPublication(B, first.gen); await publish(B, first.gen, first.seq);
  const sweep = inFlight(() => cleanup(runner));
  await waitUntilBlocked(owner, runner.pid);
  await B.client.query('COMMIT');
  await sweep.result(); await runner.client.query('COMMIT');
  const second = await stage();
  await cleanup(runner); // cleanup holds the Connection FOR NO KEY UPDATE until it commits
  await beginScoped(C);
  await assert.rejects(publish(C, second.gen, second.seq), /lock the Connection|55P03/);
  await rollbackQuietly(C);
  await beginScoped(B);
  const pub = inFlight(async () => { await lockForPublication(B, second.gen); await publish(B, second.gen, second.seq); });
  await waitUntilBlocked(owner, B.pid);
  await runner.client.query('COMMIT');
  await pub.result(); await B.client.query('COMMIT');
  assert.equal((await shape(second.gen)).state, 'PUBLISHED', 'after cleanup the ordered publisher proceeds on a still ACTIVE connection');
});
