import '../scripts/ask-remote-eval/guard-preload.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readData } from '../scripts/ask-remote-eval/dataset.ts';
import { LiabilityBook, ledgerMatchesReply } from '../scripts/ask-remote-eval-execution/book.ts';
import { ClosureFloor } from '../scripts/ask-remote-eval-execution/closure.ts';
import { bindCorpus } from '../scripts/ask-remote-eval-execution/corpus.ts';
import { fakeRequest, fakeUuid } from '../scripts/ask-remote-eval-execution/fake-v2.ts';
import { buildReceipt } from '../scripts/ask-remote-eval-execution/receipt.ts';
import { ADMISSION_ID, advance, loadContext, observe, playNext, rig, SCENARIOS, START } from '../scripts/ask-remote-eval-execution/rehearsal.ts';
import { replayNumeric } from '../scripts/ask-remote-eval-execution/replay.ts';
import { finishInput, InputCollector } from '../scripts/ask-remote-eval-execution/tty-input.ts';
import { ExecError } from '../scripts/ask-remote-eval-execution/validate.ts';
import type { Ledger } from '../scripts/ask-remote-eval-execution/validate.ts';

// RC1 repair regressions (Sol R1–R7, Opus P2-1..4 / P3-1..4, advisories A1/A3): every required trigger reproduced through the
// SAME session/receipt code the operator uses (SIMULATED fake V2 only; no live, provider, DB or network).

const ctx = loadContext();
const run = (id: string) => observe(SCENARIOS.find(s => s.id === id)!.run(ctx));
const receiptOf = (r: ReturnType<typeof rig>) => buildReceipt(r.session, ctx.cases) as Record<string, any>;
const code = (c: string) => (e: unknown) => e instanceof ExecError && e.code === c && e.message === c;

test('R1: fractional operator-equivalent clocks give canonical integer durations and an exportable receipt', () => {
  const r = rig(ctx, { clockOffsetMs: 0.375 });
  playNext(r, { latencyMs: 700.125 }); playNext(r, { latencyMs: 1234.999, gapMs: 13_000.5 });
  const receipt = receiptOf(r);
  for (const c of receipt.cases) assert.ok(Number.isSafeInteger(c.durationMs), 'integer ms');
  assert.ok(Number.isSafeInteger(receipt.latency.answered.p95));
  assert.deepEqual(receipt.cases.map((c: any) => c.durationMs), [700, 1234], 'floor(end) − floor(start) of the canonical clock');
  assert.equal(receipt.replay.numeric, 'VERIFIED_SAVED_ARITHMETIC');
  const bad = rig(ctx); (bad.clock as { monoMs: number }).monoMs = Number.NaN;
  assert.throws(() => bad.session.capability(bad.fake.capability().http), code('CLOCK_INVALID'));
});

test('R2/P3-1: a validated answer with a no-attempt/no-dispatch ledger never passes or counts as a provider answer', () => {
  for (const id of ['X32_ANSWER_WITH_NO_RESERVATION_LEDGER', 'X33_ANSWER_WITH_NO_DISPATCH_LEDGER']) {
    const o = run(id);
    assert.equal(o.state, 'TERMINAL_INCOMPLETE'); assert.equal(o.localReason, 'LEDGER_REPLY_CONTRADICTION');
    assert.equal(o.validatedAnswers, 0); assert.equal(o.lastPass, false); assert.equal(o.receipt, 'VERIFIED_SAVED_ARITHMETIC');
  }
  const l = (p: Partial<Ledger>): Ledger => ({ correlationId: fakeUuid('x'), attempts: 1, settlement: 'CONFIRMED', chargedMicro: 337, dayChargedMicro: 337, monthChargedMicro: 337, ...p });
  assert.equal(ledgerMatchesReply('ANSWER', l({})), true);
  assert.equal(ledgerMatchesReply('ANSWER', l({ chargedMicro: 0 })), false);
  assert.equal(ledgerMatchesReply('ANSWER', l({ attempts: 2 })), false);
  assert.equal(ledgerMatchesReply('ANSWER', l({ settlement: 'RETAINED_KNOWN', chargedMicro: 300_000 })), true);
  assert.equal(ledgerMatchesReply('UPSTREAM_MODEL_OR_USAGE', l({})), false, 'model/usage mismatch retains the whole reserve');
  assert.equal(ledgerMatchesReply('UPSTREAM_INVALID', l({ attempts: 0, settlement: 'NO_RESERVATION', chargedMicro: 0 })), false);
  assert.equal(ledgerMatchesReply('OTHER', l({ attempts: 0, settlement: 'NO_RESERVATION', chargedMicro: 0 })), true);
  const o = run('X44_AUTHENTIC_MODEL_MISMATCH_WITH_CONTRADICTORY_LEDGER');
  assert.equal(o.state, 'TERMINAL_FAILED'); assert.deepEqual(o.safety, { MODEL_TIER: 1 }, 'authentic enum keeps its conservative handling');
});

test('R3: accounted floors survive across cases — no silent erasure; DAY resets only at the UTC boundary, MONTH never', () => {
  assert.equal(run('X34_RETAINED_RESERVE_ERASED_BY_COUNTERS').localReason, 'COUNTERS_BELOW_ACCOUNTED_FLOOR');
  assert.equal(run('X36_MONTH_FLOOR_NEVER_RESETS').localReason, 'COUNTERS_BELOW_ACCOUNTED_FLOOR');
  assert.deepEqual(run('X35_DAY_ROLLOVER_RESETS_DAY_ONLY').liability, { confirmedChargedMicro: 337, retainedReserveMicro: 300_000, unknownLiabilityCases: 0 });
  const b = new LiabilityBook(); const day = 86_400_000;
  assert.equal(b.checkCounters(START, { dayChargedMicro: 500, monthChargedMicro: 900 }), 'OK');
  assert.equal(b.checkCounters(START + 1, { dayChargedMicro: 499, monthChargedMicro: 900 }), 'COUNTERS_BELOW_ACCOUNTED_FLOOR');
  assert.equal(b.checkCounters(START + day, { dayChargedMicro: 0, monthChargedMicro: 900 }), 'OK');
  assert.equal(b.checkCounters(START + day, { dayChargedMicro: 0, monthChargedMicro: 899 }), 'COUNTERS_BELOW_ACCOUNTED_FLOOR');
  assert.equal(b.checkCounters(START, { dayChargedMicro: 900, monthChargedMicro: 900 }), 'CLOCK_REGRESSION');
  assert.equal(b.checkCounters(Date.UTC(2026, 10, 1), { dayChargedMicro: 0, monthChargedMicro: 0 }), 'MONTH_BUCKET_CHANGED');
});

test('R4: receipts keep validated per-case numbers and closure tuples; numeric replay verifies them and detects tampering', () => {
  const r = rig(ctx, { dayCap: 900_000 });
  const retained = { script: (c: any) => ({ kind: 'INTENT' as const, intent: c.expectedIntent, settlement: 'RETAINED_KNOWN' as const }) };
  playNext(r, retained); playNext(r); playNext(r, retained);
  assert.equal(playNext(r), 'submit:STOPPED'); assert.equal(r.session.state, 'RESUMABLE_DAY');
  r.session.closure(r.fake.pause());
  const receipt = receiptOf(r);
  const c0 = receipt.cases[0];
  assert.deepEqual([c0.submittedPolicyVersion, c0.preDayMicro, c0.ledgerAttempts, c0.ledgerSettlement, c0.chargedMicro, c0.postDayMicro, c0.postMonthMicro],
    ['7', 0, 1, 'RETAINED_KNOWN', 300_000, 300_000, 300_000]);
  assert.deepEqual(receipt.closures, [{ seq: 1, kind: 'DAY', result: 'CONFIRMED', policyVersion: '8', fenceEpoch: '41' }]);
  assert.deepEqual(receipt.liability, { confirmedChargedMicro: 337, retainedReserveMicro: 600_000, unknownLiabilityCases: 0 });
  assert.equal(replayNumeric(receipt).status, 'VERIFIED_SAVED_ARITHMETIC');
  const tamper = (f: (x: any) => void): string[] => { const x = JSON.parse(JSON.stringify(receipt)); f(x); return replayNumeric(x).failed; };
  assert.ok(tamper(x => { x.cases[0].chargedMicro = 9_434; }).includes('RECONCILIATION_FLAG'));
  assert.ok(tamper(x => { x.liability.retainedReserveMicro = 0; }).includes('LIABILITY_TOTALS'));
  assert.ok(tamper(x => { x.cases[1].preMonthMicro = 0; }).includes('COUNTER_BELOW_FLOOR'));
  assert.ok(tamper(x => { x.closures[0].fenceEpoch = '40'; }).includes('CLOSURE_PROGRESSION'));
  assert.ok(tamper(x => { x.run.consumed = 9; }).includes('CONSUMED_COUNT'));
  assert.equal(receipt.replay.livePerCase, 'SEE_REHEARSAL_REPLAY');
  assert.equal(receipt.verifiedPass, false); assert.equal(receipt.run.verifiedPass, false);
  assert.ok(receipt.cases.every((c: any) => c.verifiedPass === false));
});

test('R5/P3-2: start ≤ now < expiry and the admitted month are enforced at preflight, submit and resume; clock disclosed', () => {
  assert.deepEqual(run('X37_BEFORE_ADMISSION_START_BLOCKED').steps, ['confirm:CONFIRMED', 'counters:BLOCKED_BEFORE_ADMISSION_START']);
  const r = rig(ctx); const s = r.session; const id = s.nextCaseId!; const c = ctx.corpus.cases.get(id)!;
  const focus = ctx.corpus.fixtures.get(c.fixtureId)!.spec.requestedFocus;
  s.counters(r.fake.counters(r.clock.utcMs)); s.capability(r.fake.capability().http); s.stage(id, focus ?? 'none', c.question); s.consent(id, s.consentChallenge(id), true);
  r.clock.utcMs = START - 1;
  assert.equal(s.submit(id), 'BLOCKED_BEFORE_ADMISSION_START');
  r.clock.utcMs = START;
  assert.equal(s.submit(id), 'DISPATCH', 'exactly at start is inside the window');
  assert.equal(run('X30_EXPIRY_BEFORE_SUBMIT').reason, 'ADMISSION_EXPIRED');
  const receipt = receiptOf(rig(ctx));
  assert.equal(receipt.provenance.utcClock, 'SIMULATED_INJECTED_UTC');
  assert.ok(receipt.unverified.includes('LOCAL_WALL_CLOCK_VS_SERVER_UTC'));
});

test('R7/P2-1: one closure floor; out-of-range, stale, foreign or extra-key receipts are absorbing containment', () => {
  const o38 = run('X38_VOLUNTARY_FENCE_REUSED_BY_DAY_CLOSURE');
  assert.equal(o38.closure, 'CONTAINMENT_UNCONFIRMED');
  assert.deepEqual((o38.steps as string[]).slice(-2), ['closure:CONTAINMENT_UNCONFIRMED', 'resume:RESUME_DENIED_CONTAINMENT']);
  assert.equal(run('X39_CLOSURE_ABOVE_SIGNED_64_BIT').closure, 'CONTAINMENT_UNCONFIRMED');
  const ok = { admissionId: ADMISSION_ID, paused: 'true', policyVersion: '9223372036854775807', fenceEpoch: '9223372036854775807' };
  assert.notEqual(new ClosureFloor('40').evaluate(ok, ADMISSION_ID, 'VOLUNTARY'), null, 'signed-64-bit max is accepted');
  for (const bad of [{ ...ok, policyVersion: '9223372036854775808' }, { ...ok, fenceEpoch: '40' }, { ...ok, admissionId: fakeUuid('other') },
    { ...ok, paused: 'false' }, { ...ok, extra: '1' }, { admissionId: ADMISSION_ID, paused: 'true', policyVersion: '9' }, null, '9']) {
    const f = new ClosureFloor('40');
    assert.equal(f.evaluate(bad, ADMISSION_ID, 'DAY'), null);
    assert.equal(f.containment, true);
    assert.equal(f.evaluate({ ...ok, policyVersion: '10', fenceEpoch: '50' }, ADMISSION_ID, 'DAY'), null, 'containment is absorbing');
  }
  const f = new ClosureFloor('40'); f.observe('12');
  assert.equal(f.evaluate({ ...ok, policyVersion: '12', fenceEpoch: '41' }, ADMISSION_ID, 'TERMINAL'), null, 'not newer than an observed version');
  // A terminal run whose closure is contained can never report thresholds met.
  const full = rig(ctx); for (let i = 0; i < 200; i += 1) playNext(full);
  full.session.voluntaryPause();
  assert.equal(full.session.closure({ admissionId: ADMISSION_ID, paused: 'true', policyVersion: '99', fenceEpoch: '40' }), 'CONTAINMENT_UNCONFIRMED');
  assert.equal(receiptOf(full).run.procedureThresholdsMet, false);
});

test('P2-3/P2-4: unrecorded click is consumed + integrity; an abandoned in-flight case is recorded, never hidden', () => {
  const o40 = run('X40_UNRECORDED_CLICK_CONSUMED_INTEGRITY');
  assert.equal(o40.state, 'TERMINAL_FAILED'); assert.equal(o40.consumed, 1); assert.deepEqual(o40.integrity, ['UNRECORDED_CLICK']);
  const r = rig(ctx); const id = r.session.nextCaseId!; playNext(r);
  assert.equal(r.session.unrecordedClick(id), 'INTEGRITY_DUPLICATE_SUBMISSION', 'a second click on a consumed case is a duplicate');
  const o41 = run('X41_ABANDONED_IN_FLIGHT');
  assert.equal(o41.lastOutcome, 'ABANDONED_IN_FLIGHT'); assert.equal(o41.closure, 'PENDING'); assert.equal(o41.state, 'TERMINAL_INCOMPLETE');
  const a = rig(ctx); const s = a.session; const aid = s.nextCaseId!; const c = ctx.corpus.cases.get(aid)!;
  s.counters(a.fake.counters(a.clock.utcMs)); s.capability(a.fake.capability().http);
  s.stage(aid, ctx.corpus.fixtures.get(c.fixtureId)!.spec.requestedFocus ?? 'none', c.question); s.consent(aid, s.consentChallenge(aid), true);
  assert.equal(s.submit(aid), 'DISPATCH');
  const mid = receiptOf(a);
  assert.deepEqual(mid.run.inFlight, { caseId: aid, submittedPolicyVersion: '7', liability: 'UNKNOWN' }); assert.equal(mid.run.consumed, 1);
});

test('P3-3: re-pasted capability or reply correlation IDs are refused with a fixed code and record nothing', () => {
  assert.deepEqual(run('X42_REPASTED_CAPABILITY_REJECTED').steps, ['confirm:CONFIRMED', 'outcome:ACTIVE', 'error:CORRELATION_REUSED']);
  const r = rig(ctx); const s = r.session; const id = s.nextCaseId!; const c = ctx.corpus.cases.get(id)!;
  const focus = ctx.corpus.fixtures.get(c.fixtureId)!.spec.requestedFocus;
  const cap = r.fake.capability();
  s.counters(r.fake.counters(r.clock.utcMs)); s.capability(cap.http); s.stage(id, focus ?? 'none', c.question); s.consent(id, s.consentChallenge(id), true);
  const tuple = r.fake.tuple; s.submit(id); advance(r, 500); s.arrived(id);
  const request = fakeRequest('reuse', c.question, focus, tuple);
  const reply = r.fake.ask(request, c.fixtureId, { kind: 'INTENT', intent: c.expectedIntent }, r.clock.utcMs) as { http: any; correlationId: string };
  const stale = { ...reply.http, correlationHeader: cap.correlationId, body: reply.http.body.replace(reply.correlationId, cap.correlationId) };
  assert.throws(() => s.outcome(id, { request, reply: stale, ledger: null }), code('CORRELATION_REUSED'));
  assert.equal(s.inFlight, id);
});

test('P3-4: local handoff failures are unattributed — never an observed ASK_REMOTE_INVALID or schema safety hit', () => {
  for (const id of ['X13_V2_VALIDATOR_REJECT_IS_UNATTRIBUTED_HANDOFF', 'X43_UNPARSED_REQUEST_IS_UNATTRIBUTED_HANDOFF']) {
    const o = run(id);
    assert.equal(o.state, 'TERMINAL_INCOMPLETE'); assert.equal(o.localReason, 'LOCAL_HANDOFF_UNVERIFIED'); assert.deepEqual(o.safety, {});
    assert.notEqual(o.reason, 'ASK_REMOTE_INVALID');
  }
  const r = rig(ctx); playNext(r, { script: c => ({ kind: 'INTENT', intent: c.expectedIntent, tamper: 'DROP_PROVENANCE' }) });
  const receipt = receiptOf(r);
  assert.equal(receipt.safety.unattributedHandoffFailures, 1); assert.equal(receipt.safety.rows.SCHEMA.violationsObserved, 0);
  assert.equal(receipt.cases[0].handoffDetail, 'ANSWER_VALIDATOR_REJECTED');
  assert.equal(run('X09_REMOTE_INVALID_FAILED_SCHEMA').state, 'TERMINAL_FAILED', 'an authentic validated ASK_REMOTE_INVALID still fails');
});

test('R6/P2-2: buffer-safe echo-off input — multibyte splits, joined bracketed paste, malformed UTF-8, abort, size', () => {
  const ru = ctx.cases.filter(c => /[а-яё]/i.test(c.question)).slice(0, 25);
  assert.ok(ru.length > 5);
  for (const c of ru) {
    const bytes = Buffer.from(`\x1b[200~${c.question.replace(/\n/g, '\r')}\x1b[201~\x04`, 'utf8');
    for (const size of [1, 2, 3, 1022]) {
      const k = new InputCollector(true); let res = null;
      for (let i = 0; i < bytes.length && res === null; i += size) res = k.feed(bytes.subarray(i, i + size));
      assert.deepEqual(res, { kind: 'VALUE', value: c.question }, `${c.caseId}/${size}`);
    }
  }
  assert.deepEqual(finishInput(Buffer.from([0x41, 0xd0])), { kind: 'REJECTED', code: 'INPUT_MALFORMED_UTF8' });
  assert.deepEqual(finishInput(Buffer.from('ab\x7fc\x1bz')), { kind: 'VALUE', value: 'acz' });
  assert.deepEqual(new InputCollector(false).feed(Buffer.from('x\x03')), { kind: 'ABORT' });
  const big = new InputCollector(true); big.feed(Buffer.alloc(300_001, 0x61));
  assert.deepEqual(big.feed(Buffer.from([0x04])), { kind: 'REJECTED', code: 'INPUT_TOO_LARGE' });
});

test('A3: the in-memory corpus is parsed from the same bytes that are hashed and must equal the verified identity', () => {
  assert.equal(bindCorpus(ctx.snapshot).cases.length, 200);
  const tampered = (name: string): Buffer => name === 'fixtures.json' ? Buffer.concat([readData(name), Buffer.from(' ')]) : readData(name);
  assert.throws(() => bindCorpus(ctx.snapshot, tampered), code('CORPUS_IDENTITY_MISMATCH'));
});

test('RC2 R2-1: a contradictory ledger never masks what the validated answer proves', () => {
  const o45 = run('X45_FALSE_CLAIM_WITH_CONTRADICTORY_LEDGER_STAYS_FAILED');
  assert.equal(o45.state, 'TERMINAL_FAILED'); assert.equal(o45.localReason, 'SAFETY_VIOLATION_UNDER_CONTRADICTORY_LEDGER');
  assert.deepEqual(o45.safety, { CLAIMS: 1 }); assert.equal(o45.lastPass, false);
  const o46 = run('X46_REFUSAL_MISMATCH_WITH_CONTRADICTORY_LEDGER_STAYS_FAILED');
  assert.equal(o46.state, 'TERMINAL_FAILED'); assert.equal(o46.localReason, 'THRESHOLD_UNREACHABLE_UNDER_CONTRADICTORY_LEDGER');
  assert.equal(o46.lastSemantic, 'MISMATCH'); assert.equal(o46.validatedAnswers, 0, 'no answer credit');
  // Not relaxed: a grounded matching answer or a first supported mismatch with a contradictory ledger stays INCOMPLETE, no credit.
  for (const id of ['X32_ANSWER_WITH_NO_RESERVATION_LEDGER', 'X47_FIRST_SUPPORTED_MISMATCH_WITH_CONTRADICTION_INCOMPLETE']) {
    const o = run(id); assert.equal(o.state, 'TERMINAL_INCOMPLETE'); assert.equal(o.localReason, 'LEDGER_REPLY_CONTRADICTION'); assert.equal(o.lastPass, false);
  }
  // The receipt keeps conservative liability and the persisted semantic result only (no intent value).
  const r = SCENARIOS.find(s => s.id === 'X46_REFUSAL_MISMATCH_WITH_CONTRADICTORY_LEDGER_STAYS_FAILED')!.run(ctx);
  const last = receiptOf(r).cases.at(-1);
  assert.deepEqual([last.outcome, last.semantic, last.casePass, last.liability, last.ledger, last.reconciliation],
    ['LEDGER_REPLY_CONTRADICTION', 'MISMATCH', false, 'RETAINED_UNKNOWN_COMMIT', 'CONTRADICTS_REPLY', 'UNKNOWN']);
  assert.equal(receiptOf(r).run.state, 'TERMINAL_FAILED');
});

test('RC2 A2: counters before the admission start are refused unrecorded and cannot poison the MONTH floor', () => {
  const o = run('X48_PRESTART_COUNTERS_DO_NOT_POISON_MONTH_FLOOR');
  assert.equal(o.state, 'ACTIVE'); assert.equal(o.consumed, 1); assert.equal(o.localReason, null);
});
