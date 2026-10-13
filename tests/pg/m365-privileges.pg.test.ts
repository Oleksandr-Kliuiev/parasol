import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { assertRuntimeRole } from '../../packages/graph/scoped-db.ts';
import { seedGraph } from '../sql-invariants.ts';
import type { SqlRunner } from '../sql-invariants.ts';
import { checkM365Privileges } from '../m365-sql-invariants.ts';
import { checkCleanupRoutine, seedRetentionFixtures } from '../m365-cleanup-invariants.ts';
import { adminUrl, createTestDatabase, provisionRoles, urlFor } from '../support/pg-harness.ts';

// Stage 2 A4a (and the role half of C5a) on PostgreSQL 17: three managed roles per database with unique names, the
// EXECUTE-only cleanup runner logging in with its own credential, the NOLOGIN definer, and a runtime self-check that
// fails closed whenever provisioning drifts — until prisma/roles.sql is applied again.
const pgdb = await createTestDatabase();
const runtime = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
const runnerClient = new pg.Client({ connectionString: pgdb.runnerUrl });
const runtimeClient = new pg.Client({ connectionString: pgdb.runtimeUrl });
await runnerClient.connect(); await runtimeClient.connect();
after(async () => { await runnerClient.end(); await runtimeClient.end(); await runtime.$disconnect(); await pgdb.drop(); });
const asRunner = (c: pg.Client): SqlRunner => ({ exec: sql => c.query(sql).then(() => undefined), query: async (sql, params) => (await c.query(sql, params)).rows as never });
const roles = { runtime: pgdb.runtimeRole, definer: pgdb.definerRole, runner: pgdb.runnerRole, fence: pgdb.fenceRole, poDefiner: pgdb.poDefinerRole, poRunner: pgdb.poRunnerRole };
const reprovision = () => provisionRoles(pgdb.owner, roles, { runtimePassword: randomBytes(18).toString('hex'), runnerPassword: randomBytes(18).toString('hex') });
await seedGraph(asRunner(pgdb.owner));
await seedRetentionFixtures(asRunner(pgdb.owner));

test('fresh provisioning: runtime, definer and runner with their own attributes and grants; the runner logs in with its own credential', async () => {
  const attrs = (await pgdb.owner.query(`SELECT rolname, rolcanlogin, rolinherit, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles
    WHERE rolname = ANY($1) ORDER BY rolname`, [Object.values(roles)])).rows;
  assert.deepEqual(attrs.map(r => [r.rolname, r.rolcanlogin, r.rolinherit, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb]).sort(), [
    [roles.runtime, true, false, false, false, false, false], [roles.definer, false, false, false, false, false, false], [roles.runner, true, false, false, false, false, false],
    [roles.fence, false, false, false, false, false, false], [roles.poDefiner, false, false, false, false, false, false],
    [roles.poRunner, true, false, false, false, false, false]].sort());
  assert.equal((await runnerClient.query('SELECT current_user AS u')).rows[0].u, roles.runner);
  await checkM365Privileges(asRunner(pgdb.owner), roles);
  await assert.rejects(runnerClient.query(`SET ROLE "${roles.definer}"`), /permission denied/, 'the runner cannot become the definer');
  await assert.rejects(runtimeClient.query(`SET ROLE "${roles.definer}"`), /permission denied/);
  const definerLogin = new pg.Client({ connectionString: urlFor(pgdb.ownerUrl, roles.definer, randomBytes(18).toString('hex')) });
  await assert.rejects(definerLogin.connect(), /not permitted to log in|password authentication failed/, 'the definer is NOLOGIN');
  await definerLogin.end().catch(() => undefined);
});

test('the runner executes the confined routine; the runtime cannot; expired payload of one client goes, fresh and foreign rows stay', async () => {
  await checkCleanupRoutine(asRunner(pgdb.owner), asRunner(runnerClient), asRunner(runtimeClient));
});

test('cleanup takes the publication fence: it waits while another transaction holds the Connection lock, and never changes the Connection', async () => {
  const holder = new pg.Client({ connectionString: pgdb.ownerUrl }); await holder.connect();
  try {
    await holder.query('BEGIN');
    await holder.query(`SELECT id FROM "Connection" WHERE id = 'm1' FOR NO KEY UPDATE`);
    let settled = false;
    const pending = runnerClient.query(`BEGIN; SELECT set_config('app.workspace_id', 'w', true), set_config('app.client_ids', 'c1', true),
      set_config('app.actor_id', 'm365-op', true); SELECT atlas_m365_cleanup('corr-retention-lock'); COMMIT;`).finally(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(settled, false, 'the routine waits for the Connection row lock');
    await holder.query('COMMIT');
    await pending;
  } finally { await holder.end(); }
});

test('the runtime self-check fails closed on provisioning drift and passes again once prisma/roles.sql reapplied the grants', async () => {
  await assertRuntimeRole(runtime);
  const d = `"${roles.definer}"`;
  const drifts = [
    // the definer's reviewed minimum is required (without it the routine cannot lock, read, withdraw, delete or audit)
    `REVOKE UPDATE (id) ON "Connection" FROM ${d}`, `REVOKE SELECT ("lifecycleVersion") ON "Connection" FROM ${d}`,
    `REVOKE DELETE ON "M365SignInEvidence" FROM ${d}`, `REVOKE UPDATE ("activeGenerationId") ON "M365ResourceState" FROM ${d}`,
    `REVOKE INSERT ON "AuditEvent" FROM ${d}`,
    // ... and nothing beyond it on any protected table, table or column level
    `GRANT SELECT ("secretRef") ON "Connection" TO ${d}`, `GRANT DELETE ON "AuditEvent" TO ${d}`, `GRANT INSERT ON "Client" TO ${d}`,
    `GRANT UPDATE ("lastSuccessAt") ON "M365ResourceState" TO ${d}`, `GRANT SELECT ON "ApiToken" TO ${d}`, `GRANT INSERT ON "M365SignInEvidence" TO ${d}`,
    // the runtime role and the routine itself
    `GRANT EXECUTE ON FUNCTION public.atlas_m365_cleanup(text) TO "${roles.runtime}"`,
    `GRANT DELETE ON "M365SignInEvidence" TO "${roles.runtime}"`,
    `GRANT UPDATE ON "M365WindowEvidence" TO "${roles.runtime}"`,
    `ALTER FUNCTION public.atlas_m365_cleanup(text) OWNER TO CURRENT_USER`,
  ];
  for (const drift of drifts) {
    await pgdb.owner.query(drift);
    await assert.rejects(assertRuntimeRole(runtime), /RUNTIME_ROLE_NOT_CONFINED/, drift);
    await reprovision();
    await assertRuntimeRole(runtime);
  }
  // Role attributes: the runtime refuses, and roles.sql itself refuses to provision an unconfined existing definer
  for (const [attribute, restore] of [['CREATEROLE', 'NOCREATEROLE'], ['CREATEDB', 'NOCREATEDB'], ['REPLICATION', 'NOREPLICATION']]) {
    await pgdb.owner.query(`ALTER ROLE ${d} ${attribute}`);
    await assert.rejects(assertRuntimeRole(runtime), /RUNTIME_ROLE_NOT_CONFINED/, attribute);
    await assert.rejects(reprovision(), /is not confined/, `roles.sql stops on ${attribute}`);
    await pgdb.owner.query('ROLLBACK').catch(() => undefined);
    await pgdb.owner.query(`ALTER ROLE ${d} ${restore}`);
    await reprovision();
    await assertRuntimeRole(runtime);
  }
  // Restored provisioning still lets the real EXECUTE-only runner clean up (an idempotent pass)
  await runnerClient.query(`BEGIN; SELECT set_config('app.workspace_id', 'w', true), set_config('app.client_ids', 'c1', true),
    set_config('app.actor_id', 'm365-op', true); SELECT atlas_m365_cleanup('corr-retention-after'); COMMIT;`);
});

test('two databases on one cluster get independent role names; dropping one removes only its own roles', async () => {
  const second = await createTestDatabase();
  const names = [second.runtimeRole, second.definerRole, second.runnerRole, second.fenceRole, second.poDefinerRole, second.poRunnerRole];
  const exists = async (role: string) => {
    const admin = new pg.Client({ connectionString: adminUrl() }); await admin.connect();
    try { return (await admin.query(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = $1`, [role])).rows[0].n === 1; } finally { await admin.end(); }
  };
  assert.equal(new Set([...names, ...Object.values(roles)]).size, 12, 'no shared or prefix-colliding names');
  assert.ok(names.every(n => !Object.values(roles).some(r => r.startsWith(n) || n.startsWith(r))));
  await second.drop();
  for (const n of names) assert.equal(await exists(n), false, `${n} dropped with its database`);
  for (const r of Object.values(roles)) assert.equal(await exists(r), true, `${r} of the first database is untouched`);
  await assertRuntimeRole(runtime);
});
