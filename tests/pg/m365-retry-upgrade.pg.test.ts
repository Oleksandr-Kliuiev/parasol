import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { assertRuntimeRole } from '../../packages/graph/scoped-db.ts';
import { RUNTIME_ROLE_CHECK_SQL } from '../../packages/graph/runtime-role.ts';
import type { RuntimeRoleFacts } from '../../packages/graph/runtime-role.ts';
import { migrationNames } from '../support/migrations.ts';
import { PRISMA_CLI, createTestDatabase, runWithDatabase, urlFor } from '../support/pg-harness.ts';
import { readRolesSql, readStage2RolesSql, renderRolesSql, renderStage2RolesSql } from '../support/roles-sql.ts';

// Review F6 provisioning on PostgreSQL 17: an S2-A deployment (migrations through 202610081200 and the S2-A roles.sql,
// which grants no "retryAt") upgrades to 202610081300 with `prisma migrate deploy`; the runtime self-check then refuses
// to start (missing state-column grant) until prisma/roles.sql ran again; reprovisioning keeps the existing credential.
const S2A_LAST = '202610081200_stage2_m365_cleanup_routine';
const pgdb = await createTestDatabase({ migrateThrough: S2A_LAST });
after(async () => { await pgdb.drop(); });
const roles = { runtime: pgdb.runtimeRole, definer: pgdb.definerRole, runner: pgdb.runnerRole, fence: pgdb.fenceRole, poDefiner: pgdb.poDefinerRole, poRunner: pgdb.poRunnerRole };

test('S2-A database + S2-A roles → retry migration: runtime refused until roles.sql grants "retryAt"; credential kept; idempotent', async () => {
  const current = await readRolesSql();
  // The S2-A text of prisma/roles.sql differs from the accepted Stage 2 one only by the S2-B columns in the runtime grant
  const stage2 = await readStage2RolesSql();
  const s2a = stage2.replace(', "safeErrorCode", "retryAt", "attemptsUsed") ON "M365ResourceState"', ', "safeErrorCode") ON "M365ResourceState"');
  assert.notEqual(s2a, stage2);
  const password = randomBytes(18).toString('hex');
  const secrets = { runtimePassword: password, runnerPassword: randomBytes(18).toString('hex') };
  await pgdb.owner.query(renderStage2RolesSql(s2a, roles, secrets));
  const runtime = new PrismaClient({ datasourceUrl: urlFor(pgdb.ownerUrl, roles.runtime, password) });
  try {
    // This code version fails closed on the un-migrated S2-A schema (its allowlisted column does not exist yet)
    const before = (await runtime.$queryRawUnsafe<RuntimeRoleFacts[]>(RUNTIME_ROLE_CHECK_SQL))[0]!;
    assert.deepEqual([before.missingUpdateColumns, before.unguardedUpdateColumns, before.cleanupOwnerViolations], [2, 0, 0], 'otherwise a confined S2-A deployment');
    // (and, since Stage 3, the action tables this code protects do not exist yet: RLS_NOT_ENABLED is the first refusal)
    await assert.rejects(assertRuntimeRole(runtime), /RLS_NOT_ENABLED/);
    runWithDatabase(pgdb.ownerUrl, process.execPath, [PRISMA_CLI, 'migrate', 'deploy']);
    const applied = (await pgdb.owner.query(`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY 1`)).rows.map(r => r.migration_name);
    assert.deepEqual(applied, await migrationNames());
    const facts = (await runtime.$queryRawUnsafe<RuntimeRoleFacts[]>(RUNTIME_ROLE_CHECK_SQL))[0]!;
    assert.deepEqual([facts.missingUpdateColumns, facts.unguardedUpdateColumns], [2, 0], 'exactly the new S2-B columns are missing; nothing wider');
    await assert.rejects(assertRuntimeRole(runtime), /RUNTIME_ROLE_NOT_CONFINED/, 'the upgraded runtime stays stopped until provisioning');
    await pgdb.owner.query(renderRolesSql(current, roles, { runtimePassword: randomBytes(18).toString('hex'), runnerPassword: randomBytes(18).toString('hex') }));
    await assertRuntimeRole(runtime);
    const fresh = new PrismaClient({ datasourceUrl: urlFor(pgdb.ownerUrl, roles.runtime, password) });
    try { await assertRuntimeRole(fresh); } finally { await fresh.$disconnect(); } // a new login with the existing credential
    const grant = (await pgdb.owner.query(`SELECT has_column_privilege($1, '"M365ResourceState"', 'retryAt', 'UPDATE') AS u,
      has_column_privilege($2, '"M365ResourceState"', 'retryAt', 'UPDATE') AS d`, [roles.runtime, roles.definer])).rows[0];
    assert.deepEqual(grant, { u: true, d: false }, 'runtime only; the cleanup definer gains nothing');
    await pgdb.owner.query(renderRolesSql(current, roles, secrets));
    await assertRuntimeRole(runtime);
  } finally { await runtime.$disconnect(); }
});
