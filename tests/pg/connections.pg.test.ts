import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { AtlasError } from '../../packages/core/contracts.ts';
import { resolveConnection, assertResolvedConnection, bindConnection } from '../../packages/connections/connections.ts';
import { registerExternalEntity } from '../../packages/graph/mapping.ts';
import { createTestDatabase, runSeed } from '../support/pg-harness.ts';
import { actors, addMappingFixtures, gasta, other, WS } from '../support/graph-fixtures.ts';

// Task 1.4 on PostgreSQL 17 through the runtime role: ConnectionsModule issues ResolvedConnection and records explicit
// client ↔ customer/organization bindings.
const pgdb = await createTestDatabase();
const db = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
after(async () => { await db.$disconnect(); await pgdb.drop(); });
runSeed(pgdb.ownerUrl);
await addMappingFixtures(pgdb.owner);
const auditOf = async (clientId: string) => (await pgdb.owner.query(
  `SELECT "actorId", "eventType", metadata FROM "AuditEvent" WHERE "clientId" = $1 ORDER BY "recordedAt", id`, [clientId])).rows as { actorId: string; eventType: string; metadata: Record<string, string> }[];

test('resolveConnection issues a frozen ResolvedConnection with the bound tenant from the database, for enabled connections in scope only', async () => {
  const c = await resolveConnection(db, actors.sync, gasta, 'demo-atera-connection', 'sync');
  assert.deepEqual({ ...c }, { workspaceId: WS, clientId: 'demo-gasta', connectionId: 'demo-atera-connection', system: 'atera', externalTenantId: 'atera-synthetic-gasta' });
  assert.ok(Object.isFrozen(c));
  assertResolvedConnection(c);
  await assert.rejects(resolveConnection(db, actors.sync, gasta, 'other-atera', 'sync'), /CONNECTION_NOT_FOUND/, "another client's connection is invisible");
  await assert.rejects(resolveConnection(db, actors.sync, gasta, 'no-such-connection', 'sync'), /CONNECTION_NOT_FOUND/);
  await assert.rejects(resolveConnection(db, actors.sync, gasta, 'demo-atera-connection', 'read'), /PERMISSION_DENIED/, 'events:ingest does not grant reads');
  await assert.rejects(resolveConnection(db, actors.reviewer, other, 'other-atera', 'sync'), /SCOPE_DENIED/);
});

test('only an issued ResolvedConnection passes: a copied or fabricated one is rejected before any database work', async () => {
  const real = await resolveConnection(db, actors.sync, gasta, 'demo-atera-connection', 'sync');
  const input = { resourceType: 'agent' as const, externalId: 'atera-agent-1', attributes: {}, observedAt: new Date() };
  const fabricated = { workspaceId: WS, clientId: 'demo-gasta', connectionId: 'demo-atera-connection', system: 'atera' as const, externalTenantId: 'atera-anyone' };
  for (const fake of [{ ...real }, fabricated]) {
    assert.throws(() => assertResolvedConnection(fake), /CONNECTION_NOT_RESOLVED/);
    await assert.rejects(registerExternalEntity(db, actors.sync, fake, input), /CONNECTION_NOT_RESOLVED/);
  }
  assert.equal(Number((await pgdb.owner.query(`SELECT count(*)::int AS n FROM "ExternalEntity" WHERE "externalId" = 'atera-agent-1'`)).rows[0].n), 0);
});

test('explicit binding: recorded with who and when, starts DISABLED (does not resolve), audited without tenant ID or secret reference', async () => {
  const at = new Date('2026-10-07T12:00:00Z');
  assert.deepEqual(await bindConnection(db, actors.admin, gasta,
    { connectionId: 'gasta-atera-live', system: 'atera', externalTenantId: '4711', secretRef: 'vault://atlas/atera/gasta' }, at),
    { connectionId: 'gasta-atera-live', status: 'DISABLED' });
  const row = (await pgdb.owner.query(`SELECT status, "boundBy", "boundAt"::text AS "boundAt", "externalTenantId", "secretRef" FROM "Connection" WHERE id = 'gasta-atera-live'`)).rows[0];
  assert.deepEqual([row.status, row.boundBy, row.boundAt, row.externalTenantId, row.secretRef], ['DISABLED', 'demo-admin', '2026-10-07 12:00:00', '4711', 'vault://atlas/atera/gasta']);
  await assert.rejects(resolveConnection(db, actors.sync, gasta, 'gasta-atera-live', 'sync'), /CONNECTION_DISABLED/);
  const audit = await auditOf('demo-gasta');
  assert.deepEqual(audit.map(a => [a.actorId, a.eventType, a.metadata]), [['demo-admin', 'connection.bound', { connectionId: 'gasta-atera-live', system: 'atera' }]]);
  assert.ok(!JSON.stringify(audit).includes('4711') && !JSON.stringify(audit).includes('vault://'));
});

test('one tenant, one client: binding a bound tenant again is rejected as CONFLICT and recorded; the first binding stays', async () => {
  await assert.rejects(bindConnection(db, actors.admin, other, { connectionId: 'other-atera-live', system: 'atera', externalTenantId: '4711', secretRef: 'vault://atlas/atera/other' }),
    (e: AtlasError) => e.code === 'TENANT_ALREADY_BOUND' && e.kind === 'CONFLICT');
  await assert.rejects(bindConnection(db, actors.admin, gasta, { connectionId: 'gasta-atera-live', system: 'atera', externalTenantId: '4712', secretRef: 'vault://atlas/atera/gasta2' }),
    /CONNECTION_EXISTS/);
  assert.deepEqual((await auditOf('demo-other')).map(a => [a.eventType, a.metadata.safeErrorCode]), [['connection.bind_rejected', 'TENANT_ALREADY_BOUND']]);
  const bound = (await pgdb.owner.query(`SELECT "clientId"||'/'||id AS s FROM "Connection" WHERE system = 'atera' AND "externalTenantId" = '4711'`)).rows.map(r => r.s);
  assert.deepEqual(bound, ['demo-gasta/gasta-atera-live']);
  // The same ID in another system is another tenant
  await bindConnection(db, actors.admin, other, { connectionId: 'other-huntress-live', system: 'huntress', externalTenantId: '4711', secretRef: 'vault://atlas/huntress/other' });
});

test('a binding takes only a Stage 1 system, a plain tenant ID and a secret reference — never a credential — and needs connections:manage', async () => {
  const base = { connectionId: 'gasta-huntress-live', system: 'huntress' as const, externalTenantId: 'org-77', secretRef: 'vault://atlas/huntress/gasta' };
  const bad: Record<string, string>[] = [{ secretRef: 'hk_live_1234567890abcdef' }, { secretRef: 'Bearer abc' }, { externalTenantId: '77,78' },
    { externalTenantId: 'org 77' }, { externalTenantId: 'org\u000077' }, { system: 'microsoft365' }, { connectionId: 'bad id' }];
  for (const change of bad) await assert.rejects(bindConnection(db, actors.admin, gasta, { ...base, ...change } as never), /INVALID_BINDING/, JSON.stringify(change));
  await assert.rejects(bindConnection(db, actors.reviewer, gasta, base), /PERMISSION_DENIED/);
  await assert.rejects(bindConnection(db, actors.admin, { workspaceId: WS, clientId: 'demo-elsewhere' }, base), /SCOPE_DENIED/);
  assert.equal(Number((await pgdb.owner.query(`SELECT count(*)::int AS n FROM "Connection" WHERE id = 'gasta-huntress-live'`)).rows[0].n), 0);
});
