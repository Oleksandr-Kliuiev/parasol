import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { RUNTIME_ROLE_CHECK_SQL, assertConfinedRuntimeRole } from '../../packages/graph/runtime-role.ts';
import type { RuntimeRoleFacts } from '../../packages/graph/runtime-role.ts';
import { createTestDatabase, provisionRoles } from '../support/pg-harness.ts';
import { readRolesSql, renderRolesSql } from '../support/roles-sql.ts';
import { connect, sqlState } from '../support/poweroffice-fixtures.ts';

// S4-A A3 on PostgreSQL 17: the exact runtime grants on the three PowerOffice tables, the two maintenance roles (NOLOGIN
// definer owning the confined routine, EXECUTE-only runner), their exact privileges/policies, and fail-closed readiness
// under tampering (malicious grant, policy, ACL, trigger, FORCE RLS, search_path). Provisioning is rerunnable.
const pgdb = await createTestDatabase();
after(async () => { await runtime.end().catch(() => undefined); await runner.end().catch(() => undefined); await pgdb.drop(); });
const { owner, roles } = pgdb;
const runtime = await connect(pgdb.runtimeUrl);
const runner = await connect(pgdb.poRunnerUrl);
const facts = async () => (await runtime.query(RUNTIME_ROLE_CHECK_SQL)).rows[0] as RuntimeRoleFacts;
const reprovision = () => provisionRoles(owner, roles, { runtimePassword: randomBytes(18).toString('hex'), runnerPassword: randomBytes(18).toString('hex') });
const PO = ['PowerOfficeState', 'PowerOfficeAttempt', 'PowerOfficeSnapshot'];
const actionFenceFacts = (f: RuntimeRoleFacts) => f.actionFenceRoutineViolations + f.actionFenceOwnerViolations + f.actionFenceFunctionViolations;

/** Every (relation, privilege[, column]) the role holds on a schema relation, table level first, column level only where not table-wide. */
async function privileges(role: string): Promise<string[]> {
  const rows = (await owner.query(`
    WITH rels AS (SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','p','f')),
         privs(p) AS (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER'))
    SELECT r.relname || ':' || v.p AS x FROM rels r, privs v WHERE has_table_privilege($1, r.oid, v.p)
    UNION ALL
    SELECT r.relname || ':' || v.p || ':' || a.attname FROM rels r JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped,
           (VALUES ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) v(p)
     WHERE has_column_privilege($1, r.oid, a.attnum, v.p) AND NOT has_table_privilege($1, r.oid, v.p)
    ORDER BY 1`, [role])).rows;
  return rows.map(r => r.x as string);
}

test('runtime: SELECT/INSERT on the three tables, UPDATE only of State operational columns and Attempt terminal columns; no DELETE/TRUNCATE/Snapshot UPDATE', async () => {
  const all = (await privileges(roles.runtime)).filter(p => PO.some(t => p.startsWith(`${t}:`)));
  assert.deepEqual(all, [
    'PowerOfficeAttempt:INSERT', 'PowerOfficeAttempt:SELECT', 'PowerOfficeAttempt:UPDATE:completedAt', 'PowerOfficeAttempt:UPDATE:safeErrorCode', 'PowerOfficeAttempt:UPDATE:state',
    'PowerOfficeSnapshot:INSERT', 'PowerOfficeSnapshot:SELECT', 'PowerOfficeState:INSERT', 'PowerOfficeState:SELECT',
    ...['activeAttemptId', 'lastAttemptErrorCode', 'lastAttemptId', 'lastAttemptState', 'lastCompletedAttemptId', 'lastCompletedErrorCode', 'lastCompletedState',
      'lastSuccessAt', 'nextSequence', 'snapshotId', 'snapshotVersion', 'updatedAt'].map(c => `PowerOfficeState:UPDATE:${c}`)].sort());
  assertConfinedRuntimeRole(await facts());
});

test('PowerOffice definer: exactly fence/Connection/State/Attempt/Snapshot/AuditEvent privileges, no auth/member/credential access; runner: none', async () => {
  assert.deepEqual(await privileges(roles.poDefiner), [
    'ActionAuthorityFence:SELECT:workspaceId', 'ActionAuthorityFence:UPDATE:workspaceId', 'AuditEvent:INSERT',
    ...['boundAt', 'boundBy', 'clientId', 'externalTenantId', 'id', 'lifecycleVersion', 'status', 'system', 'workspaceId'].map(c => `Connection:SELECT:${c}`),
    'PowerOfficeAttempt:DELETE', 'PowerOfficeAttempt:SELECT', 'PowerOfficeSnapshot:DELETE', 'PowerOfficeSnapshot:SELECT', 'PowerOfficeState:SELECT',
    'PowerOfficeState:UPDATE:snapshotId', 'PowerOfficeState:UPDATE:snapshotVersion', 'PowerOfficeState:UPDATE:updatedAt'].sort());
  assert.deepEqual(await privileges(roles.poRunner), []);
  const attrs = (await owner.query(`SELECT rolname, rolcanlogin, rolinherit, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname IN ($1, $2) ORDER BY rolcanlogin`,
    [roles.poDefiner, roles.poRunner])).rows;
  assert.deepEqual(attrs.map(r => [r.rolcanlogin, r.rolinherit, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb]), [[false, false, false, false, false, false], [true, false, false, false, false, false]]);
  const routine = (await owner.query(`SELECT proowner::regrole::text AS owner, prosecdef, proconfig, proacl::text AS acl FROM pg_proc WHERE proname = 'atlas_poweroffice_cleanup'`)).rows[0];
  assert.equal(routine.owner, roles.poDefiner); assert.equal(routine.prosecdef, true); assert.deepEqual(routine.proconfig, ['search_path=pg_catalog, public']);
  const exec = async (role: string, fn: string) => (await owner.query(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS x`, [role, fn])).rows[0].x;
  const po = 'public.atlas_poweroffice_cleanup(text, text, text, uuid)'; const m365 = 'public.atlas_m365_cleanup(text)';
  assert.deepEqual([await exec(roles.poRunner, po), await exec(roles.runtime, po), await exec(roles.runner, po), await exec(roles.fence, po), await exec(roles.definer, po)],
    [true, false, false, false, false]);
  assert.equal(await exec(roles.poRunner, m365), false, 'the PowerOffice runner cannot run the M365 routine');
  // The runner holds no table privilege and no path to the definer.
  assert.equal(await sqlState(runner.query(`SELECT 1 FROM public."PowerOfficeState"`)), '42501');
  assert.equal(await sqlState(runner.query(`SET ROLE "${roles.poDefiner}"`)), '42501');
  assert.equal(await sqlState(runtime.query(`SELECT public.atlas_poweroffice_cleanup('w', 'c', 'p', gen_random_uuid())`)), '42501');
});

test('policies: each table has exactly its PUBLIC permissive scope policy and a RESTRICTIVE three-ID policy for the definer; the fence keeps its two', async () => {
  const policies = (await owner.query(`SELECT c.relname, p.polname, p.polpermissive, p.polroles::regrole[]::text[] AS roles FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
    WHERE c.relname = ANY($1) ORDER BY 1, 2`, [[...PO, 'ActionAuthorityFence']])).rows;
  assert.deepEqual(policies.map(p => [p.relname, p.polname, p.polpermissive, p.roles]), [
    ['ActionAuthorityFence', 'ActionAuthorityFence_definer', true, [roles.fence]], ['ActionAuthorityFence', 'ActionAuthorityFence_scope', true, ['-']],
    ...PO.slice().sort().flatMap(t => [[t, `${t}_maintenance`, false, [roles.poDefiner]], [t, `${t}_scope`, true, ['-']]])]);
  const force = (await owner.query(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1) ORDER BY 1`, [PO])).rows;
  assert.ok(force.every(r => r.relrowsecurity && r.relforcerowsecurity));
});

test('readiness fails closed under tampering and recovers only by provisioning or explicit repair', async () => {
  const broken = async (tamper: string, fact: keyof RuntimeRoleFacts, repair: string | null) => {
    await owner.query(tamper);
    const f = await facts();
    assert.ok(Number(f[fact]) > 0, `${tamper} → ${String(fact)}`);
    assert.throws(() => assertConfinedRuntimeRole(f), /RUNTIME_ROLE_NOT_CONFINED|RLS_NOT_ENABLED/, tamper);
    if (repair) await owner.query(repair); else await reprovision();
    assertConfinedRuntimeRole(await facts());
  };
  await broken(`GRANT UPDATE ON "PowerOfficeSnapshot" TO "${roles.runtime}"`, 'poRuntimeGrantViolations', null);
  await broken(`GRANT UPDATE ("claimToken") ON "PowerOfficeAttempt" TO "${roles.runtime}"`, 'poRuntimeGrantViolations', null);
  await broken(`REVOKE UPDATE ("activeAttemptId") ON "PowerOfficeState" FROM "${roles.runtime}"`, 'poRuntimeMissingGrants', null);
  await broken(`GRANT DELETE ON "PowerOfficeAttempt" TO "${roles.runtime}"`, 'poRuntimeGrantViolations', null);
  await broken(`GRANT SELECT ON "ApiToken" TO "${roles.poDefiner}"`, 'poOwnerViolations', null);
  await broken(`GRANT UPDATE ("lastSuccessAt") ON "PowerOfficeState" TO "${roles.poDefiner}"`, 'poOwnerViolations', null);
  await broken(`REVOKE DELETE ON "PowerOfficeSnapshot" FROM "${roles.poDefiner}"`, 'poOwnerMissingGrants', null);
  await broken(`GRANT SELECT ON "PowerOfficeState" TO "${roles.poRunner}"`, 'poExecuteViolations', null);
  await broken(`GRANT EXECUTE ON FUNCTION public.atlas_poweroffice_cleanup(text, text, text, uuid) TO "${roles.runner}"`, 'poExecuteViolations', null);
  await broken(`DROP POLICY "PowerOfficeAttempt_maintenance" ON "PowerOfficeAttempt"`, 'poPolicyViolations', null);
  await broken(`CREATE POLICY "PowerOfficeSnapshot_wide" ON "PowerOfficeSnapshot" FOR SELECT TO "${roles.poDefiner}" USING (true)`, 'poPolicyViolations',
    `DROP POLICY "PowerOfficeSnapshot_wide" ON "PowerOfficeSnapshot"`);
  await broken(`ALTER TABLE "PowerOfficeState" DISABLE TRIGGER "PowerOfficeState_commit"`, 'poTriggerViolations', `ALTER TABLE "PowerOfficeState" ENABLE TRIGGER "PowerOfficeState_commit"`);
  await broken(`ALTER TABLE "PowerOfficeSnapshot" NO FORCE ROW LEVEL SECURITY`, 'poTableViolations', `ALTER TABLE "PowerOfficeSnapshot" FORCE ROW LEVEL SECURITY`);
  await broken(`ALTER FUNCTION public.atlas_poweroffice_cleanup(text, text, text, uuid) SET search_path = public, pg_temp`, 'poRoutineViolations',
    `ALTER FUNCTION public.atlas_poweroffice_cleanup(text, text, text, uuid) SET search_path = pg_catalog, public`);
  // A PUBLIC trigger function is refused by readiness AND by provisioning (fail closed; repaired offline).
  await owner.query(`GRANT EXECUTE ON FUNCTION public.atlas_poweroffice_state_guard() TO PUBLIC`);
  const f = await facts();
  assert.ok(f.poRoutineViolations > 0 && f.actionFenceRoutineViolations > 0, 'also an unexpected routine for the Stage 3 fence definer');
  await assert.rejects(reprovision(), /PowerOffice routine privileges are not confined|fence definer .* can execute an unexpected routine/);
  await owner.query('ROLLBACK');
  await owner.query(`REVOKE EXECUTE ON FUNCTION public.atlas_poweroffice_state_guard() FROM PUBLIC`);
  await reprovision();
  assertConfinedRuntimeRole(await facts());
});

test('provisioning is rerunnable and refuses colliding role names', async () => {
  await reprovision(); await reprovision();
  assertConfinedRuntimeRole(await facts());
  assert.equal((await owner.query(`SELECT proowner::regrole::text AS o FROM pg_proc WHERE proname = 'atlas_poweroffice_cleanup'`)).rows[0].o, roles.poDefiner);
  // The renderer refuses equal names itself; roles.sql must refuse them too when rendered by hand.
  assert.throws(() => renderRolesSql('', { ...roles, poRunner: roles.runner }, { runtimePassword: 'a'.repeat(20), runnerPassword: 'b'.repeat(20) }));
  const rendered = renderRolesSql(await readRolesSql(), roles, { runtimePassword: 'a'.repeat(20), runnerPassword: 'b'.repeat(20) });
  for (const [from, to] of [[roles.poRunner, roles.runner], [roles.poDefiner, roles.definer], [roles.poDefiner, roles.poRunner]]) {
    const sql = rendered.replace(`'${from}'`, `'${to}'`);
    assert.notEqual(sql, rendered);
    await assert.rejects(owner.query(sql), /seven different roles/);
    await owner.query('ROLLBACK');
  }
  assertConfinedRuntimeRole(await facts());
});

test('RC1 F1: each maintenance role executes only its exact capability plus the shared invoker helpers; extras fail readiness and are revoked or refused', async () => {
  const exec = async (role: string, fn: string) => (await owner.query(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS x`, [role, fn])).rows[0].x as boolean;
  await owner.query(`CREATE SCHEMA s4a_foreign;
    CREATE FUNCTION public.s4a_extra() RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS 'SELECT 42';
    CREATE FUNCTION public.s4a_helper() RETURNS integer LANGUAGE sql SET search_path = pg_catalog AS 'SELECT 7';
    CREATE FUNCTION s4a_foreign.s4a_remote() RETURNS integer LANGUAGE sql SET search_path = pg_catalog AS 'SELECT 9';
    REVOKE ALL ON FUNCTION public.s4a_extra(), public.s4a_helper(), s4a_foreign.s4a_remote() FROM PUBLIC;`);
  // The reviewer's reproduction: an unrelated SECURITY DEFINER routine granted to both roles.
  await owner.query(`GRANT EXECUTE ON FUNCTION public.s4a_extra() TO "${roles.poRunner}", "${roles.poDefiner}"`);
  let f = await facts();
  assert.ok(f.poExecuteViolations > 0 && f.poOwnerViolations > 0, 'runner and definer surfaces both flagged');
  assert.throws(() => assertConfinedRuntimeRole(f), /RUNTIME_ROLE_NOT_CONFINED/);
  assert.equal((await runner.query(`SELECT public.s4a_extra() AS x`)).rows[0].x, 42, 'the extra path was real');
  await reprovision();
  assertConfinedRuntimeRole(await facts());
  assert.deepEqual([await exec(roles.poRunner, 'public.s4a_extra()'), await exec(roles.poDefiner, 'public.s4a_extra()')], [false, false], 'revoked by provisioning');
  assert.equal(await sqlState(runner.query(`SELECT public.s4a_extra()`)), '42501');
  // Each role separately, an invoker helper, a foreign schema, an explicit grant of a shared helper, a grant option.
  const separately: [string, keyof RuntimeRoleFacts, keyof RuntimeRoleFacts][] = [
    [`GRANT EXECUTE ON FUNCTION public.s4a_extra() TO "${roles.poRunner}"`, 'poExecuteViolations', 'poOwnerViolations'],
    [`GRANT EXECUTE ON FUNCTION public.s4a_extra() TO "${roles.poDefiner}"`, 'poOwnerViolations', 'poExecuteViolations'],
    [`GRANT EXECUTE ON FUNCTION public.s4a_helper() TO "${roles.poRunner}"`, 'poExecuteViolations', 'poOwnerViolations'],
    [`GRANT USAGE ON SCHEMA s4a_foreign TO "${roles.poDefiner}"; GRANT EXECUTE ON FUNCTION s4a_foreign.s4a_remote() TO "${roles.poDefiner}"`, 'poOwnerViolations', 'poExecuteViolations'],
    [`GRANT EXECUTE ON FUNCTION s4a_foreign.s4a_remote() TO "${roles.poRunner}" WITH GRANT OPTION`, 'poExecuteViolations', 'poOwnerViolations'],
    [`GRANT EXECUTE ON FUNCTION public.atlas_app_workspace() TO "${roles.poDefiner}"`, 'poOwnerViolations', 'poExecuteViolations'],
    [`GRANT EXECUTE ON FUNCTION public.atlas_app_clients() TO "${roles.poRunner}"`, 'poExecuteViolations', 'poOwnerViolations'],
    [`GRANT EXECUTE ON FUNCTION public.atlas_poweroffice_cleanup(text, text, text, uuid) TO "${roles.poRunner}" WITH GRANT OPTION`, 'poExecuteViolations', 'poOwnerViolations'],
  ];
  for (const [tamper, flagged, clean] of separately) {
    await owner.query(tamper);
    f = await facts();
    assert.ok(Number(f[flagged]) > 0, `${tamper} → ${String(flagged)}`);
    assert.equal(Number(f[clean]), 0, `${tamper} leaves ${String(clean)} clean`);
    assert.deepEqual(actionFenceFacts(f), 0, 'the Stage 3 fence surface is unaffected');
    await reprovision();
    assertConfinedRuntimeRole(await facts());
  }
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.proname IN ('atlas_app_workspace', 'atlas_app_clients') AND a.grantee IN ($1::regrole, $2::regrole)`, [roles.poDefiner, roles.poRunner])).rows[0].n, 0,
    'explicit grants on shared helpers were revoked; PUBLIC access to them is unchanged');
  // PUBLIC access to a non-shared routine (here in a foreign schema) and an inherited path cannot be revoked by roles.sql: refused.
  for (const [tamper, repair] of [
    [`GRANT EXECUTE ON FUNCTION s4a_foreign.s4a_remote() TO PUBLIC`, `REVOKE EXECUTE ON FUNCTION s4a_foreign.s4a_remote() FROM PUBLIC`],
    [`CREATE ROLE s4a_carrier_${roles.poRunner.slice(-8)} NOLOGIN; GRANT EXECUTE ON FUNCTION public.s4a_extra() TO s4a_carrier_${roles.poRunner.slice(-8)};
      GRANT s4a_carrier_${roles.poRunner.slice(-8)} TO "${roles.poRunner}"`,
     `REVOKE s4a_carrier_${roles.poRunner.slice(-8)} FROM "${roles.poRunner}"; REVOKE ALL ON FUNCTION public.s4a_extra() FROM s4a_carrier_${roles.poRunner.slice(-8)};
      DROP ROLE s4a_carrier_${roles.poRunner.slice(-8)}`]] as const) {
    await owner.query(tamper);
    f = await facts();
    assert.ok(f.poExecuteViolations > 0, tamper);
    await assert.rejects(reprovision(), /roles\.sql/, `provisioning refuses: ${tamper}`);
    await owner.query('ROLLBACK');
    await owner.query(repair);
    await reprovision();
    assertConfinedRuntimeRole(await facts());
  }
});
