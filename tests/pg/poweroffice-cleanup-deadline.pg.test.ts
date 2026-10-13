import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { admitPowerOfficeCleanup, openPowerOfficeRuntime, runPowerOfficeCleanup } from '../../packages/poweroffice/maintenance.ts';
import type { PowerOfficeRuntime } from '../../packages/poweroffice/maintenance.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { CA, WS, addPowerOfficeFixtures, connect, tokens } from '../support/poweroffice-fixtures.ts';
import { addSyncConnection, observe, sleep } from '../support/poweroffice-sync.ts';
import { ageConnection } from '../support/poweroffice-history.ts';
import { MOCK, as, goodSync } from '../support/poweroffice-read.ts';
import { runOps, trapDir } from '../support/poweroffice-process.ts';

// S4-C RC2 closure of Astra S4C-rc1 R1/R2 on PostgreSQL 17. The ONE original 10 s budget covers acquisition, the routine
// AND COMMIT with actual server-side cancellation: login + routine + deferred COMMIT work summing beyond 10 s (and COMMIT
// work alone beyond it) end as POWEROFFICE_CLEANUP_TIMEOUT with pointer, snapshots, attempts and audit rolled back —
// re-checked after the delayed work would have finished, with no runner backend left. A real login/acquisition overrun is
// CLEANUP_TIMEOUT (in-process and actual CLI exit 1), never RUNTIME_NOT_READY, and no routine/audit/commit happens later.
// Delays are TEST-ONLY DB-local objects (PUBLIC-revoked functions; a login event trigger for the disposable runner role;
// a BEFORE audit trigger and a deferred audit constraint trigger only for 'poweroffice.cleanup'), dropped in finally.
const pgdb = await createTestDatabase();
const prisma = new PrismaClient({ datasources: { db: { url: pgdb.runtimeUrl } } });
const runtimeSql = await connect(pgdb.runtimeUrl);
const withTimeout = (url: string) => { const u = new URL(url); u.searchParams.set('connect_timeout', '30'); return u.toString(); };
const paired = openPowerOfficeRuntime(pgdb.runtimeUrl);
const pairedSlow = openPowerOfficeRuntime(withTimeout(pgdb.runtimeUrl)); // same target options as the runner below
after(async () => { await runtimeSql.end().catch(() => undefined); for (const r of [paired, pairedSlow]) await r.db.$disconnect(); await prisma.$disconnect(); await pgdb.drop(); });
const owner = pgdb.owner;
await addPowerOfficeFixtures(owner);
const ENV = { ATLAS_POWEROFFICE_CLEANUP_RUNNER_SECRET_REF: 'env://ATLAS_TEST_PO_RUNNER', ATLAS_TEST_PO_RUNNER: pgdb.poRunnerUrl };
const ENV_SLOW = { ...ENV, ATLAS_TEST_PO_RUNNER: withTimeout(pgdb.poRunnerUrl) };
const key = (connectionId: string) => ({ workspaceId: WS, clientId: CA, connectionId });
const cleanupAudits = async (id: string) => Number((await owner.query(`SELECT count(*) FROM "AuditEvent" WHERE "eventType" = 'poweroffice.cleanup'
  AND metadata->>'connectionId' = $1`, [id])).rows[0].count);
const runnerBackends = async () => Number((await owner.query(`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()
  AND usename = $1 AND state <> 'idle'`, [pgdb.poRunnerRole])).rows[0].count);
/** Published, expired and with old eligible attempts (two syncs, everything aged 31 days): cleanup would delete rows of every kind. */
async function eligible(id: string) {
  const c = await addSyncConnection(owner, key(id), 4);
  await goodSync(prisma, CA, id); await goodSync(prisma, CA, id);
  await ageConnection(owner, c, '31 days');
  return c;
}
async function timed(id: string, runtime: PowerOfficeRuntime = paired, env: Record<string, string> = ENV) {
  const admission = await admitPowerOfficeCleanup(runtime, MOCK, as('maintainer'), CA, id);
  const t0 = performance.now();
  const code = await runPowerOfficeCleanup(admission, env).then(r => `ok:${r.outcome}`, (e: { code?: string }) => e.code ?? 'NO_CODE');
  return { code, ms: performance.now() - t0, t0 };
}
async function delays(spec: { login?: number; routine?: number; commit?: number }): Promise<() => Promise<void>> {
  const sql: string[] = [];
  if (spec.login) sql.push(`CREATE FUNCTION public.s4c_rc2_login() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN
      IF session_user = '${pgdb.poRunnerRole}' THEN PERFORM pg_sleep(${spec.login}); END IF; END $$;
    REVOKE ALL ON FUNCTION public.s4c_rc2_login() FROM PUBLIC; CREATE EVENT TRIGGER s4c_rc2_login ON login EXECUTE FUNCTION public.s4c_rc2_login();`);
  if (spec.routine) sql.push(`CREATE FUNCTION public.s4c_rc2_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW."eventType" = 'poweroffice.cleanup' THEN PERFORM pg_sleep(${spec.routine}); END IF; RETURN NEW; END $$;
    REVOKE ALL ON FUNCTION public.s4c_rc2_audit() FROM PUBLIC;
    CREATE TRIGGER s4c_rc2_audit BEFORE INSERT ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION public.s4c_rc2_audit();`);
  if (spec.commit) sql.push(`CREATE FUNCTION public.s4c_rc2_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW."eventType" = 'poweroffice.cleanup' THEN PERFORM pg_sleep(${spec.commit}); END IF; RETURN NEW; END $$;
    REVOKE ALL ON FUNCTION public.s4c_rc2_commit() FROM PUBLIC;
    CREATE CONSTRAINT TRIGGER s4c_rc2_commit AFTER INSERT ON "AuditEvent" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.s4c_rc2_commit();`);
  await owner.query(sql.join('\n'));
  return async () => {
    await owner.query(`DROP EVENT TRIGGER IF EXISTS s4c_rc2_login; DROP TRIGGER IF EXISTS s4c_rc2_audit ON "AuditEvent"; DROP TRIGGER IF EXISTS s4c_rc2_commit ON "AuditEvent";
      DROP FUNCTION IF EXISTS public.s4c_rc2_login(); DROP FUNCTION IF EXISTS public.s4c_rc2_audit(); DROP FUNCTION IF EXISTS public.s4c_rc2_commit();`);
  };
}
/** Waits until `ms` after `t0` (the cleanup's start): every delayed piece of work would have finished by then. */
const until = async (t0: number, ms: number) => { const wait = t0 + ms - performance.now(); if (wait > 0) await sleep(wait); };

test('R1: 4 s login + 4 s routine + 4 s deferred COMMIT work (12 s) is CLEANUP_TIMEOUT within the original 10 s, all rolled back', async () => {
  const c = await eligible('dl-sum');
  const before = await observe(runtimeSql, c);
  assert.ok(before.snapshots.length === 2 && before.attempts.length === 2 && before.state.pointer !== null, 'cleanup would clear, delete and audit');
  const drop = await delays({ login: 4, routine: 4, commit: 4 });
  let run: Awaited<ReturnType<typeof timed>>;
  try {
    run = await timed('dl-sum');
    assert.equal(run.code, 'POWEROFFICE_CLEANUP_TIMEOUT');
    assert.ok(run.ms >= 9_000 && run.ms <= 10_000 + 150, `returned at ${Math.round(run.ms)} ms: the server ended it by the original deadline`);
    assert.deepEqual(await observe(runtimeSql, c), before, 'pointer, snapshots and attempts unchanged immediately');
    assert.equal(await cleanupAudits('dl-sum'), 0, 'no cleanup audit');
    await until(run.t0, 13_500);
    assert.deepEqual(await observe(runtimeSql, c), before, 'still unchanged after the delayed work would have finished');
    assert.equal(await cleanupAudits('dl-sum'), 0);
    assert.equal(await runnerBackends(), 0, 'no runner backend left working');
  } finally { await drop(); }
  assert.equal((await timed('dl-sum')).code, 'ok:COMPLETED', 'positive control: the same cleanup completes without the delays');
  const done = await observe(runtimeSql, c);
  assert.deepEqual([done.state.pointer, done.snapshots.length, done.attempts.length, await cleanupAudits('dl-sum')], [null, 0, 1, 1]);
});

test('R1: COMMIT-time work alone beyond the budget (12 s deferred trigger) is cancelled at COMMIT, never committed late', async () => {
  const c = await eligible('dl-commit');
  const before = await observe(runtimeSql, c);
  const drop = await delays({ commit: 12 });
  try {
    const run = await timed('dl-commit');
    assert.equal(run.code, 'POWEROFFICE_CLEANUP_TIMEOUT');
    assert.ok(run.ms <= 10_000 + 150, `${Math.round(run.ms)} ms`);
    await until(run.t0, 13_000);
    assert.deepEqual(await observe(runtimeSql, c), before); assert.equal(await cleanupAudits('dl-commit'), 0);
    assert.equal(await runnerBackends(), 0);
  } finally { await drop(); }
});

test('R1 positive: login, routine and COMMIT delays within the budget still COMMIT (the server deadline is not premature)', async () => {
  const c = await eligible('dl-within');
  const drop = await delays({ login: 2, routine: 2, commit: 2 });
  try {
    const run = await timed('dl-within');
    assert.equal(run.code, 'ok:COMPLETED');
    assert.ok(run.ms >= 6_000 && run.ms < 9_500, `${Math.round(run.ms)} ms`);
  } finally { await drop(); }
  assert.deepEqual([(await observe(runtimeSql, c)).snapshots.length, await cleanupAudits('dl-within')], [0, 1]);
});

test('R2: a 15 s login with connect_timeout=30 is CLEANUP_TIMEOUT at the budget; no later routine, audit or commit', async () => {
  const c = await eligible('dl-login');
  const before = await observe(runtimeSql, c);
  const drop = await delays({ login: 15 });
  try {
    const run = await timed('dl-login', pairedSlow, ENV_SLOW);
    assert.equal(run.code, 'POWEROFFICE_CLEANUP_TIMEOUT', 'acquisition overrun is a timeout, not readiness');
    assert.ok(run.ms >= 9_500 && run.ms <= 10_000 + 150, `${Math.round(run.ms)} ms`);
    await until(run.t0, 17_000); // the delayed login has completed by now
    assert.deepEqual(await observe(runtimeSql, c), before); assert.equal(await cleanupAudits('dl-login'), 0);
    assert.equal(await runnerBackends(), 0, 'no late transaction on the finished login');
    // Default connect timeout (5 s) on a 7 s login: the structured connect timeout (P1001 on the proven same target).
    await drop();
    const restore = await delays({ login: 7 });
    try {
      const short = await timed('dl-login');
      assert.equal(short.code, 'POWEROFFICE_CLEANUP_TIMEOUT');
      assert.ok(short.ms < 10_150);
    } finally { await restore(); }
  } finally { await drop(); }
  assert.deepEqual(await observe(runtimeSql, c), before);
  const wrong = new URL(pgdb.poRunnerUrl); wrong.password = 'not-the-password';
  assert.equal((await timed('dl-login', paired, { ...ENV, ATLAS_TEST_PO_RUNNER: wrong.toString() })).code, 'POWEROFFICE_RUNTIME_NOT_READY',
    'authentication failure stays readiness/configuration');
});

test('R2 actual CLI: acquisition overrun is exit 1 POWEROFFICE_CLEANUP_TIMEOUT with no URL in the output and no late effect', async () => {
  const c = await eligible('dl-cli');
  const before = await observe(runtimeSql, c);
  const trap = trapDir();
  const drop = await delays({ login: 15 });
  try {
    const t0 = performance.now();
    const run = await runOps(trap, ['poweroffice-cleanup', '--client', CA, '--connection', 'dl-cli'], { ATLAS_RUNTIME_DATABASE_URL: withTimeout(pgdb.runtimeUrl),
      ATLAS_OPERATOR_TOKEN: tokens.maintainer!, ATLAS_POWEROFFICE_MODE: 'MOCK', ...ENV_SLOW });
    assert.deepEqual([run.code, run.output.safeErrorCode, run.output.synthetic], [1, 'POWEROFFICE_CLEANUP_TIMEOUT', true]);
    for (const s of [pgdb.poRunnerUrl, new URL(pgdb.poRunnerUrl).password, 'postgresql://']) assert.ok(!(run.stdout + run.stderr).includes(s));
    assert.equal(trap.trapped(), '');
    await until(t0, 17_500);
    assert.deepEqual(await observe(runtimeSql, c), before); assert.equal(await cleanupAudits('dl-cli'), 0);
    assert.equal(await runnerBackends(), 0);
  } finally { await drop(); trap.close(); }
});
