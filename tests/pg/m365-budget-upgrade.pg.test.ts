import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { AtlasError } from '../../packages/core/contracts.ts';
import { assertRuntimeRole } from '../../packages/graph/scoped-db.ts';
import { RUNTIME_ROLE_CHECK_SQL } from '../../packages/graph/runtime-role.ts';
import type { RuntimeRoleFacts } from '../../packages/graph/runtime-role.ts';
import { syncM365Directory } from '../../packages/m365/directory.ts';
import { migrationNames } from '../support/migrations.ts';
import { PRISMA_CLI, createTestDatabase, runSeed, runWithDatabase, urlFor } from '../support/pg-harness.ts';
import { readRolesSql, readStage2RolesSql, renderRolesSql, renderStage2RolesSql } from '../support/roles-sql.ts';
import { addMappingFixtures, gasta } from '../support/graph-fixtures.ts';
import { M365_CONNECTION, M365_TENANT, addM365Actors, addM365Fixtures, m365Actors } from '../support/m365-fixtures.ts';
import { mockM365, page, syntheticSecrets, userRow } from '../support/m365-graph-mock.ts';
import { guid } from '../m365-sql-invariants.ts';

// RC3 provisioning on PostgreSQL 17 (approved policy S2B_RETRY_REPAIR_PLAN_RC2): a populated S2-B-rc2 database (through
// 202610081300, RC2 roles.sql) upgrades with `prisma migrate deploy`. The backfill charges min(8, started − published), so
// an over-tried chain is exhausted, not fresh; retry times, sequences, statuses and codes stay; sign-in rows stay at zero.
// The runtime is refused until roles.sql grants "attemptsUsed"; then the stored throttle/exhaustion gate every claim.
const RC2_LAST = '202610081300_stage2_m365_directory_retry';
const pgdb = await createTestDatabase({ migrateThrough: RC2_LAST });
after(async () => { await pgdb.drop(); });
const roles = { runtime: pgdb.runtimeRole, definer: pgdb.definerRole, runner: pgdb.runnerRole, fence: pgdb.fenceRole, poDefiner: pgdb.poDefinerRole, poRunner: pgdb.poRunnerRole };
const fails = (code: string) => (e: unknown) => e instanceof AtlasError && e.code === code;
const utcNow = `(now() AT TIME ZONE 'UTC')`;

test('populated RC2 → budget migration: remaining/exhausted chains and a future Retry-After survive; runtime refused until roles.sql; no fresh budget', async () => {
  const current = await readRolesSql();
  const stage2 = await readStage2RolesSql();
  const rc2 = stage2.replace(', "retryAt", "attemptsUsed") ON "M365ResourceState"', ', "retryAt") ON "M365ResourceState"');
  assert.notEqual(rc2, stage2);
  const password = randomBytes(18).toString('hex');
  await pgdb.owner.query(renderStage2RolesSql(rc2, roles, { runtimePassword: password, runnerPassword: randomBytes(18).toString('hex') }));
  runSeed(pgdb.ownerUrl);
  await addMappingFixtures(pgdb.owner);
  await addM365Fixtures(pgdb.owner);
  await addM365Actors(pgdb.owner);
  const insert = `INSERT INTO "M365ResourceState" ("workspaceId","clientId","connectionId","resourceType","latestStartedSeq","latestRecordedSeq",status,"safeErrorCode","lastAttemptAt")`;
  // Remaining chain (5 charged since the last publication) throttled for two hours; exhausted chain (12 started); sign-in capability
  await pgdb.owner.query(`${insert} VALUES ('demo-vardahei','demo-gasta',$1,'m365_user',5,4,'ERROR','M365_UPSTREAM_UNAVAILABLE',${utcNow})`, [M365_CONNECTION]);
  await pgdb.owner.query(`UPDATE "M365ResourceState" SET "latestRecordedSeq" = 5, "safeErrorCode" = 'M365_RATE_LIMITED', "retryAt" = ${utcNow} + interval '2 hours'
    WHERE "connectionId" = $1 AND "resourceType" = 'm365_user'`, [M365_CONNECTION]);
  await pgdb.owner.query(`${insert} VALUES ('demo-vardahei','demo-gasta',$1,'m365_device',12,12,'ERROR','M365_ACCESS_DENIED',${utcNow})`, [M365_CONNECTION]);
  await pgdb.owner.query(`INSERT INTO "M365ResourceState" ("workspaceId","clientId","connectionId","resourceType",status,"lastAttemptAt","lastSuccessAt")
    VALUES ('demo-vardahei','demo-gasta',$1,'m365_signin','OK',${utcNow},${utcNow})`, [M365_CONNECTION]);
  const rows = async () => (await pgdb.owner.query(`SELECT "resourceType" AS t, "latestStartedSeq" AS s, "latestRecordedSeq" AS r, status, "safeErrorCode" AS code,
    "retryAt" IS NOT NULL AS throttled FROM "M365ResourceState" WHERE "connectionId" = $1 ORDER BY 1`, [M365_CONNECTION])).rows;
  const before = await rows();
  const runtime = new PrismaClient({ datasourceUrl: urlFor(pgdb.ownerUrl, roles.runtime, password) });
  try {
    runWithDatabase(pgdb.ownerUrl, process.execPath, [PRISMA_CLI, 'migrate', 'deploy']);
    const applied = (await pgdb.owner.query(`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY 1`)).rows.map(r => r.migration_name);
    assert.deepEqual(applied, await migrationNames());
    assert.deepEqual(await rows(), before, 'sequences, statuses, codes and retry times unchanged');
    const budgets = (await pgdb.owner.query(`SELECT "resourceType" AS t, "attemptsUsed" AS u FROM "M365ResourceState" WHERE "connectionId" = $1 ORDER BY 1`, [M365_CONNECTION])).rows;
    assert.deepEqual(budgets, [{ t: 'm365_device', u: 8 }, { t: 'm365_signin', u: 0 }, { t: 'm365_user', u: 5 }], 'min(8, started − published); exhausted stays exhausted');
    const facts = (await runtime.$queryRawUnsafe<RuntimeRoleFacts[]>(RUNTIME_ROLE_CHECK_SQL))[0]!;
    assert.deepEqual([facts.missingUpdateColumns, facts.unguardedUpdateColumns], [1, 0], 'exactly the new column is missing');
    await assert.rejects(assertRuntimeRole(runtime), /RUNTIME_ROLE_NOT_CONFINED/, 'the upgraded runtime stays stopped until provisioning');
    await pgdb.owner.query(renderRolesSql(current, roles, { runtimePassword: randomBytes(18).toString('hex'), runnerPassword: randomBytes(18).toString('hex') }));
    await assertRuntimeRole(runtime); // existing credential kept
    const mock = mockM365(M365_TENANT, { route: url => url.pathname === '/v1.0/users' || url.pathname === '/v1.0/devices' ? page([userRow(guid('1'))]) : undefined });
    const secrets = syntheticSecrets();
    const io = { graph: mock.graph, tokens: mock.tokens, secrets };
    const throttled = await syncM365Directory(runtime, m365Actors.syncer, gasta, M365_CONNECTION, 'm365_user', io).catch(e => e) as AtlasError;
    assert.ok(fails('M365_RETRY_NOT_DUE')(throttled)); assert.equal(throttled.details.attemptsUsed, '5');
    await assert.rejects(syncM365Directory(runtime, m365Actors.syncer, gasta, M365_CONNECTION, 'm365_device', io), fails('M365_ATTEMPTS_EXHAUSTED'));
    assert.deepEqual([mock.requests, secrets.calls], [[], []], 'no automatic fresh attempts after the upgrade');
    assert.deepEqual(await rows(), before);
  } finally { await runtime.$disconnect(); }
});
