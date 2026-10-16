import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ASK_REMOTE_READY_SQL, ASK_REMOTE_ROUTINES, askRemoteProblems } from '../../packages/graph/ask-remote-role.ts';
import type { AskRemoteFacts } from '../../packages/graph/ask-remote-role.ts';
import { ACTION_FENCE_READY_SQL, actionFenceProblems } from '../../packages/graph/fence-role.ts';
import type { ActionFenceFacts } from '../../packages/graph/fence-role.ts';
import { RUNTIME_ROLE_CHECK_SQL, assertConfinedRuntimeRole } from '../../packages/graph/runtime-role.ts';
import type { RuntimeRoleFacts } from '../../packages/graph/runtime-role.ts';
import { createTestDatabase, provisionRoles } from '../support/pg-harness.ts';
import { connectAs, sqlstate } from '../support/ask-remote-pg.ts';
import { readRolesSql, renderRolesSql } from '../support/roles-sql.ts';

// ASK-REMOTE R-A confinement on PostgreSQL 17 (04 roles/readiness, 05 "DB roles/upgrade"): after provisioning the shared
// runtime readiness (every Ask mode, OFF/MOCK included) and the Stage 3 fence readiness pass; every tamper below — stray
// PUBLIC routine (definer, invoker, trigger), missing/extra remote-owner or fence-column privilege, runtime table/column DML,
// default-grant replay, role membership/inheritance/ownership/attributes, RLS/policy/trigger/FK drift — fails the focused
// check (and, where provisioning cannot repair it, roles.sql refuses); each probe is restored and readiness passes again.
const pgdb = await createTestDatabase();
const owner = pgdb.owner;
const runtime = await connectAs(pgdb.runtimeUrl);
after(async () => { await runtime.end().catch(() => undefined); await pgdb.drop(); });
const R = pgdb.remoteRole; const RT = pgdb.runtimeRole;
const secrets = () => ({ runtimePassword: randomBytes(18).toString('hex'), runnerPassword: randomBytes(18).toString('hex') });
const reprovision = () => provisionRoles(owner, pgdb.roles, secrets());
/** roles.sql must refuse (its one transaction is left aborted, as psql -v ON_ERROR_STOP=1 would end the session): roll back. */
async function refused(pattern: RegExp): Promise<void> {
  await assert.rejects(reprovision(), pattern);
  await owner.query('ROLLBACK');
}
const runtimeFacts = async () => (await runtime.query(RUNTIME_ROLE_CHECK_SQL)).rows[0] as RuntimeRoleFacts;
const remoteFacts = async () => (await runtime.query(ASK_REMOTE_READY_SQL)).rows[0] as AskRemoteFacts;
const fenceFacts = async () => (await runtime.query(ACTION_FENCE_READY_SQL)).rows[0] as ActionFenceFacts;
const sig = async (name: string) => (await owner.query(`SELECT oid::regprocedure::text AS s FROM pg_proc WHERE proname = $1`, [name])).rows[0].s as string;
async function allReady(): Promise<void> {
  assert.deepEqual(askRemoteProblems(await remoteFacts()), [], 'ASK-REMOTE readiness');
  assert.deepEqual(actionFenceProblems(await fenceFacts()), [], 'Stage 3 fence readiness unchanged');
  const facts = await runtimeFacts();
  assert.doesNotThrow(() => assertConfinedRuntimeRole(facts), 'shared runtime readiness (mode-independent)');
}
/** One isolated probe: tamper, observe the expected failing facts, restore, observe readiness again. */
async function probe(name: string, tamper: string[], expected: (keyof AskRemoteFacts | 'fence')[], restore: () => Promise<unknown>): Promise<void> {
  for (const sql of tamper) await owner.query(sql);
  const facts = await remoteFacts();
  for (const key of expected) {
    if (key === 'fence') assert.notDeepEqual(actionFenceProblems(await fenceFacts()), [], `${name}: fence readiness detects it`);
    else assert.ok(Number(facts[key]) > 0, `${name}: ${key}`);
  }
  await assert.rejects(runtimeFacts().then(assertConfinedRuntimeRole), /RUNTIME_ROLE_NOT_CONFINED|RLS_NOT_ENABLED/, `${name}: the runtime refuses to start`);
  await restore();
  await allReady();
}

test('provisioned: eight routines owned by the NOLOGIN NOINHERIT remote definer, exact ACLs, runtime SELECT-only; all readiness passes', async () => {
  await allReady();
  const role = (await owner.query(`SELECT rolcanlogin, rolinherit, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication FROM pg_roles WHERE rolname = $1`, [R])).rows[0];
  assert.deepEqual(role, { rolcanlogin: false, rolinherit: false, rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false });
  const acl = (await owner.query(`SELECT p.proname, p.proowner::regrole::text AS owner, coalesce((SELECT array_agg(a.grantee::regrole::text ORDER BY a.grantee::regrole::text) FROM aclexplode(p.proacl) a
    WHERE a.grantee <> p.proowner), '{}') AS grantees FROM pg_proc p WHERE p.proname LIKE 'atlas\\_ask\\_remote\\_%' ORDER BY 1`)).rows;
  const tableOwner = (await owner.query(`SELECT relowner::regrole::text AS o FROM pg_class WHERE oid = 'public."RemoteAskPolicy"'::regclass`)).rows[0].o;
  assert.deepEqual(acl, ASK_REMOTE_ROUTINES.map(([n, , , g]) => ({ proname: n, owner: R, grantees: g === 'runtime' ? [RT] : g === 'owner' ? [tableOwner] : [] }))
    .sort((a, b) => a.proname.localeCompare(b.proname)));
  for (const t of ['RemoteAskPolicy', 'RemoteAskClientAdmission', 'RemoteAskPeriodCounter', 'RemoteAskAttempt']) {
    const p = (await owner.query(`SELECT has_table_privilege($1, $2, 'SELECT') AS s, has_any_column_privilege($1, $2, 'INSERT') AS i,
      has_any_column_privilege($1, $2, 'UPDATE') AS u, has_table_privilege($1, $2, 'DELETE') AS d, has_table_privilege($1, $2, 'TRUNCATE') AS t`, [RT, `public."${t}"`])).rows[0];
    assert.deepEqual(p, { s: true, i: false, u: false, d: false, t: false }, t);
  }
  // The existing fence definer, its routine and both fence policies are unchanged; the remote definer uses the scope policy.
  const fence = (await owner.query(`SELECT array_agg(polname::text ORDER BY polname) AS p FROM pg_policy WHERE polrelid = 'public."ActionAuthorityFence"'::regclass`)).rows[0].p;
  assert.deepEqual(fence, ['ActionAuthorityFence_definer', 'ActionAuthorityFence_scope']);
  assert.equal((await owner.query(`SELECT proowner::regrole::text AS o FROM pg_proc WHERE proname = 'atlas_action_authority_fence'`)).rows[0].o, pgdb.fenceRole);
  assert.deepEqual((await owner.query(`SELECT has_column_privilege($1, 'public."ActionAuthorityFence"', 'version', 'UPDATE') AS u,
    has_column_privilege($1, 'public."ActionAuthorityFence"', 'version', 'INSERT') AS i, has_table_privilege($1, 'public."ActionAuthorityFence"', 'DELETE') AS d`, [R])).rows[0],
    { u: true, i: false, d: false });
  for (const role of [pgdb.fenceRole, pgdb.definerRole, pgdb.runnerRole, pgdb.poDefinerRole, pgdb.poRunnerRole]) {
    const n = (await owner.query(`SELECT count(*)::int AS n FROM pg_class c, pg_proc p WHERE (c.relname LIKE 'RemoteAsk%' AND has_any_column_privilege($1, c.oid, 'SELECT'))
      OR (p.proname LIKE 'atlas\\_ask\\_remote\\_%' AND has_function_privilege($1, p.oid, 'EXECUTE'))`, [role])).rows[0].n;
    assert.equal(n, 0, `${role} gains nothing`);
  }
});

test('reprovisioning is idempotent: identical ACL/ownership/membership snapshot, no PUBLIC routine, runtime DML still denied', async () => {
  // Canonical: every effective ACL entry (object, grantee, privilege, grant option, grantor), owners and memberships, sorted.
  const snapshot = async () => (await owner.query(`SELECT array_agg(e ORDER BY e) AS entries FROM (
      SELECT 'fn ' || p.proname || ' owner=' || p.proowner::regrole::text AS e FROM pg_proc p WHERE p.proname LIKE 'atlas\\_ask\\_remote\\_%'
      UNION ALL SELECT 'fn ' || p.proname || ' ' || a.grantee::regrole::text || ' ' || a.privilege_type || ' ' || a.is_grantable || ' by ' || a.grantor::regrole::text
        FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE p.proname LIKE 'atlas\\_ask\\_remote\\_%' AND a.grantee <> 0
      UNION ALL SELECT 'fn ' || p.proname || ' PUBLIC ' || a.privilege_type FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        WHERE p.proname LIKE 'atlas\\_ask\\_remote\\_%' AND a.grantee = 0
      UNION ALL SELECT 'rel ' || c.relname || ' ' || a.grantee::regrole::text || ' ' || a.privilege_type || ' ' || a.is_grantable
        FROM pg_class c, aclexplode(c.relacl) a WHERE c.relname LIKE 'RemoteAsk%' AND c.relkind = 'r' AND a.grantee <> 0
      UNION ALL SELECT 'col ' || c.relname || '.' || t.attname || ' ' || a.grantee::regrole::text || ' ' || a.privilege_type || ' ' || a.is_grantable
        FROM pg_class c JOIN pg_attribute t ON t.attrelid = c.oid, aclexplode(t.attacl) a
       WHERE (c.relname LIKE 'RemoteAsk%' OR c.relname = 'ActionAuthorityFence') AND a.grantee <> 0
      UNION ALL SELECT 'member ' || r.rolname || ' < ' || m.member::regrole::text || ' ' || m.admin_option || m.inherit_option || m.set_option
        FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid WHERE r.rolname = $1 OR m.member = (SELECT oid FROM pg_roles WHERE rolname = $1)) x`, [R])).rows[0].entries as string[];
  const before = await snapshot();
  await reprovision(); await reprovision();
  assert.deepEqual(await snapshot(), before);
  // A hand-rendered script naming the remote definer like another role is refused (the renderer refuses it itself).
  assert.throws(() => renderRolesSql('', { ...pgdb.roles, remote: RT }, secrets()));
  const rendered = renderRolesSql(await readRolesSql(), pgdb.roles, secrets());
  for (const other of [RT, pgdb.fenceRole, pgdb.poDefinerRole]) {
    await assert.rejects(owner.query(rendered.replace(`'${R}'`, `'${other}'`)), /eight different roles/);
    await owner.query('ROLLBACK');
  }
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.proname LIKE 'atlas\\_ask\\_remote\\_%' AND a.grantee = 0`)).rows[0].n, 0);
  await allReady();
});

test('stray PUBLIC routines (definer grant, new invoker function, new trigger function) fail readiness; provisioning refuses the unknown ones', async () => {
  await probe('PUBLIC EXECUTE on reserve', [`GRANT EXECUTE ON FUNCTION ${await sig('atlas_ask_remote_reserve')} TO PUBLIC`],
    ['arRoutineViolations', 'arExecuteViolations', 'fence'], reprovision);
  await probe('PUBLIC EXECUTE on the guard', [`GRANT EXECUTE ON FUNCTION public.atlas_ask_remote_guard() TO PUBLIC`], ['arRoutineViolations', 'arExecuteViolations'], reprovision);
  const strayInvoker = `CREATE FUNCTION public.atlas_ask_remote_stray() RETURNS integer LANGUAGE sql AS 'SELECT 1'`;
  await probe('new atlas_ask_remote_* invoker function (default PUBLIC EXECUTE)', [strayInvoker], ['arRoutineViolations', 'fence'], async () => {
    await refused(/ASK-REMOTE routines missing or unexpected/);
    await owner.query(`DROP FUNCTION public.atlas_ask_remote_stray()`); await reprovision();
  });
  await owner.query(`CREATE FUNCTION public.atlas_stray_trigger() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'`);
  try {
    assert.notDeepEqual(actionFenceProblems(await fenceFacts()), [], 'a stray PUBLIC trigger function fails the shared fence check');
    await assert.rejects(runtimeFacts().then(assertConfinedRuntimeRole), /RUNTIME_ROLE_NOT_CONFINED/);
    await refused(/fence definer|remote definer|capability/);
  } finally { await owner.query(`DROP FUNCTION public.atlas_stray_trigger()`); }
  await reprovision(); await allReady();
});

test('remote owner: missing or extra privileges (fence columns included) fail readiness; reprovisioning restores the exact allowlist', async () => {
  await probe('missing fence UPDATE(version)', [`REVOKE UPDATE (version) ON "ActionAuthorityFence" FROM "${R}"`], ['arOwnerMissingGrants'], reprovision);
  await probe('missing attempt INSERT', [`REVOKE INSERT ON "RemoteAskAttempt" FROM "${R}"`], ['arOwnerMissingGrants'], reprovision);
  await probe('extra fence INSERT', [`GRANT INSERT ("workspaceId", version) ON "ActionAuthorityFence" TO "${R}"`], ['arOwnerViolations'], reprovision);
  await probe('extra attempt DELETE', [`GRANT DELETE ON "RemoteAskAttempt" TO "${R}"`], ['arOwnerViolations'], reprovision);
  await probe('extra identity UPDATE', [`GRANT UPDATE ("projectIdentity") ON "RemoteAskPolicy" TO "${R}"`], ['arOwnerViolations'], reprovision);
  await probe('extra Connection read', [`GRANT SELECT ON "Connection" TO "${R}"`], ['arOwnerViolations'], reprovision);
  await probe('grant option', [`GRANT SELECT ON "RemoteAskPolicy" TO "${R}" WITH GRANT OPTION`], ['arOwnerViolations'], reprovision);
  await probe('execute another definer routine', [`GRANT EXECUTE ON FUNCTION public.atlas_m365_cleanup(text) TO "${R}"`], ['arOwnerViolations'], reprovision);
});

test('runtime: table/column DML, grant options, owner routines and default-grant replay fail readiness; provisioning removes them again', async () => {
  await probe('runtime INSERT on the policy', [`GRANT INSERT ON "RemoteAskPolicy" TO "${RT}"`], ['arRuntimeGrantViolations'], reprovision);
  await probe('runtime column UPDATE on the attempt', [`GRANT UPDATE (state, "accountedMicroUsd") ON "RemoteAskAttempt" TO "${RT}"`], ['arRuntimeGrantViolations'], reprovision);
  await probe('runtime column INSERT on the counter', [`GRANT INSERT ("workspaceId") ON "RemoteAskPeriodCounter" TO "${RT}"`], ['arRuntimeGrantViolations'], reprovision);
  await probe('runtime DELETE', [`GRANT DELETE ON "RemoteAskClientAdmission" TO "${RT}"`], ['arRuntimeGrantViolations'], reprovision);
  await probe('runtime grant option', [`GRANT SELECT ON "RemoteAskAttempt" TO "${RT}" WITH GRANT OPTION`], ['arRuntimeGrantViolations'], reprovision);
  await probe('runtime may revise', [`GRANT EXECUTE ON FUNCTION ${await sig('atlas_ask_remote_policy_revise')} TO "${RT}"`], ['arExecuteViolations'], reprovision);
  await probe('runtime lost reserve', [`REVOKE EXECUTE ON FUNCTION ${await sig('atlas_ask_remote_reserve')} FROM "${RT}"`], ['arRuntimeMissingGrants', 'arExecuteViolations'], reprovision);
  // Generic/default grant replay (what a later migration's default privileges or a careless GRANT ALL would do).
  await probe('generic regrant', [`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${RT}"`], ['arRuntimeGrantViolations'], reprovision);
  await runtime.query('BEGIN');
  try {
    await runtime.query(`SELECT set_config('app.workspace_id', 'rem-none', true)`);
    assert.equal(await sqlstate(runtime.query(`UPDATE "RemoteAskPolicy" SET state = 'ACTIVE'`)), '42501', 'replay did not reopen DML');
  } finally { await runtime.query('ROLLBACK'); }
});

test('membership, inheritance, attributes and ownership of the remote definer fail readiness and provisioning refuses them', async () => {
  const refuse = (pattern: RegExp, undo: string) => async () => { await refused(pattern); await owner.query(undo); await reprovision(); };
  await probe('runtime member of the definer', [`GRANT "${R}" TO "${RT}"`], ['arOwnerViolations'], refuse(/must not be a member/, `REVOKE "${R}" FROM "${RT}"`));
  await probe('definer member of a role', [`GRANT pg_read_all_data TO "${R}"`], ['arOwnerViolations'], refuse(/must not be a member/, `REVOKE pg_read_all_data FROM "${R}"`));
  await probe('definer INHERIT', [`ALTER ROLE "${R}" INHERIT`], ['arOwnerViolations'], refuse(/not confined/, `ALTER ROLE "${R}" NOINHERIT`));
  await probe('definer LOGIN', [`ALTER ROLE "${R}" LOGIN`], ['arOwnerViolations'], refuse(/not confined/, `ALTER ROLE "${R}" NOLOGIN`));
  await probe('definer owns a relation', [`CREATE TABLE public.ar_stray (x integer)`, `ALTER TABLE public.ar_stray OWNER TO "${R}"`], ['arOwnerViolations'],
    refuse(/must not own any relation/, `DROP TABLE public.ar_stray`));
});

test('RLS, policy, trigger, FK and CHECK drift on the remote tables fail readiness (protected-table registration included)', async () => {
  await probe('NO FORCE RLS', [`ALTER TABLE "RemoteAskAttempt" NO FORCE ROW LEVEL SECURITY`], ['arTableViolations'],
    () => owner.query(`ALTER TABLE "RemoteAskAttempt" FORCE ROW LEVEL SECURITY`));
  await probe('RLS disabled', [`ALTER TABLE "RemoteAskPeriodCounter" DISABLE ROW LEVEL SECURITY`], ['arTableViolations'],
    () => owner.query(`ALTER TABLE "RemoteAskPeriodCounter" ENABLE ROW LEVEL SECURITY`));
  assert.ok(Number((await runtimeFacts()).unprotectedTables) === 0);
  await owner.query(`ALTER TABLE "RemoteAskPolicy" DISABLE ROW LEVEL SECURITY`);
  try { assert.ok(Number((await runtimeFacts()).unprotectedTables) > 0, 'PROTECTED_TABLES covers the remote tables'); }
  finally { await owner.query(`ALTER TABLE "RemoteAskPolicy" ENABLE ROW LEVEL SECURITY`); }
  await probe('permissive extra policy', [`CREATE POLICY "RemoteAskPolicy_open" ON "RemoteAskPolicy" FOR SELECT USING (true)`], ['arTableViolations'],
    () => owner.query(`DROP POLICY "RemoteAskPolicy_open" ON "RemoteAskPolicy"`));
  await probe('guard only ORIGIN-enabled', [`ALTER TABLE "RemoteAskAttempt" ENABLE TRIGGER "RemoteAskAttempt_guard"`], ['arTriggerViolations'],
    () => owner.query(`ALTER TABLE "RemoteAskAttempt" ENABLE ALWAYS TRIGGER "RemoteAskAttempt_guard"`));
  await probe('ledger check disabled', [`ALTER TABLE "RemoteAskPeriodCounter" DISABLE TRIGGER "RemoteAskPeriodCounter_ledger"`], ['arTriggerViolations'],
    () => owner.query(`ALTER TABLE "RemoteAskPeriodCounter" ENABLE ALWAYS TRIGGER "RemoteAskPeriodCounter_ledger"`));
  await probe('scoped FK dropped', [`ALTER TABLE "RemoteAskAttempt" DROP CONSTRAINT "RemoteAskAttempt_actor_fkey"`], ['arTableViolations'],
    () => owner.query(`ALTER TABLE "RemoteAskAttempt" ADD CONSTRAINT "RemoteAskAttempt_actor_fkey" FOREIGN KEY ("workspaceId", "actorId")
      REFERENCES "Actor"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT`));
  await probe('contract CHECK renamed away', [`ALTER TABLE "RemoteAskAttempt" RENAME CONSTRAINT "RemoteAskAttempt_contract_check" TO "ar_other_check"`], ['arTableViolations'],
    () => owner.query(`ALTER TABLE "RemoteAskAttempt" RENAME CONSTRAINT "ar_other_check" TO "RemoteAskAttempt_contract_check"`));
});

test('RC2 R2: effective column/table grant options, schema CREATE/ownership/grants in any schema and out-of-allowlist relations elsewhere fail startup', async () => {
  const fixed = async (undo: string[]) => { for (const sql of undo) await owner.query(sql); await reprovision(); };
  // The two demonstrated cases (RC1 readiness accepted both) and nearby column variants.
  await probe('fence UPDATE(version) WITH GRANT OPTION', [`GRANT UPDATE (version) ON "ActionAuthorityFence" TO "${R}" WITH GRANT OPTION`], ['arOwnerViolations'], reprovision);
  await probe('fence SELECT(workspaceId) WITH GRANT OPTION', [`GRANT SELECT ("workspaceId") ON "ActionAuthorityFence" TO "${R}" WITH GRANT OPTION`], ['arOwnerViolations'], reprovision);
  await probe('allowlisted attempt column WITH GRANT OPTION', [`GRANT UPDATE (state) ON "RemoteAskAttempt" TO "${R}" WITH GRANT OPTION`], ['arOwnerViolations'], reprovision);
  await probe('allowlisted table INSERT WITH GRANT OPTION', [`GRANT INSERT ON "RemoteAskPeriodCounter" TO "${R}" WITH GRANT OPTION`], ['arOwnerViolations'], reprovision);
  await owner.query('CREATE SCHEMA ar_rc2_other');
  try {
    await probe('CREATE on another schema', [`GRANT CREATE ON SCHEMA ar_rc2_other TO "${R}"`], ['arOwnerViolations'],
      () => fixed([`REVOKE CREATE ON SCHEMA ar_rc2_other FROM "${R}"`]));
    await probe('PUBLIC CREATE on another schema (effective)', [`GRANT CREATE ON SCHEMA ar_rc2_other TO PUBLIC`], ['arOwnerViolations'],
      () => fixed([`REVOKE CREATE ON SCHEMA ar_rc2_other FROM PUBLIC`]));
    await probe('explicit USAGE on another schema', [`GRANT USAGE ON SCHEMA ar_rc2_other TO "${R}"`], ['arOwnerViolations'],
      () => fixed([`REVOKE USAGE ON SCHEMA ar_rc2_other FROM "${R}"`]));
    await probe('owns another schema', [`ALTER SCHEMA ar_rc2_other OWNER TO "${R}"`], ['arOwnerViolations'],
      async () => { await refused(/remote definer .* capability/); await fixed([`ALTER SCHEMA ar_rc2_other OWNER TO CURRENT_USER`]); });
    await probe('CREATE on public', [`GRANT CREATE ON SCHEMA public TO "${R}"`], ['arOwnerViolations'], () => fixed([`REVOKE CREATE ON SCHEMA public FROM "${R}"`]));
    // Out-of-allowlist relations: a same-named table in another schema never matches public."RemoteAskPolicy"; PUBLIC grants count.
    await owner.query(`CREATE TABLE ar_rc2_other."RemoteAskPolicy" (x integer); CREATE TABLE ar_rc2_other.plain (x integer)`);
    await probe('INSERT on a same-named table in another schema', [`GRANT INSERT ON ar_rc2_other."RemoteAskPolicy" TO "${R}"`], ['arOwnerViolations'],
      () => fixed([`REVOKE INSERT ON ar_rc2_other."RemoteAskPolicy" FROM "${R}"`]));
    await probe('column UPDATE on another schema table', [`GRANT UPDATE (x) ON ar_rc2_other.plain TO "${R}"`], ['arOwnerViolations'],
      () => fixed([`REVOKE UPDATE (x) ON ar_rc2_other.plain FROM "${R}"`]));
    await probe('PUBLIC SELECT on another schema table (effective)', [`GRANT SELECT ON ar_rc2_other.plain TO PUBLIC`], ['arOwnerViolations'],
      () => fixed([`REVOKE SELECT ON ar_rc2_other.plain FROM PUBLIC`]));
    await owner.query(`CREATE FUNCTION ar_rc2_other.ar_def() RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS 'SELECT 1'`);
    await probe('PUBLIC SECURITY DEFINER routine in another schema', [], ['arOwnerViolations', 'fence'],
      () => fixed([`REVOKE ALL ON FUNCTION ar_rc2_other.ar_def() FROM PUBLIC`]));
    await probe('database CREATE', [`GRANT CREATE ON DATABASE "${pgdb.name}" TO "${R}"`], ['arOwnerViolations'],
      () => fixed([`REVOKE CREATE ON DATABASE "${pgdb.name}" FROM "${R}"`]));
  } finally { await owner.query('DROP SCHEMA ar_rc2_other CASCADE'); }
  await reprovision(); await allReady();
});
