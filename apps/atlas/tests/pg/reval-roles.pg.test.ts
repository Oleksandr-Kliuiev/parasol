import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { RUNTIME_ROLE_CHECK_SQL, assertConfinedRuntimeRole } from '../../packages/graph/runtime-role.ts';
import { REVAL_DEFINER_COLUMNS } from '../../packages/graph/reval-role.ts';
import { provisionRoles, renderRolesSql } from '../support/pg-harness.ts';
import { readRolesSql } from '../support/roles-sql.ts';
import { nonsuperDatabase, revalFacts, roleFlags, violations } from '../support/reval-nonsuper.ts';

// R-EVAL RS-A roles on PostgreSQL 17 under the non-superuser migration owner (brief §8, ACCEPTANCE_CHECKS "roles"): the ninth
// (evidence definer) and tenth (evidence reader) principals, exact grants, complete EXECUTE confinement with the accepted
// PUBLIC invoker helpers only, readiness negatives for BOTH roles, idempotent reprovisioning and distinctness refusals.
const n = await nonsuperDatabase();
after(() => n.cleanup());
const { db, admin } = n;
const def = db.revalDefinerRole; const rdr = db.revalReaderRole;
const secrets = () => ({ runtimePassword: randomBytes(18).toString('hex'), runnerPassword: randomBytes(18).toString('hex'), revalReaderPassword: randomBytes(18).toString('hex') });
const reprovision = async () => { try { await provisionRoles(db.owner, db.roles, secrets()); } catch (e) { await db.owner.query('ROLLBACK').catch(() => undefined); throw e; } };
const as = async <T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> => { const c = new pg.Client({ connectionString: url }); await c.connect(); try { return await fn(c); } finally { await c.end(); } };
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e: { code?: string }) => e.code ?? 'ERR');
const ready = async () => violations(await revalFacts(db.runtimeUrl));
async function catalog(): Promise<string> {
  return JSON.stringify((await admin.query(`SELECT (SELECT array_agg(x ORDER BY x) FROM (SELECT p.proname || ':' || p.proowner::regrole || ':' || coalesce(p.proacl::text, '')
      AS x FROM pg_proc p WHERE p.proname LIKE 'atlas\\_reval\\_%') a) AS procs,
    (SELECT array_agg(x ORDER BY x) FROM (SELECT c.relname || ':' || coalesce(c.relacl::text, '') || ':' || coalesce((SELECT string_agg(a.attname || '=' || a.attacl::text, ',' ORDER BY a.attnum)
      FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attacl IS NOT NULL), '') AS x FROM pg_class c WHERE c.relname IN ('RevalSandboxRegistration', 'RevalFixtureBinding',
      'RemoteAskPolicy', 'RemoteAskAttempt', 'RemoteAskPeriodCounter', 'RemoteAskClientAdmission', 'ActionAuthorityFence')) b) AS rels,
    (SELECT array_agg(x ORDER BY x) FROM (SELECT polname || ':' || polroles::text || ':' || pg_get_expr(polqual, polrelid) AS x FROM pg_policy
      WHERE polrelid IN ('"RevalSandboxRegistration"'::regclass, '"RevalFixtureBinding"'::regclass)) c) AS pols,
    (SELECT array_agg(x ORDER BY x) FROM (SELECT r.rolname || ':' || m.roleid::regrole || ':' || m.admin_option || m.set_option || m.inherit_option AS x
      FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE m.roleid IN ($1::regrole, $2::regrole)) d) AS members`, [def, rdr])).rows[0]);
}

test('non-superuser owner provisions both new roles: attributes, exact column grants incl. both attempt rates, reader EXECUTE only, readiness passes', async () => {
  const flags = await roleFlags(admin, [n.ownerRole, db.runtimeRole, def, rdr]);
  assert.deepEqual(flags[n.ownerRole], { super: false, bypassRls: false, login: true });
  assert.deepEqual(flags[db.runtimeRole], { super: false, bypassRls: false, login: true });
  assert.deepEqual(flags[def], { super: false, bypassRls: false, login: false });
  assert.deepEqual(flags[rdr], { super: false, bypassRls: false, login: true });
  const attrs = (await admin.query(`SELECT rolinherit, rolcreaterole, rolcreatedb, rolreplication, rolconfig FROM pg_roles WHERE rolname = ANY($1)`, [[def, rdr]])).rows;
  assert.ok(attrs.every(a => !a.rolinherit && !a.rolcreaterole && !a.rolcreatedb && !a.rolreplication && a.rolconfig === null));
  for (const [table, cols] of Object.entries(REVAL_DEFINER_COLUMNS)) for (const c of cols) {
    assert.equal((await admin.query(`SELECT has_column_privilege($1, $2, $3, 'SELECT') AS ok`, [def, `public."${table}"`, c])).rows[0].ok, true, `${table}.${c}`);
  }
  for (const c of ['secretRef', 'ownerApprovalRef', 'retentionAttestationRef']) {
    assert.equal((await admin.query(`SELECT has_column_privilege($1, 'public."RemoteAskPolicy"', $2, 'SELECT') AS ok`, [def, c])).rows[0].ok, false, c);
  }
  const counts = (await admin.query(`SELECT (SELECT count(*) FROM pg_proc WHERE proname LIKE 'atlas\\_reval\\_%')::int AS reval,
    (SELECT count(*) FROM pg_proc WHERE proname LIKE 'atlas\\_ask\\_remote\\_%' AND proowner = $1::regrole)::int AS remote,
    (SELECT proowner::regrole::text FROM pg_proc WHERE proname = 'atlas_reval_snapshot') AS snap_owner,
    (SELECT proowner::regrole::text FROM pg_proc WHERE proname = 'atlas_reval_guard') AS guard_owner`, [db.remoteRole])).rows[0];
  assert.deepEqual(counts, { reval: 2, remote: 9, snap_owner: def, guard_owner: n.ownerRole });
  assert.equal(await ready(), 0);
  await as(db.runtimeUrl, async c => assertConfinedRuntimeRole((await c.query(RUNTIME_ROLE_CHECK_SQL)).rows[0]));
});

test('runtime holds only the RS-B Reval column SELECTs (no other column, no write, no snapshot); the reader reaches no table, no guard, no SET ROLE', async () => {
  await as(db.runtimeUrl, async c => {
    // RS-B (rs-b brief B10): exactly the allowlisted columns are readable; every other column, any write and the routines are denied.
    assert.equal(await code(c.query(`SELECT "registrationId", "databaseInstanceId", "workspaceId", "clientId", "actorId", "admissionId",
      "datasetManifestSha256", "syntheticOnly" FROM "RevalSandboxRegistration"`)), 'OK');
    assert.equal(await code(c.query(`SELECT "registrationId", "workspaceId", "clientId", "fixtureId", generation, "syntheticFreshnessAt",
      "datasetManifestSha256" FROM "RevalFixtureBinding"`)), 'OK');
    for (const [t, col] of [['RevalSandboxRegistration', 'evidenceReaderRoleOid'], ['RevalSandboxRegistration', 'buildManifestSha256'],
      ['RevalSandboxRegistration', 'createdAt'], ['RevalFixtureBinding', 'installedAt']] as const) {
      assert.equal(await code(c.query(`SELECT "${col}" FROM "${t}"`)), '42501', `${t}.${col}`);
    }
    assert.equal(await code(c.query(`SELECT * FROM "RevalSandboxRegistration"`)), '42501');
    assert.equal(await code(c.query(`INSERT INTO "RevalFixtureBinding" ("registrationId") VALUES (gen_random_uuid())`)), '42501');
    assert.equal(await code(c.query(`UPDATE "RevalFixtureBinding" SET generation = generation`)), '42501');
    assert.equal(await code(c.query(`DELETE FROM "RevalSandboxRegistration"`)), '42501');
    assert.equal(await code(c.query(`SELECT public.atlas_reval_snapshot()`)), '42501');
  });
  await as(db.revalReaderUrl, async c => {
    for (const t of ['RemoteAskPolicy', 'RemoteAskAttempt', 'RevalSandboxRegistration', 'ActionAuthorityFence', 'Workspace']) assert.equal(await code(c.query(`SELECT 1 FROM "${t}"`)), '42501', t);
    assert.equal(await code(c.query(`SELECT public.atlas_reval_guard()`)), '42501');
    assert.equal(await code(c.query(`SET ROLE "${def}"`)), '42501');
    assert.equal(await code(c.query(`SELECT public.atlas_ask_remote_pause('x', gen_random_uuid(), 'OWNER')`)), '42501');
  });
});

test('EXECUTE confinement drift fails readiness for the affected role and roles.sql refuses or removes it; ancestors untouched', async () => {
  const before = await catalog();
  const cases: [string, string, string, 'refuse' | 'remove'][] = [
    ['new PUBLIC user function', `CREATE FUNCTION public.reval_extra() RETURNS int LANGUAGE sql AS 'SELECT 1'`, `DROP FUNCTION public.reval_extra()`, 'refuse'],
    ['listed helper replaced by SECURITY DEFINER', `ALTER FUNCTION public.atlas_app_workspace() SECURITY DEFINER`, `ALTER FUNCTION public.atlas_app_workspace() SECURITY INVOKER`, 'refuse'],
    ['same-name helper in another schema', `CREATE SCHEMA rvshadow; CREATE FUNCTION rvshadow.atlas_app_workspace() RETURNS text LANGUAGE sql AS 'SELECT 1::text'; GRANT USAGE ON SCHEMA rvshadow TO PUBLIC`,
      `DROP SCHEMA rvshadow CASCADE`, 'refuse'],
    ['explicit helper grant to the reader', `GRANT EXECUTE ON FUNCTION public.atlas_app_workspace() TO "${rdr}"`, '', 'remove'],
    ['grant option to the definer', `GRANT SELECT ("workspaceId") ON "RemoteAskPolicy" TO "${def}" WITH GRANT OPTION`, '', 'remove'],
    ['guard EXECUTE for the reader', `GRANT EXECUTE ON FUNCTION public.atlas_reval_guard() TO "${rdr}"`, '', 'remove'],
    ['runtime regrant on a Reval table', `GRANT INSERT ON "RevalSandboxRegistration" TO "${db.runtimeRole}"`, '', 'remove'],
    ['runtime extra Reval column (RS-B)', `GRANT SELECT ("buildManifestSha256") ON "RevalSandboxRegistration" TO "${db.runtimeRole}"`, '', 'remove'],
    ['runtime table-level Reval SELECT (RS-B)', `GRANT SELECT ON "RevalFixtureBinding" TO "${db.runtimeRole}"`, '', 'remove'],
    ['runtime lost an allowlisted column (RS-B)', `REVOKE SELECT (generation) ON "RevalFixtureBinding" FROM "${db.runtimeRole}"`, '', 'remove'],
    ['snapshot ownership drift', `ALTER FUNCTION public.atlas_reval_snapshot() OWNER TO "${n.ownerRole}"`, '', 'remove'],
    ['membership injection (SET ROLE path)', `GRANT "${def}" TO "${db.runtimeRole}"`, `REVOKE "${def}" FROM "${db.runtimeRole}"`, 'refuse'],
    ['per-role settings', `ALTER ROLE "${rdr}" SET search_path = public`, `ALTER ROLE "${rdr}" RESET search_path`, 'refuse'],
    ['parameter grant', `GRANT SET ON PARAMETER work_mem TO "${rdr}"`, `REVOKE SET ON PARAMETER work_mem FROM "${rdr}"`, 'refuse'],
    ['default-privilege regrant', `ALTER DEFAULT PRIVILEGES FOR ROLE "${n.ownerRole}" IN SCHEMA public GRANT SELECT ON TABLES TO "${rdr}"`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE "${n.ownerRole}" IN SCHEMA public REVOKE SELECT ON TABLES FROM "${rdr}"`, 'refuse'],
  ];
  for (const [name, inject, repair, expect] of cases) {
    await admin.query(inject);
    assert.ok(await ready() > 0, `${name}: readiness fails closed`);
    if (expect === 'refuse') {
      await assert.rejects(reprovision(), /roles\.sql/, `${name}: roles.sql refuses`);
      await admin.query(repair);
      await reprovision();
    } else {
      await reprovision();
    }
    assert.equal(await ready(), 0, `${name}: ready again`);
  }
  assert.equal(await catalog(), before, 'reprovisioning restores exactly the same catalog state');
  await reprovision();
  assert.equal(await catalog(), before, 'idempotent');
});

test('distinctness: the evidence roles cannot alias each other or any of the eight accepted principals', async () => {
  const sql = await readRolesSql();
  for (const [label, names] of [['reader = remote definer', { ...db.roles, revalReader: db.remoteRole }], ['definer = reader', { ...db.roles, revalDefiner: rdr, revalReader: rdr }],
    ['reader = runtime', { ...db.roles, revalReader: db.runtimeRole }]] as const) {
    let threw = false;
    try { await db.owner.query(renderRolesSql(sql, names, secrets())); } catch (e) { threw = /distinct|differ/.test(String(e)) || /role names must differ/.test(String(e)); }
    await db.owner.query('ROLLBACK').catch(() => undefined);
    assert.ok(threw, label);
  }
  assert.throws(() => renderRolesSql(sql, { ...db.roles, revalDefiner: rdr, revalReader: rdr }, secrets()), /role names must differ/);
  // The SQL guard itself (renderer bypassed): reval.sql refuses an alias of the remote definer or of the runtime.
  for (const alias of [db.remoteRole, db.runtimeRole]) {
    const raw = renderRolesSql(sql, db.roles, secrets()).replace(`set_config('atlas.reval_reader_role', '${rdr}', true)`, `set_config('atlas.reval_reader_role', '${alias}', true)`);
    assert.ok(raw.includes(`'atlas.reval_reader_role', '${alias}'`));
    await assert.rejects(db.owner.query(raw), /ten distinct principals/, alias);
    await db.owner.query('ROLLBACK').catch(() => undefined);
  }
  assert.equal(await ready(), 0);
});
