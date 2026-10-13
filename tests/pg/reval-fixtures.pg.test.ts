import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { AskPhase, phaseSql } from '../../packages/ask/phase.ts';
import { readDbSource } from '../../packages/ask/read.ts';
import { FIXTURE_IDS } from '../../packages/reval/dataset.ts';
import { verifyFixture } from '../../packages/reval/fixture-verify.ts';
import { rawTransaction } from '../../packages/reval/pg-tx.ts';
import { registerSandbox } from '../../packages/reval/register.ts';
import { buildSource } from '../../scripts/ask-remote-eval/fixtures.ts';
import { nonsuperDatabase } from '../support/reval-nonsuper.ts';
import { CLIENT, WS, dataset, install, pidOf, provisionSandbox, q, registration, runtimeClient, state } from '../support/reval-fixture-pg.ts';

// R-EVAL RS-B on PostgreSQL 17 (rs-b brief §2/§3, 05 "Fixtures" and "Clock isolation"): a NON-superuser table owner (FORCE
// RLS applies to it) registers the sandbox and installs every frozen fixture through the REAL fence-first switch; after each
// switch the verifier proves DB = fixture under the confined runtime role with no bearer — row identity, the accepted source
// read with the pinned reference, the bank/coverage/urgency/entity facts and all five intents against the independent
// predicates. FX04's declared agent↔PERSON CANDIDATE link (unrepresentable under the accepted EntityLink_type_compat_check)
// is materialized through the owner-approved exact mapping exception (rc2, B1) as contact↔PERSON; the reader never selects
// it. The ordinary real-clock read of the same rows is
// probed as an explicit negative. Synthetic data only.
const ns = await nonsuperDatabase();
await ns.admin.end(); // no extra backend on the sandbox: the census admits only the maintenance connection
const { db } = ns; const owner = db.owner;
after(async () => { await ns.cleanup(); });
const { admissionId } = await provisionSandbox(owner);
const r = registration(admissionId, db.revalReaderRole);
const pid = await pidOf(owner);

test('register, then every frozen fixture through the real switch: 11 × 5 proven under the runtime role', async () => {
  await registerSandbox(q(owner), r, [pid]);
  let gen = '0';
  const evidence: string[] = [];
  for (const id of FIXTURE_IDS) {
    const before = await state(owner, r);
    const res = await install(owner, r, id, gen, [pid]);
    assert.equal(res.generation, String(BigInt(gen) + 1n)); assert.equal(res.fixtureId, id);
    assert.equal(res.fenceAdvanced, true, 'the Connection fence triggers keep their increments');
    assert.ok(BigInt((await state(owner, r)).fence) > BigInt(before.fence));
    gen = res.generation;
    const after1 = await state(owner, r);
    assert.equal(after1.preserved, before.preserved, `${id}: finance/audit/identity/history untouched`);
    const rt = await runtimeClient(db.runtimeUrl);
    try {
      const v = await verifyFixture(q(rt), { ...r, fixtureId: id, fixtureGeneration: gen }, 1500);
      assert.deepEqual(v, { kind: 'CHECKED', rowIdentity: true, sourceProjection: true, expectedFacts: true, allFiveIntents: true }, id);
      // A stale generation never verifies another fixture.
      assert.deepEqual(await verifyFixture(q(rt), { ...r, fixtureId: id, fixtureGeneration: String(BigInt(gen) + 1n) }, 1500), { kind: 'REFUSED', code: 'FIXTURE_MISMATCH' });
    } finally { await rt.end(); }
    evidence.push(`${id}:g${gen}:ALL_TRUE`);
  }
  assert.equal(gen, '11');
  console.log(`# REVAL_EVIDENCE fixtures ${evidence.join(' ')}`);
});

test('clock isolation: the same DB rows read with the REAL clock no longer equal the frozen OK/STALE declarations (explicit negative)', async () => {
  const mismatched: string[] = []; const equal: string[] = [];
  let gen = (await state(owner, r)).gen!;
  for (const id of FIXTURE_IDS) {
    const res = await install(owner, r, id, gen, [pid]); gen = res.generation;
    const spec = dataset.byId.get(id)!;
    const rt = await runtimeClient(db.runtimeUrl);
    try {
      await rt.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await rt.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true)`, [WS, CLIENT]);
      const now = new Date((await rt.query('SELECT clock_timestamp() AS t')).rows[0].t as Date);
      const source = await readDbSource(phaseSql(rawTransaction(q(rt)), new AskPhase({ check() {} }, 2000)), { workspaceId: WS, clientId: CLIENT }, spec.requestedFocus, now);
      await rt.query('COMMIT');
      const declared = buildSource(spec, dataset.file.scope).source;
      const real = JSON.stringify(source.resources); const want = JSON.stringify(declared.resources);
      const hasOk = declared.resources.some(x => x.status === 'OK');
      (real === want ? equal : mismatched).push(id);
      assert.equal(real === want, !hasOk, `${id}: real-clock projection differs exactly when the frozen fixture declares an OK resource`);
    } finally { await rt.end(); }
  }
  console.log(`# REVAL_EVIDENCE real-clock negative: mismatched ${mismatched.join(',')} equal ${equal.join(',')} (FX08 07:20 vs 07:58 limitation reported, not repaired)`);
  assert.ok(mismatched.length >= 8);
});
