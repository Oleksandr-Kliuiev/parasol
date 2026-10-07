import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { bindConnection, resolveConnection } from '../../packages/connections/connections.ts';
import { activateConnection } from '../../packages/sync/activation.ts';
import { connectorFor, syncResource } from '../../packages/sync/snapshots.ts';
import { getClientContext } from '../../packages/graph/prisma-context.ts';
import { EnvSecretResolver } from '../../connectors/secrets.ts';
import { createTestDatabase, runSeed } from '../support/pg-harness.ts';
import { actors, gasta } from '../support/graph-fixtures.ts';
import { gastaVendor, testSecrets } from '../support/vendor-routes.ts';
import type { Endpoint } from '../support/vendor-routes.ts';
import { vendorFixture } from '../support/mock-http.ts';
import type { Reply } from '../support/mock-http.ts';

// Review B4 on PostgreSQL 17: a paged read is complete only when its pages agree with each other. Totals that change
// between pages, an empty page before the declared last one, a repeated ID or a count other than the declared one is a
// visible TRANSIENT error: the previous complete snapshot stays (STALE) and nothing of the inconsistent read is kept.
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
const atera = await resolveConnection(db, actors.sync, gasta, 'gasta-atera', 'sync');
const huntress = await resolveConnection(db, actors.sync, gasta, 'gasta-huntress', 'sync');
const view = async (connectionId: string, resourceType: string) => {
  const v = (await getClientContext(db, actors.reader, gasta)).resources.find(r => r.connectionId === connectionId && r.resourceType === resourceType)!;
  return [v.status, v.safeErrorCode, v.asOf, v.items === null ? null : (v.items as { externalId: string }[]).map(i => i.externalId).sort()];
};
const page = (fixture: string, patch: Record<string, unknown>): Reply => ({ status: 200, body: { ...(vendorFixture(fixture) as object), ...patch } });
const items = (fixture: string, key = 'items') => (vendorFixture(fixture) as Record<string, unknown[]>)[key]!;
/** One read with some pages replaced; the replaced endpoints are restored afterwards. */
async function read(connection: typeof atera, resourceType: 'ticket' | 'incident', overrides: Partial<Record<Endpoint, Reply>>) {
  Object.assign(vendor.overrides, overrides);
  try { return await syncResource(db, actors.sync, connection, connectorFor(db, actors.sync, connection, io), resourceType, new Date()); }
  finally { for (const endpoint of Object.keys(overrides)) delete vendor.overrides[endpoint as Endpoint]; }
}
const events = async () => Number((await pgdb.owner.query(`SELECT count(*)::int AS n FROM "RawEvent"`)).rows[0].n);

test('Atera: inconsistent pages fail the read as TRANSIENT and keep the last complete snapshot', async () => {
  const complete = await read(atera, 'ticket', {});
  assert.deepEqual([complete.status, complete.itemCount], ['OK', 2]);
  const before = await view('gasta-atera', 'ticket');
  assert.deepEqual([before[0], before[3]], ['OK', ['30001', '30002']]);
  const p1 = 'atera/tickets-open-page-1.json'; const p2 = 'atera/tickets-open-page-2.json';
  const cases: [string, Partial<Record<Endpoint, Reply>>][] = [
    ['empty last page with declared remaining items (the reviewer\'s case)', { ateraTicketsPage2: page(p2, { items: [] }) }],
    ['empty nullable last page', { ateraTicketsPage2: page(p2, { items: null }) }],
    ['empty first page while two pages are declared', { ateraTicketsPage1: page(p1, { items: [] }) }],
    ['the same ticket on both pages', { ateraTicketsPage2: page(p2, { items: items(p1) }) }],
    ['totals that change between pages', { ateraTicketsPage2: page(p2, { totalItemCount: 3 }) }],
    ['fewer tickets than both pages declare', { ateraTicketsPage1: page(p1, { totalItemCount: 3 }), ateraTicketsPage2: page(p2, { totalItemCount: 3 }) }],
  ];
  for (const [name, overrides] of cases) {
    const failed = await read(atera, 'ticket', overrides);
    assert.deepEqual([failed.status, failed.safeErrorCode, failed.errorKind], ['ERROR', 'UPSTREAM_PAGINATION_INCONSISTENT', 'TRANSIENT'], name);
    assert.deepEqual(await view('gasta-atera', 'ticket'), ['STALE', 'UPSTREAM_PAGINATION_INCONSISTENT', before[2], ['30001', '30002']], name);
  }
});

test('Atera: a consistent empty set is a complete read of zero tickets, not an error', async () => {
  const empty = await read(atera, 'ticket', { ateraTicketsPage1: page('atera/tickets-open-page-1.json', { items: null, totalPages: 0, totalItemCount: 0, nextLink: null }) });
  assert.deepEqual([empty.status, empty.itemCount], ['OK', 0]);
  const [status, code, , ids] = await view('gasta-atera', 'ticket');
  assert.deepEqual([status, code, ids], ['OK', null, []]);
});

test('Huntress: an incident repeated across pages fails the read; no event of it is stored and the snapshot stays', async () => {
  assert.equal((await read(huntress, 'incident', {})).status, 'OK');
  const before = await view('gasta-huntress', 'incident');
  const stored = await events();
  const reports = items('huntress/incident-reports-sent.json', 'incident_reports');
  const failed = await read(huntress, 'incident', {
    huntressIncidents: { status: 200, body: { incident_reports: reports, pagination: { next_page_token: 'p2' } } },
    huntressIncidentsPage2: { status: 200, body: { incident_reports: reports.slice(1), pagination: {} } },
  });
  assert.deepEqual([failed.status, failed.safeErrorCode, failed.errorKind], ['ERROR', 'UPSTREAM_PAGINATION_INCONSISTENT', 'TRANSIENT']);
  assert.deepEqual(await view('gasta-huntress', 'incident'), ['STALE', 'UPSTREAM_PAGINATION_INCONSISTENT', before[2], before[3]]);
  assert.equal(await events(), stored);
});
