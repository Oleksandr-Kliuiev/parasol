import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { assertRuntimeRole } from '../../packages/graph/scoped-db.ts';
import { RUNTIME_ROLE_CHECK_SQL } from '../../packages/graph/runtime-role.ts';
import type { RuntimeRoleFacts } from '../../packages/graph/runtime-role.ts';
import { getAction } from '../../packages/actions/requests.ts';
import { migrationNames } from '../support/migrations.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { readRolesSql, readS3bRolesSql, renderRolesSql, renderStage3RolesSql } from '../support/roles-sql.ts';
import { CA, MOCK, WA, addActionFixtures, fenceVersion, privateDir, runtimeClient } from '../support/action-fixtures.ts';
import { actionFlow, addApprovalActors, as, fails } from '../support/action-approval.ts';
import { addExecutionActors, exec, observeExec, scriptedPorts } from '../support/action-exec.ts';

// Stage 3 S3-C, R2 on PostgreSQL 17: S3-C adds no migration. A deployment provisioned with the byte-exact accepted S3-B
// roles.sql (approval/reservation grants, no execution/verification/synthetic-ticket writes) is refused by this code's
// startup check and by every fenced admission until the current roles.sql runs; S3-B grants are a strict subset (no
// violation, only missing grants). Provisioning moves no epoch, so a request approved before the upgrade then executes to
// VERIFIED. Re-provisioning is idempotent.
const pgdb = await createTestDatabase();
const db = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
const runtime = await runtimeClient(pgdb.runtimeUrl);
const files = await privateDir();
after(async () => { await runtime.end(); await db.$disconnect(); await files.remove(); await pgdb.drop(); });
const owner = pgdb.owner;
const roles = { runtime: pgdb.runtimeRole, definer: pgdb.definerRole, runner: pgdb.runnerRole, fence: pgdb.fenceRole, poDefiner: pgdb.poDefinerRole, poRunner: pgdb.poRunnerRole };
const secrets = () => ({ runtimePassword: randomBytes(18).toString('hex'), runnerPassword: randomBytes(18).toString('hex') });

test('accepted S3-B provisioning → S3-C: refused until the current roles.sql; no migration, no epoch move; an approved request then executes', async () => {
  const migrations = await migrationNames();
  // All 20 accepted migrations, none added by S3-C; the only later migrations are the additive Stage 4 S4-A and Stage 5
  // ASK-REMOTE R-A and R-EVAL RS-A ones.
  assert.equal(migrations.indexOf('202610091100_stage3_action_requests'), 19, 'all 20 accepted migrations, none added');
  assert.deepEqual(migrations.slice(20), ['202610091200_stage4_poweroffice_state', '202610091210_stage4_poweroffice_guards', '202610091220_stage4_poweroffice_cleanup',
    '202610111000_stage5_ask_remote_permission', '202610111010_stage5_ask_remote_state', '202610111020_stage5_ask_remote_routines',
    '202610121000_stage5_ask_remote_egress_floor', '202610131000_stage5_reval_registration']);
  await addActionFixtures(owner);
  await addApprovalActors(owner);
  await addExecutionActors(owner);
  const flow = actionFlow(db, files);
  const approved = await flow.approved();
  await owner.query(renderStage3RolesSql(await readS3bRolesSql(), roles, secrets()));
  const epoch = await fenceVersion(runtime, WA);
  const facts = (await db.$queryRawUnsafe<RuntimeRoleFacts[]>(RUNTIME_ROLE_CHECK_SQL))[0]!;
  assert.deepEqual([facts.actionRuntimeGrantViolations, facts.actionRuntimeMissingGrants > 0], [0, true], 'S3-B grants are a strict subset');
  await assert.rejects(assertRuntimeRole(db), /RUNTIME_ROLE_NOT_CONFINED/);
  await assert.rejects(getAction(db, MOCK, as('reader'), CA, approved.requestId), fails('ACTION_FENCE_NOT_READY'));
  const { ports, calls } = scriptedPorts(db);
  await assert.rejects(exec(db, ports, approved), fails('ACTION_FENCE_NOT_READY'));
  assert.deepEqual([(await observeExec(runtime).attempt(approved.requestId)), calls.create], [null, 0], 'no reservation, no call');
  await owner.query(renderRolesSql(await readRolesSql(), roles, secrets()));
  await assertRuntimeRole(db);
  assert.equal(await fenceVersion(runtime, WA), epoch, 'provisioning is no auth mutation');
  const result = await exec(db, ports, approved);
  assert.deepEqual([result.state, calls.create, calls.read], ['VERIFIED', 1, 1]);
  await owner.query(renderRolesSql(await readRolesSql(), roles, secrets()));
  await assertRuntimeRole(db);
});
