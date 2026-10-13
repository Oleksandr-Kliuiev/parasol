import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { assertRuntimeRole } from '../../packages/graph/scoped-db.ts';
import { seedGraph } from '../sql-invariants.ts';
import type { SqlRunner } from '../sql-invariants.ts';
import { seedM365 } from '../m365-sql-invariants.ts';
import { createTestDatabase, provisionRoles } from '../support/pg-harness.ts';

// The cleanup routine's EXECUTE ACL on PostgreSQL 17 (02_CONTRACTS §6): besides the owner, exactly the dedicated runner
// holds EXECUTE, without grant option, and no role reaches it through membership (SET ROLE). Startup refuses any other
// principal; prisma/roles.sql removes unexpected grantees and fails closed on memberships it must not silently undo.
// Synthetic roles only, dropped in finally.
const pgdb = await createTestDatabase();
const runtime = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
const runnerClient = new pg.Client({ connectionString: pgdb.runnerUrl });
const runtimeClient = new pg.Client({ connectionString: pgdb.runtimeUrl });
await runnerClient.connect(); await runtimeClient.connect();
after(async () => { await runnerClient.end(); await runtimeClient.end(); await runtime.$disconnect(); await pgdb.drop(); });
const asRunner = (c: pg.Client): SqlRunner => ({ exec: sql => c.query(sql).then(() => undefined), query: async (sql, params) => (await c.query(sql, params)).rows as never });
await seedGraph(asRunner(pgdb.owner));
await seedM365(asRunner(pgdb.owner));
const roles = { runtime: pgdb.runtimeRole, definer: pgdb.definerRole, runner: pgdb.runnerRole, fence: pgdb.fenceRole, poDefiner: pgdb.poDefinerRole, poRunner: pgdb.poRunnerRole };
const ROUTINE = 'public.atlas_m365_cleanup(text)';
const reprovision = () => provisionRoles(pgdb.owner, roles, { runtimePassword: randomBytes(18).toString('hex'), runnerPassword: randomBytes(18).toString('hex') });
const canExecute = async (role: string) => (await pgdb.owner.query(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, ROUTINE])).rows[0].ok as boolean;
const acl = async () => (await pgdb.owner.query(`SELECT a.grantee::regrole::text AS grantee, a.is_grantable FROM pg_proc p, aclexplode(p.proacl) a
  WHERE p.oid = $1::regprocedure AND a.grantee <> p.proowner ORDER BY 1`, [ROUTINE])).rows;
const cleanupAs = (c: pg.Client, prefix = '') => c.query(`BEGIN; ${prefix} SELECT set_config('app.workspace_id', 'w', true), set_config('app.client_ids', 'c1', true),
  set_config('app.actor_id', 'm365-op', true); SELECT atlas_m365_cleanup('corr-acl-check-1'); COMMIT;`);

/** One synthetic extra role for the duration of `fn`, always dropped (its grants are revoked first). */
async function withExtraRole(attributes: string, fn: (name: string) => Promise<void>): Promise<void> {
  const name = `atlas_acl_probe_${randomBytes(4).toString('hex')}`;
  await pgdb.owner.query(`CREATE ROLE "${name}" ${attributes}`);
  try { await fn(name); }
  finally {
    await pgdb.owner.query('ROLLBACK').catch(() => undefined);
    await pgdb.owner.query(`REVOKE ALL ON FUNCTION ${ROUTINE} FROM "${name}" CASCADE`).catch(() => undefined);
    await pgdb.owner.query(`DROP ROLE IF EXISTS "${name}"`).catch(() => undefined);
  }
}
const refusedThenRepaired = async (label: string) => {
  await assert.rejects(assertRuntimeRole(runtime), /RUNTIME_ROLE_NOT_CONFINED/, `${label}: startup refused`);
  await reprovision();
  await assertRuntimeRole(runtime);
  assert.deepEqual(await acl(), [{ grantee: roles.runner, is_grantable: false }], `${label}: only the runner, without grant option`);
};

test('after provisioning, EXECUTE is held by the owner and exactly the runner (no grant option); PUBLIC and the runtime have none', async () => {
  await assertRuntimeRole(runtime);
  assert.deepEqual(await acl(), [{ grantee: roles.runner, is_grantable: false }]);
  assert.equal(await canExecute(roles.runtime), false);
});

test('an extra grantee — NOLOGIN, or even a confined-looking LOGIN role — is refused at startup and removed by roles.sql', async () => {
  for (const attributes of ['NOLOGIN', 'LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS']) {
    await withExtraRole(attributes, async extra => {
      await pgdb.owner.query(`GRANT EXECUTE ON FUNCTION ${ROUTINE} TO "${extra}"`);
      await refusedThenRepaired(attributes);
      assert.equal(await canExecute(extra), false, 'the unexpected grant is gone');
    });
  }
});

test('PUBLIC EXECUTE and a runner grant option (with a grant passed on) are refused, then reset to the runner alone', async () => {
  await pgdb.owner.query(`GRANT EXECUTE ON FUNCTION ${ROUTINE} TO PUBLIC`);
  assert.equal(await canExecute(roles.runtime), true, 'PUBLIC would reach the runtime');
  await refusedThenRepaired('PUBLIC');
  assert.equal(await canExecute(roles.runtime), false);
  await withExtraRole('NOLOGIN', async extra => {
    await pgdb.owner.query(`GRANT EXECUTE ON FUNCTION ${ROUTINE} TO "${roles.runner}" WITH GRANT OPTION`);
    await runnerClient.query(`GRANT EXECUTE ON FUNCTION ${ROUTINE} TO "${extra}"`);
    await refusedThenRepaired('grant option');
    assert.equal(await canExecute(extra), false, 'what the runner passed on is revoked with its grant option (CASCADE)');
  });
});

test('membership in the runner is an EXECUTE path: the runtime (via SET ROLE) or any other member is refused; roles.sql stops until it is removed', async () => {
  await pgdb.owner.query(`GRANT "${roles.runner}" TO "${roles.runtime}"`);
  try {
    assert.equal(await canExecute(roles.runtime), false, 'NOINHERIT: no direct privilege appears...');
    await cleanupAs(runtimeClient, `SET LOCAL ROLE "${roles.runner}";`); // ...yet the routine is reachable through SET ROLE
    await assert.rejects(assertRuntimeRole(runtime), /RUNTIME_ROLE_NOT_CONFINED/);
    await assert.rejects(reprovision(), /member of the cleanup runner|must not be a member/);
    await pgdb.owner.query('ROLLBACK').catch(() => undefined);
  } finally { await pgdb.owner.query(`REVOKE "${roles.runner}" FROM "${roles.runtime}"`); }
  await withExtraRole('NOLOGIN', async extra => {
    await pgdb.owner.query(`GRANT "${roles.runner}" TO "${extra}"`);
    await assert.rejects(assertRuntimeRole(runtime), /RUNTIME_ROLE_NOT_CONFINED/);
    await assert.rejects(reprovision(), /member of the cleanup runner/);
    await pgdb.owner.query('ROLLBACK').catch(() => undefined);
    await pgdb.owner.query(`REVOKE "${roles.runner}" FROM "${extra}"`);
  });
  await reprovision();
  await assertRuntimeRole(runtime);
  await assert.rejects(runtimeClient.query(`SET ROLE "${roles.runner}"`), /permission denied/);
});

test('after every repair the runner still cleans up and the runtime still cannot execute; passwords are kept', async () => {
  await cleanupAs(runnerClient);
  await assert.rejects(cleanupAs(runtimeClient), /permission denied/);
  await runtimeClient.query('ROLLBACK').catch(() => undefined);
  const fresh = new pg.Client({ connectionString: pgdb.runnerUrl }); // re-provisioning never replaced the runner's credential
  try { await fresh.connect(); assert.equal((await fresh.query('SELECT current_user AS u')).rows[0].u, roles.runner); } finally { await fresh.end(); }
});
