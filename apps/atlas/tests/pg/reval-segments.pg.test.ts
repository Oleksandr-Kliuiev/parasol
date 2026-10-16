import { verifyTestRevision } from '../support/reval-history.ts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bindCorpus } from '../../scripts/ask-remote-eval-execution/corpus.ts';
import { assertReceiptV6 } from '../../scripts/reval-instrument/receipt.ts';
import { revise } from '../support/ask-remote-pg.ts';
import { LiveOwner } from '../support/reval-eval-process.ts';
import { CLIENT, WS, install, pidOf } from '../support/reval-fixture-pg.ts';
import { LiveTty } from '../support/reval-live-tty.ts';
import { kv, segmentHarness } from '../support/reval-segment-harness.ts';
import { privateDir, writePrivate } from '../support/reval-test-deps.ts';

// R-EVAL RS-D-A segment rehearsal on darwin/arm64 (rs-d brief A §6–§7; owner decisions D1/D2): O (live PTY) → C → S (BUILT bridge
// server under the pinned profile, offline scripted provider answering each frozen question with its frozen intent) and the REAL
// instrument code under a live PTY (tests/support/reval-segment-entry.ts). One admitted run follows the fixture-grouped order through
// the whole FX07 segment, then crosses the boundary to FX05 with S and C UP: GO refused without the closure and without the DRAIN
// (nothing consumed); the owner's pause-export closure; DRAIN QUIESCENT (instrument and owner); the maintenance switch while S and C
// stay connected; FIXTURE_CHECK; manual resume; re-PAIR; two FX05 cases; a final DRAIN. Every case's PRE/POST process census MATCHes;
// the receipt (v6) carries the drains, C's proofs and C's build. Docker PG17 = regression evidence only; never MEASURED.
const darwin = process.platform === 'darwin' && process.arch === 'arm64';
const skip = { skip: !darwin && 'darwin/arm64 only', timeout: 900_000 };
const ctx = bindCorpus(verifyTestRevision().snapshot); // identity FIRST: no throwaway database on a top-level failure
const h = await segmentHarness('rsda-seg');
after(async () => { await h.cleanup(); });

test('D1/D2: one run crosses a fixture-segment boundary with S and C up — closure, DRAIN QUIESCENT, switch, re-check, resume, re-PAIR', skip, async () => {
  const dir = await privateDir('rsda-seg-run'); const serverPort = 5600 + Math.floor(Math.random() * 300);
  const { path } = await h.ownerConfig(dir, serverPort);
  await writePrivate(dir, 'test.json', JSON.stringify({ ...h.tcp, provider: { intent: 'BY_QUESTION' }, fsSecretLog: join(dir, 'fs-secrets.log') }));
  const o = new LiveOwner(dir, h.ownerEntry, ['--config', path]);
  try {
    await o.prompt();
    assert.match((await o.type('snapshot'))[0]!, /^OK SNAPSHOT /);
    assert.match((await o.type('fixture-check'))[0]!, /^OK FIXTURE_CHECK .*"allFiveIntents":true/);
    const policyVersion = await h.withOwner(c => revise(c, WS, { state: 'ACTIVE' }));
    const now = Date.now(); const receipts = join(dir, 'receipts');
    const input = await writePrivate(dir, 'seg.json', JSON.stringify({ configDir: dir, registrationId: h.r.registrationId, databaseInstanceId: h.r.databaseInstanceId,
      port: serverPort, bearer: h.bearer, clientId: CLIENT, maxSegments: 2, lastSegmentCases: 2, policyVersion, receiptDir: receipts, paceMs: 12_500,
      receiptName: 'REVAL_SEGMENTS.json', admission: { admissionId: h.admissionId, startUtc: new Date(now - 60_000).toISOString(),
        expiryUtc: new Date(now + 2 * 3_600_000).toISOString(), dayCapMicro: '2000000', monthCapMicro: '10000000', openingFenceEpoch: h.setupFence, pacingMax: '10' } }));
    const i = new LiveTty(dir, h.driver, [input], 'segments');
    try {
      const [, ctl, ho] = await i.expect(/CONNECTED ([0-9a-f-]{36}) ([0-9a-f-]{36})/, 60_000);
      let [ackLine, secretLine] = await o.type(`pair ${ctl} ${ho}`, 2);
      const pairId = JSON.parse(ackLine!.slice('OK PAIR_ACK '.length)).pairId as string;
      i.type(`PAIR ${secretLine!.split(' ')[2]} ${ackLine!.slice('OK PAIR_ACK '.length)}`);
      // Boundary: the instrument paused itself (RC5 voluntary pause); the owner's fence-first closure moves the policy to PAUSED.
      await i.expect(/NEED_CLOSURE/, 600_000);
      const closureLine = (await o.type(`pause-export ${h.admissionId} ${policyVersion} 0 0`))[0]!;
      assert.match(closureLine, /^OK CLOSURE /);
      i.type(`CLOSURE ${JSON.stringify(kv(closureLine))}`);
      await i.expect(/\nDRAINED/, 60_000);
      // The owner's own view at the boundary: S's census and C's DRAIN, then END_PAIR.
      assert.match((await o.type('process-census'))[0]!, /^OK PROCESS_CENSUS .*"activeTaskCount":"0"/);
      const ownerDrain = kv((await o.type('drain'))[0]!);
      assert.deepEqual([ownerDrain.state, ownerDrain.continuity, ownerDrain.policyVersion], ['QUIESCENT', 'INTACT', kv(closureLine).policyVersion]);
      assert.match((await o.type(`end-pair ${pairId}`))[0]!, /^OK PAIR_ACK /);
      // D2: the switch while S (runtime pool) and C (reader) stay connected; without the registered roles it would refuse. RS-D-B: while
      // the owner's switch connection is open, C's process inventory is incomplete, so DRAIN is UNKNOWN (never QUIESCENT).
      const switched = await h.withOwner(async c => {
        const backends = (await c.query(`SELECT application_name AS a FROM pg_stat_activity WHERE datname = $1 AND application_name LIKE 'atlas-reval-%'`, [h.db.name])).rows.map(x => x.a);
        assert.ok(backends.includes('atlas-reval-s-runtime') && backends.includes('atlas-reval-c-reader'), JSON.stringify(backends));
        assert.equal(kv((await o.type('drain'))[0]!).state, 'UNKNOWN', 'an owner session in the DB: the process inventory is incomplete');
        const cpid = await pidOf(c);
        await assert.rejects(install(c, h.r, 'FX05', '1', [cpid]), (e: { code?: string }) => e.code === 'ANOTHER_WRITER', 'RS-B semantics: S/C sessions refuse');
        return install(c, h.r, 'FX05', '1', [cpid], undefined, undefined, { runtime: h.roles.runtime, reader: h.roles.reader });
      });
      assert.deepEqual([switched.fixtureId, switched.generation], ['FX05', '2']);
      assert.match((await o.type('fixture-check'))[0]!, /^OK FIXTURE_CHECK .*"fixtureId":"FX05".*"allFiveIntents":true/);
      const resumed = await h.withOwner(c => revise(c, WS, { state: 'ACTIVE' }));
      [ackLine, secretLine] = await o.type(`pair ${ctl} ${ho}`, 2);
      i.type(`RESUMED ${secretLine!.split(' ')[2]} ${resumed} ${ackLine!.slice('OK PAIR_ACK '.length)}`);
      const [, summary] = await i.expect(/SEGMENTS_(?:SUMMARY|FAILED) (.*)/, 240_000);
      assert.ok(!i.transcript.includes('SEGMENTS_FAILED'), i.transcript.slice(-600));
      const s = JSON.parse(summary!.slice(summary!.indexOf('{'))) as { segments: { fixtureId: string; cases: string[] }[]; refusals: string[]; drains: string[];
        proofs: string[]; finalDrain: string };
      const [first, second] = s.segments.map(x => x.cases) as [string[], string[]];
      assert.deepEqual([s.segments.map(x => x.fixtureId), first.length, second.length, s.refusals], [['FX07', 'FX05'], 13, 2,
        ['BLOCKED_SEGMENT_CLOSURE_REQUIRED', 'BLOCKED_SEGMENT_DRAIN_REQUIRED']]);
      const rec = JSON.parse(readFileSync(join(receipts, 'REVAL_SEGMENTS.json'), 'utf8'));
      assertReceiptV6(rec, ctx.cases);
      const consumed = rec.base.cases.map((c: { caseId: string }) => c.caseId);
      assert.deepEqual(consumed, [...first, ...second], 'consumed exactly in the grouped order; the refused boundary GOs consumed nothing');
      assert.ok(Object.values(rec.cases).every((c: any) => c.census === 'MATCH' && c.preCensus.guardEpoch === c.postCensus.guardEpoch), 'every case census MATCH, one epoch');
      const epochs = new Set(Object.values(rec.cases).map((c: any) => c.preCensus.guardEpoch));
      assert.equal(epochs.size, 1, 'ONE S incarnation for the whole run (D2)');
      const quiescent = rec.drains.filter((d: any) => d.drain.state === 'QUIESCENT');
      assert.deepEqual(quiescent.map((d: any) => [d.afterCaseId, d.closurePolicyVersion, d.closureFenceEpoch]),
        [[first.at(-1), kv(closureLine).policyVersion, kv(closureLine).fenceEpoch], [second.at(-1), null, null]]);
      assert.ok(rec.drains.every((d: any) => d.drain.state === 'QUIESCENT' || d.drain.state === 'UNKNOWN'), 'only transient UNKNOWN retries besides');
      // RS-D-B/RS-D-C: C's proofs before the first GO, at the boundary and at the end — the server tree enforced and covered, nothing a
      // verified zero on this platform — all of C's ONE identified build (receipt v6 `build` = the registered build digest).
      for (const line of s.proofs) {
        assert.match(line, /^PROOFS platform=rsd-seatbelt-s-v2 process=COMPLETE destinations=UNKNOWN verifiedZero=false privacy=\S+ unreadable=\d+ matches=0 verifiedZero=false$/);
      }
      assert.deepEqual([rec.proofs.map((p: any) => p.afterCaseId), rec.build], [[null, first.at(-1), second.at(-1)], { buildManifestSha256: h.digests.buildManifestSha256 }]);
      const p = rec.proofs.at(-1);
      assert.deepEqual([p.platform.unmeasuredProcessCount, p.privacy.forbiddenContentMatchCount, p.privacy.metadataViolationCount, p.platform.serverBootId === rec.connection.serverBootId],
        ['4', '0', '0', true]);
      // RS-D-B rc2 (review F1): the I-initiated privacy proofs made C open no credential file but its reader's (fs-level spy in the C entry).
      assert.deepEqual([...new Set(readFileSync(join(dir, 'fs-secrets.log'), 'utf8').trim().split('\n'))], ['reader'], 'C never opens secretFiles.owner/runtime');
      assert.deepEqual([rec.order.rule, rec.base.run.state, rec.armStop, rec.effective.reason], ['FIXTURE_GROUPED_FIRST_APPEARANCE_V1', 'ACTIVE', null, null]);
      console.log(`# REVAL_EVIDENCE RS-D-A segments: ${first.length} FX07 + ${second.length} FX05 cases in one run, ONE guard epoch, boundary refusals ${s.refusals.join(',')}, `
        + `boundary ${s.drains[0]!.split(' ').slice(0, 3).join(' ')}, switch with S/C up generation ${switched.generation}; S sandboxed, ${s.proofs.at(-1)}`);
    } finally { assert.deepEqual((await i.stop()).forced, []); }
  } finally { assert.deepEqual((await o.stop()).forced, [], 'no O/C/S process survives'); }
});
