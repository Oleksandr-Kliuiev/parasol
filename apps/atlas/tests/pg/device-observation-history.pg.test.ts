import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import type { Actor } from '../../packages/core/contracts.ts';
import { observationStatuses } from '../../packages/core/contracts.ts';
import { generateToken } from '../../packages/auth/token.ts';
import { ingestEvent } from '../../packages/events/inbox.ts';
import { processPending } from '../../packages/events/worker.ts';
import { confirmLink, proposeLink, registerExternalEntity, rejectLink } from '../../packages/graph/mapping.ts';
import { getClientContext, getObservationPage } from '../../packages/graph/prisma-context.ts';
import { triageObservation } from '../../packages/observations/lifecycle.ts';
import { activeQuery } from '../../packages/observations/query.ts';
import { createTestDatabase, runSeed } from '../support/pg-harness.ts';
import { addMappingFixtures, actors, gasta, other } from '../support/graph-fixtures.ts';
import { CountingProvider, incident, liveHuntressWithConfirmedAgent } from '../support/events-fixtures.ts';
import { startApi, type ApiProcess } from '../support/api-process.ts';

const database = await createTestDatabase();
const db = new PrismaClient({ datasourceUrl: database.runtimeUrl });
const token = generateToken();
let api: ApiProcess | undefined;
after(async () => { await api?.stop(); await db.$disconnect(); await database.drop(); });
const device = 'demo-device-07';
const selection = { ...activeQuery(25), deviceId: device };
const triager: Actor = { ...actors.reader, memberships: [{ clientId: gasta.clientId, permissions: ['context:read', 'observations:triage'] }] };

before(async () => {
  runSeed(database.ownerUrl, { ATLAS_DEMO_TOKEN: token });
  await addMappingFixtures(database.owner);
  await database.owner.query(`UPDATE "Device" SET hostname = (SELECT hostname FROM "Device" WHERE id = $1 AND "clientId" = $2)
    WHERE id = 'dev-08' AND "clientId" = $2`, [device, gasta.clientId]);
  const { connection } = await liveHuntressWithConfirmedAgent(db);
  const second = await registerExternalEntity(db, actors.sync, connection, {
    resourceType: 'agent', externalId: '207002', attributes: { hostname: 'Same name is not identity' }, observedAt: new Date(),
  });
  await confirmLink(db, actors.reviewer, gasta, (await proposeLink(db, actors.reviewer, gasta, { externalEntityId: second.id, entityId: 'dev-08' })).linkId);
  for (let i = 0; i < 31; i++) await ingestEvent(db, actors.sync, connection, incident(connection, `device-one-${i}`, i < 26 ? 'CRITICAL' : 'HIGH'));
  for (let i = 0; i < 7; i++) await ingestEvent(db, actors.sync, connection, incident(connection, `device-two-${i}`, 'LOW', { agent: '207002' }));
  await ingestEvent(db, actors.sync, connection, incident(connection, 'unresolved-device', 'CRITICAL', { agent: null }));
  const processed = await processPending(db, actors.sync, gasta, { workerId: 'device-history-test', provider: new CountingProvider(), batchSize: 50 });
  assert.equal(processed.filter(o => o.status === 'PROCESSED').length, 39);
  const high = await getObservationPage(db, actors.reader, gasta, { ...selection, severities: ['HIGH'] });
  await triageObservation(db, triager, gasta, high.items[0]!.id, 'resolve');
  api = await startApi({ ATLAS_MODE: 'db', ATLAS_RUNTIME_DATABASE_URL: database.runtimeUrl });
});

const request = (query: string, clientId = gasta.clientId) => fetch(`${api!.base}/clients/${clientId}/observations?${query}`, {
  headers: { Authorization: `Bearer ${token}` },
});

test('exact device selection covers every page and its full counts despite identical hostnames and unresolved events', async () => {
  const context = await getClientContext(db, actors.reader, gasta);
  const names = context.devices.filter(d => [device, 'dev-08'].includes(d.id)).map(d => d.hostname);
  assert.equal(names.length, 2); assert.equal(names[0], names[1]);
  const first = await getObservationPage(db, actors.reader, gasta, selection);
  assert.deepEqual([first.total, first.items.length, first.counts.CRITICAL, first.counts.HIGH, first.counts.LOW], [30, 25, 26, 4, 0]);
  assert.ok(first.nextCursor);
  const next = await getObservationPage(db, actors.reader, gasta, { ...selection, cursor: first.nextCursor });
  assert.deepEqual([next.total, next.items.length, next.nextCursor], [30, 5, null]);
  const all = [...first.items, ...next.items];
  assert.equal(new Set(all.map(o => o.id)).size, 30);
  assert.ok(all.every(o => o.entityId === device));
  const history = await getObservationPage(db, actors.reader, gasta, { ...selection, statuses: [...observationStatuses], limit: 100 });
  assert.deepEqual([history.total, history.items.filter(o => o.status === 'RESOLVED').length], [31, 1]);
  const second = await getObservationPage(db, actors.reader, gasta, { ...selection, deviceId: 'dev-08' });
  assert.deepEqual([second.total, second.counts.LOW], [7, 7]);
  assert.ok(second.items.every(o => o.entityId === 'dev-08'));
});

test('compiled HTTP API applies the device filter and refuses a continuation under a different device', async () => {
  const response = await request(`deviceId=${device}&limit=25`);
  assert.equal(response.status, 200);
  const page = await response.json() as { total: number; items: { entityId: string }[]; nextCursor: string };
  assert.deepEqual([page.total, page.items.length], [30, 25]);
  assert.ok(page.items.every(o => o.entityId === device));
  const next = await request(`deviceId=${device}&limit=25&cursor=${page.nextCursor}`);
  assert.equal(next.status, 200); assert.equal((await next.json() as { items: unknown[] }).items.length, 5);
  const changed = await request(`deviceId=dev-08&limit=25&cursor=${page.nextCursor}`);
  assert.equal(changed.status, 400); await changed.arrayBuffer();
  const unfiltered = await request(`limit=25&cursor=${page.nextCursor}`);
  assert.equal(unfiltered.status, 400); await unfiltered.arrayBuffer();
});

test('missing, foreign and non-device identifiers disclose no other registry or observations; caller scope is still required', async () => {
  const person = (await getClientContext(db, actors.reader, gasta)).people[0]!.id;
  for (const deviceId of ['absent', 'other-dev', person]) {
    const page = await getObservationPage(db, actors.reader, gasta, { ...selection, deviceId });
    assert.deepEqual([page.total, page.items, page.nextCursor], [0, [], null]);
    assert.equal(Object.values(page.counts).reduce((a, b) => a + b, 0), 0);
  }
  await assert.rejects(getObservationPage(db, actors.reader, other, { ...selection, deviceId: 'other-dev' }), /SCOPE_DENIED/);
  const denied = await request('deviceId=other-dev', other.clientId);
  assert.equal(denied.status, 403); await denied.arrayBuffer();
});

test('stored device history survives revoking its current source link without inventing a new confirmed link', async () => {
  const context = await getClientContext(db, actors.reader, gasta);
  const current = context.links.filter(link => link.entityId === device && link.system === 'huntress' && link.resourceType === 'agent');
  assert.ok(current.length > 0);
  for (const link of current) {
    const links = await database.owner.query(`SELECT l.id FROM "EntityLink" l JOIN "ExternalEntity" e
      ON e."workspaceId" = l."workspaceId" AND e."clientId" = l."clientId" AND e.id = l."externalEntityId"
      WHERE l."workspaceId" = $1 AND l."clientId" = $2 AND l."entityId" = $3
      AND e."connectionId" = $4 AND e."externalId" = $5 AND l.status = 'CONFIRMED'`,
    [gasta.workspaceId, gasta.clientId, device, link.connectionId, link.externalId]);
    assert.equal(links.rows.length, 1);
    await rejectLink(db, actors.reviewer, gasta, links.rows[0].id);
  }
  const refreshed = await getClientContext(db, actors.reader, gasta);
  assert.equal(refreshed.links.some(link => link.entityId === device && link.system === 'huntress'), false);
  const history = await getObservationPage(db, actors.reader, gasta, { ...selection, statuses: [...observationStatuses], limit: 100 });
  assert.equal(history.total, 31); assert.ok(history.items.every(o => o.entityId === device));
});

test('malformed device IDs fail at the HTTP and direct service boundaries before querying PostgreSQL text', async () => {
  for (const query of ['deviceId=', 'deviceId=one&deviceId=two', 'deviceId=pc%00bad', `deviceId=${'x'.repeat(257)}`]) {
    const response = await request(query); assert.equal(response.status, 400); await response.arrayBuffer();
  }
  for (const deviceId of ['', '\ud800', '\u0000', ['one', 'two']]) {
    await assert.rejects(getObservationPage(db, actors.reader, gasta, { ...selection, deviceId } as never), /INVALID_OBSERVATION_QUERY/);
  }
});
