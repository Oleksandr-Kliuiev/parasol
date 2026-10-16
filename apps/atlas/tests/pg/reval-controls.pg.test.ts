import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { readSnapshotWrapper, wrapperBound } from '../../packages/reval/snapshot-reader.ts';
import { activate, connectAs, ownerScoped, pauseOnce, PRICE, reserveOnce, revise, settleOnce } from '../support/ask-remote-pg.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { closureHarness } from '../support/reval-closure-harness.ts';
import type { Setup } from '../support/reval-closure-harness.ts';
import { registerSandbox, syntheticLedger } from '../support/reval-pg.ts';
import { nonsuperDatabase } from '../support/reval-nonsuper.ts';

// R-EVAL RS-A isolated PAUSE_EXPORT controls on PostgreSQL 17 (Sol RC1 R3/R4, Opus RC1 F1/F2/F3.2/F3.3): the REAL E child and
// peer proof, the controller's pauseExport with its byte-capped reread, and the dedicated NOSUPERUSER NOBYPASSRLS table owner.
// Each case changes ONE thing against a valid control path and asserts no lock/revise, no closure and the exact latch rule.
const darwin = process.platform === 'darwin' && process.arch === 'arm64';
const n = await nonsuperDatabase();
const { db, admin } = n; const owner = db.owner;
const h = darwin ? await closureHarness(n) : null;
const other = await createTestDatabase();
after(async () => { await h?.close(); await other.drop(); await n.cleanup(); });
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e: { code?: string }) => e.code ?? String(e));
// Scoped to THIS test database: other PG test files run executors of their own in parallel on the shared Docker cluster.
const ownerBackends = async () => Number((await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND application_name = 'atlas-reval-e-owner'`, [db.name])).rows[0].n);
const noBackendWithin = async (ms: number) => { const t = Date.now(); while (await ownerBackends() > 0 && Date.now() - t < ms) await new Promise(r => setTimeout(r, 50)); return await ownerBackends() === 0; };
const version = async (s: Setup) => String((await s.policy()).policyVersion);
const skip = { skip: !darwin && 'needs the Darwin peer proof' };

test('E against ANOTHER physical database holding the copied registration/instance/workspace/client/actor/admission UUIDs → REFUSED REGISTRATION_MISMATCH before any statement; the control reader is valid', skip, async () => {
  const s = await h!.setup('cp', { test: { execDatabase: other.name } });
  // Copy the logical identity exactly into the other ready database (its own superuser owner, trusted routines only).
  await other.owner.query(`INSERT INTO "Workspace" (id, name) VALUES ($1, 'copy')`, [s.p.ws]);
  await other.owner.query(`INSERT INTO "Client" ("workspaceId", id, name) VALUES ($1, $2, 'C')`, [s.p.ws, s.p.client]);
  await other.owner.query(`INSERT INTO "Actor" ("workspaceId", id, "displayName") VALUES ($1, $2, 'A')`, [s.p.ws, s.p.actor]);
  await activate(other.owner, s.p.ws, [s.p.client], { admissionId: s.p.admissionId });
  await registerSandbox(other.owner, { ...s.p }, other.revalReaderRole, { registrationId: s.reg.registrationId, databaseInstanceId: s.reg.databaseInstanceId });
  const copied = await ownerScoped(other.owner, s.p.ws, async () => (await other.owner.query(`SELECT 1 FROM "RevalSandboxRegistration" WHERE "registrationId" = $1
    AND "databaseInstanceId" = $2 AND "clientId" = $3 AND "actorId" = $4 AND "admissionId" = $5`, [s.reg.registrationId, s.reg.databaseInstanceId, s.p.client, s.p.actor, s.p.admissionId])).rows.length);
  assert.equal(copied, 1, 'the other database WOULD pass the logical registration read: only the physical tuple can refuse');
  const w = await readSnapshotWrapper(h!.reader as never, performance.now() + 1500, () => performance.now());
  assert.ok(wrapperBound(w, { ...s.ctx.config, buildManifestSha256: w.buildManifestSha256 }), 'control: the reader is correctly bound to the real database');
  const before = await s.policy(); const f = await s.fence();
  const otherBefore = await ownerScoped(other.owner, s.p.ws, async () => (await other.owner.query(`SELECT to_jsonb(p) AS j FROM "RemoteAskPolicy" p`)).rows[0].j);
  const r = await s.pause(await version(s));
  assert.deepEqual(r.d, { kind: 'FAILURE', code: 'REGISTRATION_MISMATCH', latch: false });
  assert.deepEqual(await s.captured(), [], 'no statement at all: no lock, no revise');
  assert.deepEqual([await s.policy(), await s.fence()], [before, f], 'the real policy is untouched');
  assert.deepEqual(await ownerScoped(other.owner, s.p.ws, async () => (await other.owner.query(`SELECT to_jsonb(p) AS j FROM "RemoteAskPolicy" p`)).rows[0].j), otherBefore,
    'the other database is untouched');
  assert.deepEqual([s.ctx.spawns, s.ctx.latched, r.reaped], [1, false, true]);
});

test('E with a WRONG owner password on the real database → REFUSED OWNER_REQUIRED (28P01 kept): no lock/revise/closure/latch, one spawn, bounded cleanup', skip, async () => {
  const s = await h!.setup('wp', { ownerPassword: 'WrongOwnerPassword0000000' });
  const before = await s.policy(); const f = await s.fence();
  const r = await s.pause(await version(s));
  assert.deepEqual(r.d, { kind: 'FAILURE', code: 'OWNER_REQUIRED', latch: false });
  assert.deepEqual(await s.captured(), []);
  assert.deepEqual([await s.policy(), await s.fence()], [before, f]);
  assert.deepEqual([s.ctx.spawns, s.ctx.latched, r.reaped], [1, false, true]); assert.ok(r.elapsed < 1800, String(r.elapsed));
  assert.ok(await noBackendWithin(1500));
  const again = await s.pause(await version(s));
  assert.deepEqual([again.d, s.ctx.spawns], [{ kind: 'FAILURE', code: 'OWNER_REQUIRED', latch: false }, 2], 'no latch: the next PAUSE_EXPORT spawns again');
});

test('TOMBSTONE pre-state → refused without calling the routine; already-PAUSED NO-OP with NONZERO microseconds: whole row identical, confirmed COMMIT', skip, async () => {
  const t = await h!.setup('tb');
  // TOMBSTONE is reached only by version exhaustion: max−1 planted (owner, guard trigger modes restored exactly), then a revision.
  const modes = (await admin.query(`SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = '"RemoteAskPolicy"'::regclass AND NOT tgisinternal`)).rows;
  await ownerScoped(owner, t.p.ws, async () => { await owner.query(`ALTER TABLE "RemoteAskPolicy" DISABLE TRIGGER USER`);
    await owner.query(`UPDATE "RemoteAskPolicy" SET "policyVersion" = 9223372036854775806`);
    for (const m of modes) await owner.query(`ALTER TABLE "RemoteAskPolicy" ENABLE ${m.tgenabled === 'A' ? 'ALWAYS' : ''} TRIGGER "${m.tgname}"`); });
  assert.deepEqual((await admin.query(`SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = '"RemoteAskPolicy"'::regclass AND NOT tgisinternal`)).rows, modes);
  await revise(owner, t.p.ws, { state: 'PAUSED' });
  assert.equal((await t.policy()).state, 'TOMBSTONE');
  const tb = await t.policy();
  // The exact Dec64 text (to_jsonb → JS Number would lose precision at the maximum).
  const tr = await t.pause(await ownerScoped(owner, t.p.ws, async () => (await owner.query(`SELECT "policyVersion"::text AS v FROM "RemoteAskPolicy"`)).rows[0].v as string));
  assert.deepEqual(tr.d, { kind: 'FAILURE', code: 'CONTAINMENT_UNCONFIRMED', latch: false });
  assert.ok(!(await t.captured()).some(x => x.sql === 'REVISE'), 'no call'); assert.deepEqual(await t.policy(), tb);
  const s = await h!.setup('nu');
  await revise(owner, s.p.ws, { expiresAt: new Date(Date.now() + 3_600_000).toISOString().replace(/\.(\d{3})Z$/, '.$1789Z') });
  const rt = await connectAs(db.runtimeUrl);
  try { await pauseOnce(rt, s.p.ws, s.p.admissionId, 'MODEL_MISMATCH'); } finally { await rt.end(); }
  const before = await s.policy(); const f = await s.fence(); const v = String(before.policyVersion);
  assert.match(String(before.expiresAt), /\.\d{3}789/, 'nonzero microseconds planted on the already-PAUSED row');
  const r = await s.pause(v, [String(BigInt(v) - 1n), String(BigInt(f) - 1n)]);
  assert.deepEqual(r.d, { kind: 'CLOSURE', closure: { admissionId: s.p.admissionId, paused: true, policyVersion: v, fenceEpoch: f } });
  assert.deepEqual(await s.policy(), before, 'whole row identical, microseconds included');
  const cap = (await s.captured()).map(x => x.sql);
  assert.ok(cap.includes('REVISE') && cap.at(-1) === 'COMMIT', `routine called, then a confirmed COMMIT: ${cap.join(' | ')}`);
});

test('over-cap census at the reread AFTER a confirmed commit → CONTAINMENT_UNCONFIRMED + latch (no closure, no truncation); a small census closes', skip, async () => {
  const s = await h!.setup('ov');
  const rows = Array.from({ length: 700 }, (_, i) => ({ createdAt: new Date(Date.UTC(2025, 0, 1) + i * 3_600_000).toISOString(), clientId: s.p.client, actorId: s.p.actor,
    outcome: 'NO_DISPATCH' as const }));
  await syntheticLedger(admin, db.remoteRole, s.p, rows, PRICE);
  const v = await version(s);
  const r = await s.pause(v);
  assert.deepEqual(r.d, { kind: 'FAILURE', code: 'CONTAINMENT_UNCONFIRMED', latch: true });
  assert.deepEqual([(await s.policy()).state, String((await s.policy()).policyVersion)], ['PAUSED', String(BigInt(v) + 1n)], 'the commit happened; still no closure');
  assert.ok(s.ctx.latched);
  const c = await h!.setup('ok');
  await syntheticLedger(admin, db.remoteRole, c.p, rows.slice(0, 10).map(r => ({ ...r, clientId: c.p.client, actorId: c.p.actor })), PRICE);
  assert.equal((await c.pause(await version(c))).d.kind, 'CLOSURE', 'control: the same path with a small census closes');
});

/**
 * Waits until E (of THIS test database) HOLDS the fence: idle in transaction during the test-only sleep that follows its fence (then policy) FOR UPDATE
 * — its last statement is that FOR UPDATE. (Merely "idle in transaction" also matches the gaps between E's earlier statements,
 * before any lock: a concurrent reserve could then legitimately serialize BEFORE E.)
 */
async function eHoldsLocks(ms = 2000): Promise<boolean> {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if ((await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND application_name = 'atlas-reval-e-owner' AND state = 'idle in transaction'
      AND query LIKE '%FOR UPDATE%'`, [db.name])).rows[0].n > 0) return true;
    await new Promise(r => setTimeout(r, 10));
  }
  return false;
}
test('concurrent reserve / revoke / settle against an in-flight E: reserve and revoke wait for its commit and are refused; settle proceeds; the closure stays exact', skip, async () => {
  for (const kind of ['reserve', 'revoke', 'settle'] as const) {
    const s = await h!.setup(`cc${kind}`, { hooks: { sleepInTxMs: 350 } });
    const rt = await connectAs(db.runtimeUrl); const own = new pg.Client({ connectionString: n.ownerUrl }); await own.connect();
    try {
      const pending = kind === 'settle' ? await reserveOnce(rt, s.p.ws, s.p.client, s.p, { actor: s.p.actor }) : null;
      const v = await version(s); const f = await s.fence();
      const running = s.pause(v);
      assert.ok(await eHoldsLocks(), `${kind}: E holds the fence`);
      const t = performance.now();
      const result = await (kind === 'reserve' ? code(reserveOnce(rt, s.p.ws, s.p.client, { admissionId: s.p.admissionId, policyVersion: v }, { actor: s.p.actor }))
        : kind === 'revoke' ? code(revise(own, s.p.ws, { state: 'REVOKED' }, v))
        : code(settleOnce(rt, s.p.ws, s.p.client, pending!, 'NO_DISPATCH')));
      const waited = performance.now() - t; const eStill = await eHoldsLocks(1);
      const { d } = await running;
      assert.deepEqual(d, { kind: 'CLOSURE', closure: { admissionId: s.p.admissionId, paused: true, policyVersion: String(BigInt(v) + 1n), fenceEpoch: String(BigInt(f) + 1n) } }, kind);
      if (kind === 'settle') { assert.equal(result, 'OK', 'settle needs neither fence nor policy lock'); assert.ok(eStill || waited < 300, `${kind}: not serialized behind E`); }
      else { assert.notEqual(result, 'OK', `${kind} refused after E's commit`); assert.ok(waited > 100, `${kind} waited for E (${waited.toFixed(0)} ms)`); }
      const p = await s.policy();
      assert.deepEqual([p.state, String(p.policyVersion)], ['PAUSED', String(BigInt(v) + 1n)], `${kind}: the closure's tuple is the current one`);
    } finally { await rt.end(); await own.end(); }
  }
});
