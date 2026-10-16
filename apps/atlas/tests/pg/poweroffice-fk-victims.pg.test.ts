import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PrismaClient } from '@prisma/client';
import { generateToken, hashToken } from '../../packages/auth/token.ts';
import { powerOfficeCredential } from '../../packages/poweroffice/authority.ts';
import { syncPowerOffice } from '../../packages/poweroffice/sync.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { CA, WS, addPowerOfficeFixtures, connect, tokens } from '../support/poweroffice-fixtures.ts';
import { addSyncConnection, audits, codeOf, observe, seam, untilWaiting } from '../support/poweroffice-sync.ts';
import type { SyncConnection } from '../support/poweroffice-sync.ts';

// S4-B mandatory FK residual (IMPLEMENTATION_HANDOFF.md item 4; 06 B2/B4) on PostgreSQL 17. After the workspace fence,
// INSERTs into State/Attempt/Snapshot take KEY SHARE on the Connection row (Attempt also on the Actor row). A direct
// mutation that holds the tuple exclusively (SELECT … FOR UPDATE, then UPDATE whose fence trigger waits for the fence)
// closes a cycle; whichever transaction waited FIRST is PostgreSQL's 40P01 victim. Each ordering is real: the Stage 4
// transaction as victim and the Connection UPDATE as victim, at admission and at publication — fixed outcome, zero partial
// effects, the next command sees the committed lifecycle. A plain non-key UPDATE (FOR NO KEY UPDATE) does not conflict
// with KEY SHARE and is shown to serialize without a deadlock. No Connection row lock is ever taken by Stage 4 code.
const pgdb = await createTestDatabase();
const prisma = new PrismaClient({ datasources: { db: { url: pgdb.runtimeUrl } } });
const runtime = await connect(pgdb.runtimeUrl);
const sessions: pg.Client[] = [];
after(async () => { for (const c of [runtime, ...sessions]) await c.end().catch(() => undefined); await prisma.$disconnect(); await pgdb.drop(); });
const owner = pgdb.owner;
await addPowerOfficeFixtures(owner);
const syncer = powerOfficeCredential(tokens.syncer!);
const key = (connectionId: string) => ({ workspaceId: WS, clientId: CA, connectionId });
const STATE_LOCK = '"nextSequence", "activeAttemptId"'; // the services' State FOR UPDATE (locks.ts)
const BUMP = (id: string) => `UPDATE "Connection" SET "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = '${id}'`;

async function session(url = pgdb.ownerUrl): Promise<pg.Client> { const c = await connect(url); sessions.push(c); return c; }
/**
 * A direct mutator holding the Connection tuple exclusively (owner, as every existing Connection mutator path). Its
 * session-level deadlock_timeout selects which side of a cycle runs PostgreSQL's deadlock check first, so the intended
 * victim is deterministic: 5 s → the Stage 4 transaction (default 1 s) is the victim; 400 ms → this UPDATE is (a session
 * SET only; no catalog or privilege change). The deadlock itself is always real.
 */
async function tupleHolder(connectionId: string, victim: 'stage4' | 'update'): Promise<pg.Client> {
  const u = await session();
  await u.query(`SET deadlock_timeout = '${victim === 'stage4' ? '5s' : '400ms'}'`);
  await u.query('BEGIN');
  await u.query(`SELECT 1 FROM "Connection" WHERE id = $1 FOR UPDATE`, [connectionId]);
  return u;
}
async function stateHolder(connectionId: string): Promise<pg.Client> {
  const h = await session(pgdb.runtimeUrl);
  await h.query('BEGIN');
  await h.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true)`, [WS, CA]);
  await h.query(`SELECT 1 FROM public."PowerOfficeState" WHERE "connectionId" = $1 FOR UPDATE`, [connectionId]);
  return h;
}
const lifecycle = async (id: string) => Number((await owner.query(`SELECT "lifecycleVersion" AS v FROM "Connection" WHERE id = $1`, [id])).rows[0].v);
/** The next explicit sync sees the committed lifecycle version in its claim and snapshot. */
async function nextSyncSees(conn: SyncConnection, version: number): Promise<void> {
  const receipt = await syncPowerOffice(prisma, seam().composition, syncer, CA, conn.connectionId);
  const o = await observe(runtime, conn);
  assert.equal(o.attempts.at(-1).lifecycleVersion, version); assert.equal(o.snapshots.find((s: { id: string }) => s.id === receipt.snapshotId).lifecycleVersion, version);
}

test('admission, Stage 4 victim: State initialization waits for the tuple, the UPDATE then waits for the fence → DB_CONFLICT, zero effects', async () => {
  const conn = await addSyncConnection(owner, key('fk-adm-s4'), 3);
  const u = await tupleHolder('fk-adm-s4', 'stage4');
  const s = seam();
  const pending = codeOf(syncPowerOffice(prisma, s.composition, syncer, CA, 'fk-adm-s4'));
  await untilWaiting(owner, 'INSERT INTO public."PowerOfficeState"'); // KEY SHARE of the FK check, after the fence
  const update = await u.query(BUMP('fk-adm-s4')).then(() => 'updated', e => e.code);
  assert.equal(await pending, 'POWEROFFICE_DB_CONFLICT', 'the admission waited first and is the victim; never retried');
  assert.equal(update, 'updated');
  await u.query('COMMIT');
  assert.equal(await observe(runtime, conn).then(o => o.state), null, 'no State, attempt or audit committed');
  assert.deepEqual(await audits(owner, 'fk-adm-s4'), []); assert.equal(s.calls.length, 0);
  await nextSyncSees(conn, 2);
});

test('admission, Connection UPDATE victim: the UPDATE waited for the fence first → 40P01 for it; the claim commits and publishes', async () => {
  const conn = await addSyncConnection(owner, key('fk-adm-u'), 3);
  await syncPowerOffice(prisma, seam().composition, syncer, CA, 'fk-adm-u'); // State exists: the admission waits on its lock
  const h = await stateHolder('fk-adm-u');
  const pending = codeOf(syncPowerOffice(prisma, seam().composition, syncer, CA, 'fk-adm-u'));
  await untilWaiting(owner, STATE_LOCK);
  const u = await tupleHolder('fk-adm-u', 'update');
  const update = u.query(BUMP('fk-adm-u')).then(() => 'updated', e => e.code);
  await untilWaiting(owner, 'UPDATE "Connection"');
  await h.query('ROLLBACK'); // the admission proceeds to the Attempt INSERT and waits for the tuple: the cycle closes
  assert.equal(await update, '40P01', 'the Connection UPDATE waited first and is the victim');
  await u.query('ROLLBACK');
  assert.equal(await pending, 'ok');
  const o = await observe(runtime, conn);
  assert.deepEqual(o.attempts.map((a: { state: string; lifecycleVersion: number }) => [a.state, a.lifecycleVersion]), [['SUCCEEDED', 1], ['SUCCEEDED', 1]]);
  await owner.query(BUMP('fk-adm-u'));
  await nextSyncSees(conn, 2);
});

test('publication, Stage 4 victim: the snapshot INSERT waits for the tuple → known rollback re-run sees the new lifecycle → BINDING_CHANGED, claim FAILED', async () => {
  const conn = await addSyncConnection(owner, key('fk-pub-s4'), 3);
  await syncPowerOffice(prisma, seam().composition, syncer, CA, 'fk-pub-s4');
  const prior = await observe(runtime, conn);
  let u: pg.Client | null = null;
  const s = seam(async call => { u = await tupleHolder('fk-pub-s4', 'stage4'); return call.builtIn(); }); // after the last page admission committed
  const pending = codeOf(syncPowerOffice(prisma, s.composition, syncer, CA, 'fk-pub-s4'));
  await untilWaiting(owner, 'INSERT INTO public."PowerOfficeSnapshot"');
  assert.equal(await u!.query(BUMP('fk-pub-s4')).then(() => 'updated', e => e.code), 'updated', 'the publication waited first and is the victim');
  await u!.query('COMMIT');
  assert.equal(await pending, 'POWEROFFICE_BINDING_CHANGED', 're-run with fresh binding (a non-re-run victim would surface DB_CONFLICT)');
  const o = await observe(runtime, conn);
  assert.deepEqual([o.attempts.at(-1).state, o.attempts.at(-1).safeErrorCode], ['FAILED', 'POWEROFFICE_BINDING_CHANGED']);
  assert.deepEqual([o.snapshots.length, o.state.pointer, o.state.lastSuccessAt], [1, prior.state.pointer, prior.state.lastSuccessAt], 'no partial publication');
  assert.deepEqual((await audits(owner, 'fk-pub-s4')).slice(2).map(r => r.metadata.outcome), ['STARTED', 'FAILED']);
  assert.equal(await lifecycle('fk-pub-s4'), 2); assert.equal(s.calls.length, 1, 'zero extra port calls');
  await nextSyncSees(conn, 2);
});

test('publication, Connection UPDATE victim: the UPDATE waited for the fence first → 40P01 for it; the publication commits', async () => {
  const conn = await addSyncConnection(owner, key('fk-pub-u'), 3);
  let h: pg.Client | null = null;
  const s = seam(async call => { h = await stateHolder('fk-pub-u'); return call.builtIn(); });
  const pending = codeOf(syncPowerOffice(prisma, s.composition, syncer, CA, 'fk-pub-u'));
  await untilWaiting(owner, STATE_LOCK); // the publication holds the fence and waits for the State row
  const u = await tupleHolder('fk-pub-u', 'update');
  const update = u.query(BUMP('fk-pub-u')).then(() => 'updated', e => e.code);
  await untilWaiting(owner, 'UPDATE "Connection"');
  await h!.query('ROLLBACK');
  assert.equal(await update, '40P01', 'the Connection UPDATE is the victim');
  await u.query('ROLLBACK');
  assert.equal(await pending, 'ok');
  const o = await observe(runtime, conn);
  assert.deepEqual([o.snapshots.length, o.snapshots[0].lifecycleVersion, o.attempts[0].state], [1, 1, 'SUCCEEDED']);
  await owner.query(BUMP('fk-pub-u'));
  await nextSyncSees(conn, 2);
});

test('a plain non-key UPDATE (FOR NO KEY UPDATE) never conflicts with KEY SHARE: it serializes after the admission, and the next page sees it', async () => {
  const conn = await addSyncConnection(owner, key('fk-plain'), 3);
  await syncPowerOffice(prisma, seam().composition, syncer, CA, 'fk-plain');
  const h = await stateHolder('fk-plain');
  const s = seam();
  const pending = codeOf(syncPowerOffice(prisma, s.composition, syncer, CA, 'fk-plain'));
  await untilWaiting(owner, STATE_LOCK);
  const u = await session();
  await u.query('BEGIN');
  const update = u.query(BUMP('fk-plain')).then(() => 'updated', e => e.code);
  await untilWaiting(owner, 'UPDATE "Connection"');
  await h.query('ROLLBACK'); // the admission's Attempt INSERT takes KEY SHARE beside the UPDATE's tuple lock: no cycle
  assert.equal(await update, 'updated', 'no deadlock: the UPDATE got the fence after the admission committed');
  await u.query('COMMIT');
  assert.equal(await pending, 'POWEROFFICE_BINDING_CHANGED', 'the first page admission sees the committed lifecycle');
  assert.equal(s.calls.length, 0, 'no page was read');
  const o = await observe(runtime, conn);
  assert.deepEqual([o.attempts.at(-1).state, o.attempts.at(-1).lifecycleVersion, o.attempts.at(-1).safeErrorCode], ['FAILED', 1, 'POWEROFFICE_BINDING_CHANGED']);
  await nextSyncSees(conn, 2);
});

test('Actor KEY SHARE: the Attempt INSERT waits for a locked Actor row whose UPDATE waits for the fence → admission DB_CONFLICT, zero effects', async () => {
  await owner.query(`INSERT INTO "Actor" ("workspaceId", id, "displayName", status, "workspacePermissions") VALUES ($1, 'syncer-fk', 'Synthetic actor', 'ACTIVE', '{}')`, [WS]);
  await owner.query(`INSERT INTO "ClientMembership" ("workspaceId","clientId","actorId",permissions) VALUES ($1,$2,'syncer-fk','{context:read,poweroffice:read,poweroffice:sync}')`, [WS, CA]);
  const bearer = generateToken();
  await owner.query(`INSERT INTO "ApiToken" ("workspaceId", id, "actorId", "tokenHash") VALUES ($1, 'tok-syncer-fk', 'syncer-fk', $2)`, [WS, hashToken(bearer)]);
  const credential = powerOfficeCredential(bearer);
  const conn = await addSyncConnection(owner, key('fk-actor'), 3);
  await syncPowerOffice(prisma, seam().composition, credential, CA, 'fk-actor');
  const before = await observe(runtime, conn);
  const u = await session();
  await u.query(`SET deadlock_timeout = '5s'`); // the Stage 4 admission checks first: it is the victim
  await u.query('BEGIN');
  await u.query(`SELECT 1 FROM "Actor" WHERE id = 'syncer-fk' FOR UPDATE`);
  const s = seam();
  const pending = codeOf(syncPowerOffice(prisma, s.composition, credential, CA, 'fk-actor'));
  await untilWaiting(owner, 'INSERT INTO public."PowerOfficeAttempt"');
  assert.equal(await u.query(`UPDATE "Actor" SET "displayName" = 'Synthetic actor 2' WHERE id = 'syncer-fk'`).then(() => 'updated', e => e.code), 'updated');
  assert.equal(await pending, 'POWEROFFICE_DB_CONFLICT');
  await u.query('COMMIT');
  assert.deepEqual(await observe(runtime, conn), before, 'zero partial effects'); assert.equal(s.calls.length, 0);
  assert.equal((await syncPowerOffice(prisma, seam().composition, credential, CA, 'fk-actor')).sequence, 2, 'the next explicit sync proceeds');
});
