import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PrismaClient } from '@prisma/client';
import { admitPowerOfficeCleanup, openPowerOfficeRuntime, runPowerOfficeCleanup } from '../../packages/poweroffice/maintenance.ts';
import type { CleanupAdmission } from '../../packages/poweroffice/maintenance.ts';
import { POWEROFFICE_PAIRING_SQL, POWEROFFICE_RUNNER_CHECK_SQL, runnerProblems } from '../../packages/poweroffice/runner-role.ts';
import type { Pairing, RunnerFacts } from '../../packages/poweroffice/runner-role.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { CA, WS, addPowerOfficeFixtures, connect } from '../support/poweroffice-fixtures.ts';
import { addSyncConnection, codeOf, observe, sleep, untilWaiting } from '../support/poweroffice-sync.ts';
import { ageConnection } from '../support/poweroffice-history.ts';
import { MOCK, as, goodSync } from '../support/poweroffice-read.ts';

// S4-C C3 on PostgreSQL 17, part 2: the actual runner's confinement/pairing facts (positive and negative controls), the
// 1000 ms lock timeout, a real routine audit failure, the ONE original 10 s whole-transaction budget including a real
// slow login (pool acquisition) and a statement cancelled at the remaining budget — every failure rolls everything back —
// and real Connection UPDATEs against cleanup: both natural interleavings and a constructed deadlock with each side as
// PostgreSQL's victim (handoff item 4), always with fixed outcomes and zero partial effects. Test-only DB-local objects
// (PUBLIC-revoked trigger/event-trigger functions, a role setting of the disposable runner) are removed in finally.
const pgdb = await createTestDatabase();
const prisma = new PrismaClient({ datasources: { db: { url: pgdb.runtimeUrl } } });
const runtimeSql = await connect(pgdb.runtimeUrl);
const paired = openPowerOfficeRuntime(pgdb.runtimeUrl);
const sessions: pg.Client[] = [];
after(async () => { for (const c of [runtimeSql, ...sessions]) await c.end().catch(() => undefined); await prisma.$disconnect(); await paired.db.$disconnect(); await pgdb.drop(); });
const owner = pgdb.owner;
await addPowerOfficeFixtures(owner);
const key = (connectionId: string) => ({ workspaceId: WS, clientId: CA, connectionId });
const ENV = { ATLAS_POWEROFFICE_CLEANUP_RUNNER_SECRET_REF: 'env://ATLAS_TEST_PO_RUNNER', ATLAS_TEST_PO_RUNNER: pgdb.poRunnerUrl };
const admit = (id: string) => admitPowerOfficeCleanup(paired, MOCK, as('maintainer'), CA, id);
async function session(url = pgdb.ownerUrl): Promise<pg.Client> { const c = await connect(url); sessions.push(c); return c; }
async function expiredConnection(id: string) {
  const c = await addSyncConnection(owner, key(id), 4);
  await goodSync(prisma, CA, id);
  await ageConnection(owner, c, '25 hours');
  return c;
}
const cleanupAudits = async (id: string) => Number((await owner.query(`SELECT count(*) FROM "AuditEvent" WHERE "eventType" = 'poweroffice.cleanup'
  AND metadata->>'connectionId' = $1`, [id])).rows[0].count);
const lifecycle = async (id: string) => Number((await owner.query(`SELECT "lifecycleVersion" AS v FROM "Connection" WHERE id = $1`, [id])).rows[0].v);
/** Elapsed ms and fixed outcome of one admitted cleanup run (the budget starts inside runPowerOfficeCleanup). */
async function timed(id: string, env = ENV, admitted?: CleanupAdmission): Promise<{ code: string; ms: number }> {
  const admission = admitted ?? await admit(id);
  const t0 = performance.now();
  const code = await runPowerOfficeCleanup(admission, env).then(r => `ok:${r.outcome}`, (e: { code?: string }) => e.code ?? 'NO_CODE');
  return { code, ms: performance.now() - t0 };
}
async function slowAudit(seconds: number): Promise<() => Promise<void>> {
  await owner.query(`CREATE FUNCTION public.s4c_test_slow_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW."eventType" = 'poweroffice.cleanup' THEN PERFORM pg_sleep(${seconds}); END IF; RETURN NEW; END $$;
    REVOKE ALL ON FUNCTION public.s4c_test_slow_audit() FROM PUBLIC;
    CREATE TRIGGER s4c_test_slow_audit BEFORE INSERT ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION public.s4c_test_slow_audit();`);
  return async () => { await owner.query(`DROP TRIGGER s4c_test_slow_audit ON "AuditEvent"; DROP FUNCTION public.s4c_test_slow_audit();`); };
}

test('runner facts: the actual PowerOffice runner is confined and paired; the Stage 2 runner, runtime and owner are not', async () => {
  const admitted = (await runtimeSql.query(POWEROFFICE_PAIRING_SQL)).rows[0] as Pairing;
  assert.equal(admitted.runner, pgdb.poRunnerRole);
  const facts = async (url: string) => { const c = await session(url); return (await c.query(POWEROFFICE_RUNNER_CHECK_SQL)).rows[0] as RunnerFacts; };
  assert.deepEqual(runnerProblems(await facts(pgdb.poRunnerUrl), admitted), [], 'positive control');
  assert.ok(runnerProblems(await facts(pgdb.runnerUrl), admitted).includes('executeViolations'));
  assert.ok(runnerProblems(await facts(pgdb.runtimeUrl), admitted).includes('pairing.runner'));
  assert.ok(runnerProblems(await facts(pgdb.ownerUrl), admitted).length > 0);
  assert.ok(runnerProblems(await facts(pgdb.poRunnerUrl), { ...admitted, routine: '1' }).includes('pairing.routine'), 'another routine identity');
  assert.ok(runnerProblems(await facts(pgdb.poRunnerUrl), { ...admitted, database: 'other' }).includes('pairing.database'));
});

test('lock wait over 1000 ms: POWEROFFICE_CLEANUP_TIMEOUT after about one second, everything rolled back', async () => {
  const c = await expiredConnection('bg-lock');
  const before = await observe(runtimeSql, c);
  const holder = await session();
  await holder.query('BEGIN');
  await holder.query(`SELECT 1 FROM public."PowerOfficeState" WHERE "connectionId" = 'bg-lock' FOR UPDATE`);
  let result: { code: string; ms: number };
  try { result = await timed('bg-lock'); } finally { await holder.query('ROLLBACK'); }
  assert.equal(result.code, 'POWEROFFICE_CLEANUP_TIMEOUT');
  assert.ok(result.ms >= 950 && result.ms < 4000, `lock timeout ${Math.round(result.ms)} ms`);
  assert.deepEqual(await observe(runtimeSql, c), before); assert.equal(await cleanupAudits('bg-lock'), 0);
  assert.equal((await timed('bg-lock')).code, 'ok:COMPLETED', 'no lasting effect: the next explicit cleanup completes');
});

test('an actual routine audit failure: POWEROFFICE_CLEANUP_FAILED, pointer and expired snapshot unchanged', async () => {
  const c = await expiredConnection('bg-audit');
  const before = await observe(runtimeSql, c);
  await owner.query(`CREATE FUNCTION public.s4c_test_cleanup_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW."eventType" = 'poweroffice.cleanup' THEN RAISE EXCEPTION 'audit sink down' USING ERRCODE = '58000'; END IF; RETURN NEW; END $$;
    REVOKE ALL ON FUNCTION public.s4c_test_cleanup_audit_fault() FROM PUBLIC;
    CREATE TRIGGER s4c_test_cleanup_audit_fault BEFORE INSERT ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION public.s4c_test_cleanup_audit_fault();`);
  try { assert.equal((await timed('bg-audit')).code, 'POWEROFFICE_CLEANUP_FAILED'); }
  finally { await owner.query(`DROP TRIGGER s4c_test_cleanup_audit_fault ON "AuditEvent"; DROP FUNCTION public.s4c_test_cleanup_audit_fault();`); }
  assert.deepEqual(await observe(runtimeSql, c), before);
});

test('ONE original 10 s budget: a statement is cancelled at the remaining budget, a slow login (pool acquisition) consumes it', async () => {
  const c = await expiredConnection('bg-budget');
  const before = await observe(runtimeSql, c);
  const drop = await slowAudit(30);
  try {
    const plain = await timed('bg-budget');
    assert.equal(plain.code, 'POWEROFFICE_CLEANUP_TIMEOUT');
    assert.ok(plain.ms >= 9000 && plain.ms < 13_000, `statement cancelled at the budget: ${Math.round(plain.ms)} ms`);
    // Real slow login of the runner role only (a PG17 login event trigger, test-only): ~4 s of connection acquisition.
    await owner.query(`CREATE FUNCTION public.s4c_test_login_delay() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN
        IF session_user = '${pgdb.poRunnerRole}' THEN PERFORM pg_sleep(4); END IF; END $$;
      REVOKE ALL ON FUNCTION public.s4c_test_login_delay() FROM PUBLIC;
      CREATE EVENT TRIGGER s4c_test_login_delay ON login EXECUTE FUNCTION public.s4c_test_login_delay();`);
    try {
      const t0 = performance.now();
      await session(pgdb.poRunnerUrl); // positive control: the delay really applies to the runner's login
      assert.ok(performance.now() - t0 >= 3900, 'runner login is delayed ~4 s');
      const slow = await timed('bg-budget');
      assert.equal(slow.code, 'POWEROFFICE_CLEANUP_TIMEOUT');
      assert.ok(slow.ms >= 9000 && slow.ms < 13_000, `pool wait counted in the original budget, never reset: ${Math.round(slow.ms)} ms`);
    } finally { await owner.query(`DROP EVENT TRIGGER s4c_test_login_delay; DROP FUNCTION public.s4c_test_login_delay();`); }
  } finally { await drop(); }
  assert.deepEqual(await observe(runtimeSql, c), before, 'every timeout rolled everything back');
  assert.equal(await cleanupAudits('bg-budget'), 0);
});

test('real Connection UPDATE vs cleanup, natural orders: fence held by the UPDATE → lock timeout, zero effects; cleanup first → UPDATE waits', async () => {
  const c = await expiredConnection('bg-conn');
  const before = await observe(runtimeSql, c);
  const admitted = await admit('bg-conn'); // admission first: it takes the fence too (no lock timeout there)
  const mutator = await session();
  await mutator.query('BEGIN');
  await mutator.query(`UPDATE "Connection" SET "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = 'bg-conn'`); // its trigger now holds the fence
  let held: { code: string; ms: number };
  try { held = await timed('bg-conn', ENV, admitted); } finally { await mutator.query('COMMIT'); }
  assert.equal(held.code, 'POWEROFFICE_CLEANUP_TIMEOUT');
  assert.deepEqual(await observe(runtimeSql, c), before);
  assert.equal((await timed('bg-conn')).code, 'ok:COMPLETED', 'the next cleanup sees the advanced lifecycle (closeout binding)');
  // Cleanup holds the fence (slow audit inside the routine); a direct UPDATE waits and commits after it.
  const c2 = await expiredConnection('bg-conn2');
  const drop = await slowAudit(1.5);
  try {
    const running = timed('bg-conn2');
    for (let i = 0; i < 200 && Number((await owner.query(`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()
      AND wait_event = 'PgSleep' AND query LIKE '%atlas_poweroffice_cleanup%'`)).rows[0].count) === 0; i++) await sleep(20);
    const update = owner.query(`UPDATE "Connection" SET "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = 'bg-conn2'`);
    assert.equal((await running).code, 'ok:COMPLETED');
    await update;
  } finally { await drop(); }
  assert.equal(await lifecycle('bg-conn2'), 2);
  assert.deepEqual([(await observe(runtimeSql, c2)).state.pointer, await cleanupAudits('bg-conn2')], [null, 1]);
});

/**
 * Constructed FK/lock cycle (handoff item 4): a direct owner transaction holds the connection's State row, cleanup takes
 * the fence and waits for State, then the same owner transaction UPDATEs the Connection, whose fence trigger waits for
 * cleanup. The side whose deadlock check runs first is PostgreSQL's 40P01 victim: the UPDATE (session deadlock_timeout
 * 200 ms) or cleanup (the disposable runner role's deadlock_timeout 600 ms, below its 1000 ms lock_timeout; owner 5 s).
 */
async function cycle(id: string, victim: 'update' | 'cleanup'): Promise<{ cleanup: string; update: string }> {
  const m = await session();
  await m.query(`SET deadlock_timeout = '${victim === 'update' ? '200ms' : '5s'}'`);
  await m.query('BEGIN');
  await m.query(`SELECT 1 FROM public."PowerOfficeState" WHERE "connectionId" = $1 FOR UPDATE`, [id]);
  const running = timed(id);
  await untilWaiting(owner, 'atlas_poweroffice_cleanup');
  const update = m.query(`UPDATE "Connection" SET "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = $1`, [id])
    .then(async () => { await m.query('COMMIT'); return 'committed'; }, async (e: { code?: string }) => { await m.query('ROLLBACK'); return e.code ?? 'NO_CODE'; });
  return { cleanup: (await running).code, update: await update };
}

test('deadlock with the Connection UPDATE as victim: 40P01 for it, lifecycle unchanged; cleanup completes', async () => {
  const c = await expiredConnection('bg-dl-update');
  const outcome = await cycle('bg-dl-update', 'update');
  assert.deepEqual(outcome, { cleanup: 'ok:COMPLETED', update: '40P01' });
  assert.equal(await lifecycle('bg-dl-update'), 1, 'the victim UPDATE left no partial effect');
  assert.deepEqual([(await observe(runtimeSql, c)).snapshots.length, await cleanupAudits('bg-dl-update')], [0, 1]);
});

test('deadlock with cleanup as victim: POWEROFFICE_DB_CONFLICT, zero effects; the UPDATE commits and the next cleanup completes', async () => {
  const c = await expiredConnection('bg-dl-cleanup');
  const before = await observe(runtimeSql, c);
  await owner.query(`ALTER ROLE "${pgdb.poRunnerRole}" IN DATABASE "${pgdb.name}" SET deadlock_timeout = '600ms'`);
  let outcome: { cleanup: string; update: string };
  try { outcome = await cycle('bg-dl-cleanup', 'cleanup'); }
  finally { await owner.query(`ALTER ROLE "${pgdb.poRunnerRole}" IN DATABASE "${pgdb.name}" RESET deadlock_timeout`); }
  assert.deepEqual(outcome, { cleanup: 'POWEROFFICE_DB_CONFLICT', update: 'committed' });
  assert.deepEqual(await observe(runtimeSql, c), before, 'the victim cleanup left no partial effect');
  assert.equal(await cleanupAudits('bg-dl-cleanup'), 0);
  assert.equal(await lifecycle('bg-dl-cleanup'), 2);
  assert.equal((await timed('bg-dl-cleanup')).code, 'ok:COMPLETED');
});
