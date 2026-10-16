import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { runBoundedTransaction, startBudget } from '../../packages/poweroffice/runner-transaction.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { sleep } from '../support/poweroffice-sync.ts';

// S4-C RC5 closure of Astra S4C-rc4 F1/F2 on PostgreSQL 17 (decision table: docs/stage4/S4C_RC5_IMPLEMENTATION_REPORT.md §2),
// helper level on the actual runner transport. F1: a GENERIC transport loss observed early (the backend provably gone before
// the effective 1 s timer) stays CLEANUP_FAILED even though the callback only fails later, after that timer; the genuine
// idle timer stays TIMEOUT and an early administrative termination stays FAILED. F2: positively known non-timeout SQLSTATEs
// raised by the server with ~150 ms of the original budget left stay CLEANUP_FAILED; a timeout state there stays TIMEOUT.
// TEST-ONLY seams: a prototype hook that captures the runner's pg client (restored in finally) to destroy its socket, and
// callback bodies that idle or disable their own transaction timer. Role settings are DB-local and reset in finally.
const pgdb = await createTestDatabase();
after(async () => {
  await pgdb.owner.query(`ALTER ROLE "${pgdb.poRunnerRole}" IN DATABASE "${pgdb.name}" RESET ALL`).catch(() => undefined);
  await pgdb.drop();
});
const owner = pgdb.owner;
const runnerBackends = async () => Number((await owner.query(`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND usename = $1`,
  [pgdb.poRunnerRole])).rows[0].count);
const outcome = (p: Promise<unknown>) => p.then(r => `ok:${String(r)}`, (e: { code?: string }) => e.code ?? 'NO_CODE');
const inherited1s = () => owner.query(`ALTER ROLE "${pgdb.poRunnerRole}" IN DATABASE "${pgdb.name}" SET transaction_timeout = '1s'`);
const resetInherited = () => owner.query(`ALTER ROLE "${pgdb.poRunnerRole}" IN DATABASE "${pgdb.name}" RESET transaction_timeout`);

/** Captures the runner's own pg client (test-only) while `fn` runs; the original prototype method is always restored. */
async function withCapturedClient<T>(fn: (captured: () => pg.Client) => Promise<T>): Promise<T> {
  const original = pg.Client.prototype.connect;
  let client: pg.Client | undefined;
  pg.Client.prototype.connect = function (this: pg.Client, ...args: unknown[]) { client ??= this; return (original as (...a: unknown[]) => unknown).apply(this, args); } as typeof original;
  try { return await fn(() => client!); } finally { pg.Client.prototype.connect = original; }
}

test('F1: generic transport loss observed early (backend gone before the 1 s timer), callback resumes after it → CLEANUP_FAILED', async t => {
  await inherited1s();
  try {
    const t0 = performance.now();
    let eventAt = -1; let goneBeforeTimer = -1;
    const code = await withCapturedClient(captured => outcome(runBoundedTransaction(pgdb.poRunnerUrl, startBudget(), async (query, bounded) => {
      await bounded.statement(); await query('SELECT 1');
      captured().on('error', () => { if (eventAt < 0) eventAt = performance.now() - t0; });
      captured().connection.stream.destroy(); // actual socket loss while idle: no SQLSTATE
      await sleep(100);
      goneBeforeTimer = await runnerBackends();
      await sleep(1_400); // resume AFTER the effective 1 s timer could have fired
      await bounded.statement();
      return 'late';
    })));
    const ms = performance.now() - t0;
    t.diagnostic(`event at ${Math.round(eventAt)} ms, backends at ~100 ms: ${goneBeforeTimer}, returned at ${Math.round(ms)} ms`);
    assert.ok(eventAt >= 0 && eventAt < 500, 'the generic loss was observed well before the effective timer');
    assert.equal(goneBeforeTimer, 0, 'the backend was already gone before its timer could fire');
    assert.ok(ms > 1_400, 'the callback failed only after the timer was due');
    assert.equal(code, 'POWEROFFICE_CLEANUP_FAILED', 'classified by the FIRST observed cause, not the later failure time');
    assert.equal(await runnerBackends(), 0);
  } finally { await resetInherited(); }
});

test('F1 controls: the genuine 1 s idle timer is TIMEOUT; an early administrative termination idling past it is FAILED', async () => {
  await inherited1s();
  try {
    const idle = await outcome(runBoundedTransaction(pgdb.poRunnerUrl, startBudget(), async (query, bounded) => {
      await bounded.statement(); await query('SELECT 1'); await sleep(1_500); await bounded.statement(); return 'late';
    }));
    assert.equal(idle, 'POWEROFFICE_CLEANUP_TIMEOUT');
    const admin = await outcome(runBoundedTransaction(pgdb.poRunnerUrl, startBudget(), async (query, bounded) => {
      await bounded.statement();
      const pid = (await query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]!.pid;
      assert.equal((await owner.query('SELECT pg_terminate_backend($1) AS k', [pid])).rows[0].k, true);
      await sleep(1_500); await bounded.statement(); return 'late';
    }));
    assert.equal(admin, 'POWEROFFICE_CLEANUP_FAILED');
    assert.equal(await runnerBackends(), 0);
  } finally { await resetInherited(); }
});

test('F2: known non-timeout SQLSTATEs raised with ~150 ms of the original budget left stay FAILED; a timeout state stays TIMEOUT', async t => {
  const inWindow = (sql: string) => {
    const budget = startBudget();
    return outcome(runBoundedTransaction(pgdb.poRunnerUrl, budget, async (query, bounded) => {
      await query('SET LOCAL transaction_timeout = 0'); // test-only: keep the session alive into the original window
      while (budget.left() > 150) await sleep(10);
      t.diagnostic(`statement at ${budget.left()} ms left`);
      await bounded.statement();
      await query(sql);
      return 'late';
    }));
  };
  assert.equal(await inWindow('SELECT 1/0'), 'POWEROFFICE_CLEANUP_FAILED', '22012 at ≤ 250 ms left');
  assert.equal(await inWindow(`DO $$ BEGIN RAISE EXCEPTION 'synthetic' USING ERRCODE = '42501'; END $$`), 'POWEROFFICE_CLEANUP_FAILED', '42501');
  assert.equal(await inWindow(`DO $$ BEGIN RAISE EXCEPTION 'synthetic' USING ERRCODE = 'PO010'; END $$`), 'POWEROFFICE_CLEANUP_FAILED', 'PO010');
  assert.equal(await inWindow(`DO $$ BEGIN RAISE EXCEPTION 'synthetic' USING ERRCODE = '40P01'; END $$`), 'POWEROFFICE_DB_CONFLICT', '40P01');
  assert.equal(await inWindow(`DO $$ BEGIN RAISE EXCEPTION 'synthetic' USING ERRCODE = '55P03'; END $$`), 'POWEROFFICE_CLEANUP_TIMEOUT', '55P03');
  assert.equal(await runnerBackends(), 0);
});
