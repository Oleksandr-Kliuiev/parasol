import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { AtlasError } from '../../packages/core/contracts.ts';
import { generateToken } from '../../packages/auth/token.ts';
import { assertRuntimeRole } from '../../packages/graph/scoped-db.ts';
import { RUNTIME_ROLE_CHECK_SQL } from '../../packages/graph/runtime-role.ts';
import type { RuntimeRoleFacts } from '../../packages/graph/runtime-role.ts';
import { actionCredential } from '../../packages/actions/authority.ts';
import { previewAction, requestAction } from '../../packages/actions/requests.ts';
import { migrationNames } from '../support/migrations.ts';
import { PRISMA_CLI, createTestDatabase, runSeed, runWithDatabase, urlFor } from '../support/pg-harness.ts';
import { readRolesSql, readStage2RolesSql, renderRolesSql, renderStage2RolesSql } from '../support/roles-sql.ts';
import { MOCK, fenceVersion, privateDir, runtimeClient } from '../support/action-fixtures.ts';

// Stage 3 S3-A, R2 on PostgreSQL 17: a populated deployment of the accepted Stage 2 (all Stage 2 migrations, the byte-exact
// accepted roles.sql, seeded actors/tokens/connections) upgrades with `prisma migrate deploy`: every workspace gets one
// version-0 fence before FORCE, the permission vocabulary only grows, the runtime and every fenced admission stay refused
// until the current roles.sql provisions the fence definer and the exact action grants; the runtime credential is kept.
const STAGE2_LAST = '202610081400_stage2_m365_directory_budget';
const pgdb = await createTestDatabase({ migrateThrough: STAGE2_LAST });
const files = await privateDir();
after(async () => { await files.remove(); await pgdb.drop(); });
const roles = { runtime: pgdb.runtimeRole, definer: pgdb.definerRole, runner: pgdb.runnerRole, fence: pgdb.fenceRole, poDefiner: pgdb.poDefinerRole, poRunner: pgdb.poRunnerRole };
const fails = (code: string) => (e: unknown) => e instanceof AtlasError && e.code === code;

test('populated accepted Stage 2 → S3-A migrations: fences backfilled, vocabulary extended, runtime refused until roles.sql, credential kept', async () => {
  const owner = pgdb.owner;
  const password = randomBytes(18).toString('hex');
  await owner.query(renderStage2RolesSql(await readStage2RolesSql(), roles, { runtimePassword: password, runnerPassword: randomBytes(18).toString('hex') }));
  const technician = generateToken();
  runSeed(pgdb.ownerUrl, { ATLAS_DEMO_TOKEN: technician });
  await owner.query(`INSERT INTO "Workspace" (id, name) VALUES ('upgrade-second', 'Second')`);
  const memberships = (await owner.query(`SELECT "actorId", "clientId", permissions FROM "ClientMembership" ORDER BY 1, 2`)).rows;
  const runtimeUrl = urlFor(pgdb.ownerUrl, roles.runtime, password);
  const runtime = new PrismaClient({ datasourceUrl: runtimeUrl });
  const runtimeSql = await runtimeClient(runtimeUrl);
  try {
    await assert.rejects(assertRuntimeRole(runtime), /RLS_NOT_ENABLED/, 'this code refuses a database without the action tables');
    runWithDatabase(pgdb.ownerUrl, process.execPath, [PRISMA_CLI, 'migrate', 'deploy']);
    assert.deepEqual((await owner.query(`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY 1`)).rows.map(r => r.migration_name),
      await migrationNames());
    // Superuser owner (this harness): the backfill is complete and every fence starts at 0
    assert.deepEqual((await owner.query(`SELECT w.id, f.version FROM "Workspace" w LEFT JOIN "ActionAuthorityFence" f ON f."workspaceId" = w.id ORDER BY 1`)).rows,
      [{ id: 'demo-vardahei', version: 0 }, { id: 'upgrade-second', version: 0 }]);
    assert.deepEqual((await owner.query(`SELECT "actorId", "clientId", permissions FROM "ClientMembership" ORDER BY 1, 2`)).rows, memberships, 'memberships intact');
    const facts = (await runtime.$queryRawUnsafe<RuntimeRoleFacts[]>(RUNTIME_ROLE_CHECK_SQL))[0]!;
    assert.ok(facts.actionRuntimeGrantViolations > 0, 'broad default grants from the Stage 2 provisioning on the new tables');
    assert.ok(facts.actionFenceOwnerViolations + facts.actionFenceFunctionViolations > 0, 'the trigger function is not yet the definer\'s');
    await assert.rejects(assertRuntimeRole(runtime), /RUNTIME_ROLE_NOT_CONFINED/, 'refused until roles.sql');
    const input = await files.input({ connectionId: 'demo-atera-connection', title: 'Upgrade', description: 'Body', idempotencyKey: '71111111-2222-4333-8444-555555555555' });
    await assert.rejects(previewAction(runtime, MOCK, actionCredential(technician), 'demo-gasta', input, files.out('u1.json')), fails('ACTION_FENCE_NOT_READY'));
    await owner.query(renderRolesSql(await readRolesSql(), roles, { runtimePassword: randomBytes(18).toString('hex'), runnerPassword: randomBytes(18).toString('hex') }));
    await assertRuntimeRole(runtime);
    const fresh = new PrismaClient({ datasourceUrl: runtimeUrl });
    try { await assertRuntimeRole(fresh); } finally { await fresh.$disconnect(); } // a new login with the kept credential
    assert.equal(await fenceVersion(runtimeSql, 'demo-vardahei'), 0, 'provisioning itself is no auth mutation');
    await owner.query(`UPDATE "ClientMembership" SET permissions = permissions || ARRAY['actions:read','actions:request']
      WHERE "workspaceId" = 'demo-vardahei' AND "actorId" = 'demo-technician'`);
    await assert.rejects(owner.query(`UPDATE "ClientMembership" SET permissions = ARRAY['actions:delete'] WHERE "actorId" = 'demo-technician'`), /permissions_check/);
    assert.equal(await fenceVersion(runtimeSql, 'demo-vardahei'), 1);
    assert.equal(await fenceVersion(runtimeSql, 'upgrade-second'), 0);
    const preview = await previewAction(runtime, MOCK, actionCredential(technician), 'demo-gasta', input, files.out('u2.json'));
    const stored = await requestAction(runtime, MOCK, actionCredential(technician), 'demo-gasta', input, preview.inputHash);
    assert.deepEqual([stored.state, stored.authorityEpoch, stored.idempotent], ['AWAITING_APPROVAL', 1, false]);
    await owner.query(renderRolesSql(await readRolesSql(), roles, { runtimePassword: randomBytes(18).toString('hex'), runnerPassword: randomBytes(18).toString('hex') }));
    await assertRuntimeRole(runtime); // idempotent re-provisioning
  } finally { await runtimeSql.end(); await runtime.$disconnect(); }
});
