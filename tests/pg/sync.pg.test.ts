import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { bindConnection, resolveConnection } from '../../packages/connections/connections.ts';
import { activateConnection } from '../../packages/sync/activation.ts';
import { connectorFor, syncConnection, syncResource } from '../../packages/sync/snapshots.ts';
import { getClientContext } from '../../packages/graph/prisma-context.ts';
import { EnvSecretResolver } from '../../connectors/secrets.ts';
import { createTestDatabase, runSeed } from '../support/pg-harness.ts';
import { actors, gasta } from '../support/graph-fixtures.ts';
import { gastaVendor, testSecrets } from '../support/vendor-routes.ts';

// Task 1.5 snapshot repository on PostgreSQL 17 through the runtime role, mock vendor: complete reads replace the snapshot
// atomically; failures keep it (STALE) and never advance lastSuccessAt; bounded items; identities feed the matcher.
const pgdb = await createTestDatabase();
const db = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
after(async () => { await db.$disconnect(); await pgdb.drop(); });
runSeed(pgdb.ownerUrl);
const vendor = gastaVendor();
const io = { transport: vendor.transport, secrets: new EnvSecretResolver(testSecrets) };
for (const [connectionId, system, externalTenantId, secretRef] of [['gasta-huntress', 'huntress', '7001', 'env://HUNTRESS_GASTA'], ['gasta-atera', 'atera', '5001', 'env://ATERA_GASTA']] as const) {
  await bindConnection(db, actors.admin, gasta, { connectionId, system, externalTenantId, secretRef });
  assert.deepEqual(await activateConnection(db, actors.admin, gasta, connectionId, io), { status: 'ACTIVE' });
}
const T = Date.now();
const at = (minutesAgo: number) => new Date(T - minutesAgo * 60_000);
const huntress = await resolveConnection(db, actors.sync, gasta, 'gasta-huntress', 'sync');
const atera = await resolveConnection(db, actors.sync, gasta, 'gasta-atera', 'sync');
const view = async (connectionId: string, resourceType: string) =>
  (await getClientContext(db, actors.reader, gasta)).resources.find(r => r.connectionId === connectionId && r.resourceType === resourceType)!;
const syncState = async (connectionId: string, resourceType: string) => (await pgdb.owner.query(`SELECT status, "safeErrorCode" AS code,
  "lastSyncAt" AS "lastSyncAt", "lastSuccessAt" AS "lastSuccessAt" FROM "SyncState" WHERE "connectionId" = $1 AND "resourceType" = $2`, [connectionId, resourceType])).rows[0];
const ids = (items: unknown) => (items as { externalId: string; severity: string | null }[]).map(i => `${i.externalId}:${i.severity}`);

test('a complete read replaces the snapshot and records success in one transaction; the context shows it OK and contact-free', async () => {
  const result = await syncConnection(db, actors.sync, huntress, io, at(5));
  assert.deepEqual(result.identities, { status: 'OK', registered: 2, candidates: 1, ambiguous: 0, safeErrorCode: null, errorKind: null });
  assert.deepEqual(result.resources.map(r => [r.resourceType, r.status, r.itemCount]), [['incident', 'OK', 2]]);
  const incidents = await view('gasta-huntress', 'incident');
  assert.deepEqual([incidents.status, incidents.asOf, incidents.truncated, ids(incidents.items)], ['OK', at(5).toISOString(), false, ['9001:CRITICAL', '9002:LOW']]);
  assert.ok(!JSON.stringify(incidents).includes('Analyst narrative'));
  const candidates = (await pgdb.owner.query(`SELECT l.status||':'||l.method||':'||l."entityId"||':'||x."externalId" AS s FROM "EntityLink" l
    JOIN "ExternalEntity" x ON x."workspaceId" = l."workspaceId" AND x."clientId" = l."clientId" AND x.id = l."externalEntityId" WHERE x."connectionId" = 'gasta-huntress'`)).rows.map(r => r.s);
  assert.deepEqual(candidates, ['CANDIDATE:HOSTNAME_EXACT:demo-device-07:207001'], 'GASTA-LT-07 proposed, never confirmed; GASTA-LT-08 has no device here');
});

test('a failed refresh keeps the last snapshot (STALE, with the failure code) and never advances lastSuccessAt; Retry-After travels', async () => {
  const connector = connectorFor(db, actors.sync, huntress, io);
  vendor.overrides.huntressIncidents = { status: 500 };
  const failed = await syncResource(db, actors.sync, huntress, connector, 'incident', at(3));
  assert.deepEqual([failed.status, failed.safeErrorCode, failed.errorKind], ['ERROR', 'UPSTREAM_UNAVAILABLE', 'TRANSIENT']);
  const stale = await view('gasta-huntress', 'incident');
  assert.deepEqual([stale.status, stale.safeErrorCode, stale.asOf, stale.lastSuccessAt, ids(stale.items)],
    ['STALE', 'UPSTREAM_UNAVAILABLE', at(5).toISOString(), at(5).toISOString(), ['9001:CRITICAL', '9002:LOW']]);
  const row = await syncState('gasta-huntress', 'incident');
  assert.deepEqual([row.status, row.code, row.lastSyncAt.getTime() > row.lastSuccessAt.getTime()], ['ERROR', 'UPSTREAM_UNAVAILABLE', true]);
  vendor.overrides.huntressIncidents = { status: 429, headers: { 'retry-after': '30' } };
  const limited = await syncResource(db, actors.sync, huntress, connector, 'incident', at(2));
  assert.deepEqual([limited.safeErrorCode, limited.errorKind, limited.retryAfterSeconds], ['UPSTREAM_RATE_LIMITED', 'TRANSIENT', '30']);
  delete vendor.overrides.huntressIncidents;
  assert.equal((await syncResource(db, actors.sync, huntress, connector, 'incident', at(1))).status, 'OK');
  assert.deepEqual([(await view('gasta-huntress', 'incident')).status, (await view('gasta-huntress', 'incident')).asOf], ['OK', at(1).toISOString()]);
});

test('Atera: a read failing on page 2 keeps nothing of it; an old snapshot is STALE by age; alerts are UNAVAILABLE and never requested', async () => {
  const result = await syncConnection(db, actors.sync, atera, io, at(40));
  assert.deepEqual(result.resources.map(r => `${r.resourceType}:${r.status}:${r.safeErrorCode}`), ['ticket:OK:null', 'alert:UNAVAILABLE:UPSTREAM_TENANT_FILTER_UNAVAILABLE']);
  const tickets = await view('gasta-atera', 'ticket');
  assert.deepEqual([tickets.status, tickets.safeErrorCode, (tickets.items as unknown[]).length], ['STALE', 'SNAPSHOT_STALE', 2], '40 minutes is beyond the 30-minute window');
  const alerts = await view('gasta-atera', 'alert');
  assert.deepEqual([alerts.status, alerts.safeErrorCode, alerts.items], ['MISSING', 'UPSTREAM_TENANT_FILTER_UNAVAILABLE', null]);
  vendor.overrides.ateraTicketsPage2 = { status: 503 };
  const failed = await syncResource(db, actors.sync, atera, connectorFor(db, actors.sync, atera, io), 'ticket', at(4));
  delete vendor.overrides.ateraTicketsPage2;
  assert.equal(failed.safeErrorCode, 'UPSTREAM_UNAVAILABLE');
  const kept = await view('gasta-atera', 'ticket');
  assert.deepEqual([kept.status, kept.safeErrorCode, kept.asOf, (kept.items as unknown[]).length], ['STALE', 'UPSTREAM_UNAVAILABLE', at(40).toISOString(), 2]);
  // The failure belongs to that resource: its sibling and the other connection keep their own state, the connection stays ACTIVE
  assert.deepEqual([(await view('gasta-atera', 'alert')).safeErrorCode, (await view('gasta-huntress', 'incident')).status], ['UPSTREAM_TENANT_FILTER_UNAVAILABLE', 'OK']);
  assert.deepEqual((await pgdb.owner.query(`SELECT status FROM "Connection" WHERE id = 'gasta-atera'`)).rows, [{ status: 'ACTIVE' }]);
  assert.equal((await resolveConnection(db, actors.sync, gasta, 'gasta-atera', 'sync')).connectionId, 'gasta-atera');
  assert.ok(vendor.requests.every(r => !r.url.pathname.startsWith('/api/v3/alerts')));
});

test('bounded: at most 100 items, most severe first, with the source total; a resource never read completely is ERROR, not empty', async () => {
  const severities = ['low', 'high', 'critical'];
  const reports = Array.from({ length: 150 }, (_, i) => ({ id: 10_000 + i, organization_id: 7001, agent_id: null, severity: severities[i % 3], status: 'sent',
    subject: `Synthetic ${i}`, updated_at: new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString() }));
  vendor.overrides.huntressIncidents = { status: 200, body: { incident_reports: reports, pagination: {} } };
  const synced = await syncResource(db, actors.sync, huntress, connectorFor(db, actors.sync, huntress, io), 'incident', new Date());
  delete vendor.overrides.huntressIncidents;
  assert.equal(synced.itemCount, 150);
  const bounded = await view('gasta-huntress', 'incident');
  const items = bounded.items as { severity: string }[];
  assert.deepEqual([bounded.status, items.length, bounded.truncated], ['OK', 100, true]);
  assert.ok(items.slice(0, 50).every(i => i.severity === 'CRITICAL') && items.slice(50, 100).every(i => i.severity === 'HIGH'));
  await bindConnection(db, actors.admin, gasta, { connectionId: 'gasta-huntress-b', system: 'huntress', externalTenantId: '7003', secretRef: 'env://HUNTRESS_GASTA' });
  vendor.state.extra = url => url.host !== 'api.huntress.io' ? undefined
    : url.pathname === '/v1/organizations/7003' ? { status: 200, body: { organization: { id: 7003 } } }
    : url.pathname === '/v1/incident_reports' && url.searchParams.get('organization_id') === '7003' ? { status: 503 } : undefined;
  assert.deepEqual(await activateConnection(db, actors.admin, gasta, 'gasta-huntress-b', io), { status: 'ACTIVE' });
  const second = await resolveConnection(db, actors.sync, gasta, 'gasta-huntress-b', 'sync');
  await syncResource(db, actors.sync, second, connectorFor(db, actors.sync, second, io), 'incident', new Date());
  vendor.state.extra = null;
  const never = await view('gasta-huntress-b', 'incident');
  assert.deepEqual([never.status, never.safeErrorCode, never.items], ['ERROR', 'UPSTREAM_UNAVAILABLE', null]);
});
