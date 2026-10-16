import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PrismaClient } from '@prisma/client';
import { admitPowerOfficeCleanup, openPowerOfficeRuntime, runPowerOfficeCleanup } from '../../packages/poweroffice/maintenance.ts';
import { runBoundedTransaction, startBudget } from '../../packages/poweroffice/runner-transaction.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { CA, WS, addPowerOfficeFixtures, connect } from '../support/poweroffice-fixtures.ts';
import { addSyncConnection, observe, sleep } from '../support/poweroffice-sync.ts';
import { ageConnection } from '../support/poweroffice-history.ts';
import { MOCK, as, goodSync } from '../support/poweroffice-read.ts';

// S4-C RC4 closure of Astra S4C-rc3 F1/F2 on PostgreSQL 17 (phase map: docs/stage4/S4C_RC4_IMPLEMENTATION_REPORT.md).
// F1: a setup statement blocked on an uncommitted ACCESS EXCLUSIVE lock of pg_catalog.pg_settings (DB-local, rolled back in
// finally) ends within the original bound through the real admitted wrapper, with no runner backend left while the lock is
// STILL held and no effect afterwards; the deadline watchdog cancels ANY in-flight statement even when every server-side
// timer is switched off (helper level). F2: a session terminated by the EFFECTIVE (stricter inherited) transaction timer
// while the client is idle is CLEANUP_TIMEOUT; an earlier non-timeout termination stays CLEANUP_FAILED.
const pgdb = await createTestDatabase();
const prisma = new PrismaClient({ datasources: { db: { url: pgdb.runtimeUrl } } });
const runtimeSql = await connect(pgdb.runtimeUrl);
const paired = openPowerOfficeRuntime(pgdb.runtimeUrl);
after(async () => {
  await pgdb.owner.query(`ALTER ROLE "${pgdb.poRunnerRole}" IN DATABASE "${pgdb.name}" RESET ALL`).catch(() => undefined);
  await runtimeSql.end().catch(() => undefined); await paired.db.$disconnect(); await prisma.$disconnect(); await pgdb.drop();
});
const owner = pgdb.owner;
await addPowerOfficeFixtures(owner);
const ENV = { ATLAS_POWEROFFICE_CLEANUP_RUNNER_SECRET_REF: 'env://ATLAS_TEST_PO_RUNNER', ATLAS_TEST_PO_RUNNER: pgdb.poRunnerUrl };
const key = (connectionId: string) => ({ workspaceId: WS, clientId: CA, connectionId });
const runnerBackends = async () => (await owner.query(`SELECT state, wait_event_type FROM pg_stat_activity WHERE datname = current_database() AND usename = $1`,
  [pgdb.poRunnerRole])).rows;
const cleanupAudits = async (id: string) => Number((await owner.query(`SELECT count(*) FROM "AuditEvent" WHERE "eventType" = 'poweroffice.cleanup'
  AND metadata->>'connectionId' = $1`, [id])).rows[0].count);
const outcome = (p: Promise<unknown>) => p.then(r => `ok:${String((r as { outcome?: string })?.outcome ?? r)}`, (e: { code?: string }) => e.code ?? 'NO_CODE');

test('F1: a setup statement blocked on a pg_settings ACCESS EXCLUSIVE lock ends within the bound; no runner backend while the lock is held', async t => {
  const c = await addSyncConnection(owner, key('ph-lock'), 4);
  await goodSync(prisma, CA, 'ph-lock'); await ageConnection(owner, c, '31 days');
  const before = await observe(runtimeSql, c);
  const admission = await admitPowerOfficeCleanup(paired, MOCK, as('maintainer'), CA, 'ph-lock');
  const holder = await connect(pgdb.ownerUrl);
  let settledAt = 0;
  try {
    await holder.query('BEGIN'); await holder.query('LOCK TABLE pg_catalog.pg_settings IN ACCESS EXCLUSIVE MODE');
    const t0 = performance.now();
    const pending = outcome(runPowerOfficeCleanup(admission, ENV)).then(code => { settledAt = performance.now() - t0; return code; });
    await sleep(10_500); // past the original deadline, the lock STILL held
    assert.ok(settledAt > 0 && settledAt <= 10_150, `settled at ${Math.round(settledAt)} ms with the lock still held`);
    assert.equal(await pending, 'POWEROFFICE_CLEANUP_TIMEOUT');
    t.diagnostic(`F1 settled at ${Math.round(settledAt)} ms (lock held until 10 500 ms)`);
    assert.deepEqual(await runnerBackends(), [], 'no runner backend left waiting or working while the lock is held');
    assert.deepEqual(await observe(runtimeSql, c), before); assert.equal(await cleanupAudits('ph-lock'), 0);
  } finally { await holder.query('ROLLBACK').catch(() => undefined); await holder.end(); }
  await sleep(1_000);
  assert.deepEqual(await observe(runtimeSql, c), before, 'nothing happens after the release either');
  assert.deepEqual([await cleanupAudits('ph-lock'), (await runnerBackends()).length], [0, 0]);
  const done = await runPowerOfficeCleanup(await admitPowerOfficeCleanup(paired, MOCK, as('maintainer'), CA, 'ph-lock'), ENV);
  assert.equal(done.outcome, 'COMPLETED', 'positive control after the release');
});

test('watchdog: a statement with every server timer switched off is cancelled at the original deadline (CancelRequest), backend ends', async t => {
  const t0 = performance.now();
  let pid = 0;
  const code = await outcome(runBoundedTransaction(pgdb.poRunnerUrl, startBudget(), async query => {
    pid = (await query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]!.pid;
    await query(`SET LOCAL statement_timeout = 0`); await query(`SET LOCAL lock_timeout = 0`);
    await query(`SET LOCAL transaction_timeout = 0`); // disables the armed transaction timer (test-only misbehaving body)
    await query('SELECT pg_sleep(30)');
    return 'late';
  }));
  const ms = performance.now() - t0;
  assert.equal(code, 'POWEROFFICE_CLEANUP_TIMEOUT');
  t.diagnostic(`watchdog cancel settled at ${Math.round(ms)} ms`);
  assert.ok(ms >= 9_500 && ms <= 10_150, `cancelled at ${Math.round(ms)} ms, not after the 30 s sleep`);
  assert.ok(pid > 0);
  assert.deepEqual(await runnerBackends(), [], 'the cancelled backend is gone');
});

test('F2: the EFFECTIVE stricter inherited timer ending an idle session is CLEANUP_TIMEOUT; an earlier non-timeout termination is CLEANUP_FAILED', async () => {
  await owner.query(`ALTER ROLE "${pgdb.poRunnerRole}" IN DATABASE "${pgdb.name}" SET transaction_timeout = '1s'`);
  try {
    const t0 = performance.now();
    const code = await outcome(runBoundedTransaction(pgdb.poRunnerUrl, startBudget(), async (query, bounded) => {
      await bounded.statement(); await query('SELECT 1');
      await sleep(1_500); // client idle past the effective 1 s server timer
      await bounded.statement();
      return 'late';
    }));
    assert.equal(code, 'POWEROFFICE_CLEANUP_TIMEOUT', 'positively identified by the timer the runner itself armed');
    assert.ok(performance.now() - t0 < 2_500);
    assert.deepEqual(await runnerBackends(), []);
  } finally { await owner.query(`ALTER ROLE "${pgdb.poRunnerRole}" IN DATABASE "${pgdb.name}" RESET transaction_timeout`); }
  // Negative control: an operator terminates the session early (no timer due) → the fixed non-timeout failure.
  const t1 = performance.now();
  const code = await outcome(runBoundedTransaction(pgdb.poRunnerUrl, startBudget(), async (query, bounded) => {
    await bounded.statement();
    const pid = (await query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]!.pid;
    await owner.query('SELECT pg_terminate_backend($1)', [pid]);
    await sleep(300);
    await bounded.statement();
    return 'late';
  }));
  assert.equal(code, 'POWEROFFICE_CLEANUP_FAILED', 'an early unrelated disconnect is not relabelled as a timeout');
  assert.ok(performance.now() - t1 < 2_000);
  assert.deepEqual(await runnerBackends(), []);
});

test('controls: wrong password stays RUNTIME_NOT_READY; a direct pg control confirms the driver reports idle termination without SQLSTATE', async () => {
  const wrong = new URL(pgdb.poRunnerUrl); wrong.password = 'not-the-password';
  assert.equal(await outcome(runBoundedTransaction(wrong.toString(), startBudget(), async () => 'x')), 'POWEROFFICE_RUNTIME_NOT_READY');
  await owner.query(`ALTER ROLE "${pgdb.poRunnerRole}" IN DATABASE "${pgdb.name}" SET transaction_timeout = '1s'`);
  const control = new pg.Client({ connectionString: pgdb.poRunnerUrl });
  try {
    let sessionCode: unknown = 'none';
    control.on('error', (e: Error) => { sessionCode = (e as { code?: unknown }).code ?? null; });
    await control.connect(); await control.query('BEGIN'); await control.query('SELECT 1'); await sleep(1_500);
    const later = await control.query('SELECT 1').then(() => 'resolved', (e: { code?: unknown }) => e.code ?? null);
    assert.deepEqual([sessionCode, later], [null, null], 'generic errors only: classification must use the runner\'s own timer context');
  } finally { await control.end().catch(() => undefined); await owner.query(`ALTER ROLE "${pgdb.poRunnerRole}" IN DATABASE "${pgdb.name}" RESET transaction_timeout`); }
});
