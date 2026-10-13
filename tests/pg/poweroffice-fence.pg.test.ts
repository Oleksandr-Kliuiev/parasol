import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { admitPowerOfficeCleanup, openPowerOfficeRuntime, runPowerOfficeCleanup } from '../../packages/poweroffice/maintenance.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { CA, WS, addPowerOfficeFixtures, connect } from '../support/poweroffice-fixtures.ts';
import { addSyncConnection, codeOf, observe } from '../support/poweroffice-sync.ts';
import { ageConnection } from '../support/poweroffice-history.ts';
import { MOCK, as, counts, goodSync, statusOf, summaryOf } from '../support/poweroffice-read.ts';

// S4-C R1 healthy/corrupt fence and readiness regressions on PostgreSQL 17 for the new paths: with the workspace fence
// row lost (offline owner DDL outside supported operation, then the reviewed same-version repair) or a readiness/runner
// confinement tamper, status/summary reads and cleanup admission refuse with the fixed POWEROFFICE_RUNTIME_NOT_READY and
// write nothing; an already admitted cleanup whose fence disappears refuses in the routine (CLEANUP_FAILED, zero effects);
// a runner granted extra privilege after admission is caught by the runner-side check. After repair all paths work again.
// The direct-routine empty/foreign GUC and three-ID definer isolation cases are the accepted S4-A tests
// (tests/pg/poweroffice-cleanup.pg.test.ts, poweroffice-locks.pg.test.ts) and are not repeated here.
const pgdb = await createTestDatabase();
const prisma = new PrismaClient({ datasources: { db: { url: pgdb.runtimeUrl } } });
const runtimeSql = await connect(pgdb.runtimeUrl);
const paired = openPowerOfficeRuntime(pgdb.runtimeUrl);
after(async () => { await runtimeSql.end().catch(() => undefined); await prisma.$disconnect(); await paired.db.$disconnect(); await pgdb.drop(); });
const owner = pgdb.owner;
await addPowerOfficeFixtures(owner);
const ENV = { ATLAS_POWEROFFICE_CLEANUP_RUNNER_SECRET_REF: 'env://ATLAS_TEST_PO_RUNNER', ATLAS_TEST_PO_RUNNER: pgdb.poRunnerUrl };
const key = (connectionId: string) => ({ workspaceId: WS, clientId: CA, connectionId });
const c = await addSyncConnection(owner, key('fn-a'), 5);
await goodSync(prisma, CA, 'fn-a');
await ageConnection(owner, c, '25 hours');
const admit = () => admitPowerOfficeCleanup(paired, MOCK, as('maintainer'), CA, 'fn-a');
const version = async () => Number((await owner.query(`SELECT version FROM "ActionAuthorityFence" WHERE "workspaceId" = $1`, [WS])).rows[0]?.version);
let lost = 0;
async function loseFence(): Promise<void> {
  lost = await version();
  await owner.query(`BEGIN; ALTER TABLE "ActionAuthorityFence" DISABLE TRIGGER "ActionAuthorityFence_guard";
    DELETE FROM "ActionAuthorityFence" WHERE "workspaceId" = '${WS}'; ALTER TABLE "ActionAuthorityFence" ENABLE ALWAYS TRIGGER "ActionAuthorityFence_guard"; COMMIT;`);
}
async function restoreFence(): Promise<void> {
  await owner.query(`BEGIN; ALTER TABLE "ActionAuthorityFence" DISABLE TRIGGER "ActionAuthorityFence_guard";
    INSERT INTO "ActionAuthorityFence" ("workspaceId", version) VALUES ('${WS}', ${lost}); ALTER TABLE "ActionAuthorityFence" ENABLE ALWAYS TRIGGER "ActionAuthorityFence_guard"; COMMIT;`);
}

test('healthy fence: reads and cleanup admission work; the fence version is not moved by them', async () => {
  const v = await version();
  assert.equal((await statusOf(prisma, 'fn-a', CA)).status, 'EXPIRED');
  assert.equal((await summaryOf(prisma, 'fn-a', CA)).summary, null);
  assert.ok(await admit());
  assert.equal(await version(), v, 'reads and admission never write the fence');
});

test('missing fence: reads and admission are POWEROFFICE_RUNTIME_NOT_READY with no write; an admitted cleanup refuses in the routine', async () => {
  const admitted = await admit();
  const domain = await observe(runtimeSql, c);
  await loseFence();
  try {
    const before = await counts(owner);
    assert.equal(await codeOf(summaryOf(prisma, 'fn-a', CA)), 'POWEROFFICE_RUNTIME_NOT_READY');
    assert.equal(await codeOf(statusOf(prisma, 'fn-a', CA)), 'POWEROFFICE_RUNTIME_NOT_READY');
    assert.equal(await codeOf(statusOf(prisma, 'fn-a', CA, 'contextOnly')), 'POWEROFFICE_RUNTIME_NOT_READY', 'no denial audit either');
    assert.equal(await codeOf(admit()), 'POWEROFFICE_RUNTIME_NOT_READY');
    assert.equal(await codeOf(runPowerOfficeCleanup(admitted, ENV)), 'POWEROFFICE_CLEANUP_FAILED');
    assert.deepEqual(await counts(owner), before);
    assert.deepEqual(await observe(runtimeSql, c), domain);
  } finally { await restoreFence(); }
  assert.equal((await summaryOf(prisma, 'fn-a', CA)).status, 'EXPIRED', 'repaired');
});

test('readiness tamper refuses reads; a runner privilege granted after admission is caught by the runner-side check', async () => {
  await owner.query(`GRANT UPDATE ON "PowerOfficeSnapshot" TO "${pgdb.runtimeRole}"`);
  try { assert.equal(await codeOf(summaryOf(prisma, 'fn-a', CA)), 'POWEROFFICE_RUNTIME_NOT_READY'); }
  finally { await owner.query(`REVOKE UPDATE ON "PowerOfficeSnapshot" FROM "${pgdb.runtimeRole}"`); }
  const admitted = await admit();
  const domain = await observe(runtimeSql, c);
  await owner.query(`GRANT SELECT ON "PowerOfficeState" TO "${pgdb.poRunnerRole}"`);
  try { assert.equal(await codeOf(runPowerOfficeCleanup(admitted, ENV)), 'POWEROFFICE_RUNTIME_NOT_READY'); }
  finally { await owner.query(`REVOKE SELECT ON "PowerOfficeState" FROM "${pgdb.poRunnerRole}"`); }
  assert.deepEqual(await observe(runtimeSql, c), domain, 'zero effects');
  const receipt = await runPowerOfficeCleanup(await admit(), ENV);
  assert.deepEqual([receipt.outcome, receipt.clearedPointer], ['COMPLETED', true]);
});
