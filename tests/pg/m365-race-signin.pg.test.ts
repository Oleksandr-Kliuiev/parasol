import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { seedGraph } from '../sql-invariants.ts';
import type { SqlRunner } from '../sql-invariants.ts';
import { seedM365 } from '../m365-sql-invariants.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { beginScoped, inFlight, openSession, rollbackQuietly, waitUntilBlocked } from '../support/pg-race.ts';
import type { Session } from '../support/pg-race.ts';

// Review S2-A-rc1 F2, sign-in half, on PostgreSQL 17 with real runtime sessions. Membership writes hold the attempt and
// the leaf in SHARE mode; leaf completion and publication wait for them and count them; leaf insertions of one attempt
// are serialized; publication holds the Connection → window → attempt order. Orderings are forced by lock observation.
const pgdb = await createTestDatabase();
const owner = pgdb.owner;
const asRunner = (c: pg.Client): SqlRunner => ({ exec: sql => c.query(sql).then(() => undefined), query: async (sql, params) => (await c.query(sql, params)).rows as never });
await seedGraph(asRunner(owner));
await seedM365(asRunner(owner));
const sessions: Session[] = [];
const open = async () => { const s = await openSession(pgdb.runtimeUrl); sessions.push(s); return s; };
const [A, B, C] = [await open(), await open(), await open()];
after(async () => { for (const s of sessions) await s.client.end().catch(() => undefined); await pgdb.drop(); });

const R = `date_trunc('hour', now()) - interval '2 hours'`;
await owner.query(`INSERT INTO "M365SignInWindow" ("workspaceId","clientId","connectionId","id","rootFrom","rootTo") VALUES ('w','c1','m1','win',${R},${R} + interval '1 hour');
  INSERT INTO "M365SyncRequest" ("workspaceId","clientId","connectionId","id","requestedFrom","requestedTo","configVersion","rootCount","createdBy")
    VALUES ('w','c1','m1','req',${R},${R} + interval '1 hour','m365-sync.1',1,'m365-op');
  INSERT INTO "M365SyncRootJob" ("workspaceId","clientId","connectionId","requestId","windowId","maxAttempts") VALUES ('w','c1','m1','req','win',10)`);
let seq = 0; let evidence = 0;
const version = async () => Number((await owner.query(`SELECT "lifecycleVersion" AS v FROM "Connection" WHERE id = 'm1'`)).rows[0].v);
/** A RUNNING newest attempt with a RUNNING full-interval root leaf L0 (or a SPLIT root when `split`), and one evidence row. */
async function stage(split = false): Promise<{ att: string; seq: number; ev: string }> {
  seq += 1; evidence += 1; const att = `att-${seq}`; const ev = `ev-${evidence}`;
  await owner.query(`UPDATE "M365SignInWindow" SET "latestStartedSeq" = $1 WHERE id = 'win'`, [seq]);
  await owner.query(`INSERT INTO "M365WindowAttempt" ("workspaceId","clientId","connectionId","windowId","id","rootFrom","requestId","attemptSeq","lifecycleVersion",
    "coveredFrom","coveredTo","configVersion","claimToken","leaseExpiresAt","deadlineAt","expiresAt") VALUES ('w','c1','m1','win',$1,${R},'req',$2,$3,${R},
    ${R} + interval '1 hour','m365-sync.1',gen_random_uuid(),now() + interval '10 minutes',now() + interval '10 minutes',now() + interval '1 hour')`, [att, seq, await version()]);
  await owner.query(`INSERT INTO "M365WindowLeaf" ("workspaceId","clientId","connectionId","windowId","attemptId","id","fromInclusive","toExclusive")
    VALUES ('w','c1','m1','win',$1,'L0',${R},${R} + interval '1 hour')`, [att]);
  await owner.query(`UPDATE "M365WindowLeaf" SET state = $2 WHERE "attemptId" = $1 AND id = 'L0'`, [att, split ? 'SPLIT' : 'RUNNING']);
  await owner.query(`INSERT INTO "M365SignInEvidence" ("workspaceId","clientId","connectionId","id","sourceId","contentHash","dto","occurredAt","expiresAt") VALUES
    ('w','c1','m1',$1,$1,$2,jsonb_build_object('id',$1::text,'createdDateTime','2026-10-08T08:05:00Z','userId',NULL,'deviceId',NULL,'appId',NULL,'errorCode',0,'isInteractive',true),
    ${R} + interval '5 minutes',${R} + interval '5 minutes' + interval '7 days')`, [ev, String(evidence % 10).repeat(64)]);
  return { att, seq, ev };
}
const member = (s: Session, att: string, ev: string, leaf = 'L0') =>
  s.client.query(`INSERT INTO "M365WindowEvidence" VALUES ('w','c1','m1','win',$1,$2,$3)`, [att, leaf, ev]);
async function lockForPublication(s: Session, att: string): Promise<void> {
  await s.client.query(`SELECT id FROM "Connection" WHERE id = 'm1' FOR SHARE`);
  await s.client.query(`SELECT 1 FROM "M365SignInWindow" WHERE id = 'win' FOR UPDATE`);
  await s.client.query(`SELECT 1 FROM "M365WindowAttempt" WHERE id = $1 FOR UPDATE`, [att]);
}
async function publish(s: Session, att: string, at: number, evidenceCount: number): Promise<void> {
  await s.client.query(`UPDATE "M365WindowLeaf" SET state = 'COMPLETE' WHERE "attemptId" = $1 AND id = 'L0'`, [att]);
  await s.client.query(`UPDATE "M365WindowAttempt" SET state = 'COMPLETE', "completedAt" = now(), "publishedAt" = now(), "claimToken" = NULL, "leaseExpiresAt" = NULL,
    "evidenceCount" = $2, "stagedRows" = $2, "leafCount" = 1, "expiresAt" = "coveredTo" + interval '7 days' WHERE id = $1`, [att, evidenceCount]);
  await s.client.query(`UPDATE "M365SignInWindow" SET "publishedAttemptId" = $1, "latestPublishedSeq" = $2, "latestRecordedSeq" = $2, status = 'OK',
    "lastAttemptAt" = now(), "lastSuccessAt" = now() WHERE id = 'win'`, [att, at]);
}
const shape = async (att: string) => (await owner.query(`SELECT a.state, a."evidenceCount",
  (SELECT count(*)::int FROM "M365WindowEvidence" m WHERE m."attemptId" = a.id) AS memberships FROM "M365WindowAttempt" a WHERE a.id = $1`, [att])).rows[0];

test('membership before completion: publication waits for the writer, then counts its membership; a stale count is refused', async () => {
  const { att, seq: at, ev } = await stage();
  await beginScoped(A); await member(A, att, ev);
  await beginScoped(B);
  const stale = inFlight(async () => { await lockForPublication(B, att); await publish(B, att, at, 0); });
  await waitUntilBlocked(owner, B.pid);
  await A.client.query('COMMIT');
  await assert.rejects(stale.result(), /evidenceCount must equal the staged memberships/);
  await rollbackQuietly(B);
  await beginScoped(B); await lockForPublication(B, att); await publish(B, att, at, 1); await B.client.query('COMMIT');
  assert.deepEqual(await shape(att), { state: 'COMPLETE', evidenceCount: 1, memberships: 1 });
});

test('completion before membership: the writer waits, then finds the attempt published and is refused', async () => {
  const { att, seq: at, ev } = await stage();
  await beginScoped(B); await lockForPublication(B, att); await publish(B, att, at, 0);
  await beginScoped(A);
  const late = inFlight(() => member(A, att, ev));
  await waitUntilBlocked(owner, A.pid);
  await B.client.query('COMMIT');
  await assert.rejects(late.result(), /running leaf of a running attempt/);
  await rollbackQuietly(A);
  assert.deepEqual(await shape(att), { state: 'COMPLETE', evidenceCount: 0, memberships: 0 }, 'the published attempt never gains a late membership');
});

test('a leaf cannot be completed under a membership writer, nor gain one after it completed', async () => {
  const { att, ev } = await stage();
  await beginScoped(A); await member(A, att, ev);
  await beginScoped(B);
  const complete = inFlight(() => B.client.query(`UPDATE "M365WindowLeaf" SET state = 'COMPLETE' WHERE "attemptId" = $1 AND id = 'L0'`, [att]));
  await waitUntilBlocked(owner, B.pid);
  await A.client.query('COMMIT');
  await complete.result(); await B.client.query('COMMIT'); // completed after the membership committed: consistent
  const second = await stage();
  await beginScoped(B); await B.client.query(`SELECT 1 FROM "M365WindowAttempt" WHERE id = $1 FOR UPDATE`, [second.att]);
  await B.client.query(`UPDATE "M365WindowLeaf" SET state = 'COMPLETE' WHERE "attemptId" = $1 AND id = 'L0'`, [second.att]);
  await beginScoped(A);
  const late = inFlight(() => member(A, second.att, second.ev));
  await waitUntilBlocked(owner, A.pid);
  await B.client.query('COMMIT');
  await assert.rejects(late.result(), /running leaf/);
  await rollbackQuietly(A);
});

test('disable first: sign-in publication out of order fails at once; in lock order it waits, revalidates and is refused', async () => {
  const { att, seq: at } = await stage();
  await beginScoped(A);
  await A.client.query(`SELECT id FROM "Connection" WHERE id = 'm1' FOR NO KEY UPDATE`);
  await A.client.query(`UPDATE "Connection" SET status = 'DISABLED', "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = 'm1'`);
  await beginScoped(C);
  await C.client.query(`SELECT 1 FROM "M365SignInWindow" WHERE id = 'win' FOR UPDATE`);
  await C.client.query(`SELECT 1 FROM "M365WindowAttempt" WHERE id = $1 FOR UPDATE`, [att]);
  await assert.rejects(publish(C, att, at, 0), /lock the Connection|55P03/);
  await rollbackQuietly(C);
  await beginScoped(B);
  const pub = inFlight(async () => { await lockForPublication(B, att); await publish(B, att, at, 0); });
  await waitUntilBlocked(owner, B.pid);
  await A.client.query('COMMIT');
  await assert.rejects(pub.result(), /ACTIVE connection of the claimed lifecycleVersion/);
  await rollbackQuietly(B);
  assert.equal((await shape(att)).state, 'RUNNING');
  await owner.query(`UPDATE "Connection" SET status = 'ACTIVE', "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = 'm1'`);
});

test('newest-attempt fence for windows: a newer claim makes the older publisher wait, then refuses it', async () => {
  const { att, seq: at } = await stage();
  await beginScoped(C);
  await C.client.query(`SELECT 1 FROM "M365SignInWindow" WHERE id = 'win' FOR UPDATE`);
  await C.client.query(`UPDATE "M365SignInWindow" SET "latestStartedSeq" = $1 WHERE id = 'win'`, [at + 1]);
  await beginScoped(B);
  const pub = inFlight(async () => { await lockForPublication(B, att); await publish(B, att, at, 0); });
  await waitUntilBlocked(owner, B.pid);
  await C.client.query('COMMIT'); seq = at + 1;
  await assert.rejects(pub.result(), /only the newest started sign-in attempt publishes/);
  await rollbackQuietly(B);
});

test('sibling leaves are serialized per attempt: a concurrent overlapping child waits and is then refused', async () => {
  const { att } = await stage(true);
  const child = (s: Session, id: string, from: number, to: number) => s.client.query(`INSERT INTO "M365WindowLeaf" ("workspaceId","clientId","connectionId","windowId",
    "attemptId","id","parentLeafId","fromInclusive","toExclusive") VALUES ('w','c1','m1','win',$1,$2,'L0',${R} + make_interval(mins => $3),${R} + make_interval(mins => $4))`,
    [att, id, from, to]);
  await beginScoped(A); await child(A, 'L1', 0, 30);
  await beginScoped(B);
  const overlap = inFlight(() => child(B, 'L2', 20, 40));
  await waitUntilBlocked(owner, B.pid);
  await A.client.query('COMMIT');
  await assert.rejects(overlap.result(), /sibling leaves never overlap/);
  await rollbackQuietly(B);
  assert.equal(Number((await owner.query(`SELECT count(*)::int AS n FROM "M365WindowLeaf" WHERE "attemptId" = $1`, [att])).rows[0].n), 2);
});
