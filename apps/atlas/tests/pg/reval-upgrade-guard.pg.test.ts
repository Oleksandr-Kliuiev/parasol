import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { RUNTIME_ROLE_CHECK_SQL, assertConfinedRuntimeRole } from '../../packages/graph/runtime-role.ts';
import { migrationNames } from '../support/migrations.ts';
import { PRISMA_CLI, provisionRoles, runWithDatabase, urlFor } from '../support/pg-harness.ts';
import { readS5RemoteRolesSql, renderS5RemoteRolesSql } from '../support/roles-sql.ts';
import { connectAs, freshProject, ledger, ownerScoped, reserveOnce, settleOnce } from '../support/ask-remote-pg.ts';
import { DATASET_SHA256, registerSandbox } from '../support/reval-pg.ts';
import { nonsuperDatabase, revalFacts, roleFlags, violations } from '../support/reval-nonsuper.ts';

// R-EVAL RS-A populated upgrade and the owner-only ALWAYS guard on PostgreSQL 17, under the NON-superuser table owner
// (ACCEPTANCE_CHECKS "upgrade" and "guard"): accepted R-A…R-C state (all migrations through 202610121000 + the byte-exact
// pre-RS-A roles.sql) with remote data → the new migration → runtime DML through the default grants is refused by the guard
// in the window → readiness refuses until roles.sql reruns → afterwards ready with data unchanged; then every guard negative.
const n = await nonsuperDatabase({ migrateThrough: '202610121000_stage5_ask_remote_egress_floor' });
after(() => n.cleanup());
const { db, admin } = n; const owner = db.owner;
const runtimePassword = randomBytes(18).toString('hex');
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e: { code?: string }) => e.code ?? String(e));
let project: Awaited<ReturnType<typeof freshProject>>;

test('pre-RS-A deployment → new migration: guard refuses runtime DML in the window, readiness refuses, roles.sql provisions, remote data unchanged', async () => {
  await owner.query(renderS5RemoteRolesSql(await readS5RemoteRolesSql(), db.roles, { runtimePassword, runnerPassword: randomBytes(18).toString('hex'),
    poRunnerPassword: randomBytes(18).toString('hex') }));
  const runtimeUrl = urlFor(db.ownerUrl, db.runtimeRole, runtimePassword);
  project = await freshProject(owner, 'up');
  const rt = await connectAs(runtimeUrl);
  try { const a = await reserveOnce(rt, project.ws, project.client, project, { actor: project.actor }); await settleOnce(rt, project.ws, project.client, a, 'NO_DISPATCH'); }
  finally { await rt.end(); }
  const before = await ledger(owner, project.ws);
  runWithDatabase(db.ownerUrl, process.execPath, [PRISMA_CLI, 'migrate', 'deploy']);
  assert.deepEqual((await owner.query(`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY 1`)).rows.map(r => r.migration_name), await migrationNames());
  const c = new pg.Client({ connectionString: runtimeUrl }); await c.connect();
  try {
    assert.equal((await c.query(`SELECT has_table_privilege('public."RevalSandboxRegistration"', 'INSERT') AND has_table_privilege('public."RevalFixtureBinding"', 'UPDATE') AS g`)).rows[0].g,
      true, 'the window exists: default privileges gave the runtime INSERT/UPDATE');
    await c.query('BEGIN'); await c.query(`SELECT set_config('app.workspace_id', $1, true)`, [project.ws]);
    assert.equal(await code(c.query(`INSERT INTO "RevalSandboxRegistration" ("registrationId", "databaseInstanceId", "workspaceId", "clientId", "actorId", "admissionId",
      "evidenceReaderRoleOid", "datasetManifestSha256", "buildManifestSha256", "syntheticOnly") VALUES ($1, $2, $3, $4, $5, $6, 424242, $7, $7, true)`,
      [randomUUID(), randomUUID(), project.ws, project.client, project.actor, project.admissionId, DATASET_SHA256])), 'RV010', 'runtime registration write refused by the guard');
    await c.query('ROLLBACK');
    assert.throws(() => assertConfinedRuntimeRole(undefined), /RUNTIME_ROLE/);
    const facts = (await c.query(RUNTIME_ROLE_CHECK_SQL)).rows[0];
    assert.throws(() => assertConfinedRuntimeRole(facts), /R-EVAL|RUNTIME_ROLE_NOT_CONFINED/, 'readiness refuses before roles.sql');
  } finally { await c.end(); }
  await provisionRoles(owner, db.roles, { runtimePassword, runnerPassword: randomBytes(18).toString('hex'), revalReaderPassword: randomBytes(18).toString('hex') });
  assert.equal(violations(await revalFacts(runtimeUrl)), 0);
  const c2 = new pg.Client({ connectionString: runtimeUrl }); await c2.connect();
  try { assertConfinedRuntimeRole((await c2.query(RUNTIME_ROLE_CHECK_SQL)).rows[0]); } finally { await c2.end(); }
  assert.deepEqual(await ledger(owner, project.ws), before, 'remote data unchanged');
  const flags = await roleFlags(admin, [n.ownerRole, db.runtimeRole, db.revalReaderRole]);
  assert.ok(Object.values(flags).every(f => !f.super && !f.bypassRls), JSON.stringify(flags));
});

const reg = async () => registerSandbox(owner, project, db.revalReaderRole);
test('owner-only ALWAYS guard: registration immutable even for the owner; binding monotonic and identity-fixed; DB time; FKs; replica mode; pg_temp shadow', async () => {
  const r = await reg();
  const scoped = <T>(fn: () => Promise<T>) => ownerScoped(owner, project.ws, fn);
  assert.equal(await code(scoped(() => owner.query(`UPDATE "RevalSandboxRegistration" SET "syntheticOnly" = true WHERE "registrationId" = $1`, [r.registrationId]))), 'RV010', 'owner UPDATE');
  assert.equal(await code(scoped(() => owner.query(`DELETE FROM "RevalSandboxRegistration" WHERE "registrationId" = $1`, [r.registrationId]))), 'RV010', 'owner DELETE');
  assert.equal(await code(scoped(() => owner.query(`TRUNCATE "RevalFixtureBinding", "RevalSandboxRegistration"`))), 'RV010', 'owner TRUNCATE');
  for (const [label, sql] of [['equal generation', `SET generation = 1`], ['lower generation', `SET generation = 0`], ['dataset change', `SET "datasetManifestSha256" = repeat('b', 64)`],
    ['client change', `SET "clientId" = 'other'`]] as const) {
    assert.notEqual(await code(scoped(() => owner.query(`UPDATE "RevalFixtureBinding" ${sql} WHERE "registrationId" = $1`, [r.registrationId]))), 'OK', label);
  }
  assert.equal(await code(scoped(() => owner.query(`DELETE FROM "RevalFixtureBinding" WHERE "registrationId" = $1`, [r.registrationId]))), 'RV010', 'binding DELETE');
  await scoped(() => owner.query(`CREATE FUNCTION pg_temp.clock_timestamp() RETURNS timestamptz LANGUAGE sql AS $$SELECT '2000-01-01'::timestamptz$$`));
  await scoped(() => owner.query(`UPDATE "RevalFixtureBinding" SET generation = 2, "installedAt" = '2001-01-01' WHERE "registrationId" = $1`, [r.registrationId]));
  const row = await scoped(async () => (await owner.query(`SELECT generation::text AS g, "installedAt" > now() - interval '1 minute' AS recent,
    extract(microseconds FROM "installedAt")::bigint % 1000 AS sub_ms FROM "RevalFixtureBinding" WHERE "registrationId" = $1`, [r.registrationId])).rows[0]);
  assert.deepEqual(row, { g: '2', recent: true, sub_ms: '0' }, 'installedAt is real DB time, ms-truncated, not caller-supplied nor a pg_temp shadow');
  // FKs: a foreign client and a dataset not equal to the registration's.
  const other = await freshProject(owner, 'fk');
  // Unique workspace/OID untouched (other workspace, another existing login OID): only the scoped FK differs.
  assert.equal(await code(registerSandbox(owner, { ...other, client: project.client }, db.runtimeRole, { registrationId: randomUUID() })), 'RV010', 'client of another workspace (the ALWAYS guard refuses before the FK)');
  assert.equal(await code(scoped(() => owner.query(`INSERT INTO "RevalFixtureBinding" ("registrationId", "workspaceId", "clientId", "fixtureId", generation, "syntheticFreshnessAt",
    "datasetManifestSha256") VALUES ($1, $2, $3, 'FX02', 1, now(), repeat('c', 64))`, [randomUUID(), project.ws, project.client]))), 'RV010', 'unknown registration/dataset');
  // A non-owner with an explicit INSERT grant is still refused (writer identity, not grants).
  await admin.query(`GRANT SELECT, INSERT, UPDATE ON "RevalFixtureBinding" TO "${db.runtimeRole}"`);
  const rt = await connectAs(urlFor(db.ownerUrl, db.runtimeRole, runtimePassword));
  try {
    await rt.query('BEGIN'); await rt.query(`SELECT set_config('app.workspace_id', $1, true)`, [project.ws]);
    assert.equal(await code(rt.query(`UPDATE "RevalFixtureBinding" SET generation = 9 WHERE "registrationId" = $1`, [r.registrationId])), 'RV010');
    await rt.query('ROLLBACK');
  } finally { await rt.end(); await admin.query(`REVOKE SELECT, INSERT, UPDATE ON "RevalFixtureBinding" FROM "${db.runtimeRole}"`); }
  // ENABLE ALWAYS: still fires under session_replication_role = replica (superuser, disposable DB; not the owner → refused).
  await admin.query('BEGIN'); await admin.query(`SET LOCAL session_replication_role = replica`); await admin.query(`SELECT set_config('app.workspace_id', $1, true)`, [project.ws]);
  assert.equal(await code(admin.query(`UPDATE "RevalFixtureBinding" SET generation = 10 WHERE "registrationId" = $1`, [r.registrationId])), 'RV010');
  await admin.query('ROLLBACK');
  await admin.query('BEGIN'); await admin.query(`SET LOCAL session_replication_role = replica`);
  assert.equal(await code(admin.query(`TRUNCATE "RevalFixtureBinding"`)), 'RV010');
  await admin.query('ROLLBACK');
  assert.equal((await admin.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid IN ('"RevalSandboxRegistration"'::regclass, '"RevalFixtureBinding"'::regclass)
    AND NOT tgisinternal AND tgenabled = 'A'`)).rows[0].n, 4);
});

/** One statement in a transaction that is ALWAYS rolled back: its SQLSTATE, or 'OK'. `asOwnerUnderReplica`: superuser sets replica, then SET ROLE owner. */
async function attempt(ws: string, sql: string, params: unknown[], asOwnerUnderReplica = false): Promise<string> {
  const c = asOwnerUnderReplica ? admin : owner;
  await c.query('BEGIN');
  try {
    if (asOwnerUnderReplica) { await c.query(`SET LOCAL session_replication_role = replica`); await c.query(`SET LOCAL ROLE "${n.ownerRole}"`); }
    await c.query(`SELECT set_config('app.workspace_id', $1, true)`, [ws]);
    return await code(c.query(sql, params));
  } finally { await c.query('ROLLBACK'); }
}
const INSERT_REG = `INSERT INTO "RevalSandboxRegistration" ("registrationId", "databaseInstanceId", "workspaceId", "clientId", "actorId", "admissionId",
  "evidenceReaderRoleOid", "datasetManifestSha256", "buildManifestSha256", "syntheticOnly") VALUES ($1, $2, $3, $4, $5, $6, (SELECT oid::bigint FROM pg_roles WHERE rolname = $7), $8, $8, true)`;
const INSERT_BINDING = `INSERT INTO "RevalFixtureBinding" ("registrationId", "workspaceId", "clientId", "fixtureId", generation, "syntheticFreshnessAt", "datasetManifestSha256")
  VALUES ($1, $2, $3, 'FX01', 1, now(), $4)`;
test('guard, isolated (Sol RC1 R4): each FK defect alone vs a valid control; binding identity immutable; the owner’s refusals hold under replica; the owner cannot enable replica', async () => {
  const q = await freshProject(owner, 'iso');
  const reg = (over: Partial<{ client: string; actor: string; admission: string }>) => [randomUUID(), randomUUID(), q.ws, over.client ?? q.client, over.actor ?? q.actor,
    over.admission ?? q.admissionId, db.runtimeRole, DATASET_SHA256];
  await owner.query(`INSERT INTO "Client" ("workspaceId", id, name) VALUES ($1, $2, 'unadmitted')`, [q.ws, `${q.client}-u`]);
  for (const replica of [false, true]) {
    const tag = replica ? ' (owner, replica)' : ' (owner)';
    assert.equal(await attempt(q.ws, INSERT_REG, reg({}), replica), 'OK', `control: the unchanged registration is accepted${tag}`);
    assert.equal(await attempt(q.ws, INSERT_REG, reg({ actor: project.actor }), replica), 'RV010', `foreign actor${tag}`);
    assert.equal(await attempt(q.ws, INSERT_REG, reg({ admission: project.admissionId }), replica), 'RV010', `foreign admission${tag}`);
    assert.equal(await attempt(q.ws, INSERT_REG, reg({ client: project.client }), replica), 'RV010', `foreign client${tag}`);
    assert.equal(await attempt(q.ws, INSERT_REG, reg({ client: `${q.client}-u` }), replica), 'RV010', `own client without its admission row${tag}`);
  }
  // An EXISTING registration without a binding: a binding with a mismatched dataset is refused, the matching one accepted.
  const r = await registerSandbox(owner, q, db.runtimeRole, { binding: false });
  for (const replica of [false, true]) {
    const tag = replica ? ' (owner, replica)' : ' (owner)';
    assert.equal(await attempt(q.ws, INSERT_BINDING, [r.registrationId, q.ws, q.client, DATASET_SHA256], replica), 'OK', `control binding${tag}`);
    assert.equal(await attempt(q.ws, INSERT_BINDING, [r.registrationId, q.ws, q.client, 'e'.repeat(64)], replica), 'RV010', `mismatched dataset${tag}`);
    assert.equal(await attempt(q.ws, INSERT_BINDING, [randomUUID(), q.ws, q.client, DATASET_SHA256], replica), 'RV010', `unknown registration${tag}`);
  }
  // The existing project's binding (registered in the previous test): identity immutable, generation monotonic, never deleted.
  const existing = (await ownerScoped(owner, project.ws, async () => (await owner.query(`SELECT "registrationId"::text AS id FROM "RevalFixtureBinding"`)).rows[0].id)) as string;
  for (const replica of [false, true]) {
    const tag = replica ? ' (owner, replica)' : ' (owner)';
    for (const [label, sql, params] of [
      ['registrationId change', `UPDATE "RevalFixtureBinding" SET "registrationId" = $2, generation = generation + 10 WHERE "registrationId" = $1`, [existing, randomUUID()]],
      ['workspaceId change', `UPDATE "RevalFixtureBinding" SET "workspaceId" = 'rem-other', generation = generation + 10 WHERE "registrationId" = $1`, [existing]],
      ['equal generation', `UPDATE "RevalFixtureBinding" SET generation = generation WHERE "registrationId" = $1`, [existing]],
      ['lower generation', `UPDATE "RevalFixtureBinding" SET generation = generation - 1 WHERE "registrationId" = $1`, [existing]],
      ['binding DELETE', `DELETE FROM "RevalFixtureBinding" WHERE "registrationId" = $1`, [existing]],
      ['binding TRUNCATE', `TRUNCATE "RevalFixtureBinding"`, []],
      ['registration UPDATE', `UPDATE "RevalSandboxRegistration" SET "syntheticOnly" = true WHERE "workspaceId" = $1`, [project.ws]],
      ['registration DELETE', `DELETE FROM "RevalSandboxRegistration" WHERE "workspaceId" = $1`, [project.ws]],
      ['registration TRUNCATE', `TRUNCATE "RevalFixtureBinding", "RevalSandboxRegistration"`, []]] as const) {
      assert.equal(await attempt(project.ws, sql, [...params], replica), 'RV010', `${label}${tag}`);
    }
    assert.equal(await attempt(project.ws, `UPDATE "RevalFixtureBinding" SET generation = generation + 1 WHERE "registrationId" = $1`, [existing], replica), 'OK',
      `control: a strictly advancing generation is accepted${tag}`);
  }
  assert.equal(await code(owner.query(`SET session_replication_role = replica`)), '42501', 'the NOSUPERUSER owner cannot enable replica itself');
});
