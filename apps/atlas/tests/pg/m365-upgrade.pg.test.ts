import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import type { Actor } from '../../packages/core/contracts.ts';
import { assertRuntimeRole } from '../../packages/graph/scoped-db.ts';
import { RUNTIME_ROLE_CHECK_SQL } from '../../packages/graph/runtime-role.ts';
import type { RuntimeRoleFacts } from '../../packages/graph/runtime-role.ts';
import { getClientContext } from '../../packages/graph/prisma-context.ts';
import { seedGraph } from '../sql-invariants.ts';
import type { SqlRunner } from '../sql-invariants.ts';
import { migrationNames } from '../support/migrations.ts';
import { PRISMA_CLI, createTestDatabase, provisionRoles, runWithDatabase, urlFor } from '../support/pg-harness.ts';

// Stage 2 A4/A4a on PostgreSQL 17: a database of the last Stage 1 release, with data and the runtime role as the Stage 1
// prisma/roles.sql created it, upgrades through `prisma migrate deploy` without edits to earlier migrations; the runtime
// stays refused until prisma/roles.sql ran again; provisioning keeps the existing login credential.
const STAGE1_LAST = '202610080000_stage1_tool_gateway';
const pgdb = await createTestDatabase({ migrateThrough: STAGE1_LAST });
after(async () => { await pgdb.drop(); });
const asRunner = (c: pg.Client): SqlRunner => ({ exec: sql => c.query(sql).then(() => undefined), query: async (sql, params) => (await c.query(sql, params)).rows as never });
const stage1Password = randomBytes(18).toString('hex');
const roles = { runtime: pgdb.runtimeRole, definer: pgdb.definerRole, runner: pgdb.runnerRole, fence: pgdb.fenceRole, poDefiner: pgdb.poDefinerRole, poRunner: pgdb.poRunnerRole };
const reader: Actor = { id: 'upgrade-reader', workspaceId: 'w', workspacePermissions: [], memberships: [{ clientId: 'c1', permissions: ['context:read'] }] };

test('populated Stage 1 database → Stage 2 migrations: data and mapping intact, vocabularies extended, runtime refused until roles.sql, credential kept', async () => {
  // The Stage 1 release: its roles.sql (verbatim grants) and synthetic data with confirmed links and memberships
  await pgdb.owner.query(`CREATE ROLE "${roles.runtime}" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${stage1Password}';
    GRANT USAGE ON SCHEMA public TO "${roles.runtime}";
    GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO "${roles.runtime}";
    REVOKE UPDATE ON "AuditEvent", "SecurityAuditEvent" FROM "${roles.runtime}";
    REVOKE INSERT, UPDATE ON "Actor", "ClientMembership", "ApiToken" FROM "${roles.runtime}";
    REVOKE ALL ON "_prisma_migrations" FROM "${roles.runtime}";
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO "${roles.runtime}";`);
  await seedGraph(asRunner(pgdb.owner));
  await pgdb.owner.query(`INSERT INTO "Actor" ("workspaceId","id","displayName") VALUES ('w','upgrade-reader','Reader');
    INSERT INTO "ClientMembership" ("workspaceId","clientId","actorId","permissions") VALUES ('w','c1','upgrade-reader',ARRAY['context:read','mapping:review','observations:triage'])`);
  const links = async () => (await pgdb.owner.query(`SELECT id, "resourceType", "entityKind", status FROM "EntityLink" ORDER BY id`)).rows;
  const linksBefore = await links();
  // Upgrade: the pinned CLI applies only the pending (Stage 2) migrations; the earlier ones keep their recorded checksums
  runWithDatabase(pgdb.ownerUrl, process.execPath, [PRISMA_CLI, 'migrate', 'deploy']);
  const applied = (await pgdb.owner.query(`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY 1`)).rows.map(r => r.migration_name);
  assert.deepEqual(applied, await migrationNames());
  assert.deepEqual(await links(), linksBefore, 'existing links are unchanged');
  assert.deepEqual((await pgdb.owner.query(`SELECT status, "lifecycleVersion" AS v FROM "Connection" ORDER BY id`)).rows.map(r => `${r.status}:${r.v}`),
    ['FIXTURE:0', 'FIXTURE:0', 'FIXTURE:0'], 'existing connections start at version 0');
  await pgdb.owner.query(`UPDATE "ClientMembership" SET permissions = permissions || ARRAY['m365:read'] WHERE "actorId" = 'upgrade-reader'`);
  // Fail closed: the Stage 1 role now has table-level UPDATE on the M365 tables, and the routine still belongs to the owner
  const oldUrl = urlFor(pgdb.ownerUrl, roles.runtime, stage1Password);
  const upgraded = new PrismaClient({ datasourceUrl: oldUrl });
  try {
    const facts = (await upgraded.$queryRawUnsafe<RuntimeRoleFacts[]>(RUNTIME_ROLE_CHECK_SQL))[0]!;
    assert.ok(facts.unguardedUpdateColumns > 0 && facts.cleanupOwnerViolations > 0, JSON.stringify(facts));
    await assert.rejects(assertRuntimeRole(upgraded), /RUNTIME_ROLE_NOT_CONFINED/, 'the upgraded runtime stays stopped until provisioning passed');
    // Provisioning with existing roles: a different password variable does not replace the existing credential
    const offered = randomBytes(18).toString('hex');
    await provisionRoles(pgdb.owner, roles, { runtimePassword: offered, runnerPassword: randomBytes(18).toString('hex') });
    const login = async (password: string) => { const c = new pg.Client({ connectionString: urlFor(pgdb.ownerUrl, roles.runtime, password) });
      try { await c.connect(); return (await c.query('SELECT current_user AS u')).rows[0].u as string; } finally { await c.end().catch(() => undefined); } };
    assert.equal(await login(stage1Password), roles.runtime, 'a new connection still authenticates with the existing credential');
    await assert.rejects(login(offered), /password authentication failed|28P01/, 'the offered password was not applied to an existing role');
    await assertRuntimeRole(upgraded);
    const ctx = await getClientContext(upgraded, reader, { workspaceId: 'w', clientId: 'c1' });
    assert.deepEqual(ctx.links.map(l => `${l.system}:${l.resourceType}:${l.status}`).sort(), ['atera:agent:CONFIRMED', 'huntress:agent:CONFIRMED'],
      'Stage 1 mapping keeps working through the runtime role');
    // Idempotent: a second run changes nothing and still passes
    await provisionRoles(pgdb.owner, roles, { runtimePassword: randomBytes(18).toString('hex'), runnerPassword: randomBytes(18).toString('hex') });
    await assertRuntimeRole(upgraded);
  } finally { await upgraded.$disconnect(); }
  const definer = (await pgdb.owner.query(`SELECT proowner::regrole::text AS owner FROM pg_proc WHERE proname = 'atlas_m365_cleanup'`)).rows[0].owner;
  assert.equal(definer, roles.definer);
});

test('an existing role that is not confined stops provisioning before any change', async () => {
  const probe = `atlas_app_probe_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: pgdb.ownerUrl }); await admin.connect();
  try {
    await admin.query(`CREATE ROLE "${probe}" LOGIN NOINHERIT BYPASSRLS`);
    const before = (await admin.query(`SELECT has_function_privilege($1, 'public.atlas_m365_cleanup(text)', 'EXECUTE') AS runner`, [roles.runner])).rows[0].runner;
    await assert.rejects(provisionRoles(admin, { ...roles, runtime: probe }, { runtimePassword: randomBytes(18).toString('hex'), runnerPassword: randomBytes(18).toString('hex') }),
      /is not confined/);
    await admin.query('ROLLBACK').catch(() => undefined);
    assert.equal((await admin.query(`SELECT has_function_privilege($1, 'public.atlas_m365_cleanup(text)', 'EXECUTE') AS runner`, [roles.runner])).rows[0].runner, before);
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM information_schema.role_table_grants WHERE grantee = $1`, [probe])).rows[0].n, 0, 'no grant to the refused role');
  } finally { await admin.query(`DROP ROLE IF EXISTS "${probe}"`).catch(() => undefined); await admin.end(); }
});

test('the Stage 2 preflight stops an upgrade it cannot interpret (an M365 connection bound to a non-GUID tenant)', async () => {
  const old = await createTestDatabase({ migrateThrough: STAGE1_LAST });
  try {
    await old.owner.query(`INSERT INTO "Workspace" VALUES ('w','Demo'); INSERT INTO "Client" VALUES ('w','c1','Client 1');
      INSERT INTO "Connection" VALUES ('w','c1','m-legacy','microsoft365','contoso.example','env://M365_LEGACY','DISABLED')`);
    assert.throws(() => runWithDatabase(old.ownerUrl, process.execPath, [PRISMA_CLI, 'migrate', 'deploy']), /v2\.2 preflight|lower-case tenant GUID/);
    assert.equal((await old.owner.query(`SELECT count(*)::int AS n FROM pg_tables WHERE tablename LIKE 'M365%'`)).rows[0].n, 0, 'nothing of Stage 2 was applied');
  } finally { await old.drop(); }
});
