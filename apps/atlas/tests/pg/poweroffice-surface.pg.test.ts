import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { RUNTIME_ROLE_CHECK_SQL, assertConfinedRuntimeRole } from '../../packages/graph/runtime-role.ts';
import type { RuntimeRoleFacts } from '../../packages/graph/runtime-role.ts';
import { createTestDatabase, provisionRoles } from '../support/pg-harness.ts';
import { addPowerOfficeFixtures, connect, stateOf } from '../support/poweroffice-fixtures.ts';

// S4-A RC2 F1–F3 repair on PostgreSQL 17: the COMPLETE effective capability surface of the two PowerOffice maintenance
// roles. Extra relation/column/sequence privileges in any schema (same-name relations included), user-created routines in
// pg_temp_N, schema CREATE/USAGE/ownership — each fails readiness for exactly the role that holds it; provisioning revokes
// what this owner can revoke (any grantor) and refuses atomically otherwise. Positive controls prove every path was real.
// Probes count synthetic fixture rows only; no token value, hash or payload is read or printed.
const pgdb = await createTestDatabase();
const clients: pg.Client[] = [];
after(async () => { for (const c of clients) await c.end().catch(() => undefined); await pgdb.drop(); });
await addPowerOfficeFixtures(pgdb.owner);
const { owner, roles } = pgdb;
const runtime = await connect(pgdb.runtimeUrl); clients.push(runtime);
const runner = await connect(pgdb.poRunnerUrl); clients.push(runner);
const facts = async () => (await runtime.query(RUNTIME_ROLE_CHECK_SQL)).rows[0] as RuntimeRoleFacts;
const reprovision = () => provisionRoles(owner, roles, { runtimePassword: randomBytes(18).toString('hex'), runnerPassword: randomBytes(18).toString('hex') });
const RUN = 'poExecuteViolations'; const DEF = 'poOwnerViolations';
/** One read as the runner (its own login) or the definer (SET LOCAL ROLE in a rolled-back owner transaction): true, or the SQLSTATE. */
async function as(role: 'runner' | 'definer', sql: string): Promise<boolean | string> {
  if (role === 'runner') return runner.query(sql).then(r => r.rows[0]?.x === true, e => stateOf(e) ?? 'ERR');
  await owner.query('BEGIN');
  try { await owner.query(`SET LOCAL ROLE "${roles.poDefiner}"`); return (await owner.query(sql)).rows[0]?.x === true; }
  catch (e) { return stateOf(e) ?? 'ERR'; } finally { await owner.query('ROLLBACK'); }
}
/** Readiness flags exactly `flagged` (the other role's counter stays 0) and refuses startup. */
async function flags(flagged: (keyof RuntimeRoleFacts)[], label: string): Promise<void> {
  const f = await facts();
  for (const key of [RUN, DEF] as (keyof RuntimeRoleFacts)[]) {
    assert.equal(Number(f[key]) > 0, flagged.includes(key), `${label}: ${String(key)}`);
  }
  assert.throws(() => assertConfinedRuntimeRole(f), /RUNTIME_ROLE_NOT_CONFINED/, label);
}
const healthy = async () => assertConfinedRuntimeRole(await facts());
const name = roles.poRunner.slice(-8);

await owner.query(`CREATE SCHEMA review_extra;
  CREATE VIEW review_extra.token_surface AS SELECT "tokenHash" FROM public."ApiToken";
  CREATE TABLE review_extra."PowerOfficeSnapshot" (id integer); INSERT INTO review_extra."PowerOfficeSnapshot" VALUES (1);
  CREATE SEQUENCE review_extra."PowerOfficeAttempt";`);

test('F1: foreign view/column/same-name table/sequence and grant options, per role; provisioning revokes them under any grantor', async () => {
  await healthy();
  const cases: [string, 'runner' | 'definer', string, string][] = [
    ['view SELECT', 'runner', `GRANT SELECT ON review_extra.token_surface TO "${roles.poRunner}"`, `SELECT count(*) > 0 AS x FROM review_extra.token_surface`],
    ['view SELECT', 'definer', `GRANT SELECT ON review_extra.token_surface TO "${roles.poDefiner}"`, `SELECT count(*) > 0 AS x FROM review_extra.token_surface`],
    ['column SELECT', 'runner', `GRANT SELECT ("tokenHash") ON review_extra.token_surface TO "${roles.poRunner}"`, `SELECT count("tokenHash") > 0 AS x FROM review_extra.token_surface`],
    ['column SELECT', 'definer', `GRANT SELECT ("tokenHash") ON review_extra.token_surface TO "${roles.poDefiner}"`, `SELECT count("tokenHash") > 0 AS x FROM review_extra.token_surface`],
    ['same-name foreign table', 'definer', `GRANT SELECT ON review_extra."PowerOfficeSnapshot" TO "${roles.poDefiner}"`, `SELECT count(*) = 1 AS x FROM review_extra."PowerOfficeSnapshot"`],
    ['same-name foreign table', 'runner', `GRANT SELECT ON review_extra."PowerOfficeSnapshot" TO "${roles.poRunner}"`, `SELECT count(*) = 1 AS x FROM review_extra."PowerOfficeSnapshot"`],
    ['sequence USAGE', 'definer', `GRANT USAGE ON SEQUENCE review_extra."PowerOfficeAttempt" TO "${roles.poDefiner}"`, `SELECT nextval('review_extra."PowerOfficeAttempt"') > 0 AS x`],
    ['sequence USAGE', 'runner', `GRANT USAGE ON SEQUENCE review_extra."PowerOfficeAttempt" TO "${roles.poRunner}"`, `SELECT nextval('review_extra."PowerOfficeAttempt"') > 0 AS x`],
  ];
  for (const [label, role, grant, probe] of cases) {
    await owner.query(`GRANT USAGE ON SCHEMA review_extra TO "${role === 'runner' ? roles.poRunner : roles.poDefiner}"; ${grant}`);
    assert.equal(await as(role, probe), true, `${label} (${role}): a real path before the repair`);
    await flags([role === 'runner' ? RUN : DEF], `${label} (${role})`);
    await reprovision();
    await healthy();
    assert.equal(await as(role, probe), '42501', `${label} (${role}): removed by provisioning`);
  }
  // Grant option on an ALLOWED public relation: the plain privilege stays, the option goes.
  await owner.query(`GRANT SELECT ON public."PowerOfficeState" TO "${roles.poDefiner}" WITH GRANT OPTION`);
  await flags([DEF], 'grant option on an allowed relation');
  await reprovision(); await healthy();
  assert.equal(await as('definer', `SELECT count(*) >= 0 AS x FROM public."PowerOfficeState"`), true, 'exact public allowlist preserved');
  // A grant recorded under another grantor is revoked by that grantor's identity.
  await owner.query(`CREATE ROLE s4a_grantor_${name} NOLOGIN; GRANT USAGE ON SCHEMA review_extra TO s4a_grantor_${name} WITH GRANT OPTION;
    GRANT SELECT ON review_extra.token_surface TO s4a_grantor_${name} WITH GRANT OPTION;
    SET ROLE s4a_grantor_${name}; GRANT USAGE ON SCHEMA review_extra TO "${roles.poRunner}"; GRANT SELECT ON review_extra.token_surface TO "${roles.poRunner}"; RESET ROLE;`);
  try {
    assert.equal(await as('runner', `SELECT count(*) > 0 AS x FROM review_extra.token_surface`), true);
    await flags([RUN], 'another grantor');
    await reprovision(); await healthy();
    assert.equal(await as('runner', `SELECT count(*) > 0 AS x FROM review_extra.token_surface`), '42501');
  } finally { await owner.query(`REVOKE ALL ON review_extra.token_surface FROM s4a_grantor_${name} CASCADE; REVOKE ALL ON SCHEMA review_extra FROM s4a_grantor_${name} CASCADE;
    DROP ROLE s4a_grantor_${name}`); }
});

test('F1: PUBLIC and inherited residual relation access cannot be revoked for these roles: readiness fails, provisioning refuses atomically', async () => {
  for (const [label, tamper, repair] of [
    ['PUBLIC view access', `GRANT USAGE ON SCHEMA review_extra TO PUBLIC; GRANT SELECT ON review_extra.token_surface TO PUBLIC`,
      `REVOKE SELECT ON review_extra.token_surface FROM PUBLIC; REVOKE USAGE ON SCHEMA review_extra FROM PUBLIC`],
    ['inherited membership', `CREATE ROLE s4a_carrier_${name} NOLOGIN; GRANT USAGE ON SCHEMA review_extra TO s4a_carrier_${name};
      GRANT SELECT ON review_extra.token_surface TO s4a_carrier_${name}; GRANT s4a_carrier_${name} TO "${roles.poRunner}"`,
      `REVOKE s4a_carrier_${name} FROM "${roles.poRunner}"; REVOKE ALL ON review_extra.token_surface FROM s4a_carrier_${name};
      REVOKE ALL ON SCHEMA review_extra FROM s4a_carrier_${name}; DROP ROLE s4a_carrier_${name}`]] as const) {
    await owner.query(tamper);
    try {
      const f = await facts();
      assert.ok(f[RUN] > 0, `${label}: runner flagged`);
      assert.throws(() => assertConfinedRuntimeRole(f), /RUNTIME_ROLE_NOT_CONFINED/);
      await assert.rejects(reprovision(), /roles\.sql/, `${label}: provisioning refuses`);
      await owner.query('ROLLBACK');
    } finally { await owner.query(repair); }
    await reprovision(); await healthy();
  }
});

test('F2: an owner-created SECURITY DEFINER routine in pg_temp_N is callable by the separate runner session; readiness flags it, provisioning revokes it', async () => {
  // The owner session stays open (its temporary schema lives as long as it does).
  await owner.query(`CREATE TEMP TABLE s4a_anchor (x integer)`);
  const tmp = (await owner.query(`SELECT quote_ident(nspname) AS s FROM pg_namespace WHERE oid = pg_my_temp_schema()`)).rows[0].s as string;
  await owner.query(`CREATE FUNCTION ${tmp}.s4a_credential_count() RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
      AS 'SELECT count(*) FROM public."ApiToken"';
    REVOKE ALL ON FUNCTION ${tmp}.s4a_credential_count() FROM PUBLIC;`);
  const call = `SELECT ${tmp}.s4a_credential_count() > 0 AS x`;
  for (const [role, key] of [['runner', RUN], ['definer', DEF]] as const) {
    const target = role === 'runner' ? roles.poRunner : roles.poDefiner;
    await owner.query(`GRANT USAGE ON SCHEMA ${tmp} TO "${target}"; GRANT EXECUTE ON FUNCTION ${tmp}.s4a_credential_count() TO "${target}"`);
    assert.equal(await as(role, call), true, `${role}: the temporary SECURITY DEFINER path was real (synthetic credential count only)`);
    await flags([key], `temp SECURITY DEFINER routine (${role})`);
    await reprovision(); await healthy();
    assert.equal(await as(role, call), '42501', `${role}: revoked`);
  }
  // PUBLIC EXECUTE on a temporary routine plus PUBLIC schema USAGE: not revocable for these roles → refused, then repaired.
  await owner.query(`GRANT EXECUTE ON FUNCTION ${tmp}.s4a_credential_count() TO PUBLIC; GRANT USAGE ON SCHEMA ${tmp} TO PUBLIC`);
  try {
    assert.equal(await as('runner', call), true);
    const f = await facts();
    assert.ok(f[RUN] > 0 && f[DEF] > 0, 'both roles reach it through PUBLIC');
    await assert.rejects(reprovision(), /roles\.sql/); await owner.query('ROLLBACK');
  } finally { await owner.query(`REVOKE EXECUTE ON FUNCTION ${tmp}.s4a_credential_count() FROM PUBLIC; REVOKE USAGE ON SCHEMA ${tmp} FROM PUBLIC`); }
  await reprovision(); await healthy();
  await owner.query(`DROP FUNCTION ${tmp}.s4a_credential_count(); DROP TABLE s4a_anchor`);
  // A temporary routine of ANOTHER open owner session: still found by readiness and revoked by provisioning from this session.
  const other = await connect(pgdb.ownerUrl);
  try {
    await other.query(`CREATE TEMP TABLE s4a_anchor2 (x integer)`);
    const tmp2 = (await other.query(`SELECT quote_ident(nspname) AS s FROM pg_namespace WHERE oid = pg_my_temp_schema()`)).rows[0].s as string;
    await other.query(`CREATE FUNCTION ${tmp2}.s4a_credential_count() RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
        AS 'SELECT count(*) FROM public."ApiToken"';
      REVOKE ALL ON FUNCTION ${tmp2}.s4a_credential_count() FROM PUBLIC;
      GRANT USAGE ON SCHEMA ${tmp2} TO "${roles.poRunner}"; GRANT EXECUTE ON FUNCTION ${tmp2}.s4a_credential_count() TO "${roles.poRunner}"`);
    const call2 = `SELECT ${tmp2}.s4a_credential_count() > 0 AS x`;
    assert.equal(await as('runner', call2), true);
    await flags([RUN], 'temp routine of another session');
    await reprovision(); await healthy();
    assert.equal(await as('runner', call2), '42501');
  } finally { await other.end(); }
});

test('F3: schema CREATE (public or foreign), foreign USAGE, PUBLIC/inherited CREATE and schema ownership, per role', async () => {
  const create = (schema: string) => `SELECT has_schema_privilege(current_user, '${schema}', 'CREATE') AS x`;
  for (const [label, role, tamper, probe] of [
    ['CREATE on public', 'runner', `GRANT CREATE ON SCHEMA public TO "${roles.poRunner}"`, create('public')],
    ['CREATE on public', 'definer', `GRANT CREATE ON SCHEMA public TO "${roles.poDefiner}"`, create('public')],
    ['CREATE on a foreign schema', 'runner', `GRANT CREATE ON SCHEMA review_extra TO "${roles.poRunner}"`, create('review_extra')],
    ['CREATE on a foreign schema', 'definer', `GRANT CREATE ON SCHEMA review_extra TO "${roles.poDefiner}"`, create('review_extra')],
    ['USAGE on a foreign schema', 'runner', `GRANT USAGE ON SCHEMA review_extra TO "${roles.poRunner}"`, `SELECT has_schema_privilege(current_user, 'review_extra', 'USAGE') AS x`],
  ] as const) {
    await owner.query(tamper);
    assert.equal(await as(role, probe), true, `${label} (${role}) was effective`);
    await flags([role === 'runner' ? RUN : DEF], `${label} (${role})`);
    await reprovision(); await healthy();
    assert.equal(await as(role, probe), false, `${label} (${role}) revoked`);
  }
  for (const [label, tamper, repair, flagged] of [
    ['definer owns a schema', `ALTER SCHEMA review_extra OWNER TO "${roles.poDefiner}"`, `ALTER SCHEMA review_extra OWNER TO CURRENT_USER`, [DEF]],
    ['PUBLIC CREATE', `GRANT CREATE ON SCHEMA review_extra TO PUBLIC`, `REVOKE CREATE ON SCHEMA review_extra FROM PUBLIC`, [RUN, DEF]],
    ['inherited CREATE', `CREATE ROLE s4a_schema_${name} NOLOGIN; GRANT CREATE ON SCHEMA review_extra TO s4a_schema_${name}; GRANT s4a_schema_${name} TO "${roles.poDefiner}"`,
      `REVOKE s4a_schema_${name} FROM "${roles.poDefiner}"; REVOKE ALL ON SCHEMA review_extra FROM s4a_schema_${name}; DROP ROLE s4a_schema_${name}`, [DEF]],
  ] as const) {
    await owner.query(tamper);
    try {
      const f = await facts();
      for (const key of flagged) assert.ok(Number(f[key as keyof RuntimeRoleFacts]) > 0, `${label}: ${key}`);
      await assert.rejects(reprovision(), /roles\.sql/, `${label}: refused (no silent ownership transfer, no global rewrite)`);
      await owner.query('ROLLBACK');
      assert.equal((await owner.query(`SELECT nspowner::regrole::text AS o FROM pg_namespace WHERE nspname = 'review_extra'`)).rows[0].o === roles.poDefiner,
        label === 'definer owns a schema', 'ownership left as found');
    } finally { await owner.query(repair); }
    await reprovision(); await healthy();
  }
});
