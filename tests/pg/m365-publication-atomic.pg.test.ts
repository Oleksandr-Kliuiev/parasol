import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { seedGraph } from '../sql-invariants.ts';
import type { SqlRunner } from '../sql-invariants.ts';
import { seedM365 } from '../m365-sql-invariants.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { beginScoped, inFlight, openSession, rollbackQuietly, waitUntilBlocked } from '../support/pg-race.ts';
import type { Session } from '../support/pg-race.ts';

// Review S2-A-rc2 on PostgreSQL 17, both resource types, real runtime sessions (production grants):
//   * commit atomicity — a first STAGING→PUBLISHED / RUNNING→COMPLETE never commits detached from its root pointer
//     (deferred constraint trigger: plain COMMIT, savepoint rollback and SET CONSTRAINTS IMMEDIATE all refuse it);
//   * pointer linearization — the pointer change itself rechecks newest-started and the ACTIVE Connection at the target's
//     lifecycleVersion, while a retained pointer survives a newer start, a failure record and a disable.
const pgdb = await createTestDatabase();
const owner = pgdb.owner;
const asRunner = (c: pg.Client): SqlRunner => ({ exec: sql => c.query(sql).then(() => undefined), query: async (sql, params) => (await c.query(sql, params)).rows as never });
await seedGraph(asRunner(owner));
await seedM365(asRunner(owner));
const sessions: Session[] = [];
const open = async () => { const s = await openSession(pgdb.runtimeUrl); sessions.push(s); return s; };
const [A, B] = [await open(), await open()];
after(async () => { for (const s of sessions) await s.client.end().catch(() => undefined); await pgdb.drop(); });
const version = async () => Number((await owner.query(`SELECT "lifecycleVersion" AS v FROM "Connection" WHERE id = 'm1'`)).rows[0].v);
const reactivate = () => owner.query(`UPDATE "Connection" SET status = 'ACTIVE', "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = 'm1'`);
const NOT_ATOMIC = /only together with its (window )?pointer/;

// ---- directory ---------------------------------------------------------------------------------------------------
let gseq = 0;
async function stageGeneration(): Promise<{ gen: string; at: number }> {
  gseq += 1; const gen = `atomic-gen-${gseq}`;
  await owner.query(`INSERT INTO "M365ResourceState" ("workspaceId","clientId","connectionId","resourceType","latestStartedSeq") VALUES ('w','c1','m1','m365_device',$1)
    ON CONFLICT ("workspaceId","clientId","connectionId","resourceType") DO UPDATE SET "latestStartedSeq" = EXCLUDED."latestStartedSeq",
    "attemptsUsed" = "M365ResourceState"."attemptsUsed" + (EXCLUDED."latestStartedSeq" - "M365ResourceState"."latestStartedSeq")`, [gseq]);
  await owner.query(`INSERT INTO "M365DirectoryGeneration" ("workspaceId","clientId","connectionId","resourceType","id","attemptSeq","lifecycleVersion","claimToken",
    "leaseExpiresAt","expiresAt") VALUES ('w','c1','m1','m365_device',$1,$2,$3,gen_random_uuid(),now() + interval '10 minutes',now() + interval '23 hours')`,
    [gen, gseq, await version()]);
  return { gen, at: gseq };
}
const lockDirectory = async (s: Session, gen: string) => {
  await s.client.query(`SELECT id FROM "Connection" WHERE id = 'm1' FOR SHARE`);
  await s.client.query(`SELECT 1 FROM "M365ResourceState" WHERE "connectionId" = 'm1' AND "resourceType" = 'm365_device' FOR UPDATE`);
  await s.client.query(`SELECT 1 FROM "M365DirectoryGeneration" WHERE id = $1 FOR UPDATE`, [gen]);
};
const publishGeneration = (s: Session, gen: string) => s.client.query(`UPDATE "M365DirectoryGeneration" SET state = 'PUBLISHED', "completedAt" = now(),
  "claimToken" = NULL, "leaseExpiresAt" = NULL, "rowCount" = 0, "expiresAt" = now() + interval '23 hours' WHERE id = $1`, [gen]);
const pointDirectory = (s: Session, gen: string, at: number) => s.client.query(`UPDATE "M365ResourceState" SET "activeGenerationId" = $1, "latestPublishedSeq" = $2,
  "latestRecordedSeq" = $2, status = 'OK', "attemptsUsed" = 0, "safeErrorCode" = NULL, "lastAttemptAt" = now(), "lastSuccessAt" = now()
  WHERE "connectionId" = 'm1' AND "resourceType" = 'm365_device'`, [gen, at]);
const directory = async () => (await owner.query(`SELECT "activeGenerationId" AS pointer, "latestStartedSeq" AS started, status,
  (SELECT string_agg(id || ':' || state, ',' ORDER BY "attemptSeq") FROM "M365DirectoryGeneration" WHERE "connectionId" = 'm1' AND "resourceType" = 'm365_device') AS gens
  FROM "M365ResourceState" WHERE "connectionId" = 'm1' AND "resourceType" = 'm365_device'`)).rows[0];

test('directory: a publication alone never commits — plain COMMIT, a savepoint that undid the pointer, or IMMEDIATE checking', async () => {
  const { gen, at } = await stageGeneration();
  await beginScoped(A); await lockDirectory(A, gen); await publishGeneration(A, gen);
  await assert.rejects(A.client.query('COMMIT'), NOT_ATOMIC);
  await beginScoped(A); await lockDirectory(A, gen); await publishGeneration(A, gen);
  await A.client.query('SAVEPOINT pointer'); await pointDirectory(A, gen, at); await A.client.query('ROLLBACK TO SAVEPOINT pointer');
  await assert.rejects(A.client.query('COMMIT'), NOT_ATOMIC);
  await beginScoped(A); await A.client.query('SET CONSTRAINTS ALL IMMEDIATE'); await lockDirectory(A, gen);
  await assert.rejects(publishGeneration(A, gen), NOT_ATOMIC, 'IMMEDIATE only moves the check earlier');
  await rollbackQuietly(A);
  assert.equal((await directory()).gens, `${gen}:STAGING`, 'every refused transaction rolled back');
  // Atomic: publication and pointer together
  await beginScoped(A); await lockDirectory(A, gen); await publishGeneration(A, gen); await pointDirectory(A, gen, at); await A.client.query('COMMIT');
  assert.equal((await directory()).pointer, gen);
});

test('directory: the pointer change rechecks the Connection fence and newest-started; a refusal keeps the retained pointer', async () => {
  const kept = (await directory()).pointer;
  const { gen, at } = await stageGeneration();
  for (const [label, between, error] of [
    ['disable', `UPDATE "Connection" SET status = 'DISABLED', "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = 'm1'`, /ACTIVE connection of the claimed lifecycleVersion/],
    ['newer start', `UPDATE "M365ResourceState" SET "latestStartedSeq" = "latestStartedSeq" + 1, "attemptsUsed" = "attemptsUsed" + 1 WHERE "connectionId" = 'm1' AND "resourceType" = 'm365_device'`,
      /moves only to the newest started attempt/]] as const) {
    await beginScoped(A); await lockDirectory(A, gen); await publishGeneration(A, gen);
    await A.client.query(between); // between the would-be completion and the pointer, in the same transaction
    await assert.rejects(pointDirectory(A, gen, at), error, label);
    await rollbackQuietly(A);
    assert.equal((await directory()).pointer, kept, `${label}: the retained pointer is unchanged`);
  }
  // A failure record after a newer start and a disable leaves the retained pointer valid (no retroactive rejection)
  await owner.query(`UPDATE "M365ResourceState" SET "latestStartedSeq" = "latestStartedSeq" + 1, "attemptsUsed" = "attemptsUsed" + 1 WHERE "connectionId" = 'm1' AND "resourceType" = 'm365_device'`);
  await owner.query(`UPDATE "Connection" SET status = 'DISABLED', "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = 'm1'`);
  await beginScoped(A);
  await A.client.query(`UPDATE "M365ResourceState" SET "latestRecordedSeq" = "latestStartedSeq", status = 'ERROR', "safeErrorCode" = 'CONNECTION_DISABLED',
    "lastAttemptAt" = now() WHERE "connectionId" = 'm1' AND "resourceType" = 'm365_device'`);
  await A.client.query('COMMIT');
  assert.deepEqual([(await directory()).pointer, (await directory()).status], [kept, 'ERROR']);
  await reactivate();
});

test('directory: publication first holds the fence through its pointer; a disable waits and then ends DISABLED with that pointer', async () => {
  const { gen, at } = await stageGeneration();
  await beginScoped(A); await lockDirectory(A, gen); await publishGeneration(A, gen);
  await beginScoped(B);
  const disable = inFlight(() => B.client.query(`UPDATE "Connection" SET status = 'DISABLED', "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = 'm1'`));
  await waitUntilBlocked(owner, B.pid);
  await pointDirectory(A, gen, at); await A.client.query('COMMIT');
  await disable.result(); await B.client.query('COMMIT');
  assert.equal((await directory()).pointer, gen);
  await reactivate();
});

// ---- sign-in windows -----------------------------------------------------------------------------------------------
const R = `date_trunc('hour', now()) - interval '3 hours'`;
await owner.query(`INSERT INTO "M365SignInWindow" ("workspaceId","clientId","connectionId","id","rootFrom","rootTo") VALUES ('w','c1','m1','aw',${R},${R} + interval '1 hour');
  INSERT INTO "M365SyncRequest" ("workspaceId","clientId","connectionId","id","requestedFrom","requestedTo","configVersion","rootCount","createdBy")
    VALUES ('w','c1','m1','areq',${R},${R} + interval '1 hour','m365-sync.1',1,'m365-op');
  INSERT INTO "M365SyncRootJob" ("workspaceId","clientId","connectionId","requestId","windowId","maxAttempts") VALUES ('w','c1','m1','areq','aw',10)`);
let aseq = 0;
async function stageAttempt(): Promise<{ att: string; at: number }> {
  aseq += 1; const att = `atomic-att-${aseq}`;
  await owner.query(`UPDATE "M365SignInWindow" SET "latestStartedSeq" = $1 WHERE id = 'aw'`, [aseq]);
  await owner.query(`INSERT INTO "M365WindowAttempt" ("workspaceId","clientId","connectionId","windowId","id","rootFrom","requestId","attemptSeq","lifecycleVersion",
    "coveredFrom","coveredTo","configVersion","claimToken","leaseExpiresAt","deadlineAt","expiresAt") VALUES ('w','c1','m1','aw',$1,${R},'areq',$2,$3,${R},
    ${R} + interval '1 hour','m365-sync.1',gen_random_uuid(),now() + interval '10 minutes',now() + interval '10 minutes',now() + interval '1 hour')`, [att, aseq, await version()]);
  await owner.query(`INSERT INTO "M365WindowLeaf" ("workspaceId","clientId","connectionId","windowId","attemptId","id","fromInclusive","toExclusive")
    VALUES ('w','c1','m1','aw',$1,'L0',${R},${R} + interval '1 hour')`, [att]);
  await owner.query(`UPDATE "M365WindowLeaf" SET state = 'RUNNING' WHERE "attemptId" = $1`, [att]);
  return { att, at: aseq };
}
const lockWindow = async (s: Session, att: string) => {
  await s.client.query(`SELECT id FROM "Connection" WHERE id = 'm1' FOR SHARE`);
  await s.client.query(`SELECT 1 FROM "M365SignInWindow" WHERE id = 'aw' FOR UPDATE`);
  await s.client.query(`SELECT 1 FROM "M365WindowAttempt" WHERE id = $1 FOR UPDATE`, [att]);
};
const completeAttempt = async (s: Session, att: string) => {
  await s.client.query(`UPDATE "M365WindowLeaf" SET state = 'COMPLETE' WHERE "attemptId" = $1`, [att]);
  await s.client.query(`UPDATE "M365WindowAttempt" SET state = 'COMPLETE', "completedAt" = now(), "publishedAt" = now(), "claimToken" = NULL, "leaseExpiresAt" = NULL,
    "evidenceCount" = 0, "stagedRows" = 0, "leafCount" = 1, "expiresAt" = "coveredTo" + interval '7 days' WHERE id = $1`, [att]);
};
const pointWindow = (s: Session, att: string, at: number) => s.client.query(`UPDATE "M365SignInWindow" SET "publishedAttemptId" = $1, "latestPublishedSeq" = $2,
  "latestRecordedSeq" = $2, status = 'OK', "safeErrorCode" = NULL, "lastAttemptAt" = now(), "lastSuccessAt" = now() WHERE id = 'aw'`, [att, at]);
const window = async () => (await owner.query(`SELECT "publishedAttemptId" AS pointer, status,
  (SELECT string_agg(id || ':' || state, ',' ORDER BY "attemptSeq") FROM "M365WindowAttempt" WHERE "windowId" = 'aw') AS attempts FROM "M365SignInWindow" WHERE id = 'aw'`)).rows[0];

test('sign-in: completion alone never commits; completion + pointer (+ superseding the previous attempt) commit atomically', async () => {
  const first = await stageAttempt();
  await beginScoped(A); await lockWindow(A, first.att); await completeAttempt(A, first.att);
  await assert.rejects(A.client.query('COMMIT'), NOT_ATOMIC);
  await beginScoped(A); await lockWindow(A, first.att); await completeAttempt(A, first.att);
  await A.client.query('SAVEPOINT pointer'); await pointWindow(A, first.att, first.at); await A.client.query('ROLLBACK TO SAVEPOINT pointer');
  await assert.rejects(A.client.query('COMMIT'), NOT_ATOMIC);
  assert.equal((await window()).attempts, `${first.att}:RUNNING`);
  await beginScoped(A); await lockWindow(A, first.att); await completeAttempt(A, first.att); await pointWindow(A, first.att, first.at); await A.client.query('COMMIT');
  const second = await stageAttempt();
  await beginScoped(A); await lockWindow(A, second.att); await completeAttempt(A, second.att); await pointWindow(A, second.att, second.at);
  await A.client.query(`UPDATE "M365WindowAttempt" SET state = 'SUPERSEDED' WHERE id = $1`, [first.att]);
  await A.client.query('COMMIT');
  assert.deepEqual(await window(), { pointer: second.att, status: 'OK', attempts: `${first.att}:SUPERSEDED,${second.att}:COMPLETE` },
    'the superseded history stays valid after the pointer moved');
});

test('sign-in: publication first holds the fence through its pointer; a disable waits and then ends DISABLED with that pointer', async () => {
  const { att, at } = await stageAttempt();
  await beginScoped(A); await lockWindow(A, att); await completeAttempt(A, att);
  await beginScoped(B);
  const disable = inFlight(() => B.client.query(`UPDATE "Connection" SET status = 'DISABLED', "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = 'm1'`));
  await waitUntilBlocked(owner, B.pid);
  await pointWindow(A, att, at); await A.client.query('COMMIT');
  await disable.result(); await B.client.query('COMMIT');
  assert.equal((await window()).pointer, att);
  await reactivate();
});

test('sign-in: the pointer change rechecks the Connection fence and newest-started; failure records keep the retained pointer', async () => {
  const kept = (await window()).pointer;
  const { att, at } = await stageAttempt();
  for (const [label, between, error] of [
    ['disable', `UPDATE "Connection" SET status = 'DISABLED', "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = 'm1'`, /ACTIVE connection of the claimed lifecycleVersion/],
    ['newer start', `UPDATE "M365SignInWindow" SET "latestStartedSeq" = "latestStartedSeq" + 1 WHERE id = 'aw'`, /moves only to the newest started attempt/]] as const) {
    await beginScoped(A); await lockWindow(A, att); await completeAttempt(A, att);
    await A.client.query(between);
    await assert.rejects(pointWindow(A, att, at), error, label);
    await rollbackQuietly(A);
    assert.equal((await window()).pointer, kept, `${label}: the retained pointer is unchanged`);
  }
  await owner.query(`UPDATE "Connection" SET status = 'DISABLED', "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = 'm1'`);
  await beginScoped(A);
  await A.client.query(`UPDATE "M365WindowAttempt" SET state = 'FAILED', "completedAt" = now(), "claimToken" = NULL, "leaseExpiresAt" = NULL,
    "safeErrorCode" = 'CONNECTION_DISABLED' WHERE id = $1`, [att]);
  await A.client.query(`UPDATE "M365SignInWindow" SET "latestRecordedSeq" = $1, status = 'ERROR', "safeErrorCode" = 'CONNECTION_DISABLED', "lastAttemptAt" = now()
    WHERE id = 'aw'`, [at]);
  await A.client.query('COMMIT');
  assert.deepEqual([(await window()).pointer, (await window()).status], [kept, 'ERROR'], 'a failed newer attempt keeps the last good publication');
  await reactivate();
});
