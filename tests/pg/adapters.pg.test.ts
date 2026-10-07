import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { bindConnection, resolveConnection } from '../../packages/connections/connections.ts';
import { activateConnection } from '../../packages/sync/activation.ts';
import { connectorFor } from '../../packages/sync/snapshots.ts';
import { EnvSecretResolver } from '../../connectors/secrets.ts';
import { createTestDatabase, runSeed } from '../support/pg-harness.ts';
import { actors, gasta, WS } from '../support/graph-fixtures.ts';
import { gastaVendor, testSecrets } from '../support/vendor-routes.ts';

// Task 1.5 adapters on PostgreSQL 17 through the runtime role, against a scoped mock vendor (no network, no real account):
// activation with a health check, tenant-scoped upstream requests, pagination, validation, refusal of foreign records.
const pgdb = await createTestDatabase();
const db = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
after(async () => { await db.$disconnect(); await pgdb.drop(); });
runSeed(pgdb.ownerUrl);
const vendor = gastaVendor();
const io = { transport: vendor.transport, secrets: new EnvSecretResolver(testSecrets) };
const admin = actors.admin; const sync = actors.sync;
await bindConnection(db, admin, gasta, { connectionId: 'gasta-huntress', system: 'huntress', externalTenantId: '7001', secretRef: 'env://HUNTRESS_GASTA' });
await bindConnection(db, admin, gasta, { connectionId: 'gasta-atera', system: 'atera', externalTenantId: '5001', secretRef: 'env://ATERA_GASTA' });
const auditTypes = async () => (await pgdb.owner.query(`SELECT "eventType"||':'||coalesce(metadata->>'safeErrorCode','') AS s FROM "AuditEvent" ORDER BY "recordedAt", id`)).rows.map(r => r.s);
const basic = `Basic ${Buffer.from(testSecrets.HUNTRESS_GASTA).toString('base64')}`;

test('activation: a health check against the bound tenant with the resolved credential; a failure keeps the connection DISABLED', async () => {
  vendor.overrides.huntressOrganization = { status: 401 };
  assert.deepEqual(await activateConnection(db, admin, gasta, 'gasta-huntress', io), { status: 'DISABLED', safeErrorCode: 'UPSTREAM_AUTH_FAILED' });
  delete vendor.overrides.huntressOrganization;
  assert.deepEqual(await activateConnection(db, admin, gasta, 'gasta-huntress', io), { status: 'ACTIVE' });
  assert.deepEqual(await activateConnection(db, admin, gasta, 'gasta-atera', io), { status: 'ACTIVE' });
  assert.deepEqual(await activateConnection(db, admin, gasta, 'gasta-atera', io), { status: 'ACTIVE' }, 'idempotent');
  const health = vendor.requests.map(r => `${r.url.host}${r.url.pathname}|${r.headers.Authorization?.split(' ')[0]}`);
  assert.deepEqual(health, ['api.huntress.io/v1/organizations/7001|Basic', 'api.huntress.io/v1/organizations/7001|Basic', 'app.atera.com/api/v3/customers/5001|Bearer']);
  assert.equal(vendor.requests[1]?.headers.Authorization, basic);
  assert.deepEqual(await auditTypes(), ['connection.bound:', 'connection.bound:', 'connection.activation_failed:UPSTREAM_AUTH_FAILED', 'connection.activated:', 'connection.activated:']);
  await bindConnection(db, admin, gasta, { connectionId: 'gasta-huntress-nosecret', system: 'huntress', externalTenantId: '7002', secretRef: 'env://NOT_SET' });
  assert.deepEqual(await activateConnection(db, admin, gasta, 'gasta-huntress-nosecret', io), { status: 'DISABLED', safeErrorCode: 'SECRET_NOT_FOUND' });
  await assert.rejects(activateConnection(db, sync, gasta, 'gasta-huntress', io), /PERMISSION_DENIED/);
});

test('a synthetic FIXTURE connection never reaches a vendor, and only an issued connection is accepted', async () => {
  const before = vendor.requests.length;
  await assert.rejects(activateConnection(db, admin, gasta, 'demo-huntress-connection', io), /FIXTURE_CONNECTION_HAS_NO_UPSTREAM/);
  const fixture = await resolveConnection(db, sync, gasta, 'demo-huntress-connection', 'sync');
  await assert.rejects(connectorFor(db, sync, fixture, io).readSnapshot(fixture, 'incident'), /FIXTURE_CONNECTION_HAS_NO_UPSTREAM/);
  const live = await resolveConnection(db, sync, gasta, 'gasta-huntress', 'sync');
  await assert.rejects(connectorFor(db, sync, live, io).readSnapshot({ ...live }, 'incident'), /CONNECTION_NOT_RESOLVED/);
  assert.equal(vendor.requests.length, before, 'no request was made');
});

test('Huntress: every list request carries organization_id = the bound tenant; pages are followed; a foreign record fails the read', async () => {
  const connection = await resolveConnection(db, sync, gasta, 'gasta-huntress', 'sync');
  const connector = connectorFor(db, sync, connection, io);
  const from = vendor.requests.length;
  const snapshot = await connector.readSnapshot(connection, 'incident');
  assert.deepEqual([snapshot.itemCount, snapshot.items.map(i => `${i.externalId}:${i.severity}`)], [2, ['9001:CRITICAL', '9002:LOW']]);
  assert.deepEqual((await connector.readIdentities(connection)).map(i => `${i.externalId}:${i.attributes.hostname}`), ['207001:GASTA-LT-07', '207008:GASTA-LT-08']);
  const made = vendor.requests.slice(from);
  assert.equal(made.length, 3, 'incidents (1 page) + agents (2 pages)');
  assert.ok(made.every(r => r.url.searchParams.get('organization_id') === '7001' && r.url.searchParams.get('limit') === '100' && r.headers.Authorization === basic));
  assert.equal(made[2]?.url.searchParams.get('page_token'), 'MjAyNi0xMC0wN1QwNzo1NTowMFo');
  vendor.overrides.huntressIncidents = { status: 200, body: { incident_reports: [{ id: 9100, organization_id: 7999, severity: 'low', status: 'sent', updated_at: '2026-10-07T00:00:00Z' }], pagination: {} } };
  await assert.rejects(connector.readSnapshot(connection, 'incident'), /UPSTREAM_SCOPE_MISMATCH/);
  delete vendor.overrides.huntressIncidents;
});

test('Atera: tickets by customerId over every page, agents by customer path, bearer auth; alerts are never requested', async () => {
  const connection = await resolveConnection(db, sync, gasta, 'gasta-atera', 'sync');
  const connector = connectorFor(db, sync, connection, io);
  const from = vendor.requests.length;
  const tickets = await connector.readSnapshot(connection, 'ticket');
  assert.deepEqual([tickets.itemCount, tickets.items.map(i => `${i.externalId}:${i.priority}`)], [2, ['30001:High', '30002:Low']]);
  assert.deepEqual((await connector.readIdentities(connection)).map(i => `${i.externalId}:${i.attributes.hostname}`), ['107001:GASTA-LT-07']);
  const made = vendor.requests.slice(from);
  assert.deepEqual(made.map(r => `${r.url.pathname}?${r.url.searchParams.get('customerId') ?? '-'}&${r.url.searchParams.get('page')}`),
    ['/api/v3/tickets?5001&1', '/api/v3/tickets?5001&2', '/api/v3/agents/customer/5001?-&1']);
  assert.ok(made.every(r => r.headers.Authorization === `Bearer ${testSecrets.ATERA_GASTA}`));
  assert.equal(connector.unavailableResources.alert, 'UPSTREAM_TENANT_FILTER_UNAVAILABLE');
  await assert.rejects(connector.readSnapshot(connection, 'alert'), /RESOURCE_NOT_SUPPORTED/);
  vendor.overrides.ateraTicketsPage2 = { status: 200, body: { items: [{ TicketID: 39999, CustomerID: 5999, TicketStatus: 'Open', TicketPriority: 'Low' }], page: 2, totalPages: 2, totalItemCount: 2 } };
  await assert.rejects(connector.readSnapshot(connection, 'ticket'), /UPSTREAM_SCOPE_MISMATCH/);
  delete vendor.overrides.ateraTicketsPage2;
  assert.ok(vendor.requests.every(r => !r.url.pathname.startsWith('/api/v3/alerts')), 'no MSP-wide alert read, ever');
  assert.ok(!JSON.stringify(await pgdb.owner.query(`SELECT * FROM "AuditEvent"`).then(r => r.rows)).includes(testSecrets.HUNTRESS_GASTA), 'no secret in the audit');
  assert.equal(WS, 'demo-vardahei');
});
