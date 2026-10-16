import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bindCorpus } from '../../scripts/ask-remote-eval-execution/corpus.ts';
import { verifyRevision } from '../../scripts/reval-instrument/identity.ts';
import { withGroupedOrder } from '../../scripts/reval-instrument/order.ts';
import { assertReceiptV6 } from '../../scripts/reval-instrument/receipt.ts';
import { revise } from '../support/ask-remote-pg.ts';
import { LiveOwner } from '../support/reval-eval-process.ts';
import { CLIENT, WS } from '../support/reval-fixture-pg.ts';
import { LiveTty } from '../support/reval-live-tty.ts';
import { kv, segmentHarness } from '../support/reval-segment-harness.ts';
import { privateDir, writePrivate } from '../support/reval-test-deps.ts';

// R-EVAL RS-D-C integrated offline rehearsal (05 row RS-D; rs-d brief C §1.8; owner decisions D1/D2) on darwin/arm64: O (live PTY) → C →
// S (BUILT bridge server under the pinned profile, the accepted OFFLINE scripted provider seam — no key, no network) and the REAL
// instrument code under a live PTY follow the WHOLE fixture-grouped order: all 200 frozen cases (incl. the 15 FX10 MISSING) in 11
// segments with ONE S incarnation. Proofs before the first GO, after every segment and at the end; at each of the 10 boundaries: GO
// refused without closure and without DRAIN (nothing consumed) → the owner's pause-export closure → DRAIN QUIESCENT (instrument and
// owner, with C's process inventory) → END_PAIR → the maintenance switch with S/C up (D2) → FIXTURE_CHECK → manual resume → re-PAIR; and at
// least one re-pair INSIDE a segment (the browser pair lives ≤ 10 min; the instrument refuses a GO near the pair's end, bound from the owner's PAIR_ACK).
// Paced by the accepted per-actor limit (≈ 50 min), so it runs only with ATLAS_REVAL_REHEARSAL=1. Docker PG17: regression evidence only.
const darwin = process.platform === 'darwin' && process.arch === 'arm64';
const enabled = process.env.ATLAS_REVAL_REHEARSAL === '1';
const skip = { skip: (!darwin && 'darwin/arm64 only') || (!enabled && 'set ATLAS_REVAL_REHEARSAL=1 (paced: ≈ 50 minutes)'), timeout: 5_400_000 };
const ctx = bindCorpus(verifyRevision().snapshot); // identity FIRST: no throwaway database on a top-level failure
const grouped = withGroupedOrder(ctx.corpus).corpus;
const fixtureOf = (id: string) => grouped.cases.get(id)!.fixtureId;
const segments = grouped.order.reduce<{ fixtureId: string; cases: string[] }[]>((acc, id) => {
  if (acc.at(-1)?.fixtureId !== fixtureOf(id)) acc.push({ fixtureId: fixtureOf(id), cases: [] });
  acc.at(-1)!.cases.push(id); return acc;
}, []);
const h = enabled && darwin ? await segmentHarness('rsdc-reh') : null;
after(async () => { await h?.cleanup(); });

test('integrated offline rehearsal: all 200 frozen cases, 11 segments, 10 boundaries with S/C up — census MATCH, QUIESCENT drains, proofs, receipt v6', skip, async () => {
  const t0 = Date.now();
  assert.deepEqual([segments.length, grouped.order.length, segments.map(s => s.fixtureId)], [11, 200,
    ['FX07', 'FX05', 'FX10', 'FX02', 'FX03', 'FX09', 'FX11', 'FX04', 'FX01', 'FX08', 'FX06']], 'D1: the grouped order');
  const H = h!; const dir = await privateDir('rsdc-run'); const serverPort = 5600 + Math.floor(Math.random() * 300);
  const { path } = await H.ownerConfig(dir, serverPort);
  await writePrivate(dir, 'test.json', JSON.stringify({ ...H.tcp, provider: { intent: 'BY_QUESTION' }, fsSecretLog: join(dir, 'fs-secrets.log') }));
  const o = new LiveOwner(dir, H.ownerEntry, ['--config', path]);
  try {
    await o.prompt();
    assert.match((await o.type('snapshot'))[0]!, /^OK SNAPSHOT /);
    assert.match((await o.type('fixture-check'))[0]!, /^OK FIXTURE_CHECK .*"fixtureId":"FX07".*"allFiveIntents":true/);
    let policyVersion = await H.withOwner(c => revise(c, WS, { state: 'ACTIVE' }));
    const now = Date.now(); const receipts = join(dir, 'receipts');
    const input = await writePrivate(dir, 'seg.json', JSON.stringify({ configDir: dir, registrationId: H.r.registrationId, databaseInstanceId: H.r.databaseInstanceId,
      port: serverPort, bearer: H.bearer, clientId: CLIENT, maxSegments: 11, lastSegmentCases: null, repairAfterCases: 40, policyVersion, receiptDir: receipts, paceMs: 12_500,
      receiptName: 'REVAL_REHEARSAL.json', admission: { admissionId: H.admissionId, startUtc: new Date(now - 60_000).toISOString(),
        expiryUtc: new Date(now + 3 * 3_600_000).toISOString(), dayCapMicro: '2000000', monthCapMicro: '10000000', openingFenceEpoch: H.setupFence, pacingMax: '10' } }));
    const i = new LiveTty(dir, H.driver, [input], 'rehearsal');
    const closures: Record<string, string>[] = [];
    try {
      const [, ctl, ho] = await i.expect(/CONNECTED ([0-9a-f-]{36}) ([0-9a-f-]{36})/, 60_000);
      let [ackLine, secretLine] = await o.type(`pair ${ctl} ${ho}`, 2);
      let pairId = JSON.parse(ackLine!.slice('OK PAIR_ACK '.length)).pairId as string;
      i.type(`PAIR ${secretLine!.split(' ')[2]} ${ackLine!.slice('OK PAIR_ACK '.length)}`);
      let generation = '1'; let boundaries = 0; let repairs = 0; let summary = '';
      for (;;) {
        const m = await i.expect(/NEED_CLOSURE|NEED_REPAIR|SEGMENTS_(?:SUMMARY|FAILED) (.*)/, 1_200_000);
        if (m[0] === 'NEED_REPAIR') { // RS-D-C: a re-pair inside a segment (the pair lives ≤ 10 min; the instrument asks after 7)
          assert.match((await o.type(`end-pair ${pairId}`))[0]!, /^OK PAIR_ACK /);
          [ackLine, secretLine] = await o.type(`pair ${ctl} ${ho}`, 2);
          pairId = JSON.parse(ackLine!.slice('OK PAIR_ACK '.length)).pairId as string;
          i.type(`REPAIRED ${secretLine!.split(' ')[2]} ${ackLine!.slice('OK PAIR_ACK '.length)}`); repairs += 1; continue;
        }
        if (m[0] !== 'NEED_CLOSURE') { summary = m[1]!; break; }
        const next = segments[++boundaries]!;
        const closureLine = (await o.type(`pause-export ${H.admissionId} ${policyVersion} 0 0`))[0]!;
        assert.match(closureLine, /^OK CLOSURE /, next.fixtureId); closures.push(kv(closureLine));
        i.type(`CLOSURE ${JSON.stringify(kv(closureLine))}`);
        await i.expect(/\nDRAINED/, 120_000);
        const ownerDrain = kv((await o.type('drain'))[0]!);
        assert.deepEqual([ownerDrain.state, ownerDrain.continuity], ['QUIESCENT', 'INTACT'], `owner DRAIN before ${next.fixtureId}`);
        assert.match((await o.type(`end-pair ${pairId}`))[0]!, /^OK PAIR_ACK /);
        const switched = await H.switchFixture(next.fixtureId, generation);
        assert.equal(switched.fixtureId, next.fixtureId); generation = switched.generation;
        assert.match((await o.type('fixture-check'))[0]!, new RegExp(`^OK FIXTURE_CHECK .*"fixtureId":"${next.fixtureId}".*"allFiveIntents":true`));
        policyVersion = await H.withOwner(c => revise(c, WS, { state: 'ACTIVE' }));
        [ackLine, secretLine] = await o.type(`pair ${ctl} ${ho}`, 2);
        pairId = JSON.parse(ackLine!.slice('OK PAIR_ACK '.length)).pairId as string;
        i.type(`RESUMED ${secretLine!.split(' ')[2]} ${policyVersion} ${ackLine!.slice('OK PAIR_ACK '.length)}`);
      }
      assert.equal(boundaries, 10);
      assert.ok(!i.transcript.includes('SEGMENTS_FAILED'), i.transcript.slice(-800));
      const s = JSON.parse(summary.slice(summary.indexOf('{'))) as { segments: { fixtureId: string; cases: string[] }[]; refusals: string[]; drains: string[];
        proofs: string[]; finalDrain: string; repairs: number };
      assert.ok(s.repairs >= 1 && s.repairs === repairs, 'at least the forced mid-segment re-pair happened, each through the owner');
      assert.deepEqual(s.segments, segments, 'every segment, every case, in the grouped order');
      assert.deepEqual(s.refusals, segments.slice(1).flatMap(() => ['BLOCKED_SEGMENT_CLOSURE_REQUIRED', 'BLOCKED_SEGMENT_DRAIN_REQUIRED']));
      assert.ok(s.drains.length === 10 && s.drains.every(d => /^DRAIN QUIESCENT INTACT /.test(d)) && /^DRAIN QUIESCENT INTACT /.test(s.finalDrain));
      assert.equal(s.proofs.length, 12, 'before the first GO, after every segment, at the end');
      for (const line of s.proofs) {
        assert.match(line, /^PROOFS platform=rsd-seatbelt-s-v2 process=COMPLETE destinations=UNKNOWN verifiedZero=false privacy=\S+ unreadable=\d+ matches=0 verifiedZero=false$/);
      }
      const rec = JSON.parse(readFileSync(join(receipts, 'REVAL_REHEARSAL.json'), 'utf8'));
      assertReceiptV6(rec, ctx.cases);
      assert.deepEqual(rec.base.cases.map((c: { caseId: string }) => c.caseId), grouped.order, 'all 200 consumed exactly in the grouped order');
      assert.ok(rec.base.cases.every((c: { casePass: boolean }) => c.casePass === true), 'every case credited (semantic MATCH, truth, COMMITTED handoff)');
      assert.ok(Object.values(rec.cases).every((c: any) => c.census === 'MATCH' && c.handoffState === 'COMMITTED' && c.terminal?.final === true), 'census MATCH, COMMITTED, FINAL');
      assert.equal(new Set(Object.values(rec.cases).map((c: any) => c.preCensus.guardEpoch)).size, 1, 'ONE S incarnation for the whole run (D2)');
      const fx10 = segments.find(x => x.fixtureId === 'FX10')!.cases;
      assert.equal(fx10.length, 15, 'the 15 FX10 MISSING cases are part of the run');
      const quiescent = rec.drains.filter((d: any) => d.drain.state === 'QUIESCENT');
      assert.deepEqual(quiescent.map((d: any) => [d.afterCaseId, d.closurePolicyVersion, d.closureFenceEpoch]),
        [...segments.slice(0, -1).map((x, k) => [x.cases.at(-1), closures[k]!.policyVersion, closures[k]!.fenceEpoch]), [grouped.order.at(-1), null, null]]);
      assert.deepEqual([rec.proofs.map((p: any) => p.afterCaseId), rec.build], [[null, ...segments.map(x => x.cases.at(-1))], { buildManifestSha256: H.digests.buildManifestSha256 }]);
      assert.deepEqual([...new Set(readFileSync(join(dir, 'fs-secrets.log'), 'utf8').trim().split('\n'))], ['reader'], 'C never opens secretFiles.owner/runtime');
      assert.deepEqual([rec.order.rule, rec.base.run.state, rec.armStop, rec.effective.reason, rec.flags], ['FIXTURE_GROUPED_FIRST_APPEARANCE_V1', 'COMPLETE_PENDING_REVIEW', null, null,
        { verifiedPass: false, liveAcceptanceEligible: false, liveAdmissionReadiness: 'BLOCKED' }]);
      console.log(`# REVAL_EVIDENCE RS-D-C integrated rehearsal: ${grouped.order.length} cases, ${segments.length} segments, ${s.drains.length} boundaries (S/C up, `
        + `switch to generation ${generation}), ${s.repairs} mid-segment re-pair(s), ONE guard epoch, every census MATCH, ${s.proofs.length} proofs, run state ${rec.base.run.state}, `
        + `${Math.round((Date.now() - t0) / 1000)} s; ${s.proofs.at(-1)}`);
    } finally { assert.deepEqual((await i.stop()).forced, []); }
  } finally { assert.deepEqual((await o.stop()).forced, [], 'no O/C/S process survives'); }
});
