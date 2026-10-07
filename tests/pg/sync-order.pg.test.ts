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
