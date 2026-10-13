import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { assertRuntimeRole } from '../../packages/graph/scoped-db.ts';
import { seedGraph } from '../sql-invariants.ts';
import type { SqlRunner } from '../sql-invariants.ts';
import { seedM365 } from '../m365-sql-invariants.ts';
import { adminUrl, createTestDatabase, provisionRoles, urlFor } from '../support/pg-harness.ts';
import type { PgTestDatabase } from '../support/pg-harness.ts';

// The documented owner path WITHOUT superuser (pg-harness: an administrator with CREATEDB and CREATEROLE). PostgreSQL 16+
// gives such a creator an ADMIN-only membership (no SET, no INHERIT) in every role it creates; that is the trusted owner's
// administrative link, not an execution path. Fresh and repeated provisioning must work, and every untrusted path to the
// cleanup routine must stay blocked. Synthetic roles only; the original test admin removes whatever this file created.
const root = new pg.Client({ connectionString: adminUrl() });
await root.connect();
const ownerRole = `atlas_nonsuper_${randomBytes(4).toString('hex')}`;
const ownerPassword = randomBytes(18).toString('hex');
await root.query(`CREATE ROLE "${ownerRole}" LOGIN NOSUPERUSER NOBYPASSRLS CREATEDB CREATEROLE PASSWORD '${ownerPassword}'`);
let pgdb: PgTestDatabase | undefined; let setupError: unknown = null;
try { pgdb = await createTestDatabase({ adminUrl: urlFor(adminUrl(), ownerRole, ownerPassword) }); } catch (error) { setupError = error; }
const clients: { end(): Promise<unknown> }[] = [];
after(async () => {
  for (const c of clients) await c.end().catch(() => undefined);
  await pgdb?.drop().catch(() => undefined);
  // Guaranteed cleanup by the original admin: databases and roles the temporary owner created, then the owner itself
  const owner = (await root.query(`SELECT oid FROM pg_roles WHERE rolname = $1`, [ownerRole])).rows[0]?.oid;
  if (owner) {
    for (const r of (await root.query(`SELECT datname FROM pg_database WHERE datdba = $1`, [owner])).rows) await root.query(`DROP DATABASE IF EXISTS "${r.datname}" WITH (FORCE)`);
    for (const r of (await root.query(`SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid WHERE m.member = $1`, [owner])).rows) {
      await root.query(`DROP ROLE IF EXISTS "${r.rolname}"`).catch(() => undefined);
    }
    await root.query(`DROP ROLE IF EXISTS "${ownerRole}"`);
  }
  await root.end();
});
const db = (): PgTestDatabase => { if (setupError) throw setupError; return pgdb!; };
const asRunner = (c: pg.Client): SqlRunner => ({ exec: sql => c.query(sql).then(() => undefined), query: async (sql, params) => (await c.query(sql, params)).rows as never });
const login = async (url: string) => { const c = new pg.Client({ connectionString: url }); await c.connect(); clients.push(c); return c; };
const names = () => ({ runtime: db().runtimeRole, definer: db().definerRole, runner: db().runnerRole, fence: db().fenceRole, poDefiner: db().poDefinerRole, poRunner: db().poRunnerRole });
const reprovision = () => provisionRoles(db().owner, names(), { runtimePassword: randomBytes(18).toString('hex'), runnerPassword: randomBytes(18).toString('hex') });
const cleanupAs = (c: pg.Client, prefix = '') => c.query(`BEGIN; ${prefix} SELECT set_config('app.workspace_id', 'w', true), set_config('app.client_ids', 'c1', true),
  set_config('app.actor_id', 'm365-op', true); SELECT atlas_m365_cleanup('corr-nonsuper-01'); COMMIT;`);
let runtime: PrismaClient | null = null;
const guard = () => assertRuntimeRole(runtime ??= (() => { const p = new PrismaClient({ datasourceUrl: db().runtimeUrl }); clients.push({ end: () => p.$disconnect() }); return p; })());

test('a non-superuser CREATEDB/CREATEROLE owner migrates and provisions a fresh database; the runtime guard accepts it', async () => {
  const { owner } = db();
  assert.deepEqual((await owner.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`)).rows[0], { rolsuper: false, rolbypassrls: false });
  const link = (await owner.query(`SELECT m.admin_option, m.set_option, m.inherit_option FROM pg_auth_members m
    WHERE m.roleid = $1::regrole AND m.member = $2::regrole`, [names().runner, ownerRole])).rows;
  assert.deepEqual(link, [{ admin_option: true, set_option: false, inherit_option: false }], 'PostgreSQL gave the creator an ADMIN-only link');
  await guard();
  assert.equal((await owner.query(`SELECT proowner::regrole::text AS o FROM pg_proc WHERE proname = 'atlas_m365_cleanup'`)).rows[0].o, names().definer);
  assert.deepEqual((await owner.query(`SELECT a.grantee::regrole::text AS g, a.is_grantable FROM pg_proc p, aclexplode(p.proacl) a
    WHERE p.proname = 'atlas_m365_cleanup' AND a.grantee <> p.proowner`)).rows, [{ g: names().runner, is_grantable: false }]);
  assert.equal((await owner.query(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS c`, [names().definer])).rows[0].c, false, 'temporary CREATE was revoked');
});

test('the runner logs in and cleans up; repeated provisioning passes and keeps every existing credential', async () => {
  await seedGraph(asRunner(db().owner));
  await seedM365(asRunner(db().owner));
  await cleanupAs(await login(db().runnerUrl));
  for (let i = 0; i < 2; i++) { await reprovision(); await guard(); }
  for (const url of [db().runtimeUrl, db().runnerUrl]) assert.ok(await login(url), 'original passwords still authenticate');
  await assert.rejects(login(urlFor(db().ownerUrl, names().runner, randomBytes(18).toString('hex'))), /password authentication failed|28P01/);
  await cleanupAs(await login(db().runnerUrl));
  const rt = await login(db().runtimeUrl);
  await assert.rejects(cleanupAs(rt), /permission denied/);
});

test('untrusted paths stay blocked under a non-superuser owner: runtime or extra members, an executable owner link, extra EXECUTE', async () => {
  const { owner } = db(); const n = names();
  const probe = `atlas_ns_probe_${randomBytes(4).toString('hex')}`;
  await owner.query(`CREATE ROLE "${probe}" NOLOGIN`);
  const refused = async (label: string, repair: string | null) => {
    await assert.rejects(guard(), /RUNTIME_ROLE_NOT_CONFINED/, `${label}: startup refused`);
    if (repair) {
      await assert.rejects(reprovision(), /member of the cleanup runner|must not be a member|definer/, `${label}: roles.sql stops`);
      await owner.query('ROLLBACK').catch(() => undefined);
      await owner.query(repair);
    }
    await reprovision();
    await guard();
  };
  await owner.query(`GRANT "${n.runner}" TO "${n.runtime}"`);
  await refused('runtime member of the runner', `REVOKE "${n.runner}" FROM "${n.runtime}"`);
  await owner.query(`GRANT "${n.runner}" TO "${probe}"`);
  await refused('extra member of the runner', `REVOKE "${n.runner}" FROM "${probe}"`);
  await owner.query(`GRANT "${n.definer}" TO "${probe}"`);
  await refused('extra member of the definer', `REVOKE "${n.definer}" FROM "${probe}"`);
  await owner.query(`GRANT "${n.runner}" TO CURRENT_USER WITH SET TRUE`);
  await refused('an executable owner link to the runner', `REVOKE "${n.runner}" FROM CURRENT_USER GRANTED BY CURRENT_USER`);
  // The owner's link to the definer does not inherit: it cannot even grant EXECUTE without explicitly becoming the definer
  await assert.rejects(owner.query(`GRANT EXECUTE ON FUNCTION public.atlas_m365_cleanup(text) TO "${probe}"`), /permission denied/);
  await owner.query(`BEGIN; SET LOCAL ROLE "${n.definer}"; GRANT EXECUTE ON FUNCTION public.atlas_m365_cleanup(text) TO "${probe}"; COMMIT;`);
  await refused('extra EXECUTE grantee', null);
  assert.equal((await owner.query(`SELECT has_function_privilege($1, 'public.atlas_m365_cleanup(text)', 'EXECUTE') AS e`, [probe])).rows[0].e, false);
  await cleanupAs(await login(db().runnerUrl));
});
