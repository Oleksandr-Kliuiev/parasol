import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { generateToken } from '../../packages/auth/token.ts';
import { ASK_REMOTE_READY_SQL, askRemoteProblems } from '../../packages/graph/ask-remote-role.ts';
import type { AskRemoteFacts } from '../../packages/graph/ask-remote-role.ts';
import { ACTION_FENCE_READY_SQL, actionFenceProblems } from '../../packages/graph/fence-role.ts';
import type { ActionFenceFacts } from '../../packages/graph/fence-role.ts';
import { POWEROFFICE_READY_SQL, powerOfficeProblems } from '../../packages/graph/poweroffice-role.ts';
import type { PowerOfficeFacts } from '../../packages/graph/poweroffice-role.ts';
import { assertRuntimeRole } from '../../packages/graph/scoped-db.ts';
import { migrationNames } from '../support/migrations.ts';
import { PRISMA_CLI, createTestDatabase, runSeed, runWithDatabase, urlFor } from '../support/pg-harness.ts';
import { readRolesSql, readS5AskbRolesSql, renderRolesSql, renderS5AskbRolesSql } from '../support/roles-sql.ts';
import { RA, RW, activate, addRemoteFixtures, connectAs, ledger, reserveOnce, settleOnce } from '../support/ask-remote-pg.ts';

// ASK-REMOTE R-A populated upgrade on PostgreSQL 17 (05 "DB roles/upgrade"): the exact accepted baseline (all 23 migrations
// through 202610091220 and the byte-exact accepted roles.sql of S4-C … S5ASKB-rc2, seeded actors/tokens/memberships,
// fences) upgrades with `prisma migrate deploy`. Before provisioning, the Stage 3 fence and Stage 4 PowerOffice readiness
// still pass (no PUBLIC routine, no new privilege for existing roles) while the runtime startup check refuses; the current
// roles.sql then provisions the eighth role. Data, fences, memberships and existing privileges are preserved; the
// permission vocabulary only grows; nothing is granted, seeded or activated.
const BASELINE_LAST = '202610091220_stage4_poweroffice_cleanup';
const pgdb = await createTestDatabase({ migrateThrough: BASELINE_LAST });
after(async () => { await pgdb.drop(); });
const owner = pgdb.owner;
const secrets = () => ({ runtimePassword: randomBytes(18).toString('hex'), runnerPassword: randomBytes(18).toString('hex'),
  poRunnerPassword: randomBytes(18).toString('hex') });
const snapshotOf = async () => ({
  fences: (await owner.query(`SELECT "workspaceId", version FROM "ActionAuthorityFence" ORDER BY 1`)).rows,
  memberships: (await owner.query(`SELECT "workspaceId", "clientId", "actorId", permissions FROM "ClientMembership" ORDER BY 1, 2, 3`)).rows,
  counts: (await owner.query(`SELECT (SELECT count(*)::int FROM "Connection") AS c, (SELECT count(*)::int FROM "ApiToken") AS t, (SELECT count(*)::int FROM "Actor") AS a,
    (SELECT count(*)::int FROM "Client") AS cl, (SELECT count(*)::int FROM "AuditEvent") AS e, (SELECT count(*)::int FROM "Observation") AS o`)).rows[0],
  privileges: (await owner.query(`SELECT c.relname, a.attname, has_column_privilege($1, c.oid, a.attnum, 'UPDATE') AS u, has_column_privilege($1, c.oid, a.attnum, 'INSERT') AS i
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public' JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE c.relkind = 'r' AND c.relname NOT LIKE 'RemoteAsk%' AND c.relname NOT LIKE 'Reval%' AND c.relname <> '_prisma_migrations' ORDER BY 1, 2`, [pgdb.runtimeRole])).rows,
  owners: (await owner.query(`SELECT proname, proowner::regrole::text AS o, coalesce(proacl::text, '') AS acl FROM pg_proc
    WHERE proname IN ('atlas_m365_cleanup', 'atlas_action_authority_fence', 'atlas_poweroffice_cleanup') ORDER BY 1`)).rows,
  fencePolicies: (await owner.query(`SELECT polname, pg_get_expr(polqual, polrelid) AS q, polroles::regrole[]::text AS r FROM pg_policy
    WHERE polrelid = 'public."ActionAuthorityFence"'::regclass ORDER BY 1`)).rows,
});

test('accepted baseline → R-A: existing readiness holds before provisioning, runtime refuses until roles.sql, accepted state preserved, nothing granted', async () => {
  const password = randomBytes(18).toString('hex');
  await owner.query(renderS5AskbRolesSql(await readS5AskbRolesSql(), pgdb.roles, { ...secrets(), runtimePassword: password }));
  runSeed(pgdb.ownerUrl, { ATLAS_DEMO_TOKEN: generateToken() });
  await addRemoteFixtures(owner);
  const before = await snapshotOf();
  assert.ok(before.memberships.length > 0 && before.fences.length >= 3, 'a populated deployment');
  const runtime = new PrismaClient({ datasourceUrl: urlFor(pgdb.ownerUrl, pgdb.runtimeRole, password) });
  try {
    await assert.rejects(assertRuntimeRole(runtime), /RLS_NOT_ENABLED/, 'this code refuses a database without the remote tables');
    runWithDatabase(pgdb.ownerUrl, process.execPath, [PRISMA_CLI, 'migrate', 'deploy']);
    assert.deepEqual((await owner.query(`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY 1`)).rows.map(r => r.migration_name),
      await migrationNames());
    // Post-migration, pre-provisioning: the existing confined surfaces are unaffected; the new routines are not PUBLIC.
    assert.deepEqual(actionFenceProblems((await runtime.$queryRawUnsafe<ActionFenceFacts[]>(ACTION_FENCE_READY_SQL))[0]), []);
    assert.deepEqual(powerOfficeProblems((await runtime.$queryRawUnsafe<PowerOfficeFacts[]>(POWEROFFICE_READY_SQL))[0]), []);
    assert.equal((await owner.query(`SELECT count(*)::int AS n FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      WHERE p.proname LIKE 'atlas\\_ask\\_remote\\_%' AND a.grantee = 0`)).rows[0].n, 0, 'every new routine revoked PUBLIC in its migration');
    assert.ok(askRemoteProblems((await runtime.$queryRawUnsafe<AskRemoteFacts[]>(ASK_REMOTE_READY_SQL))[0]).length > 0);
    await assert.rejects(assertRuntimeRole(runtime), /RUNTIME_ROLE_NOT_CONFINED/, 'default privileges are too broad until roles.sql runs');
    assert.equal((await owner.query(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = $1`, [pgdb.remoteRole])).rows[0].n, 0);
    // Vocabulary grows by exactly ask:remote; existing memberships, fences and counts are unchanged; nothing is granted or seeded.
    const check = (await owner.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'ClientMembership_permissions_check'`)).rows[0].d as string;
    assert.ok(check.includes(`'poweroffice:maintain'::text, 'ask:remote'::text]`), check);
    assert.deepEqual(await snapshotOf(), before);
    assert.equal((await owner.query(`SELECT count(*)::int AS n FROM "RemoteAskPolicy"`)).rows[0].n, 0, 'no shipped policy or admission');

    await owner.query(renderRolesSql(await readRolesSql(), pgdb.roles, secrets()));
    await assertRuntimeRole(runtime);
    assert.deepEqual(askRemoteProblems((await runtime.$queryRawUnsafe<AskRemoteFacts[]>(ASK_REMOTE_READY_SQL))[0]), []);
    assert.deepEqual(await snapshotOf(), before, 'provisioning preserved data, fences, memberships and every existing privilege');
    assert.equal((await owner.query(`SELECT count(*)::int AS n FROM "ClientMembership" WHERE 'ask:remote' = ANY (permissions)`)).rows[0].n, 0);
  } finally { await runtime.$disconnect(); }
  // The upgraded database is usable by the confined path (synthetic disposable activation through the trusted routines).
  const policy = await activate(owner, RW, [RA]);
  const rt = await connectAs(urlFor(pgdb.ownerUrl, pgdb.runtimeRole, password));
  try {
    const a = await reserveOnce(rt, RW, RA, policy);
    assert.equal(await settleOnce(rt, RW, RA, a, 'USAGE_VERIFIED', { promptTokens: 1, completionTokens: 1 }), '2');
    assert.deepEqual((await ledger(owner, RW)).counters.map(c => c.charged), ['2', '2']);
  } finally { await rt.end(); }
});
