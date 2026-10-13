import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { admitPowerOfficeCleanup, openPowerOfficeRuntime, runPowerOfficeCleanup } from '../../packages/poweroffice/maintenance.ts';
import type { PowerOfficeRuntime } from '../../packages/poweroffice/maintenance.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { CA, WS, addPowerOfficeFixtures, connect } from '../support/poweroffice-fixtures.ts';
import { addSyncConnection, observe, sleep, untilWaiting } from '../support/poweroffice-sync.ts';
import { ageConnection } from '../support/poweroffice-history.ts';
import { MOCK, as, goodSync } from '../support/poweroffice-read.ts';

// S4-C RC3 closure of Astra S4C-rc2 R1 on PostgreSQL 17: an INHERITED positive transaction_timeout (role-in-database,
// database, or connection-startup option) arms the server timer at BEGIN and an in-transaction set cannot replace it. The
// runner now sets and verifies its session timeouts on its one connection BEFORE BEGIN. With an inherited 30 s timer the
// 4 s login + 4 s routine + 4 s deferred COMMIT case (12 s) is CLEANUP_TIMEOUT by the original deadline with pointer,
// snapshots, attempts and audit rolled back — re-observed after the delayed work would have ended, no runner backend left;
// within-budget delays still commit; a STRICTER inherited value is honored, a looser one never extends 10 s / 1000 ms.
// Settings are DB-local (ALTER ROLE <disposable runner> IN DATABASE <disposable db>, ALTER DATABASE <disposable db>, or a
// startup option of this test's URLs) and reset in finally; delay objects are PUBLIC-revoked and dropped in finally.
const pgdb = await createTestDatabase();
const prisma = new PrismaClient({ datasources: { db: { url: pgdb.runtimeUrl } } });
const runtimeSql = await connect(pgdb.runtimeUrl);
const startup = (url: string) => { const u = new URL(url); u.searchParams.set('options', '-c transaction_timeout=30s'); return u.toString(); };
const paired = openPowerOfficeRuntime(pgdb.runtimeUrl);
const pairedStartup = openPowerOfficeRuntime(startup(pgdb.runtimeUrl)); // same query options as the startup runner URL
after(async () => {
  await pgdb.owner.query(`ALTER ROLE "${pgdb.poRunnerRole}" IN DATABASE "${pgdb.name}" RESET ALL; ALTER DATABASE "${pgdb.name}" RESET ALL`).catch(() => undefined);
  await runtimeSql.end().catch(() => undefined); for (const r of [paired, pairedStartup]) await r.db.$disconnect(); await prisma.$disconnect(); await pgdb.drop();
});
const owner = pgdb.owner;
await addPowerOfficeFixtures(owner);
const ENV = { ATLAS_POWEROFFICE_CLEANUP_RUNNER_SECRET_REF: 'env://ATLAS_TEST_PO_RUNNER', ATLAS_TEST_PO_RUNNER: pgdb.poRunnerUrl };
const ENV_STARTUP = { ...ENV, ATLAS_TEST_PO_RUNNER: startup(pgdb.poRunnerUrl) };
const key = (connectionId: string) => ({ workspaceId: WS, clientId: CA, connectionId });
const cleanupAudits = async (id: string) => Number((await owner.query(`SELECT count(*) FROM "AuditEvent" WHERE "eventType" = 'poweroffice.cleanup'
  AND metadata->>'connectionId' = $1`, [id])).rows[0].count);
const runnerBackends = async () => Number((await owner.query(`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()
  AND usename = $1 AND state <> 'idle'`, [pgdb.poRunnerRole])).rows[0].count);
/** What a fresh runner session inherits (independent connection, the setting under test is real). */
const inheritedOf = async (url: string, name: string) => { const c = await connect(url); try { return (await c.query(`SHOW ${name}`)).rows[0][name]; } finally { await c.end(); } };
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
  if (spec.login) sql.push(`CREATE FUNCTION public.s4c_rc3_login() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN
      IF session_user = '${pgdb.poRunnerRole}' THEN PERFORM pg_sleep(${spec.login}); END IF; END $$;
    REVOKE ALL ON FUNCTION public.s4c_rc3_login() FROM PUBLIC; CREATE EVENT TRIGGER s4c_rc3_login ON login EXECUTE FUNCTION public.s4c_rc3_login();`);
  if (spec.routine) sql.push(`CREATE FUNCTION public.s4c_rc3_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW."eventType" = 'poweroffice.cleanup' THEN PERFORM pg_sleep(${spec.routine}); END IF; RETURN NEW; END $$;
    REVOKE ALL ON FUNCTION public.s4c_rc3_audit() FROM PUBLIC;
    CREATE TRIGGER s4c_rc3_audit BEFORE INSERT ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION public.s4c_rc3_audit();`);
  if (spec.commit) sql.push(`CREATE FUNCTION public.s4c_rc3_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW."eventType" = 'poweroffice.cleanup' THEN PERFORM pg_sleep(${spec.commit}); END IF; RETURN NEW; END $$;
    REVOKE ALL ON FUNCTION public.s4c_rc3_commit() FROM PUBLIC;
    CREATE CONSTRAINT TRIGGER s4c_rc3_commit AFTER INSERT ON "AuditEvent" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.s4c_rc3_commit();`);
  await owner.query(sql.join('\n'));
  return async () => {
    await owner.query(`DROP EVENT TRIGGER IF EXISTS s4c_rc3_login; DROP TRIGGER IF EXISTS s4c_rc3_audit ON "AuditEvent"; DROP TRIGGER IF EXISTS s4c_rc3_commit ON "AuditEvent";
      DROP FUNCTION IF EXISTS public.s4c_rc3_login(); DROP FUNCTION IF EXISTS public.s4c_rc3_audit(); DROP FUNCTION IF EXISTS public.s4c_rc3_commit();`);
  };
}
const until = async (t0: number, ms: number) => { const wait = t0 + ms - performance.now(); if (wait > 0) await sleep(wait); };
/** The 4 + 4 + 4 s case under an inherited 30 s timer: timeout by the deadline, complete rollback, re-checked later. */
async function overBudget(id: string, runtime: PowerOfficeRuntime = paired, env: Record<string, string> = ENV) {
  const c = await eligible(id);
  const before = await observe(runtimeSql, c);
  const drop = await delays({ login: 4, routine: 4, commit: 4 });
  try {
    const run = await timed(id, runtime, env);
    assert.equal(run.code, 'POWEROFFICE_CLEANUP_TIMEOUT', `${id}: no late commit under the inherited timer`);
    assert.ok(run.ms >= 9_000 && run.ms <= 10_000 + 150, `${id}: returned at ${Math.round(run.ms)} ms`);
    assert.deepEqual(await observe(runtimeSql, c), before, 'pointer, snapshots and attempts unchanged immediately');
    assert.equal(await cleanupAudits(id), 0);
    await until(run.t0, 13_500);
    assert.deepEqual(await observe(runtimeSql, c), before, 'unchanged after the delayed work would have finished');
    assert.equal(await cleanupAudits(id), 0, 'no committed cleanup audit');
    assert.equal(await runnerBackends(), 0, 'no runner backend left working');
  } finally { await drop(); }
}

test('inherited role-in-database transaction_timeout 30 s: 4+4+4 s is CLEANUP_TIMEOUT with full rollback; within budget still commits', async () => {
  await owner.query(`ALTER ROLE "${pgdb.poRunnerRole}" IN DATABASE "${pgdb.name}" SET transaction_timeout = '30s'`);
  try {
    assert.equal(await inheritedOf(pgdb.poRunnerUrl, 'transaction_timeout'), '30s', 'the inherited setting is real');
    await overBudget('ih-role');
    const c = await eligible('ih-role-ok');
    const drop = await delays({ login: 2, routine: 2, commit: 2 });
    try { assert.equal((await timed('ih-role-ok')).code, 'ok:COMPLETED', 'positive control under the same inherited setting'); }
    finally { await drop(); }
    assert.deepEqual([(await observe(runtimeSql, c)).snapshots.length, await cleanupAudits('ih-role-ok')], [0, 1]);
  } finally { await owner.query(`ALTER ROLE "${pgdb.poRunnerRole}" IN DATABASE "${pgdb.name}" RESET transaction_timeout`); }
});

test('inherited database-level transaction_timeout 30 s: same timeout and rollback', async () => {
  await owner.query(`ALTER DATABASE "${pgdb.name}" SET transaction_timeout = '30s'`);
  try {
    assert.equal(await inheritedOf(pgdb.poRunnerUrl, 'transaction_timeout'), '30s');
    await overBudget('ih-db');
  } finally { await owner.query(`ALTER DATABASE "${pgdb.name}" RESET transaction_timeout`); }
});

test('connection-startup option transaction_timeout=30s in the paired URLs: same timeout and rollback', async () => {
  assert.equal(await inheritedOf(startup(pgdb.poRunnerUrl), 'transaction_timeout'), '30s', 'the startup option reaches the session');
  await overBudget('ih-startup', pairedStartup, ENV_STARTUP);
});

test('a stricter inherited value is honored, a looser one never extends: 2 s transaction timer ends a 4 s routine; 60 s lock_timeout stays 1 s', async () => {
  const c = await eligible('ih-strict');
  const before = await observe(runtimeSql, c);
  await owner.query(`ALTER ROLE "${pgdb.poRunnerRole}" IN DATABASE "${pgdb.name}" SET transaction_timeout = '2s'`);
  const drop = await delays({ routine: 4 });
  try {
    const run = await timed('ih-strict');
    assert.equal(run.code, 'POWEROFFICE_CLEANUP_TIMEOUT');
    assert.ok(run.ms < 4_000, `the stricter inherited 2 s timer ended it at ${Math.round(run.ms)} ms`);
    await until(run.t0, 5_000);
    assert.deepEqual(await observe(runtimeSql, c), before); assert.equal(await cleanupAudits('ih-strict'), 0);
  } finally { await drop(); await owner.query(`ALTER ROLE "${pgdb.poRunnerRole}" IN DATABASE "${pgdb.name}" RESET transaction_timeout`); }
  await owner.query(`ALTER ROLE "${pgdb.poRunnerRole}" IN DATABASE "${pgdb.name}" SET lock_timeout = '60s'`);
  await owner.query(`ALTER ROLE "${pgdb.poRunnerRole}" IN DATABASE "${pgdb.name}" SET statement_timeout = '60s'`);
  const holder = await connect(pgdb.ownerUrl);
  try {
    assert.equal(await inheritedOf(pgdb.poRunnerUrl, 'lock_timeout'), '1min');
    await holder.query('BEGIN');
    await holder.query(`SELECT 1 FROM public."PowerOfficeState" WHERE "connectionId" = 'ih-strict' FOR UPDATE`);
    const admission = await admitPowerOfficeCleanup(paired, MOCK, as('maintainer'), CA, 'ih-strict');
    const t0 = performance.now();
    const pending = runPowerOfficeCleanup(admission, ENV).then(() => 'ok', (e: { code?: string }) => e.code);
    await untilWaiting(owner, 'atlas_poweroffice_cleanup');
    const code = await pending;
    assert.equal(code, 'POWEROFFICE_CLEANUP_TIMEOUT');
    assert.ok(performance.now() - t0 < 3_000, 'the contract 1000 ms lock timeout, not the inherited 60 s');
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined); await holder.end();
    await owner.query(`ALTER ROLE "${pgdb.poRunnerRole}" IN DATABASE "${pgdb.name}" RESET ALL`);
  }
  assert.deepEqual(await observe(runtimeSql, c), before);
  assert.equal((await timed('ih-strict')).code, 'ok:COMPLETED', 'settings reset: the cleanup completes');
});
