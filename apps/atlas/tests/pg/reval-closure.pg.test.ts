import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { OwnerConfig } from '../../packages/reval/config.ts';
import { decodeClosure } from '../../packages/reval/payloads.ts';
import { connectAs, ownerScoped, pauseOnce, reserveOnce, revise, setClient } from '../support/ask-remote-pg.ts';
import { closureHarness } from '../support/reval-closure-harness.ts';
import { nonsuperDatabase, roleFlags } from '../support/reval-nonsuper.ts';
import type { TestTcp } from '../support/reval-test-deps.ts';
import { dockerPhysical, privateDir, writePrivate } from '../support/reval-test-deps.ts';

// R-EVAL RS-A PAUSE_EXPORT on PostgreSQL 17 (brief §4/§6, ACCEPTANCE_CHECKS "closure" and "executor lifetime"): the REAL
// executor child E (test entry = production library + Docker TCP seam + test hooks), the REAL Darwin peer proof of E, the
// controller's pauseExport orchestration, and the dedicated NOSUPERUSER NOBYPASSRLS table owner as the owner credential
// (it ran migrate deploy and roles.sql; the compose superuser only bootstraps and cleans up).
const darwin = process.platform === 'darwin' && process.arch === 'arm64';
const n = await nonsuperDatabase();
const { db, admin } = n; const owner = db.owner;
const h = darwin ? await closureHarness(n) : null;
after(async () => { await h?.close(); await n.cleanup(); });
const u = new URL(db.ownerUrl);
const tcp: TestTcp = { host: u.hostname, port: Number(u.port || 5432) };
const physical = await dockerPhysical(admin);
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e: { code?: string }) => e.code ?? String(e));
const setup = (label: string, hooks: TestTcp['hooks'] = {}, over: Partial<OwnerConfig> = {}) => h!.setup(label, { hooks, config: over });
const without = (j: Record<string, unknown>, keys: string[]) => Object.fromEntries(Object.entries(j).filter(([k]) => !keys.includes(k)));
const FOUR = ['policyVersion', 'state', 'stateReason', 'revisedAt'];

test('owner credential is the dedicated NOSUPERUSER NOBYPASSRLS table owner (recorded flags)', async () => {
  const flags = await roleFlags(admin, [n.ownerRole, db.runtimeRole, db.revalReaderRole]);
  for (const f of Object.values(flags)) assert.deepEqual([f.super, f.bypassRls], [false, false]);
  assert.equal((await admin.query(`SELECT relowner::regrole::text AS o FROM pg_class WHERE relname = 'RemoteAskPolicy'`)).rows[0].o, n.ownerRole);
});

test('APPLIED path (ACTIVE→PAUSED): exactly four columns change, microsecond expiresAt kept, closure exact, one spawn, no policy value in JS', { skip: !darwin && 'needs the Darwin peer proof' }, async () => {
  const s = await setup('ap');
  await revise(owner, s.p.ws, { expiresAt: new Date(Date.now() + 3_600_000).toISOString().replace('Z', '123Z').replace(/\.(\d{3})123Z/, '.$1456Z') });
  const before = await s.policy(); const f0 = await s.fence();
  assert.match(String(before.expiresAt), /\.\d{6}/, 'microsecond expiry planted');
  const v = String(before.policyVersion);
  const { d, elapsed, reaped } = await s.pause(v, [String(BigInt(v) - 1n), '0']);
  assert.equal(d.kind, 'CLOSURE', JSON.stringify(d));
  const c = decodeClosure(d.kind === 'CLOSURE' ? d.closure : null);
  assert.deepEqual(Object.keys(c).sort(), ['admissionId', 'fenceEpoch', 'paused', 'policyVersion']);
  assert.deepEqual(c, { admissionId: s.p.admissionId, paused: true, policyVersion: String(BigInt(v) + 1n), fenceEpoch: String(BigInt(f0) + 1n) });
  const after_ = await s.policy();
  assert.deepEqual(without(after_, FOUR), without(before, FOUR), 'every other column byte-equal (microseconds included)');
  assert.deepEqual([after_.state, after_.stateReason], ['PAUSED', 'OWNER']);
  assert.equal(s.ctx.spawns, 1); assert.ok(reaped); assert.ok(elapsed < 2000, `answered in ${elapsed} ms`);
  const cap = await s.captured(); const text = JSON.stringify(cap);
  assert.ok(cap.some(x => x.sql === 'REVISE'), 'the accepted owner routine was called');
  for (const leaked of ['fixture://', 'synthetic-owner-approval', String(before.expiresAt).slice(0, 19)]) assert.ok(!text.includes(leaked), `no ${leaked} in JS`);
});

test('already-PAUSED (runtime MODEL_MISMATCH): routine IS called as the accepted no-op; closure only strictly above floors; equal floors latch', { skip: !darwin && 'needs the Darwin peer proof' }, async () => {
  const s = await setup('np');
  const rt = await connectAs(db.runtimeUrl);
  try { await pauseOnce(rt, s.p.ws, s.p.admissionId, 'MODEL_MISMATCH'); } finally { await rt.end(); }
  const before = await s.policy(); const f = await s.fence(); const v = String(before.policyVersion);
  const ok = await s.pause(v, [String(BigInt(v) - 1n), String(BigInt(f) - 1n)]);
  assert.deepEqual(ok.d, { kind: 'CLOSURE', closure: { admissionId: s.p.admissionId, paused: true, policyVersion: v, fenceEpoch: f } });
  assert.deepEqual(await s.policy(), before, 'whole row identical; stateReason stays MODEL_MISMATCH; no artificial revision');
  assert.ok((await s.captured()).some(x => x.sql === 'REVISE'));
  const stale = await s.pause(v, [v, String(BigInt(f) - 1n)]);
  assert.deepEqual(stale.d, { kind: 'FAILURE', code: 'CONTAINMENT_UNCONFIRMED', latch: true }, 'equal/stale floor');
  assert.ok(s.ctx.latched);
  const again = await s.pause(v, ['0', '0']);
  assert.deepEqual(again.d, { kind: 'FAILURE', code: 'CONTAINMENT_UNCONFIRMED', latch: false }); assert.equal(s.ctx.spawns, 2, 'latched session never spawns again');
});

test('refusals before COMMIT roll back and never close: zero rows, argument difference, active no-op, injected rollback, REVOKED, version mismatch, max boundaries', { skip: !darwin && 'needs the Darwin peer proof' }, async () => {
  const cases: [string, TestTcp['hooks'], (s: Awaited<ReturnType<typeof setup>>) => Promise<string>, string][] = [
    ['zero-row revise statement', { reviseZeroRows: true }, async s => String((await s.policy()).policyVersion), 'POLICY_CHANGED'],
    ['argument difference on an already-PAUSED row', { argDifference: true }, async s => {
      // The call then performs a REAL revision and returns expected+1, which a PAUSED pre-state never accepts (brief §6 step 5).
      const rt = await connectAs(db.runtimeUrl); try { return await pauseOnce(rt, s.p.ws, s.p.admissionId); } finally { await rt.end(); } }, 'POLICY_CHANGED'],
    ['ACTIVE row whose call returns the no-op', { activeNoop: true }, async s => String((await s.policy()).policyVersion), 'POLICY_CHANGED'],
    ['injected ROLLBACK before COMMIT', { rollbackBeforeCommit: true }, async s => String((await s.policy()).policyVersion), 'INTERNAL_FAILURE'],
    ['REVOKED', {}, async s => revise(owner, s.p.ws, { state: 'REVOKED' }), 'CONTAINMENT_UNCONFIRMED'],
    ['expected version ≠ current', {}, async s => String(BigInt(String((await s.policy()).policyVersion)) + 5n), 'POLICY_CHANGED'],
    ['policyVersion max−1 (exhaustion → TOMBSTONE rolled back)', {}, async s => {
      await ownerScoped(owner, s.p.ws, async () => { await owner.query(`ALTER TABLE "RemoteAskPolicy" DISABLE TRIGGER USER`);
        await owner.query(`UPDATE "RemoteAskPolicy" SET "policyVersion" = 9223372036854775806`);
        await owner.query(`ALTER TABLE "RemoteAskPolicy" ENABLE ALWAYS TRIGGER "RemoteAskPolicy_guard", ENABLE ALWAYS TRIGGER "RemoteAskPolicy_truncate"`); });
      return '9223372036854775806'; }, 'CONTAINMENT_UNCONFIRMED'],
    ['fence Int max (22003 rolled back)', {}, async s => {
      const modes = (await admin.query(`SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = '"ActionAuthorityFence"'::regclass AND NOT tgisinternal`)).rows;
      await ownerScoped(owner, s.p.ws, async () => { await owner.query(`ALTER TABLE "ActionAuthorityFence" DISABLE TRIGGER USER`);
        await owner.query(`UPDATE "ActionAuthorityFence" SET version = 2147483647`);
        for (const m of modes) await owner.query(`ALTER TABLE "ActionAuthorityFence" ENABLE ${m.tgenabled === 'A' ? 'ALWAYS' : ''} TRIGGER "${m.tgname}"`); });
      assert.deepEqual((await admin.query(`SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = '"ActionAuthorityFence"'::regclass AND NOT tgisinternal`)).rows, modes);
      return String((await s.policy()).policyVersion); }, 'CONTAINMENT_UNCONFIRMED'],
  ];
  for (const [label, hooks, prep, expected] of cases) {
    const s = await setup('rf', hooks);
    const v = await prep(s);
    const before = await s.policy(); const f = await s.fence();
    const { d } = await s.pause(v);
    assert.deepEqual(d, { kind: 'FAILURE', code: expected, latch: false }, label);
    assert.deepEqual(await s.policy(), before, `${label}: rolled back`); assert.equal(await s.fence(), f);
    if (label === 'REVOKED') assert.ok(!(await s.captured()).some(x => x.sql === 'REVISE'), 'REVOKED: no call');
  }
});

test('commit uncertainty and drift after a confirmed commit latch without closure; scope and physical refusals happen before any lock', { skip: !darwin && 'needs the Darwin peer proof' }, async () => {
  const lost = await setup('al', { ackLostAfterCommit: true });
  const v = String((await lost.policy()).policyVersion);
  const r = await lost.pause(v);
  assert.deepEqual(r.d, { kind: 'FAILURE', code: 'CONTAINMENT_UNCONFIRMED', latch: true });
  assert.equal((await lost.policy()).state, 'PAUSED', 'the commit happened, yet no closure (killing/losing is never proof either way)');
  for (const [label, drift] of [['revision', async (s: Awaited<ReturnType<typeof setup>>) => { await revise(owner, s.p.ws, { dayCapMicroUsd: '1000000' }); }],
    ['client_set', async (s: Awaited<ReturnType<typeof setup>>) => { await owner.query(`INSERT INTO "Client" ("workspaceId", id, name) VALUES ($1, $2, 'x')`, [s.p.ws, `${s.p.client}-d`]); await setClient(owner, s.p.ws, `${s.p.client}-d`, true); }],
    ['Stage 3 fence bump', async (s: Awaited<ReturnType<typeof setup>>) => { await owner.query(`INSERT INTO "Actor" ("workspaceId", id, "displayName") VALUES ($1, $2, 'x')`, [s.p.ws, `${s.p.actor}-d`]); }]] as const) {
    const s = await setup('dr'); s.setReread(() => drift(s));
    const { d } = await s.pause(String((await s.policy()).policyVersion));
    assert.deepEqual(d, { kind: 'FAILURE', code: 'CONTAINMENT_UNCONFIRMED', latch: true }, label);
  }
  const sc = await setup('sc', { skipScope: true });
  assert.deepEqual((await sc.pause(String((await sc.policy()).policyVersion))).d, { kind: 'FAILURE', code: 'REGISTRATION_MISMATCH', latch: false });
  assert.ok(!(await sc.captured()).some(x => /FOR UPDATE|REVISE/.test(x.sql)), 'no lock, no call');
  const wrong = await setup('pw', {}, { physical: { ...physical, systemIdentifier: '1' } });
  assert.deepEqual((await wrong.pause(String((await wrong.policy()).policyVersion))).d, { kind: 'FAILURE', code: 'REGISTRATION_MISMATCH', latch: false }, 'wrong owner database');
  assert.deepEqual(await wrong.captured(), [], 'no statement at all');
  const rt = await connectAs(db.runtimeUrl);
  try { assert.equal(await code(reserveOnce(rt, lost.p.ws, lost.p.client, { admissionId: lost.p.admissionId, policyVersion: String(BigInt(v) + 1n) }, { actor: lost.p.actor })), 'AR001'); }
  finally { await rt.end(); }
});

// Scoped to THIS test database: other PG test files run executors of their own in parallel on the shared Docker cluster.
const ownerBackends = async () => Number((await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND application_name = 'atlas-reval-e-owner'`, [db.name])).rows[0].n);
const gone = async (pid: number, ms: number) => { const t = Date.now(); while (Date.now() - t < ms) { try { process.kill(pid, 0); } catch { return true; } await new Promise(r => setTimeout(r, 25)); } return false; };
test('executor lifetime: blocked before connect, blocked on a lock (fence held first), killed after COMMIT, parent death — single spawn, bounded cleanup', { skip: !darwin && 'needs the Darwin peer proof' }, async () => {
  const hole = createServer(() => undefined); await new Promise<void>(r => hole.listen(0, '127.0.0.1', r));
  try {
    const b = await setup('bh', { blackholePort: (hole.address() as { port: number }).port });
    const r = await b.pause(String((await b.policy()).policyVersion));
    assert.deepEqual(r.d, { kind: 'FAILURE', code: 'CONTAINMENT_UNCONFIRMED', latch: true }, 'no result by DE (request was sent)');
    assert.ok(r.elapsed < 1850, `C answered by D (${r.elapsed} ms)`); assert.ok(r.reaped && await gone(b.ctx.lastChild!.pid!, 1500));
  } finally { hole.close(); }
  // E blocked on the policy row: its lock/statement timeouts fire before DE; meanwhile it already holds the fence (fence first).
  const l = await setup('lk');
  const holder = new pg.Client({ connectionString: n.ownerUrl }); await holder.connect();
  const probe = new pg.Client({ connectionString: n.ownerUrl }); await probe.connect();
  try {
    await holder.query('BEGIN'); await holder.query(`SELECT set_config('app.workspace_id', $1, true)`, [l.p.ws]);
    await holder.query(`SELECT 1 FROM "RemoteAskPolicy" FOR UPDATE`);
    const running = l.pause(String((await l.policy()).policyVersion));
    await new Promise(r => setTimeout(r, 900));
    await probe.query('BEGIN'); await probe.query(`SELECT set_config('app.workspace_id', $1, true)`, [l.p.ws]);
    assert.equal(await code(probe.query(`SELECT 1 FROM "ActionAuthorityFence" FOR UPDATE NOWAIT`)), '55P03', 'E holds the fence while waiting for the policy');
    await probe.query('ROLLBACK');
    const r = await running;
    assert.deepEqual(r.d, { kind: 'FAILURE', code: 'DEADLINE', latch: false }); assert.ok(r.elapsed < 2000, String(r.elapsed));
    await holder.query('ROLLBACK');
  } finally { await holder.end(); await probe.end(); }
  const t0 = Date.now(); while (await ownerBackends() > 0 && Date.now() - t0 < 1500) await new Promise(r => setTimeout(r, 50));
  assert.equal(await ownerBackends(), 0, 'no owner backend survives the bounded cleanup');
  const k = await setup('kc', { killAfterCommitSent: true });
  const kr = await k.pause(String((await k.policy()).policyVersion));
  assert.deepEqual(kr.d, { kind: 'FAILURE', code: 'CONTAINMENT_UNCONFIRMED', latch: true }, 'killed after COMMIT was sent');
  // Parent death mid-transaction: E exits on parent EOF and its transaction is aborted (lock released).
  const pd = await setup('pd', { sleepInTxMs: 3000 });
  const dir = await privateDir('pd');
  const pidFile = `${dir}/e.pid`;
  const arg = await writePrivate(dir, 'pause.json', JSON.stringify({ config: pd.ctx.config, testJson: `${dir}/test.json`, pidFile,
    request: { admissionId: pd.p.admissionId, expectedPolicyVersion: String((await pd.policy()).policyVersion), policyFloor: '0', fenceFloor: '0' } }));
  await writePrivate(dir, 'test.json', JSON.stringify({ ...tcp, hooks: { sleepInTxMs: 3000 } }));
  const parent = spawn(process.execPath, [fileURLToPath(new URL('../support/reval-test-pause-entry.ts', import.meta.url)), arg], { stdio: 'ignore' });
  let ePid = 0; const t1 = Date.now();
  while (Date.now() - t1 < 3000 && !ePid) { ePid = Number(await readFile(pidFile, 'utf8').catch(() => '0')); await new Promise(r => setTimeout(r, 25)); }
  await new Promise(r => setTimeout(r, 700));
  parent.kill('SIGKILL');
  assert.ok(ePid > 0 && await gone(ePid, 1500), 'E exits on parent EOF');
  const t2 = Date.now(); while (await ownerBackends() > 0 && Date.now() - t2 < 1500) await new Promise(r => setTimeout(r, 50));
  assert.equal(await ownerBackends(), 0);
  assert.equal((await pd.policy()).state, 'ACTIVE', 'the transaction was aborted');
});
