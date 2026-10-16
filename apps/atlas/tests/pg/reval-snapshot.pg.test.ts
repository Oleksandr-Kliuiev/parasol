import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { buildResponse } from '../../packages/reval/envelope.ts';
import { encodeFrame, FrameError, METADATA_FRAME_CAP } from '../../packages/reval/frame.ts';
import { decodeSnapshot, decodeWrapper } from '../../packages/reval/payloads.ts';
import { exportSnapshot, readSnapshotWrapper, ReaderFailure, snapshotFitsEnvelope } from '../../packages/reval/snapshot-reader.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { PRICE, connectAs, freshProject, pauseOnce, reserveOnce, settleOnce, setClient } from '../support/ask-remote-pg.ts';
import { connect, registerSandbox, snapshotAs, syntheticLedger } from '../support/reval-pg.ts';

// R-EVAL RS-A atlas_reval_snapshot() on PostgreSQL 17 (brief §7, ACCEPTANCE_CHECKS "snapshot"): explicit login-OID scope,
// mandatory REPEATABLE READ READ ONLY, complete full-project census with foreign counts, original periods, missing-counter
// refusal vs synthesized zero vs orphan/sum inconsistency, bounds, timeout, concurrency, approved pricing, no secret
// columns. Runs as the confined evidence reader → definer. The harness owner here is the compose superuser (catalog drift
// injection only); E never runs in this file.
const db = await createTestDatabase();
const { owner } = db;
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e: { code?: string }) => e.code ?? String(e));
const reader = await connect(db.revalReaderUrl);
after(async () => { await reader.end().catch(() => undefined); await db.drop(); });
type W = ReturnType<typeof decodeWrapper>;
const snap = async (c: pg.Client = reader) => decodeWrapper(await snapshotAs(c)) as W;
const s = (w: W) => w.snapshot as Record<string, any>;

test('scope is the calling login only: two registrations/readers never cross-read; stale caller settings ignored; recreated OID and SET ROLE refused', async () => {
  const a = await freshProject(owner, 'sa'); const b = await freshProject(owner, 'sb');
  const regA = await registerSandbox(owner, a, db.revalReaderRole);
  const reader2 = `atlas_rv2_${randomBytes(4).toString('hex')}`; const pw = randomBytes(18).toString('hex');
  await owner.query(`CREATE ROLE "${reader2}" LOGIN NOINHERIT PASSWORD '${pw}'`);
  await owner.query(`GRANT EXECUTE ON FUNCTION public.atlas_reval_snapshot() TO "${reader2}"`); // test-only second reader
  try {
    const regB = await registerSandbox(owner, b, reader2);
    const u = new URL(db.ownerUrl); u.username = reader2; u.password = pw;
    const r2 = await connect(u.toString());
    try {
      const wa = await snap(); const wb = await snap(r2);
      assert.equal(wa.registrationId, regA.registrationId); assert.equal(s(wa).admissionId, a.admissionId);
      assert.equal(wb.registrationId, regB.registrationId); assert.equal(s(wb).admissionId, b.admissionId);
      // Stale/foreign scope settings set by the caller before the call cannot redirect or widen it.
      await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await reader.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true)`, [b.ws, b.client]);
      const stale = decodeWrapper((await reader.query('SELECT public.atlas_reval_snapshot() AS w')).rows[0].w);
      await reader.query('COMMIT');
      assert.equal(stale.registrationId, regA.registrationId);
      assert.equal(await code(snapshotAs(r2, 'READ COMMITTED')), 'RV002', 'READ COMMITTED refused');
      assert.equal(await code(snapshotAs(r2, 'REPEATABLE READ READ WRITE')), 'RV002', 'READ WRITE refused');
      await r2.query(`SET ROLE "${reader2}"`);
      assert.equal(await code(snapshotAs(r2)), 'RV002', 'SET ROLE (even to itself) refused');
    } finally { await r2.end(); }
    // Dropped and recreated login: same name, new OID → no registration.
    await owner.query(`REVOKE EXECUTE ON FUNCTION public.atlas_reval_snapshot() FROM "${reader2}"`); await owner.query(`DROP ROLE "${reader2}"`);
    await owner.query(`CREATE ROLE "${reader2}" LOGIN NOINHERIT PASSWORD '${pw}'`);
    await owner.query(`GRANT EXECUTE ON FUNCTION public.atlas_reval_snapshot() TO "${reader2}"`);
    const r3 = await connect(u.toString());
    try { assert.equal(await code(snapshotAs(r3)), 'RV001'); } finally { await r3.end(); }
  } finally {
    await owner.query(`REVOKE EXECUTE ON FUNCTION public.atlas_reval_snapshot() FROM "${reader2}"`).catch(() => undefined);
    await owner.query(`DROP ROLE IF EXISTS "${reader2}"`).catch(() => undefined);
  }
});

const fresh = async (label: string, extraClient = false) => {
  const p = await freshProject(owner, label);
  if (extraClient) { await owner.query(`INSERT INTO "Client" ("workspaceId", id, name) VALUES ($1, $2, 'other')`, [p.ws, `${p.client}-o`]);
    await owner.query(`INSERT INTO "Actor" ("workspaceId", id, "displayName") VALUES ($1, $2, 'other')`, [p.ws, `${p.actor}-o`]);
    await setClient(owner, p.ws, `${p.client}-o`, true); }
  const reg = await registerSandbox(owner, p, db.revalReaderRole);
  return { p, reg };
};
// Each case below re-registers the single reader (one registration per reader OID): clear the previous one first.
async function useOnly(ws: string) {
  await owner.query(`ALTER TABLE "RevalFixtureBinding" DISABLE TRIGGER "RevalFixtureBinding_guard"`);
  await owner.query(`ALTER TABLE "RevalSandboxRegistration" DISABLE TRIGGER "RevalSandboxRegistration_guard"`);
  try {
    await owner.query(`DELETE FROM "RevalFixtureBinding" WHERE "workspaceId" <> $1`, [ws]);
    await owner.query(`DELETE FROM "RevalSandboxRegistration" WHERE "workspaceId" <> $1`, [ws]);
  } finally {
    await owner.query(`ALTER TABLE "RevalFixtureBinding" ENABLE ALWAYS TRIGGER "RevalFixtureBinding_guard"`);
    await owner.query(`ALTER TABLE "RevalSandboxRegistration" ENABLE ALWAYS TRIGGER "RevalSandboxRegistration_guard"`);
  }
}

test('full-project census: foreign client/actor counted without IDs, original periods, late settlement, current-period zero, pricing tuples, exact export', async () => {
  await useOnly('none');
  const { p } = await fresh('cen', true);
  await syntheticLedger(owner, db.remoteRole, p, [
    { createdAt: '2026-08-31T23:59:59.9996Z', clientId: p.client, actorId: p.actor, outcome: 'NO_DISPATCH' },
    { createdAt: '2026-09-01T00:00:00.000Z', clientId: p.client, actorId: p.actor, outcome: 'EGRESS' },
    { createdAt: '2026-09-01T10:00:00.000Z', clientId: `${p.client}-o`, actorId: p.actor, outcome: 'NO_DISPATCH' },
    { createdAt: '2026-09-02T10:00:00.000Z', clientId: p.client, actorId: `${p.actor}-o`, outcome: 'NO_DISPATCH' }], PRICE);
  const w = await snap(); const x = s(w);
  assert.equal(x.projectAttemptCount, '4'); assert.equal(x.foreignScopeAttemptCount, '2'); assert.equal(x.attempts.length, 2);
  assert.equal(x.attempts[0].createdAt, '2026-08-31T23:59:59.999Z', 'truncated, never rounded into the next day'); assert.equal(x.attempts[0].dayStart, '2026-08-31');
  const periods = x.periods.map((q: any) => `${q.kind}:${q.periodStart}:${q.chargedMicroUsd}:${q.attemptCount}`);
  assert.ok(periods.includes('MONTH:2026-08-01:0:1') && periods.includes('MONTH:2026-09-01:300000:3') && periods.includes('DAY:2026-09-01:300000:2'), periods.join(' '));
  assert.ok(periods.some((q: string) => q.startsWith(`DAY:${x.currentDay}:0:0`)), 'current day synthesized zero');
  assert.equal(x.consistent, true);
  assert.deepEqual(w.pricing.attempts.length, 1);
  const exported = exportSnapshot(w, PRICE);
  assert.doesNotThrow(() => decodeSnapshot(exported));
  const text = JSON.stringify(exported);
  for (const forbidden of ['fixture://', 'synthetic-owner-approval', 'synthetic-retention-attestation', p.project, `${p.client}-o`, PRICE, 'promptRate']) {
    assert.ok(!text.includes(forbidden), forbidden);
  }
  // Late settlement keeps the ORIGINAL period: settle an attempt reserved now, the census keeps today's buckets.
  const rt = await connectAs(db.runtimeUrl);
  try {
    const a = await reserveOnce(rt, p.ws, p.client, { admissionId: p.admissionId, policyVersion: x.policyVersion }, { actor: p.actor });
    await settleOnce(rt, p.ws, p.client, a, 'NO_DISPATCH');
    const y = s(await snap());
    assert.equal(y.projectAttemptCount, '5'); assert.equal(y.consistent, true);
  } finally { await rt.end(); }
  // A historical attempt price differs from the approved expectation → POLICY_CHANGED (pricing is all-project).
  await syntheticLedger(owner, db.remoteRole, p, [{ createdAt: '2026-07-01T00:00:00.000Z', clientId: p.client, actorId: p.actor, outcome: 'NO_DISPATCH', priceRevision: 'price-historical' }], PRICE);
  assert.throws(() => exportSnapshot(w, 'price-other'), (e: ReaderFailure) => e.code === 'POLICY_CHANGED', 'policy ≠ owner-approved expectation');
  const z = await snap();
  assert.throws(() => exportSnapshot(z, PRICE), (e: ReaderFailure) => e.code === 'POLICY_CHANGED', 'historical attempt price');
});

test('integrity: missing referenced counter refuses (RV006), orphan nonzero counter and counter≠sum export consistent:false with actual values', async () => {
  await useOnly('none');
  const { p } = await fresh('int');
  await syntheticLedger(owner, db.remoteRole, p, [{ createdAt: '2026-09-05T10:00:00.000Z', clientId: p.client, actorId: p.actor, outcome: 'EGRESS' }], PRICE);
  // Disposable DB, superuser only: disable the deferred ledger invariant to plant inconsistencies the routine must detect itself.
  await owner.query(`ALTER TABLE "RemoteAskPeriodCounter" DISABLE TRIGGER "RemoteAskPeriodCounter_ledger"`);
  await owner.query(`ALTER TABLE "RemoteAskPeriodCounter" DISABLE TRIGGER "RemoteAskPeriodCounter_guard"`);
  try {
    await owner.query(`UPDATE "RemoteAskPeriodCounter" SET "chargedMicroUsd" = 1 WHERE "workspaceId" = $1 AND kind = 'DAY'`, [p.ws]);
    let x = s(await snap());
    assert.equal(x.consistent, false, 'counter ≠ sum'); assert.ok(x.periods.some((q: any) => q.chargedMicroUsd === '1'), 'actual counter value exported');
    await owner.query(`UPDATE "RemoteAskPeriodCounter" SET "chargedMicroUsd" = 300000 WHERE "workspaceId" = $1 AND kind = 'DAY'`, [p.ws]);
    await owner.query(`INSERT INTO "RemoteAskPeriodCounter" ("workspaceId", "projectIdentity", kind, "periodStart", "chargedMicroUsd") VALUES ($1, $2, 'DAY', '2026-01-02', 5)`, [p.ws, p.project]);
    x = s(await snap());
    assert.equal(x.consistent, false, 'orphan nonzero counter');
    assert.ok(!x.periods.some((q: any) => q.periodStart === '2026-01-02'), 'orphans are checked and bounded, not exported');
    await owner.query(`DELETE FROM "RemoteAskPeriodCounter" WHERE "workspaceId" = $1 AND "periodStart" = '2026-01-02'`, [p.ws]);
    await owner.query(`DELETE FROM "RemoteAskPeriodCounter" WHERE "workspaceId" = $1 AND kind = 'DAY' AND "periodStart" = '2026-09-05'`, [p.ws]);
    assert.equal(await code(snapshotAs(reader)), 'RV006', 'missing counter of a referenced period: refusal, never zero-filled');
    await owner.query(`INSERT INTO "RemoteAskPeriodCounter" ("workspaceId", "projectIdentity", kind, "periodStart", "chargedMicroUsd") VALUES ($1, $2, 'DAY', '2026-09-05', 300000)`, [p.ws, p.project]);
    assert.equal(s(await snap()).consistent, true);
    // Orphan rows count toward the 2000-row bound.
    await owner.query(`INSERT INTO "RemoteAskPeriodCounter" ("workspaceId", "projectIdentity", kind, "periodStart") SELECT $1, $2, 'DAY', d::date
      FROM generate_series('2000-01-01'::date, '2000-01-01'::date + 1999, interval '1 day') d`, [p.ws, p.project]);
    assert.equal(await code(snapshotAs(reader)), 'RV003');
    await owner.query(`DELETE FROM "RemoteAskPeriodCounter" WHERE "workspaceId" = $1 AND "periodStart" < '2010-01-01'`, [p.ws]);
  } finally {
    await owner.query(`ALTER TABLE "RemoteAskPeriodCounter" ENABLE ALWAYS TRIGGER "RemoteAskPeriodCounter_guard"`);
    await owner.query(`ALTER TABLE "RemoteAskPeriodCounter" ENABLE ALWAYS TRIGGER "RemoteAskPeriodCounter_ledger"`);
  }
});

test('bounds: 1001 attempts → RV003; a complete census over the 256 KiB envelope is CENSUS_LIMIT_EXCEEDED, never truncated', async () => {
  await useOnly('none');
  const { p } = await fresh('big');
  const rows = Array.from({ length: 700 }, (_, i) => ({ createdAt: new Date(Date.UTC(2025, 0, 1) + i * 3_600_000).toISOString(), clientId: p.client, actorId: p.actor, outcome: 'NO_DISPATCH' as const }));
  await syntheticLedger(owner, db.remoteRole, p, rows, PRICE);
  const w = await snap();
  assert.equal((w.snapshot as { attempts: unknown[] }).attempts.length, 700, 'the routine returns the COMPLETE census (within its 1000 bound)');
  // Reader-level cap (deterministic, worst-case envelope): the export refuses, never truncates; the reread uses the same measure.
  assert.equal(snapshotFitsEnvelope(w), false);
  assert.throws(() => exportSnapshot(w, PRICE), (e: ReaderFailure) => e.code === 'CENSUS_LIMIT_EXCEEDED');
  const { snapshotId: _s, ...rest } = { snapshotId: randomUUID(), ...(w.snapshot as Record<string, unknown>) }; void _s;
  assert.throws(() => encodeFrame(buildResponse({ registrationId: randomUUID(), serverBootId: randomUUID(), connectionId: randomUUID() }, { challenge: randomUUID(), sequence: '1' },
    '1', 'CONTROLLER', randomUUID(), 'SNAPSHOT', { snapshotId: randomUUID(), ...rest }, '2026-10-11T00:00:00.000Z'), METADATA_FRAME_CAP), (e: FrameError) => e.code === 'FRAME_TOO_LARGE',
    'control: the real 700-row census does exceed the 06 frame cap');
  await syntheticLedger(owner, db.remoteRole, p, Array.from({ length: 301 }, (_, i) => ({ createdAt: new Date(Date.UTC(2024, 0, 1) + i * 3_600_000).toISOString(),
    clientId: p.client, actorId: p.actor, outcome: 'NO_DISPATCH' as const })), PRICE);
  assert.equal(await code(snapshotAs(reader)), 'RV003', '1001 project attempts');
});

test('pricing tuples through the actual confined definer (Opus RC1 F3.4): exactly 8 distinct project tuples are reported; a 9th → RV004 (no partial census)', async () => {
  await useOnly('none');
  const { p } = await fresh('tuples');
  const row = (i: number, rev: string) => ({ createdAt: new Date(Date.UTC(2025, 0, 1) + i * 3_600_000).toISOString(), clientId: p.client, actorId: p.actor,
    outcome: 'NO_DISPATCH' as const, priceRevision: rev });
  await syntheticLedger(owner, db.remoteRole, p, Array.from({ length: 8 }, (_, i) => row(i, `price-tuple-${i}`)), PRICE);
  const w = await snap();
  assert.equal(w.pricing.attempts.length, 8, 'control: 8 distinct tuples are within the bound');
  await syntheticLedger(owner, db.remoteRole, p, [row(100, 'price-tuple-8')], PRICE);
  assert.equal(await code(snapshotAs(reader)), 'RV004', 'a 9th distinct tuple refuses the whole snapshot');
});

test('timeout under an ACCESS EXCLUSIVE lock is CENSUS_UNAVAILABLE within the budget; concurrent writes never split one snapshot', async () => {
  await useOnly('none');
  const { p } = await fresh('cc');
  const blocker = await connect(db.ownerUrl);
  try {
    await blocker.query('BEGIN'); await blocker.query(`LOCK TABLE "RemoteAskAttempt" IN ACCESS EXCLUSIVE MODE`);
    const t0 = performance.now();
    await assert.rejects(readSnapshotWrapper(reader as never, performance.now() + 1750, () => performance.now()), (e: ReaderFailure) => e.code === 'CENSUS_UNAVAILABLE');
    assert.ok(performance.now() - t0 < 1800, 'answered within the C budget');
    await blocker.query('ROLLBACK');
  } finally { await blocker.end(); }
  const r = await connect(db.revalReaderUrl); const rt = await connectAs(db.runtimeUrl);
  try {
    await r.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const first = (await r.query('SELECT public.atlas_reval_snapshot() AS w')).rows[0].w;
    const a = await reserveOnce(rt, p.ws, p.client, p, { actor: p.actor }); await settleOnce(rt, p.ws, p.client, a, 'NO_DISPATCH');
    await pauseOnce(rt, p.ws, p.admissionId);
    const second = (await r.query('SELECT public.atlas_reval_snapshot() AS w')).rows[0].w;
    await r.query('COMMIT');
    const strip = (x: any) => ({ ...x.snapshot, dbObservedAt: '' });
    assert.deepEqual(strip(second), strip(first), 'one transaction = one snapshot (reserve/settle/pause invisible)');
    const after = s(await snap(r));
    assert.equal(after.projectAttemptCount, String(Number(first.snapshot.projectAttemptCount) + 1)); assert.equal(after.policyState, 'PAUSED');
    // The VOLATILE split-read counterexample under READ COMMITTED: two reads straddling a write disagree, so RC is refused.
    await r.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await r.query(`SELECT 1`);
    assert.equal(await code(r.query('SELECT public.atlas_reval_snapshot()')), 'RV002');
    await r.query('ROLLBACK');
  } finally { await r.end(); await rt.end(); }
});

test('missing binding → RV005; pg_temp shadows of every referenced relation cannot redirect the definer', async () => {
  await useOnly('none');
  const { p, reg } = await fresh('tmp');
  const before = s(await snap());
  const shadow = await connect(db.revalReaderUrl);
  try {
    for (const t of ['RevalSandboxRegistration', 'RevalFixtureBinding', 'RemoteAskPolicy', 'RemoteAskAttempt', 'RemoteAskPeriodCounter', 'RemoteAskClientAdmission', 'ActionAuthorityFence']) {
      await shadow.query(`CREATE TEMP TABLE "${t}" (x int)`);
    }
    await shadow.query(`CREATE FUNCTION pg_temp.count(anyelement) RETURNS bigint LANGUAGE sql AS 'SELECT 999::bigint'`);
    const w = s(decodeWrapper(await snapshotAs(shadow)));
    assert.deepEqual({ ...w, dbObservedAt: '' }, { ...before, dbObservedAt: '' });
  } finally { await shadow.end(); }
  await owner.query(`ALTER TABLE "RevalFixtureBinding" DISABLE TRIGGER "RevalFixtureBinding_guard"`);
  try { await owner.query(`DELETE FROM "RevalFixtureBinding" WHERE "registrationId" = $1`, [reg.registrationId]); }
  finally { await owner.query(`ALTER TABLE "RevalFixtureBinding" ENABLE ALWAYS TRIGGER "RevalFixtureBinding_guard"`); }
  assert.equal(await code(snapshotAs(reader)), 'RV005');
  void p;
});

test('registered client without its RemoteAskClientAdmission row → RV001 (admission row removed afterwards: FK bypass in replica mode by the superuser owner)', async () => {
  await useOnly('none');
  const p = await freshProject(owner, 'noadm');
  // The ALWAYS Reval guard refuses registering a client without its admission row even in replica mode, so the state is
  // planted the other way round: a valid registration, then its admission row removed with the FK (RESTRICT) bypassed.
  await registerSandbox(owner, p, db.revalReaderRole);
  const modes = (await owner.query(`SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = '"RemoteAskClientAdmission"'::regclass AND NOT tgisinternal`)).rows;
  await owner.query('BEGIN');
  try {
    await owner.query(`SET LOCAL session_replication_role = replica`);
    await owner.query(`ALTER TABLE "RemoteAskClientAdmission" DISABLE TRIGGER USER`);
    await owner.query(`SELECT set_config('app.workspace_id', $1, true)`, [p.ws]);
    await owner.query(`DELETE FROM "RemoteAskClientAdmission" WHERE "workspaceId" = $1 AND "clientId" = $2`, [p.ws, p.client]);
    for (const m of modes) await owner.query(`ALTER TABLE "RemoteAskClientAdmission" ENABLE ${m.tgenabled === 'A' ? 'ALWAYS' : m.tgenabled === 'R' ? 'REPLICA' : ''} TRIGGER "${m.tgname}"`);
    await owner.query('COMMIT');
  } catch (e) { await owner.query('ROLLBACK'); throw e; }
  assert.deepEqual((await owner.query(`SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = '"RemoteAskClientAdmission"'::regclass AND NOT tgisinternal`)).rows, modes);
  assert.equal(await code(snapshotAs(reader)), 'RV001');
});
