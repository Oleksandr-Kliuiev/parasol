import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { AtlasError } from '../../packages/core/contracts.ts';
import type { AtlasConnector, IdentityRead, SnapshotRead } from '../../connectors/contracts.ts';
import { connectorFor, syncIdentities, syncResource } from '../../packages/sync/snapshots.ts';
import { getClientContext } from '../../packages/graph/prisma-context.ts';
import { createTestDatabase, runSeed } from '../support/pg-harness.ts';
import { actors, gasta } from '../support/graph-fixtures.ts';
import { incident, liveHuntressWithConfirmedAgent } from '../support/events-fixtures.ts';
import { vendorFixture } from '../support/mock-http.ts';
import * as huntressContract from '../../connectors/huntress/contract.ts';

// Review B3 on PostgreSQL 17: two reads of one resource may overlap. The outcome of the attempt that began later is the
// current state, whichever finishes last; an earlier attempt finishing late changes neither the snapshot nor its times,
// and the evidence it read (events) is still stored.
const pgdb = await createTestDatabase();
const db = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
after(async () => { await db.$disconnect(); await pgdb.drop(); });
runSeed(pgdb.ownerUrl);
const { connection, io } = await liveHuntressWithConfirmedAgent(db);
const real = connectorFor(db, actors.sync, connection, io);
const T = Date.now() - 60_000;
const at = (ms: number) => new Date(T + ms);
/** A connector whose reads wait until released: an attempt that began earlier and finishes late. */
function held(snapshot: () => SnapshotRead, identities: () => IdentityRead[] = () => []) {
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const connector: AtlasConnector = { ...real,
    async readSnapshot() { entered(); await gate; return snapshot(); },
    async readIdentities() { entered(); await gate; return identities(); } };
  return { connector, started, release };
}
const incidents = async () => {
  const v = (await getClientContext(db, actors.reader, gasta)).resources.find(r => r.connectionId === connection.connectionId && r.resourceType === 'incident')!;
  return [v.status, v.safeErrorCode, v.asOf, v.lastSuccessAt, v.items === null ? null : (v.items as { externalId: string }[]).map(i => i.externalId).sort()];
};
// Times as stored (UTC, the Prisma convention): node-postgres would read a timestamp without zone as local time
const iso = (column: string) => `to_char("${column}", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const state = async (resourceType: string) => (await pgdb.owner.query(`SELECT status, "safeErrorCode" AS code, ${iso('lastSyncAt')} AS "syncAt",
  ${iso('lastSuccessAt')} AS "successAt" FROM "SyncState" WHERE "connectionId" = $1 AND "resourceType" = $2`, [connection.connectionId, resourceType])).rows[0];

test('an older successful read finishing after a newer one changes neither the snapshot nor its times; its events are stored', async () => {
  const old = held(() => ({ resourceType: 'incident', items: [], itemCount: 0, contractVersion: 'older-read',
    events: [incident(connection, '9001', 'HIGH', { revision: '2026-10-07T06:00:00.000Z' })] }));
  const late = syncResource(db, actors.sync, connection, old.connector, 'incident', at(0));
  await old.started;
  const fresh = await syncResource(db, actors.sync, connection, real, 'incident', at(100));
  old.release();
  const finished = await late;
  assert.deepEqual(await incidents(), ['OK', null, at(100).toISOString(), at(100).toISOString(), ['9001', '9002']]);
  assert.deepEqual([fresh.status, fresh.itemCount, fresh.superseded], ['OK', 2, false]);
  assert.deepEqual([finished.status, finished.superseded, finished.eventsStored], ['OK', true, 1], 'the older read is reported as superseded; its evidence is kept');
  assert.equal((await pgdb.owner.query(`SELECT count(*)::int AS n FROM "RawEvent" WHERE "externalEventId" = '9001' AND revision = '2026-10-07T06:00:00.000Z'`)).rows[0].n, 1);
});

test('an older failed read finishing after a newer success records nothing: the resource stays OK with the newer times', async () => {
  const old = held(() => { throw new AtlasError('UPSTREAM_UNAVAILABLE', 'TRANSIENT'); });
  const late = syncResource(db, actors.sync, connection, old.connector, 'incident', at(200));
  await old.started;
  assert.equal((await syncResource(db, actors.sync, connection, real, 'incident', at(300))).status, 'OK');
  old.release();
  const finished = await late;
  assert.deepEqual(await incidents(), ['OK', null, at(300).toISOString(), at(300).toISOString(), ['9001', '9002']]);
  const row = await state('incident');
  assert.deepEqual([row.status, row.code, row.syncAt], ['OK', null, at(300).toISOString()]);
  assert.deepEqual([finished.status, finished.safeErrorCode, finished.superseded], ['ERROR', 'UPSTREAM_UNAVAILABLE', true]);
});

test('a later read finishing after an earlier one is the current state (normal order)', async () => {
  const slow = held(() => ({ resourceType: 'incident', items: [], itemCount: 0, contractVersion: 'later-read', events: [] }));
  assert.equal((await syncResource(db, actors.sync, connection, real, 'incident', at(400))).status, 'OK');
  const late = syncResource(db, actors.sync, connection, slow.connector, 'incident', at(500));
  await slow.started;
  slow.release();
  const finished = await late;
  assert.deepEqual(await incidents(), ['OK', null, at(500).toISOString(), at(500).toISOString(), []]);
  assert.deepEqual([finished.status, finished.superseded], ['OK', false]);
});

test('identities: an older failed identity read finishing after a newer success leaves the agent state OK', async () => {
  const old = held(() => { throw new Error('unused'); }, () => { throw new AtlasError('UPSTREAM_UNAVAILABLE', 'TRANSIENT'); });
  const late = syncIdentities(db, actors.sync, connection, old.connector, at(600));
  await old.started;
  assert.equal((await syncIdentities(db, actors.sync, connection, real, at(700))).status, 'OK');
  old.release();
  const finished = await late;
  const row = await state('agent');
  assert.deepEqual([row.status, row.syncAt, row.successAt], ['OK', at(700).toISOString(), at(700).toISOString()]);
  assert.deepEqual([finished.status, finished.superseded], ['ERROR', true]);
});

// Re-review B3: FIRST reads of a resource that has no state yet are ordered too. Both attempts take their numbers before
// either finishes; each pair runs in both completion orders.
const reports = huntressContract.parsePage(vendorFixture('huntress/incident-reports-sent.json'), 'incident_reports', huntressContract.parseIncident).items;
const readOf = (count: 0 | 2): SnapshotRead => {
  const picked = reports.slice(0, count);
  return { resourceType: 'incident', items: picked.map(huntressContract.incidentItem), itemCount: picked.length,
    contractVersion: huntressContract.HUNTRESS_CONTRACT_VERSION, events: picked.map(r => huntressContract.incidentEvent(connection, connection.connectionId, r, new Date().toISOString())) };
};
const failing = (): SnapshotRead => { throw new AtlasError('UPSTREAM_UNAVAILABLE', 'TRANSIENT'); };
const reset = async (resourceType: string) => {
  await pgdb.owner.query(`DELETE FROM "ResourceSnapshot" WHERE "connectionId" = $1 AND "resourceType" = $2`, [connection.connectionId, resourceType]);
  await pgdb.owner.query(`DELETE FROM "SyncState" WHERE "connectionId" = $1 AND "resourceType" = $2`, [connection.connectionId, resourceType]);
};
const numbers = async (resourceType: string) => (await pgdb.owner.query(`SELECT status||'|'||"attemptSeq"||'|'||"recordedSeq" AS s FROM "SyncState"
  WHERE "connectionId" = $1 AND "resourceType" = $2`, [connection.connectionId, resourceType])).rows.map(r => r.s);
/** A begins at `a`, then B at `b`, both held; then they finish in the given order. Starts from a resource without state. */
async function firstReads(a: { read: () => SnapshotRead; at: Date }, b: { read: () => SnapshotRead; at: Date }, order: 'A then B' | 'B then A') {
  await reset('incident');
  const A = held(a.read); const B = held(b.read);
  const runA = syncResource(db, actors.sync, connection, A.connector, 'incident', a.at);
  await A.started;
  const runB = syncResource(db, actors.sync, connection, B.connector, 'incident', b.at);
  await B.started;
  assert.deepEqual(await numbers('incident'), ['PENDING|2|0'], 'both attempts are numbered before either finishes');
  if (order === 'A then B') { A.release(); await runA; B.release(); await runB; } else { B.release(); await runB; A.release(); await runA; }
  return { A: await runA, B: await runB };
}

test('first reads, success then success: the later-begun read is the current state in both completion orders', async () => {
  for (const order of ['A then B', 'B then A'] as const) {
    const { A, B } = await firstReads({ read: () => readOf(0), at: at(1_000) }, { read: () => readOf(2), at: at(1_100) }, order);
    assert.deepEqual(await incidents(), ['OK', null, at(1_100).toISOString(), at(1_100).toISOString(), ['9001', '9002']], order);
    assert.deepEqual([A.status, A.superseded, B.status, B.superseded], ['OK', order === 'B then A', 'OK', false], order);
  }
});

test('first reads, success then a later failure: the newer failure shows the last snapshot as STALE; in the other order the older read is superseded', async () => {
  const success = { read: () => readOf(2), at: at(2_000) };
  const failure = { read: failing, at: at(2_100) };
  const earlierFirst = await firstReads(success, failure, 'A then B');
  assert.deepEqual(await incidents(), ['STALE', 'UPSTREAM_UNAVAILABLE', at(2_000).toISOString(), at(2_000).toISOString(), ['9001', '9002']]);
  assert.deepEqual([earlierFirst.A.superseded, earlierFirst.B.status, earlierFirst.B.superseded], [false, 'ERROR', false]);
  const failureFirst = await firstReads(success, failure, 'B then A');
  assert.deepEqual(await incidents(), ['ERROR', 'UPSTREAM_UNAVAILABLE', null, null, null], 'the newer failure is the state; the older complete read does not replace it');
  assert.deepEqual([failureFirst.A.status, failureFirst.A.superseded, failureFirst.B.superseded], ['OK', true, false]);
  const row = await state('incident');
  assert.deepEqual([row.status, row.syncAt, row.successAt], ['ERROR', at(2_100).toISOString(), null]);
});

test('first reads, failure then a later success: the newer success is recorded in both completion orders', async () => {
  for (const order of ['A then B', 'B then A'] as const) {
    const { A, B } = await firstReads({ read: failing, at: at(3_000) }, { read: () => readOf(2), at: at(3_100) }, order);
    assert.deepEqual(await incidents(), ['OK', null, at(3_100).toISOString(), at(3_100).toISOString(), ['9001', '9002']], order);
    assert.deepEqual([A.status, A.superseded, B.superseded], ['ERROR', order === 'B then A', false], order);
  }
});

test('first reads with identical times: the begin order decides', async () => {
  for (const order of ['A then B', 'B then A'] as const) {
    await firstReads({ read: () => readOf(0), at: at(4_000) }, { read: () => readOf(2), at: at(4_000) }, order);
    assert.deepEqual(await incidents(), ['OK', null, at(4_000).toISOString(), at(4_000).toISOString(), ['9001', '9002']], order);
  }
});

test('identities, first reads: a later-begun success is recorded, an older failure never overwrites it', async () => {
  const agents = await real.readIdentities(connection);
  for (const order of ['A then B', 'B then A'] as const) {
    await reset('agent');
    const A = held(failing, () => { throw new AtlasError('UPSTREAM_UNAVAILABLE', 'TRANSIENT'); });
    const B = held(failing, () => agents);
    const runA = syncIdentities(db, actors.sync, connection, A.connector, at(5_000));
    await A.started;
    const runB = syncIdentities(db, actors.sync, connection, B.connector, at(5_100));
    await B.started;
    assert.deepEqual(await numbers('agent'), ['PENDING|2|0']);
    if (order === 'A then B') { A.release(); await runA; B.release(); await runB; } else { B.release(); await runB; A.release(); await runA; }
    const row = await state('agent');
    assert.deepEqual([row.status, row.syncAt, row.successAt, (await runA).superseded, (await runB).superseded],
      ['OK', at(5_100).toISOString(), at(5_100).toISOString(), order === 'B then A', false], order);
  }
});

test('a later-begun attempt with an older time (a skewed clock) records nothing: recorded times never go back', async () => {
  await reset('incident');
  const first = held(() => readOf(2));
  first.release();
  assert.equal((await syncResource(db, actors.sync, connection, first.connector, 'incident', at(6_100))).status, 'OK');
  const skewed = held(failing);
  skewed.release();
  const late = await syncResource(db, actors.sync, connection, skewed.connector, 'incident', at(6_000));
  assert.deepEqual([late.status, late.superseded], ['ERROR', true]);
  assert.deepEqual(await incidents(), ['OK', null, at(6_100).toISOString(), at(6_100).toISOString(), ['9001', '9002']]);
});
