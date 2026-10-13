import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { assertRuntimeRole } from '../../packages/graph/scoped-db.ts';
import { RUNTIME_ROLE_CHECK_SQL } from '../../packages/graph/runtime-role.ts';
import type { RuntimeRoleFacts } from '../../packages/graph/runtime-role.ts';
import { AtlasError } from '../../packages/core/contracts.ts';
import { actionCredential } from '../../packages/actions/authority.ts';
import { previewAction } from '../../packages/actions/requests.ts';
import { createTestDatabase, provisionRoles, urlFor } from '../support/pg-harness.ts';
import { CA, CB, MOCK, WA, WB, addActionFixtures, fenceVersion, privateDir, runtimeClient, scoped, tokens } from '../support/action-fixtures.ts';

// Stage 3 S3-A, A5/A6 on PostgreSQL 17 (superuser migration owner; the non-superuser owner path is action-nonsuper):
// the complete authority fence — one version-0 row per workspace, increments by every auth/Connection mutation derived
// from the affected row only, refusals of identity moves/deletes/TRUNCATE and of any fence change but +1 (definer too),
// trigger-only SECURITY DEFINER function with EXECUTE revoked, and a runtime self-check that refuses every drift.
const pgdb = await createTestDatabase();
const prisma = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
const runtime = await runtimeClient(pgdb.runtimeUrl);
const files = await privateDir();
after(async () => { await runtime.end(); await prisma.$disconnect(); await files.remove(); await pgdb.drop(); });
await addActionFixtures(pgdb.owner);
const owner = pgdb.owner;
const roles = { runtime: pgdb.runtimeRole, definer: pgdb.definerRole, runner: pgdb.runnerRole, fence: pgdb.fenceRole, poDefiner: pgdb.poDefinerRole, poRunner: pgdb.poRunnerRole };
const reprovision = () => provisionRoles(owner, roles, { runtimePassword: randomBytes(18).toString('hex'), runnerPassword: randomBytes(18).toString('hex') });
const v = (w: string) => fenceVersion(runtime, w);
const refused = async (sql: string, pattern: RegExp, client: pg.Client = owner) => {
  await client.query('BEGIN');
  try { await assert.rejects(client.query(sql), pattern, sql); } finally { await client.query('ROLLBACK'); }
};

test('one version-0 fence per workspace, created by the owner\'s Workspace insert; the runtime sees only its own workspace', async () => {
  await owner.query(`INSERT INTO "Workspace" (id, name) VALUES ('act-new', 'New')`);
  assert.equal(await v('act-new'), 0);
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM "Workspace" w LEFT JOIN "ActionAuthorityFence" f ON f."workspaceId" = w.id WHERE f."workspaceId" IS NULL`)).rows[0].n, 0);
  assert.deepEqual(await scoped(runtime, '', '', `SELECT * FROM "ActionAuthorityFence"`), [], 'blank scope: nothing');
  assert.deepEqual((await scoped(runtime, WA, '', `SELECT "workspaceId" FROM "ActionAuthorityFence"`)).map(r => r.workspaceId), [WA]);
  assert.equal((await scoped(runtime, WA, '', `SELECT 1 FROM "ActionAuthorityFence" WHERE "workspaceId" = $1 FOR UPDATE`, [WA])).length, 1, 'exactly one locked row');
  assert.equal((await scoped(runtime, WB, '', `SELECT 1 FROM "ActionAuthorityFence" WHERE "workspaceId" = $1 FOR UPDATE`, [WA])).length, 0, 'another workspace: none');
});

test('every owner auth/Connection mutation increments its own workspace fence once per row — no-op, unrelated, remove+restore, wrong GUC', async () => {
  const a0 = await v(WA) as number; const b0 = await v(WB) as number;
  await owner.query(`UPDATE "Actor" SET "displayName" = "displayName" WHERE "workspaceId" = $1 AND id = 'reader'`, [WA]);           // +1 no-op
  await owner.query(`DELETE FROM "ClientMembership" WHERE "workspaceId" = $1 AND "actorId" = 'approver'`, [WA]);                      // +1
  await owner.query(`INSERT INTO "ClientMembership" ("workspaceId","clientId","actorId",permissions)
    VALUES ($1, $2, 'approver', ARRAY['context:read','actions:read','actions:approve'])`, [WA, CA]);                                    // +1 restore
  await owner.query(`UPDATE "ApiToken" SET "revokedAt" = now() WHERE id = 'tok-contextOnly'`);                                        // +1
  await owner.query(`UPDATE "ApiToken" SET "revokedAt" = NULL, "expiresAt" = now() + interval '1 day' WHERE id = 'tok-contextOnly'`);  // +1
  await owner.query(`UPDATE "Connection" SET "secretRef" = "secretRef" WHERE id = 'atera-b'`);                                         // +1 no-op
  await owner.query(`UPDATE "Actor" SET "displayName" = "displayName" WHERE "workspaceId" = $1 AND id IN ('reader', 'split')`, [WA]);  // +2 (rows)
  await owner.query('BEGIN');
  await owner.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true)`, [WB, 'act-client-x']);
  await owner.query(`UPDATE "Actor" SET "displayName" = "displayName" WHERE "workspaceId" = $1 AND id = 'reader'`, [WA]);           // +1 to WA, not WB
  await owner.query('COMMIT');
  assert.equal(await v(WA), a0 + 9);
  assert.equal(await v(WB), b0, 'another workspace is never touched');
  await owner.query(`UPDATE "ApiToken" SET "expiresAt" = NULL WHERE id = 'tok-contextOnly'`);
  assert.equal(await v(WA), a0 + 10, 'restoring the earlier values does not return to an earlier version');
});

test('identity moves, deletions and TRUNCATE are refused and leave the fence unchanged; the fence only ever moves by +1 (definer too)', async () => {
  const a0 = await v(WA);
  for (const sql of [`UPDATE "Workspace" SET id = 'moved' WHERE id = '${WB}'`, `DELETE FROM "Workspace" WHERE id = 'act-new'`, `TRUNCATE "Workspace" CASCADE`,
    `TRUNCATE "Actor" CASCADE`, `TRUNCATE "ClientMembership"`, `TRUNCATE "ApiToken" CASCADE`, `TRUNCATE "Connection" CASCADE`,
    `UPDATE "ActionAuthorityFence" SET version = version - 1 WHERE "workspaceId" = '${WA}'`,
    `UPDATE "ActionAuthorityFence" SET version = version + 2 WHERE "workspaceId" = '${WA}'`,
    `UPDATE "ActionAuthorityFence" SET version = version WHERE "workspaceId" = '${WA}'`,
    `UPDATE "ActionAuthorityFence" SET "workspaceId" = 'act-new' WHERE "workspaceId" = '${WA}'`,
    `INSERT INTO "ActionAuthorityFence" ("workspaceId", version) VALUES ('nowhere', 5)`,
    `DELETE FROM "ActionAuthorityFence" WHERE "workspaceId" = 'act-new'`, `TRUNCATE "ActionAuthorityFence"`]) {
    await refused(sql, /ACTION_FENCE_GUARD|ACTION_HISTORY_IMMUTABLE/);
  }
  for (const sql of [`UPDATE "Actor" SET id = 'moved' WHERE id = 'reader'`, `UPDATE "ClientMembership" SET "clientId" = '${CB}' WHERE "actorId" = 'reader'`,
    `UPDATE "ApiToken" SET "actorId" = 'approver' WHERE id = 'tok-reader'`, `UPDATE "ApiToken" SET "workspaceId" = '${WB}' WHERE id = 'tok-reader'`]) {
    await refused(sql, /ACTION_AUTHORITY_IDENTITY_IMMUTABLE/);
  }
  await refused(`UPDATE "Connection" SET "clientId" = '${CB}' WHERE id = 'atera-a'`, /immutable/i);
  await owner.query('BEGIN');
  await owner.query(`SET LOCAL ROLE "${roles.fence}"`);
  for (const sql of [`UPDATE "ActionAuthorityFence" SET version = version + 2 WHERE "workspaceId" = '${WA}'`,
    `UPDATE "ActionAuthorityFence" SET version = version - 1 WHERE "workspaceId" = '${WA}'`]) {
    await owner.query('SAVEPOINT s');
    await assert.rejects(owner.query(sql), /ACTION_FENCE_GUARD/, `definer: ${sql}`);
    await owner.query('ROLLBACK TO SAVEPOINT s');
  }
  await owner.query('SAVEPOINT s');
  await assert.rejects(owner.query(`DELETE FROM "ActionAuthorityFence" WHERE "workspaceId" = '${WA}'`), /permission denied|ACTION_FENCE_GUARD/);
  await owner.query('ROLLBACK');
  await runtime.query('BEGIN');
  await runtime.query(`SELECT set_config('app.workspace_id', $1, true)`, [WA]);
  await assert.rejects(runtime.query(`UPDATE "ActionAuthorityFence" SET "workspaceId" = "workspaceId"`), /ACTION_FENCE_GUARD/, 'runtime no-op update of its visible row');
  await runtime.query('ROLLBACK');
  assert.equal((await runtime.query(`UPDATE "ActionAuthorityFence" SET "workspaceId" = "workspaceId"`)).rowCount, 0, 'blank scope: no row to touch');
  await refused(`UPDATE "ActionAuthorityFence" SET version = version + 1`, /permission denied/, runtime);
  await refused(`INSERT INTO "ActionAuthorityFence" ("workspaceId", version) VALUES ('x', 0)`, /permission denied/, runtime);
  await refused(`DELETE FROM "ActionAuthorityFence"`, /permission denied/, runtime);
  assert.equal(await v(WA), a0, 'nothing above changed the epoch');
});

test('the confined runtime fires the definer trigger without EXECUTE; direct calls are refused; pg_temp cannot shadow the fence', async () => {
  const fn = 'public.atlas_action_authority_fence()';
  const facts = (await owner.query(`SELECT p.prosecdef, p.proconfig, p.proowner::regrole::text AS owner, has_function_privilege($1, p.oid, 'EXECUTE') AS runtime_exec,
      (SELECT count(*)::int FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee <> p.proowner) AS others
    FROM pg_proc p WHERE p.oid = $2::regprocedure`, [roles.runtime, fn])).rows[0];
  assert.deepEqual(facts, { prosecdef: true, proconfig: ['search_path=pg_catalog, pg_temp'], owner: roles.fence, runtime_exec: false, others: 0 });
  const attrs = (await owner.query(`SELECT rolcanlogin, rolinherit, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication,
      (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS member_of, (SELECT count(*)::int FROM pg_class c WHERE c.relowner = r.oid) AS owns
    FROM pg_roles r WHERE rolname = $1`, [roles.fence])).rows[0];
  assert.deepEqual(attrs, { rolcanlogin: false, rolinherit: false, rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false,
    rolreplication: false, member_of: 0, owns: 0 });
  await refused(`SELECT ${fn}`, /permission denied/, runtime);
  await refused(`SELECT ${fn}`, /trigger functions can only be called as triggers/);
  await refused(`SET ROLE "${roles.fence}"`, /permission denied/, runtime);
  const before = await v(WA) as number;
  await runtime.query('CREATE TEMP TABLE "ActionAuthorityFence" ("workspaceId" text, version int)');
  await runtime.query(`INSERT INTO pg_temp."ActionAuthorityFence" VALUES ($1, 1000)`, [WA]);
  await runtime.query('BEGIN');
  await runtime.query(`SET LOCAL search_path = pg_temp, public`);
  await runtime.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true)`, [WA, CA]);
  const updated = await runtime.query(`UPDATE public."Connection" SET "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = 'atera-disabled'`);
  await runtime.query('COMMIT');
  assert.equal(updated.rowCount, 1);
  assert.equal(await v(WA), before + 1, 'the runtime update incremented the real fence');
  assert.equal((await runtime.query(`SELECT version FROM pg_temp."ActionAuthorityFence"`)).rows[0].version, 1000, 'the shadow is untouched');
  await runtime.query('DROP TABLE pg_temp."ActionAuthorityFence"');
  const fenceLogin = new pg.Client({ connectionString: urlFor(pgdb.ownerUrl, roles.fence, randomBytes(18).toString('hex')) });
  await assert.rejects(fenceLogin.connect(), /not permitted to log in|password authentication failed/);
  await fenceLogin.end().catch(() => undefined);
});

test('readiness: every drift of the fence surface or of the action grants refuses startup and fenced admission until repaired', async () => {
  await assertRuntimeRole(prisma);
  const input = await files.input({ connectionId: 'atera-a', title: 'Readiness', description: 'Body', idempotencyKey: '11111111-2222-4333-8444-555555555555' });
  let n = 0;
  const admission = () => previewAction(prisma, MOCK, actionCredential(tokens.requester!), CA, input, files.out(`ready-${++n}.json`));
  await admission();
  const drifts: [string, string, () => Promise<unknown>][] = [
    ['disabled fence trigger', `ALTER TABLE "Connection" DISABLE TRIGGER "Connection_action_fence"`, () => owner.query(`ALTER TABLE "Connection" ENABLE ALWAYS TRIGGER "Connection_action_fence"`)],
    ['origin-only fence trigger', `ALTER TABLE "ApiToken" ENABLE TRIGGER "ApiToken_action_fence"`, () => owner.query(`ALTER TABLE "ApiToken" ENABLE ALWAYS TRIGGER "ApiToken_action_fence"`)],
    ['disabled TRUNCATE guard', `ALTER TABLE "Actor" DISABLE TRIGGER "Actor_action_fence_truncate"`, () => owner.query(`ALTER TABLE "Actor" ENABLE ALWAYS TRIGGER "Actor_action_fence_truncate"`)],
    ['disabled Workspace init', `ALTER TABLE "Workspace" DISABLE TRIGGER "Workspace_action_fence_init"`, () => owner.query(`ALTER TABLE "Workspace" ENABLE ALWAYS TRIGGER "Workspace_action_fence_init"`)],
    ['disabled fence self-guard', `ALTER TABLE "ActionAuthorityFence" DISABLE TRIGGER "ActionAuthorityFence_guard"`, () => owner.query(`ALTER TABLE "ActionAuthorityFence" ENABLE ALWAYS TRIGGER "ActionAuthorityFence_guard"`)],
    ['disabled request history guard', `ALTER TABLE "ActionRequest" DISABLE TRIGGER "ActionRequest_history"`, () => owner.query(`ALTER TABLE "ActionRequest" ENABLE TRIGGER "ActionRequest_history"`)],
    ['missing definer policy', `DROP POLICY "ActionAuthorityFence_definer" ON "ActionAuthorityFence"`, reprovision],
    ['extra fence policy', `CREATE POLICY "extra" ON "ActionAuthorityFence" FOR SELECT USING (true)`, () => owner.query(`DROP POLICY "extra" ON "ActionAuthorityFence"`)],
    ['extra action policy', `CREATE POLICY "extra" ON "ActionRequest" FOR SELECT USING (true)`, () => owner.query(`DROP POLICY "extra" ON "ActionRequest"`)],
    ['PUBLIC EXECUTE', `GRANT EXECUTE ON FUNCTION public.atlas_action_authority_fence() TO PUBLIC`, reprovision],
    ['definer privilege elsewhere', `GRANT SELECT ON "Actor" TO "${roles.fence}"`, reprovision],
    ['definer column privilege', `GRANT UPDATE ("workspaceId") ON "ActionAuthorityFence" TO "${roles.fence}"`, reprovision],
    ['function owned by the migration owner', `ALTER FUNCTION public.atlas_action_authority_fence() OWNER TO CURRENT_USER`, reprovision],
    ['FORCE off', `ALTER TABLE "ActionRequest" NO FORCE ROW LEVEL SECURITY`, () => owner.query(`ALTER TABLE "ActionRequest" FORCE ROW LEVEL SECURITY`)],
    ['runtime fence INSERT', `GRANT INSERT ON "ActionAuthorityFence" TO "${roles.runtime}"`, reprovision],
    ['runtime fence version UPDATE', `GRANT UPDATE (version) ON "ActionAuthorityFence" TO "${roles.runtime}"`, reprovision],
    ['runtime lost fence lock grant', `REVOKE UPDATE ON "ActionAuthorityFence" FROM "${roles.runtime}"`, reprovision],
    ...['ActionRequest', 'ActionApproval', 'ActionAttempt', 'ActionVerification', 'ActionMockTicket'].map((t): [string, string, () => Promise<unknown>] =>
      [`broad default grants on ${t}`, `GRANT SELECT, INSERT, UPDATE ON "${t}" TO "${roles.runtime}"`, reprovision]),
  ];
  for (const [label, drift, repair] of drifts) {
    await owner.query(drift);
    try {
      await assert.rejects(assertRuntimeRole(prisma), /RUNTIME_ROLE_NOT_CONFINED|RLS_NOT_ENABLED/, `startup: ${label}`);
      await assert.rejects(admission(), (e: unknown) => e instanceof AtlasError && e.code === 'ACTION_FENCE_NOT_READY', `admission: ${label}`);
    } finally { await repair(); }
    await assertRuntimeRole(prisma);
  }
  await admission();
  // A runtime membership in the definer is a SET ROLE path: roles.sql refuses to provision until it is removed
  await owner.query(`GRANT "${roles.fence}" TO "${roles.runtime}"`);
  try {
    await assert.rejects(assertRuntimeRole(prisma), /RUNTIME_ROLE_NOT_CONFINED/);
    await assert.rejects(reprovision(), /must not be a member/);
    await owner.query('ROLLBACK'); // the refused script left its transaction open and aborted
  } finally { await owner.query(`REVOKE "${roles.fence}" FROM "${roles.runtime}"`); }
  await reprovision();
  await assertRuntimeRole(prisma);
});

// Routine-inventory helpers (F1, F1-R1): readiness fact, startup and a fenced admission, all for the confined runtime.
let routineRun = 0;
const routineInput = files.input({ connectionId: 'atera-a', title: 'Routines', description: 'Body', idempotencyKey: '41111111-2222-4333-8444-555555555555' });
const admission = async () => previewAction(prisma, MOCK, actionCredential(tokens.requester!), CA, await routineInput, files.out(`routine-${++routineRun}.json`));
const notReady = async (label: string) => {
  const facts = (await prisma.$queryRawUnsafe<RuntimeRoleFacts[]>(RUNTIME_ROLE_CHECK_SQL))[0]!;
  assert.ok(facts.actionFenceRoutineViolations > 0, `fact: ${label}`);
  await assert.rejects(assertRuntimeRole(prisma), /RUNTIME_ROLE_NOT_CONFINED/, `startup: ${label}`);
  await assert.rejects(admission(), (e: unknown) => e instanceof AtlasError && e.code === 'ACTION_FENCE_NOT_READY', `admission: ${label}`);
};
const ready = async () => { await assertRuntimeRole(prisma); await admission(); };
const canExecute = async (fn: string) => (await owner.query(`SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS x`, [roles.fence, fn])).rows[0].x;

test('F1: routine privileges of the fence definer are exact — an extra grant or PUBLIC routine refuses startup and admission; roles.sql removes or refuses', async () => {
  await ready();
  // 1. An unrelated, non-PUBLIC SECURITY DEFINER routine (authority-bearing: it reads ApiToken as its owner) granted to the definer
  await owner.query(`CREATE FUNCTION public.test_extra_definer() RETURNS bigint LANGUAGE sql SECURITY DEFINER AS 'SELECT count(*) FROM "ApiToken"';
    REVOKE ALL ON FUNCTION public.test_extra_definer() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.test_extra_definer() TO "${roles.fence}"`);
  assert.equal(await canExecute('public.test_extra_definer()'), true);
  await notReady('extra SECURITY DEFINER grant');
  await reprovision(); // removes the explicit grant (the migration owner is its grantor)
  assert.equal(await canExecute('public.test_extra_definer()'), false);
  await ready();
  // 2. An explicit grant even on an accepted shared helper is drift; roles.sql removes it
  await owner.query(`GRANT EXECUTE ON FUNCTION public.atlas_app_workspace() TO "${roles.fence}"`);
  await notReady('explicit grant on a shared helper');
  await reprovision();
  await ready();
  // 3. A new PUBLIC routine outside the explicit list: not removable by roles.sql, which refuses until it is repaired
  await owner.query(`CREATE FUNCTION public.test_public_helper() RETURNS int LANGUAGE sql AS 'SELECT 1'`);
  await notReady('PUBLIC routine outside the list');
  await assert.rejects(reprovision(), /can execute an unexpected routine/);
  await owner.query('ROLLBACK');
  await owner.query(`REVOKE ALL ON FUNCTION public.test_public_helper() FROM PUBLIC`);
  await reprovision();
  await ready();
  // 4. A grant by another grantor (passed on through a grant option) cannot be revoked by roles.sql: refused until repaired
  const other = `atlas_tst_${randomBytes(4).toString('hex')}`;
  await owner.query(`CREATE ROLE "${other}" NOLOGIN; GRANT USAGE ON SCHEMA public TO "${other}";
    GRANT EXECUTE ON FUNCTION public.test_extra_definer() TO "${other}" WITH GRANT OPTION`);
  try {
    await owner.query(`SET ROLE "${other}"; GRANT EXECUTE ON FUNCTION public.test_extra_definer() TO "${roles.fence}"; RESET ROLE;`);
    await notReady('grant by another grantor');
    await assert.rejects(reprovision(), /can execute an unexpected routine/);
    await owner.query('ROLLBACK');
    await owner.query(`REVOKE ALL ON FUNCTION public.test_extra_definer() FROM "${other}" CASCADE`);
    await reprovision();
    await ready();
  } finally {
    await owner.query('RESET ROLE').catch(() => undefined);
    await owner.query(`REVOKE ALL ON FUNCTION public.test_extra_definer() FROM "${other}" CASCADE; REVOKE ALL ON SCHEMA public FROM "${other}";
      DROP ROLE IF EXISTS "${other}"`).catch(() => undefined);
  }
  await owner.query(`DROP FUNCTION public.test_extra_definer(); DROP FUNCTION public.test_public_helper()`);
  await ready();
});

test('F1-R1: an allowance is the approved schema + signature — the same helper name/arguments in another schema refuses startup, admission and provisioning', async () => {
  await ready();
  // A new SECURITY INVOKER routine with an allowed public helper's exact name and arguments, in another schema, reachable by PUBLIC
  await owner.query(`CREATE SCHEMA test_alias; GRANT USAGE ON SCHEMA test_alias TO PUBLIC;
    CREATE FUNCTION test_alias.atlas_app_workspace() RETURNS integer LANGUAGE sql SECURITY INVOKER AS 'SELECT 17'`);
  try {
    assert.equal(await canExecute('test_alias.atlas_app_workspace()'), true);
    await owner.query('BEGIN');
    await owner.query(`SET LOCAL ROLE "${roles.fence}"`);
    assert.equal((await owner.query(`SELECT test_alias.atlas_app_workspace() AS v`)).rows[0].v, 17, 'a real executable alias for the definer');
    await owner.query('ROLLBACK');
    await notReady('same name/arguments in another schema (PUBLIC)');
    await assert.rejects(reprovision(), /can execute an unexpected routine/, 'roles.sql cannot remove PUBLIC access: it refuses');
    await owner.query('ROLLBACK');
    // Without PUBLIC the alias is unreachable and readiness passes; an explicit grant to the definer is drift that roles.sql removes
    await owner.query(`REVOKE ALL ON FUNCTION test_alias.atlas_app_workspace() FROM PUBLIC`);
    await ready();
    await owner.query(`GRANT EXECUTE ON FUNCTION test_alias.atlas_app_workspace() TO "${roles.fence}"`);
    await notReady('explicit grant on the alias');
    await reprovision();
    assert.equal(await canExecute('test_alias.atlas_app_workspace()'), false, 'removed by roles.sql');
    await ready();
  } finally { await owner.query('ROLLBACK').catch(() => undefined); await owner.query('DROP SCHEMA IF EXISTS test_alias CASCADE'); }
  // The approved public helpers are unchanged and still allowed; readiness and provisioning pass again
  assert.equal(await canExecute('public.atlas_app_workspace()'), true);
  await reprovision();
  await ready();
});
