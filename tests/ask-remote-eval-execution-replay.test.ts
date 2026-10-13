import '../scripts/ask-remote-eval/guard-preload.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReceipt, assertReceipt } from '../scripts/ask-remote-eval-execution/receipt.ts';
import { loadContext, observe, playNext, playUntil, rig, SCENARIOS, UNPARSED_REQUEST, UNRECONCILE } from '../scripts/ask-remote-eval-execution/rehearsal.ts';
import { replayNumeric } from '../scripts/ask-remote-eval-execution/replay.ts';

// RC4 required repairs (SIMULATED fake V2): Sol R1 — saved numeric replay re-validates bound ledger/counter numbers with the
// SAME ingestion rules (caps, attempts, settlement/charge, reply class) before deriving credit; Opus R2 — saved pass/score/
// safety/threshold claims must be internally consistent with the saved booleans; Opus R1 — an unparsed request paste never
// erases a validated error envelope. Replay proves internal consistency only, never answer authenticity.

const ctx = loadContext();
type Rc = Record<string, any>;
const clone = (x: Rc): Rc => JSON.parse(JSON.stringify(x));
const receiptOf = (r: ReturnType<typeof rig>): Rc => buildReceipt(r.session, ctx.cases) as Rc;
const schemaOk = (x: Rc): boolean => { try { assertReceipt(x, ctx.cases); return true; } catch { return false; } };
const oneAnswer = (): Rc => { const r = rig(ctx); playNext(r); return receiptOf(r); };
/** Rewrite case 0's settlement/charge keeping pre + charged = post and the totals arithmetic consistent (Sol R1 trigger). */
function forgeLedger(base: Rc, settlement: string, charged: number): Rc {
  const x = clone(base); const c = x.cases[0];
  c.ledgerSettlement = settlement; c.liability = settlement; c.chargedMicro = charged; c.postDayMicro = c.preDayMicro + charged; c.postMonthMicro = c.preMonthMicro + charged;
  x.liability = { confirmedChargedMicro: settlement === 'CONFIRMED' ? charged : 0, retainedReserveMicro: settlement === 'CONFIRMED' ? 0 : charged, unknownLiabilityCases: 0 };
  return x;
}

test('Sol R1: impossible credited ledgers are rejected by replay even when the arithmetic and schema are consistent', () => {
  const base = oneAnswer();
  assert.equal(replayNumeric(base).status, 'VERIFIED_SAVED_ARITHMETIC');
  for (const [settlement, charged, code] of [['CONFIRMED', 0, 'REPLY_LEDGER_CLASS'], ['CONFIRMED', 9_435, 'LEDGER_INVALID'], ['RETAINED_KNOWN', 1, 'LEDGER_INVALID'],
    ['NO_DISPATCH', 0, 'REPLY_LEDGER_CLASS'], ['RETAINED_KNOWN', 299_999, 'LEDGER_INVALID']] as const) {
    const x = forgeLedger(base, settlement, charged);
    assert.ok(schemaOk(x), `${settlement}/${charged} passes the schema`);
    const r = replayNumeric(x);
    assert.equal(r.status, 'MISMATCH', `${settlement}/${charged}`); assert.ok(r.failed.includes(code), `${settlement}/${charged}: ${r.failed}`);
    assert.equal(x.cases[0].casePass, true, 'the forged receipt still claims a pass — replay refuses it');
  }
  const legit = forgeLedger(base, 'RETAINED_KNOWN', 300_000);
  assert.equal(replayNumeric(legit).status, 'VERIFIED_SAVED_ARITHMETIC', 'a full retained reserve with a validated answer is a legitimate known settlement');
});

test('Sol R1: cap, counter-order and attempt violations of saved numbers are rejected', () => {
  const base = oneAnswer();
  const mut = (f: (x: Rc) => void): string[] => { const x = clone(base); f(x); return replayNumeric(x).failed; };
  assert.ok(mut(x => { x.cases[0].preDayMicro = 2_000_001; }).includes('COUNTERS_INVALID'), 'pre DAY above the admitted cap');
  assert.ok(mut(x => { x.cases[0].preDayMicro = 10; x.cases[0].preMonthMicro = 9; }).includes('COUNTERS_INVALID'), 'DAY above MONTH');
  assert.ok(mut(x => { const c = x.cases[0]; c.postDayMicro = 2_000_001; c.postMonthMicro = 2_000_001; }).includes('LEDGER_INVALID'), 'post above cap');
  assert.ok(mut(x => { x.cases[0].ledgerAttempts = 2; }).includes('REPLY_LEDGER_CLASS'), 'two attempts are never a consistent BOUND answer ledger');
  assert.ok(mut(x => { x.cases[0].correlationId = null; }).includes('LEDGER_INVALID'), 'a bound ledger needs its correlation');
});

test('legitimate conservative receipts stay replayable: unknown/contradicted/explicitly-unknown ledgers and every scenario', () => {
  for (const s of SCENARIOS) { const o = observe(s.run(ctx)); assert.equal(o.receipt, 'VERIFIED_SAVED_ARITHMETIC', s.id); }
  const r = rig(ctx); playNext(r, { ledgerFn: UNRECONCILE });
  assert.equal(replayNumeric(receiptOf(r)).status, 'VERIFIED_SAVED_ARITHMETIC');
});

test('Opus R2: saved pass, score, safety and threshold claims must match the saved booleans', () => {
  const r = rig(ctx); playNext(r); playUntil(r, c => c.group.startsWith('SUPPORTED_')); playNext(r);
  const base = receiptOf(r);
  assert.equal(replayNumeric(base).status, 'VERIFIED_SAVED_ARITHMETIC');
  const fails = (f: (x: Rc) => void): string[] => { const x = clone(base); f(x); assert.ok(schemaOk(x), 'mutation keeps the schema'); return replayNumeric(x).failed; };
  assert.ok(fails(x => { x.cases[0].semantic = 'MISMATCH'; }).includes('CASE_PASS_DERIVATION'), 'pass on a MISMATCH');
  assert.ok(fails(x => { x.cases[0].truth.claims = false; }).includes('CASE_PASS_DERIVATION'), 'pass with a false claim');
  assert.ok(fails(x => { x.cases[0].truth.claims = false; x.cases[0].casePass = false; x.run.refusalPass -= 1; }).includes('SAFETY_ROW_DERIVATION'), 'false claim not in CLAIMS row');
  assert.ok(fails(x => { x.cases[0].text = 'REQUEST_DEVIATION'; }).includes('CASE_PASS_DERIVATION'), 'pass with a deviation');
  assert.ok(fails(x => { x.cases.at(-1).casePass = false; }).includes('CASE_PASS_DERIVATION'), 'a provable pass hidden as a failure');
  assert.ok(fails(x => { x.run.refusalPass = 100; }).includes('REFUSAL_PASS_COUNT'));
  assert.ok(fails(x => { for (const g of Object.keys(x.run.supportedPass)) x.run.supportedPass[g] = 25; }).includes('GROUP_PASS_COUNT'));
  assert.ok(fails(x => { x.run.procedureThresholdsMet = true; }).includes('THRESHOLDS_CLAIM'), 'thresholds on an incomplete run');
  assert.ok(fails(x => { x.safety.rows.MODEL_TIER.violationsObserved = 1; }).includes('SAFETY_ROW_DERIVATION'));
  assert.ok(fails(x => { x.safety.comparedAnswers += 1; }).includes('COMPARED_COUNT'));
  assert.ok(fails(x => { x.run.handoffFailures = 1; }).includes('HANDOFF_COUNT'));
  const full = SCENARIOS.find(s => s.id === 'X01_FULL_200_THEN_CLOSURE')!.run(ctx); const complete = receiptOf(full);
  assert.equal(complete.run.procedureThresholdsMet, true); assert.equal(replayNumeric(complete).status, 'VERIFIED_SAVED_ARITHMETIC');
  const unclosed = clone(complete); unclosed.run.closure = 'PENDING';
  assert.ok(replayNumeric(unclosed).failed.includes('THRESHOLDS_CLAIM'));
});

test('Opus R1: a validated error envelope survives an unparsed request paste (code, correlation, tally kept)', () => {
  for (const [code, row] of [['ASK_REMOTE_INVALID', 'SCHEMA'], ['ASK_REMOTE_MODEL_MISMATCH', 'MODEL_TIER'], ['ASK_REMOTE_USAGE_INVALID', 'USAGE']] as const) {
    const r = rig(ctx); playNext(r, { script: () => ({ kind: 'ERROR', code, settlement: 'RETAINED_KNOWN' }), request: UNPARSED_REQUEST });
    const o = observe(r); const last = receiptOf(r).cases.at(-1);
    assert.equal(o.state, 'TERMINAL_FAILED'); assert.equal(o.reason, code); assert.deepEqual(o.safety, { [row]: 1 });
    assert.deepEqual([last.outcome, last.reply, last.text, last.handoffDetail, last.ledger, typeof last.correlationId],
      [code, 'ERROR_ENVELOPE_VALID', 'REQUEST_UNVERIFIED', 'REQUEST_UNPARSED', 'BOUND', 'string']);
  }
  const busy = SCENARIOS.find(s => s.id === 'X56_BUSY_WITH_UNPARSED_REQUEST_INCOMPLETE')!.run(ctx);
  assert.equal(busy.session.state, 'TERMINAL_INCOMPLETE', 'a non-escalating error with an unverified request still stops INCOMPLETE');
  const answer = rig(ctx); playNext(answer, { request: UNPARSED_REQUEST });
  assert.equal(receiptOf(answer).cases.at(-1).outcome, 'LOCAL_HANDOFF_UNVERIFIED', 'an answer still cannot be attributed without its request');
});
