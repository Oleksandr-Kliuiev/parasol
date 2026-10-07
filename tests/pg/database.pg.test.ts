import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import type { Actor } from '../../packages/core/contracts.ts';
import { assertRuntimeRole, withScope, withWorkspaceScope } from '../../packages/graph/scoped-db.ts';
import { PrismaAudit, PrismaSecurityAudit, listClientAudit, listSecurityAudit } from '../../packages/audit/prisma.ts';
import { scope, actor } from '../../fixtures/gasta.ts';
import { migrationNames } from '../support/migrations.ts';
import { createTestDatabase, runSeed, singleConnection } from '../support/pg-harness.ts';

// Task 1.2 on a real PostgreSQL 17 server through Prisma: deploy, runtime role, repeat seed, composite FKs, RLS via withScope,
// PostgreSQL audit sinks. The pool of the runtime client has ONE connection, so "context ends with the transaction" is
// checked on the same physical connection.
const pgdb = await createTestDatabase();
const runtime = new PrismaClient({ datasourceUrl: singleConnection(pgdb.runtimeUrl) });
const ownerPrisma = new PrismaClient({ datasourceUrl: pgdb.ownerUrl });
after(async () => { await runtime.$disconnect(); await ownerPrisma.$disconnect(); await pgdb.drop(); });

const count = async (sql: string, params: unknown[] = []) => Number((await pgdb.owner.query(sql, params)).rows[0].n);
const snapshot = async (): Promise<Record<string, unknown[]>> => {
  const out: Record<string, unknown[]> = {};
  for (const table of ['Workspace', 'Client', 'Entity', 'Person', 'Device', 'Connection', 'ExternalEntity', 'EntityLink']) {
    out[table] = (await pgdb.owner.query(`SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY to_jsonb(t)::text`)).rows.map(r => r.row);
  }
  return out;
};

test('prisma migrate deploy applies every migration on a real PostgreSQL 17 server', async () => {
  assert.match(pgdb.serverVersion, /^17\./);
  const rows = (await pgdb.owner.query(`SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name`)).rows;
  assert.deepEqual(rows.map(r => r.migration_name), await migrationNames());
  assert.ok(rows.every(r => r.finished_at !== null && r.rolled_back_at === null));
});

test('roles.sql creates a confined runtime role: the startup guard accepts it and rejects the owner', async () => {
  await assertRuntimeRole(runtime);
  await assert.rejects(assertRuntimeRole(ownerPrisma), /RUNTIME_ROLE_BYPASSES_RLS/);
  const role = (await pgdb.owner.query(`SELECT rolsuper, rolbypassrls, rolinherit, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = $1`, [pgdb.runtimeRole])).rows[0];
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false, rolinherit: false, rolcreatedb: false, rolcreaterole: false });
  const can = async (table: string, privilege: string) =>
    (await pgdb.owner.query(`SELECT has_table_privilege($1, $2, $3) AS ok`, [pgdb.runtimeRole, `"${table}"`, privilege])).rows[0].ok as boolean;
  for (const table of ['Client', 'Device', 'RawEvent', 'Observation', 'AuditEvent', 'SecurityAuditEvent']) {
    assert.equal(await can(table, 'DELETE'), false, `${table} DELETE`);
    assert.equal(await can(table, 'TRUNCATE'), false, `${table} TRUNCATE`);
  }
  assert.equal(await can('AuditEvent', 'UPDATE'), false);
  assert.equal(await can('SecurityAuditEvent', 'UPDATE'), false);
  assert.equal(await can('_prisma_migrations', 'SELECT'), false);
});

test('synthetic seed: Gasta → Kari → GASTA-LT-07 with two confirmed source mappings; a second run changes nothing', async () => {
  runSeed(pgdb.ownerUrl);
  const first = await snapshot();
  assert.deepEqual(first.Client, [{ workspaceId: 'demo-vardahei', id: 'demo-gasta', name: 'Gasta (synthetic)' }]);
  assert.deepEqual((first.Person as { displayName: string }[]).map(p => p.displayName), ['Kari (synthetic)']);
  assert.deepEqual((first.Device as { id: string; hostname: string; personId: string }[]).map(d => [d.id, d.hostname, d.personId]),
    [['demo-device-07', 'GASTA-LT-07', 'demo-kari']]);
  const mappings = (await pgdb.owner.query(`
    SELECT c.system, x."resourceType", x."externalId", l."entityId", l.status, l."confirmedBy" IS NOT NULL AND l."confirmedAt" IS NOT NULL AS confirmed
    FROM "EntityLink" l
    JOIN "ExternalEntity" x ON x."workspaceId" = l."workspaceId" AND x."clientId" = l."clientId" AND x.id = l."externalEntityId"
    JOIN "Connection" c ON c."workspaceId" = x."workspaceId" AND c."clientId" = x."clientId" AND c.id = x."connectionId"
    ORDER BY c.system`)).rows;
  assert.deepEqual(mappings, [
    { system: 'atera', resourceType: 'agent', externalId: 'demo-atera-agent-107', entityId: 'demo-device-07', status: 'CONFIRMED', confirmed: true },
    { system: 'huntress', resourceType: 'agent', externalId: 'demo-huntress-agent-207', entityId: 'demo-device-07', status: 'CONFIRMED', confirmed: true }
  ]);
  // Connections carry a secret reference, never a credential
  assert.ok((first.Connection as { secretRef: string }[]).every(c => c.secretRef === 'fixture://no-credentials'));
  runSeed(pgdb.ownerUrl);
  assert.deepEqual(await snapshot(), first, 'the second seed run neither duplicates nor changes the graph');
});

test('composite foreign keys reject cross-client links even for the owner, who bypasses RLS', async () => {
  await pgdb.owner.query(`
    INSERT INTO "Client" VALUES ('demo-vardahei','demo-other','Other client (synthetic)');
    INSERT INTO "Entity" VALUES ('demo-vardahei','demo-other','other-device','DEVICE');
    INSERT INTO "Device" VALUES ('demo-vardahei','demo-other','other-device','OTHER-PC',NULL);
    INSERT INTO "Connection" VALUES ('demo-vardahei','demo-other','other-atera','atera','atera-synthetic-other','fixture://no-credentials','FIXTURE');
    INSERT INTO "ExternalEntity" VALUES ('demo-vardahei','demo-other','other-ext','other-atera','agent','demo-atera-agent-999','{}',now());`);
  // A device of another client cannot be assigned to Kari; a Gasta device cannot be linked to another client's agent
  await assert.rejects(ownerPrisma.device.update({ where: { workspaceId_clientId_id: { workspaceId: 'demo-vardahei', clientId: 'demo-other', id: 'other-device' } },
    data: { personId: 'demo-kari' } }), (e: { code?: string }) => e.code === 'P2003');
  await assert.rejects(pgdb.owner.query(`INSERT INTO "EntityLink" VALUES ('demo-vardahei','demo-gasta','cross-link','demo-device-07','other-ext','CANDIDATE','MANUAL',NULL,NULL,NULL)`), /foreign key/);
  // The same holds for the runtime role with both clients in scope
  const both: Actor = { ...actor, memberships: [...actor.memberships, { clientId: 'demo-other', permissions: ['context:read'] }] };
  await assert.rejects(withScope(runtime, both, [scope.clientId, 'demo-other'], tx => tx.entityLink.create({ data: { workspaceId: 'demo-vardahei',
    clientId: 'demo-gasta', id: 'cross-link-2', entityId: 'demo-device-07', externalEntityId: 'other-ext', method: 'MANUAL' } })), (e: { code?: string }) => e.code === 'P2003');
});

test('withScope confines Prisma queries through the runtime role: no context → nothing, one client without a where clause, context ends with the transaction', async () => {
  assert.equal(await runtime.client.count(), 0, 'no context: nothing visible');
  assert.equal(await runtime.device.count(), 0);
  await assert.rejects(runtime.auditEvent.create({ data: { workspaceId: 'demo-vardahei', clientId: 'demo-gasta', id: 'no-context', actorId: actor.id,
    eventType: 'test', correlationId: 'c', metadata: {} } }), /row-level security/);
  const devices = await withScope(runtime, actor, [scope.clientId], tx => tx.device.findMany({ select: { clientId: true, hostname: true } }));
  assert.deepEqual(devices, [{ clientId: 'demo-gasta', hostname: 'GASTA-LT-07' }], 'only the scoped client, although the query has no where clause');
  assert.equal(await withScope(runtime, actor, [scope.clientId], tx => tx.device.count({ where: { clientId: 'demo-other' } })), 0);
  assert.equal(await runtime.device.count(), 0, 'the context ended with the transaction on the same pooled connection');
  const both: Actor = { ...actor, memberships: [...actor.memberships, { clientId: 'demo-other', permissions: ['context:read'] }] };
  assert.equal(await withScope(runtime, both, [scope.clientId, 'demo-other'], tx => tx.client.count()), 2);
  await assert.rejects(withScope(runtime, actor, ['demo-other'], async () => 1), /SCOPE_DENIED/);
  await assert.rejects(withScope(runtime, actor, [scope.clientId], tx => tx.auditEvent.create({ data: { workspaceId: 'demo-vardahei', clientId: 'demo-other',
    id: 'cross-write', actorId: actor.id, eventType: 'test', correlationId: 'c', metadata: {} } })), /row-level security/);
  assert.equal(await withWorkspaceScope(runtime, actor, tx => tx.device.count()), 0, 'workspace scope sees no client rows');
});

test('audit sinks: a denial reaches only the workspace security log; the client audit keeps allowlisted metadata; both are append-only', async () => {
  await new PrismaSecurityAudit(runtime, actor).append({ workspaceId: actor.workspaceId, actorId: actor.id, eventType: 'client.overview_denied',
    outcome: 'DENIED', requestedClientId: 'ghost-client', reasonCode: 'SCOPE_DENIED', correlationId: 'corr-1', metadata: { tool: 'x', summary: 'leak' } });
  const security = await listSecurityAudit(runtime, actor);
  assert.deepEqual(security.map(s => [s.eventType, s.requestedClientId, s.reasonCode, s.metadata]), [['client.overview_denied', 'ghost-client', 'SCOPE_DENIED', { tool: 'x' }]]);
  assert.equal(await count(`SELECT count(*)::int AS n FROM "AuditEvent"`), 0, 'no client log was touched');
  await assert.rejects(listSecurityAudit(runtime, { ...actor, workspacePermissions: [] }), /PERMISSION_DENIED/);
  await new PrismaAudit(runtime, actor).append(scope, actor.id, 'tool.succeeded', 'corr-2', { tool: 'atlas.client.get_context', summary: 'leak', email: 'kari@example.invalid' });
  const audit = await listClientAudit(runtime, actor, scope);
  assert.deepEqual(audit.map(a => [a.eventType, a.metadata]), [['tool.succeeded', { tool: 'atlas.client.get_context' }]]);
  await assert.rejects(new PrismaAudit(runtime, actor).append(scope, 'someone-else', 'x', 'c', {}), /AUDIT_ACTOR_MISMATCH/);
  await assert.rejects(withScope(runtime, actor, [scope.clientId], tx => tx.auditEvent.updateMany({ data: { eventType: 'changed' } })), /permission denied/);
  await assert.rejects(withWorkspaceScope(runtime, actor, tx => tx.securityAuditEvent.deleteMany({})), /permission denied/);
  await assert.rejects(pgdb.owner.query(`UPDATE "AuditEvent" SET "eventType" = 'changed'`), /append-only/);
});
