import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { AtlasError } from '../../packages/core/contracts.ts';
import { assertRuntimeRole } from '../../packages/graph/scoped-db.ts';
import { RUNTIME_ROLE_CHECK_SQL } from '../../packages/graph/runtime-role.ts';
import type { RuntimeRoleFacts } from '../../packages/graph/runtime-role.ts';
import { getAction } from '../../packages/actions/requests.ts';
import { consumeReservationPermit } from '../../packages/actions/reservation.ts';
import { migrationNames } from '../support/migrations.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { readRolesSql, readS3aRolesSql, renderRolesSql, renderStage3RolesSql } from '../support/roles-sql.ts';
import { CA, MOCK, WA, addActionFixtures, fenceVersion, privateDir, runtimeClient } from '../support/action-fixtures.ts';
import { actionFlow, addApprovalActors, as, observe } from '../support/action-approval.ts';

// Stage 3 S3-B, R2 on PostgreSQL 17: S3-B adds no migration. A deployment provisioned with the byte-exact accepted S3-A
// roles.sql (stored requests, no approval/attempt write grants) is refused by this code's startup check and by every fenced
// admission until the current roles.sql runs; provisioning moves no epoch, so the stored S3-A request is then approved,
// reserved and its permit consumed. Re-provisioning is idempotent.
const pgdb = await createTestDatabase();
const db = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
const runtime = await runtimeClient(pgdb.runtimeUrl);
const files = await privateDir();
after(async () => { await runtime.end(); await db.$disconnect(); await files.remove(); await pgdb.drop(); });
const owner = pgdb.owner;
const roles = { runtime: pgdb.runtimeRole, definer: pgdb.definerRole, runner: pgdb.runnerRole, fence: pgdb.fenceRole, poDefiner: pgdb.poDefinerRole, poRunner: pgdb.poRunnerRole };
const secrets = () => ({ runtimePassword: randomBytes(18).toString('hex'), runnerPassword: randomBytes(18).toString('hex') });

test('accepted S3-A provisioning → S3-B: refused until the current roles.sql; no migration, no epoch move; stored requests then approve and reserve', async () => {
  const migrations = await migrationNames();
  // S3-B adds no migration; every accepted one stays frozen. The only later migrations are the additive Stage 4 S4-A and
  // Stage 5 ASK-REMOTE R-A/R-B and R-EVAL RS-A ones.
  assert.equal(migrations.indexOf('202610091100_stage3_action_requests'), 19);
  assert.deepEqual(migrations.slice(migrations.indexOf('202610091100_stage3_action_requests') + 1), ['202610091200_stage4_poweroffice_state', '202610091210_stage4_poweroffice_guards', '202610091220_stage4_poweroffice_cleanup',
    '202610111000_stage5_ask_remote_permission', '202610111010_stage5_ask_remote_state', '202610111020_stage5_ask_remote_routines',
    '202610121000_stage5_ask_remote_egress_floor', '202610131000_stage5_reval_registration'], 'S3-B adds no migration; every accepted one stays frozen');
  await addActionFixtures(owner);
  await addApprovalActors(owner);
  const flow = actionFlow(db, files);
  const stored = await flow.request(); // stored while the current grants are in place, then provisioning goes back to S3-A
  await owner.query(renderStage3RolesSql(await readS3aRolesSql(), roles, secrets()));
  const epoch = await fenceVersion(runtime, WA);
  const facts = (await db.$queryRawUnsafe<RuntimeRoleFacts[]>(RUNTIME_ROLE_CHECK_SQL))[0]!;
  assert.deepEqual([facts.actionRuntimeGrantViolations, facts.actionRuntimeMissingGrants > 0], [0, true], 'S3-A grants are a strict subset');
  await assert.rejects(assertRuntimeRole(db), /RUNTIME_ROLE_NOT_CONFINED/);
  await assert.rejects(getAction(db, MOCK, as('reader'), CA, stored.requestId), (e: unknown) => e instanceof AtlasError && e.code === 'ACTION_FENCE_NOT_READY');
  await assert.rejects(flow.approve(stored), (e: unknown) => e instanceof AtlasError && e.code === 'ACTION_FENCE_NOT_READY');
  await owner.query(renderRolesSql(await readRolesSql(), roles, secrets()));
  await assertRuntimeRole(db);
  assert.equal(await fenceVersion(runtime, WA), epoch, 'provisioning is no auth mutation');
  assert.equal((await flow.approve(stored)).state, 'APPROVED', 'the stored S3-A request keeps its epoch and is approvable');
  const { reservation, permit } = await flow.reserve(stored);
  assert.equal(reservation.state, 'DISPATCH_RESERVED');
  assert.equal(consumeReservationPermit(permit, { workspaceId: WA, clientId: CA, requestId: stored.requestId, inputHash: stored.inputHash, mode: 'MOCK' })
    .attemptId, reservation.attemptId);
  await owner.query(renderRolesSql(await readRolesSql(), roles, secrets()));
  await assertRuntimeRole(db);
  assert.equal((await observe(runtime).attempts(stored.requestId)), 1);
});
