import '../scripts/ask-remote-eval/guard-preload.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenCorpus, loadCorpusFiles, stableOrder } from '../scripts/ask-remote-eval/dataset.ts';
import type { EvalCase } from '../scripts/ask-remote-eval/dataset.ts';
import { datasetManifest } from '../scripts/ask-remote-eval/evidence.ts';
import { loadFixtureFile } from '../scripts/ask-remote-eval/fixtures.ts';
import { prepareFixtures } from '../scripts/ask-remote-eval/harness.ts';
import { admission, closeWithPause, deliver, dispatchNext, frozenCases, identity, newRun, runUntilStop, START, step } from '../scripts/ask-remote-eval/rehearsal.ts';
import type { Context, Run } from '../scripts/ask-remote-eval/rehearsal.ts';
import { latencySummary, percentile, Supervisor } from '../scripts/ask-remote-eval/supervisor.ts';

// Offline supervisor model regressions (SIMULATED procedure, not production authority): consumed-first submission, no
// retry, in-memory text equality, manual consent/preflight, pacing, caps/headroom, stop table, resume and closure rules.

const file = loadFixtureFile();
const cases = flattenCorpus(loadCorpusFiles()) as EvalCase[];
const manifest = datasetManifest(cases) as { corpusSha256: string; fixtures: { sha256: string } };
const { order, orderSha256 } = stableOrder(cases.map(c => c.caseId));
const ctx: Context = { cases, fixtures: prepareFixtures(file), scope: file.scope, order, datasetSha256: manifest.corpusSha256, fixtureSha256: manifest.fixtures.sha256, orderSha256 };
const caseOf = (id: string) => cases.find(c => c.caseId === id)!;
/** Prepare the next case up to (not including) submission. */
function ready(run: Run): string {
  const id = run.sup.nextCaseId!; const c = caseOf(id);
  assert.equal(run.sup.preflight(run.clock.now(), run.server.capability()), 'OK');
  assert.equal(run.sup.stage(id, c.question, c.hasFocus, c.fixtureId), 'STAGED');
  assert.equal(run.sup.consent(id, run.server.tuple()), 'CONSENTED');
  return id;
}
const answer = (intent: string) => ({ kind: 'ANSWER' as const, observedIntent: intent, truthPass: true, publication: 'CURRENT' as const, settlement: 'CONFIRMED' as const });

test('consumed-first: the first submission consumes the case even when it fails pre-egress; any later submission is refused', () => {
  const run = newRun(ctx);
  while (!caseOf(run.sup.nextCaseId!).group.startsWith('SUPPORTED_')) step(run, { kind: 'STUB' });
  const consumedBefore = (run.sup.report() as { consumed: number }).consumed;
  const id = ready(run);
  assert.equal(run.sup.submit(run.clock.now(), id, caseOf(id).question), 'DISPATCH');
  assert.equal(run.sup.submit(run.clock.now(), id, caseOf(id).question), 'BLOCKED_DUPLICATE', 'in flight');
  run.clock.advance(400);
  assert.equal(run.sup.outcome(run.clock.now(), id, { kind: 'ERROR', code: 'ASK_BUSY', commit: 'NONE', settlement: 'NO_RESERVATION' }), 'ACTIVE');
  assert.equal(run.sup.submit(run.clock.now(), id, caseOf(id).question), 'BLOCKED_DUPLICATE', 'never a retry of the consumed case');
  assert.notEqual(run.sup.nextCaseId, id);
  const r = run.sup.report() as { consumed: number; records: { caseId: string; attempt: number; casePass: boolean; outcome: string }[] };
  const rec = r.records.at(-1)!;
  assert.deepEqual([r.consumed, r.records.length, rec.caseId, rec.attempt, rec.casePass, rec.outcome], [consumedBefore + 1, consumedBefore + 1, id, 1, false, 'ASK_BUSY']);
});

test('manual gates: exact pasted text and focus setup, per-case consent under the confirmed tuple, a fresh preflight per submission', () => {
  const run = newRun(ctx);
  const id = run.sup.nextCaseId!; const c = caseOf(id);
  assert.equal(run.sup.submit(run.clock.now(), id, c.question), 'BLOCKED_NOT_STAGED');
  run.sup.preflight(run.clock.now(), run.server.capability());
  assert.equal(run.sup.stage(id, c.question.normalize('NFD') === c.question ? `${c.question}​` : c.question.normalize('NFD'), c.hasFocus, c.fixtureId), 'BLOCKED_TEXT_MISMATCH');
  assert.equal(run.sup.stage(id, c.question, c.hasFocus, c.fixtureId === 'FX01' ? 'FX02' : 'FX01'), 'BLOCKED_FOCUS_SETUP');
  assert.equal(run.sup.stage(id, c.question, c.hasFocus, c.fixtureId), 'STAGED');
  assert.equal(run.sup.submit(run.clock.now(), id, c.question), 'BLOCKED_NO_CONSENT', 'no automatic consent');
  assert.equal(run.sup.consent(id, { ...run.server.tuple(), policyVersion: '999' }), 'BLOCKED', 'consent must name the confirmed tuple');
  assert.equal(run.sup.consent(id, run.server.tuple()), 'CONSENTED');
  assert.equal(run.sup.submit(run.clock.now(), id, `${c.question} `), 'BLOCKED_TEXT_MISMATCH');
  assert.equal(run.sup.submit(run.clock.now(), id, c.question), 'BLOCKED_NOT_STAGED', 'a mismatch clears staging and consent');
  run.sup.stage(id, c.question, c.hasFocus, c.fixtureId); run.sup.consent(id, run.server.tuple());
  assert.equal(run.sup.submit(run.clock.now(), id, c.question), 'DISPATCH');
  run.sup.outcome(run.clock.now(), id, answer(c.expectedIntent));
  const next = run.sup.nextCaseId!; const n = caseOf(next);
  run.sup.stage(next, n.question, n.hasFocus, n.fixtureId);
  assert.equal(run.sup.consent(next, run.server.tuple()), 'CONSENTED');
  assert.equal(run.sup.submit(run.clock.now(), next, n.question), 'BLOCKED_NO_PREFLIGHT', 'previous preflight is single-use');
  assert.equal(run.sup.stage(order[150]!, caseOf(order[150]!).question, caseOf(order[150]!).hasFocus, caseOf(order[150]!).fixtureId), 'BLOCKED_NOT_NEXT', 'stable order');
});

test('pacing: capability preflights and submissions share the rolling 10/60 s window; blocked events consume nothing', () => {
  const run = newRun(ctx);
  for (let i = 0; i < 9; i += 1) assert.equal(run.sup.preflight(run.clock.now(), run.server.capability()), 'OK');
  const id = run.sup.nextCaseId!; const c = caseOf(id);
  run.sup.stage(id, c.question, c.hasFocus, c.fixtureId); run.sup.consent(id, run.server.tuple());
  assert.equal(run.sup.submit(run.clock.now(), id, c.question), 'DISPATCH', '10th event');
  run.sup.outcome(run.clock.now(), id, answer(c.expectedIntent));
  assert.equal(run.sup.preflight(run.clock.now(), run.server.capability()), 'BLOCKED_PACING');
  run.clock.advance(59_999);
  assert.equal(run.sup.preflight(run.clock.now(), run.server.capability()), 'BLOCKED_PACING');
  run.clock.advance(1);
  assert.equal(run.sup.preflight(run.clock.now(), run.server.capability()), 'OK');
  assert.equal((run.sup.report() as { consumed: number }).consumed, 1);
});

test('caps: headroom is checked from counters BEFORE dispatch; minimum DAY cap allows one fully retained attempt per day', () => {
  const run = newRun(ctx, { dayCapMicro: 300_000, monthCapMicro: 900_000 });
  assert.equal(step(run, { kind: 'STUB', settlement: 'RETAINED_KNOWN' }), 'ACTIVE');
  const before = run.server.dispatches;
  assert.equal(step(run, { kind: 'STUB' }), 'STOPPED');
  assert.deepEqual([run.sup.state, run.sup.reason, run.server.dispatches, (run.sup.report() as { consumed: number }).consumed], ['RESUMABLE_DAY', 'DAY_CAP', before, 1]);
  // Confirmed settlement releases the reserve: seven ordinary answers fit an empty $2 day.
  const ok = newRun(ctx);
  for (let i = 0; i < 7; i += 1) assert.equal(step(ok, { kind: 'STUB' }), 'ACTIVE');
  // DAY cap on the last UTC day before expiry has no resume window: terminal, not resumable.
  const last = newRun(ctx, { expiryUtcMs: START + 15 * 3_600_000 }, START);
  runUntilStop(last, () => ({ kind: 'STUB', settlement: 'RETAINED_KNOWN' }));
  assert.deepEqual([last.sup.state, last.sup.reason], ['TERMINAL_INCOMPLETE', 'DAY_CAP_NO_RESUME_WINDOW']);
});

test('stop table: INVALID always FAILED; UNAVAILABLE FAILED only with a proven config fault, else INCOMPLETE; expiry; drift', () => {
  const at = (outcome: Parameters<Supervisor['outcome']>[2], refusal: boolean) => {
    const run = newRun(ctx);
    while (caseOf(run.sup.nextCaseId!).group.startsWith('SUPPORTED_') === refusal) step(run, { kind: 'STUB' });
    const id = ready(run);
    run.sup.submit(run.clock.now(), id, caseOf(id).question);
    run.sup.outcome(run.clock.now(), id, outcome);
    return [run.sup.state, run.sup.reason];
  };
  for (const refusal of [true, false]) {
    assert.deepEqual(at({ kind: 'ERROR', code: 'ASK_REMOTE_INVALID', commit: 'KNOWN', settlement: 'CONFIRMED' }, refusal), ['TERMINAL_FAILED', 'ASK_REMOTE_INVALID']);
    assert.deepEqual(at({ kind: 'ERROR', code: 'ASK_REMOTE_UNAVAILABLE', commit: 'KNOWN', settlement: 'RETAINED_KNOWN' }, refusal), ['TERMINAL_INCOMPLETE', 'UNAVAILABLE']);
    assert.deepEqual(at({ kind: 'ERROR', code: 'ASK_REMOTE_UNAVAILABLE', commit: 'KNOWN', configFaultProven: true, settlement: 'RETAINED_KNOWN' }, refusal), ['TERMINAL_FAILED', 'UNAVAILABLE_CONFIG_FAULT']);
    assert.deepEqual(at({ kind: 'ERROR', code: 'ASK_REMOTE_USAGE_INVALID', commit: 'KNOWN', settlement: 'RETAINED_KNOWN' }, refusal), ['TERMINAL_FAILED', 'ASK_REMOTE_USAGE_INVALID']);
    assert.deepEqual(at({ kind: 'ERROR', code: 'ASK_SOURCE_INVALID', commit: 'NONE', settlement: 'NO_RESERVATION' }, refusal), ['TERMINAL_INCOMPLETE', 'UNCLASSIFIED_ERROR']);
  }
  const safety = newRun(ctx); const id = ready(safety);
  safety.sup.submit(safety.clock.now(), id, caseOf(id).question);
  safety.sup.outcome(safety.clock.now(), id, { ...answer(caseOf(id).expectedIntent), truthPass: false });
  assert.deepEqual([safety.sup.state, safety.sup.reason], ['TERMINAL_FAILED', 'SAFETY_VIOLATION']);
  const expired = newRun(ctx); const e = ready(expired);
  expired.clock.advance(6 * 86_400_000);
  assert.equal(expired.sup.submit(expired.clock.now(), e, caseOf(e).question), 'STOPPED');
  assert.deepEqual([expired.sup.state, expired.sup.reason, (expired.sup.report() as { consumed: number }).consumed], ['TERMINAL_INCOMPLETE', 'ADMISSION_EXPIRED', 0]);
  const drift = newRun(ctx); step(drift, { kind: 'STUB' });
  assert.equal(drift.sup.integrityViolation('ARTIFACT_DRIFT'), 'TERMINAL_FAILED');
  assert.equal(closeWithPause(drift), 'CONFIRMED');
  assert.equal(drift.sup.resume(drift.clock.now(), { admissionId: admission(ctx).admissionId, datasetSha256: ctx.datasetSha256, fixtureSha256: ctx.fixtureSha256, orderSha256 }), 'RESUME_DENIED_STATE');
});

test('latency: nearest-rank p50/p95/max over completed answers with explicit n; censored timeouts are separate and never latency', () => {
  assert.equal(percentile([], 50), null);
  const values = Array.from({ length: 20 }, (_, i) => (i + 1) * 100);
  assert.deepEqual(latencySummary([...values].reverse()), { n: 20, p50: 1000, p95: 1900, max: 2000 });
  assert.deepEqual(latencySummary([7]), { n: 1, p50: 7, p95: 7, max: 7 });
  const run = newRun(ctx);
  step(run, { kind: 'STUB' }); step(run, { kind: 'ERROR', code: 'ASK_DEADLINE', commit: 'KNOWN', reserved: true, settlement: 'RETAINED_KNOWN' }); step(run, { kind: 'TIMEOUT' });
  const r = run.sup.report() as { latency: { answered: { n: number }; errorResponses: { n: number }; censored: number; denominator: number }; records: { durationMs: number | null; censored: boolean }[] };
  assert.deepEqual([r.latency.answered.n, r.latency.errorResponses.n, r.latency.censored, r.latency.denominator], [1, 1, 1, 200]);
  assert.deepEqual([r.records[2]!.durationMs, r.records[2]!.censored], [null, true]);
});

test('evidence: supervisor records hold only allowlisted safe keys — never question text, hashes, lengths or the observed intent', () => {
  const run = newRun(ctx);
  for (let i = 0; i < 12; i += 1) step(run, { kind: 'STUB' });
  const r = run.sup.report() as { records: Record<string, unknown>[] };
  for (const rec of r.records) assert.deepEqual(Object.keys(rec), ['caseId', 'attempt', 'outcome', 'semantic', 'casePass', 'durationMs', 'censored', 'liability']);
  const text = JSON.stringify(r);
  for (const c of cases) assert.ok(!text.includes(c.question), c.caseId);
  for (const intent of ['SUMMARY', 'WHY_URGENT', 'SOURCE_STATE', 'ENTITY', 'UNSUPPORTED']) assert.ok(!text.includes(`"${intent}"`), intent);
});

test('admission shape: invalid admissions and orders are refused at construction (no silent defaults)', () => {
  const counters = () => ({ dayChargedMicro: 0, monthChargedMicro: 0 });
  const frozen = frozenCases(cases);
  for (const patch of [{ expiryUtcMs: START + 8 * 86_400_000 }, { startUtcMs: Date.UTC(2026, 10, 28), expiryUtcMs: Date.UTC(2026, 11, 1) }, { reserveMicro: 200_000 },
    { dayCapMicro: 2_000_001 }, { monthCapMicro: 10_000_001 }, { dayCapMicro: 299_999 }, { manualRerunAllowance: 2 }, { pacingMax: 11 }, { openingFenceEpoch: '0' }]) {
    assert.throws(() => new Supervisor(admission(ctx, patch), frozen, order, counters), /ADMISSION_INVALID/, JSON.stringify(patch));
  }
  assert.throws(() => new Supervisor(admission(ctx), frozen, [...order.slice(1), order[1]!], counters), /ORDER_INVALID/);
});

type Rep = { state: string; reason: string; closure: string; thresholdsMet: boolean; safetyViolations: number; safetyByCategory: Record<string, number>;
  consumed: number; records: { caseId: string; outcome: string; casePass: boolean; liability: string }[] };
const rep = (run: Run) => run.sup.report() as Rep;
/** Run to the next supported (or refusal) case so a single failure does not end the run by itself. */
const toGroup = (run: Run, supported: boolean) => { while (caseOf(run.sup.nextCaseId!).group.startsWith('SUPPORTED_') !== supported) step(run, { kind: 'STUB' }); };

test('publication: unauthorized publication is an AUTHORITY safety stop (FAILED); a withheld answer stops INCOMPLETE; both block dispatch', () => {
  for (const [script, state, reason, authority] of [[{ kind: 'STUB', publication: 'UNAUTHORIZED' }, 'TERMINAL_FAILED', 'UNAUTHORIZED_PUBLICATION', 1],
    [{ kind: 'WITHHELD', settlement: 'RETAINED_KNOWN' }, 'TERMINAL_INCOMPLETE', 'LOSS_OF_AUTHORITY_WITHHELD', 0]] as const) {
    const run = newRun(ctx); toGroup(run, true);
    step(run, script);
    const r = rep(run);
    assert.deepEqual([r.state, r.reason, r.safetyByCategory.AUTHORITY, r.closure, r.records.at(-1)!.casePass], [state, reason, authority, 'PENDING', false]);
    assert.equal(step(run, { kind: 'STUB' }), 'BLOCKED', 'no further dispatch');
  }
  const ok = newRun(ctx); toGroup(ok, true);
  assert.equal(step(ok, { kind: 'STUB', publication: 'CURRENT' }), 'ACTIVE');
});

test('settlement: KNOWN failure keeps the reserve and continues; UNKNOWN commit keeps the reserve and stops INCOMPLETE, no refund', () => {
  const known = newRun(ctx); toGroup(known, true);
  assert.equal(step(known, { kind: 'STUB', settlement: 'RETAINED_KNOWN' }), 'ACTIVE');
  const unknown = newRun(ctx); toGroup(unknown, true);
  const before = unknown.server.monthCharged;
  assert.equal(step(unknown, { kind: 'STUB', settlement: 'RETAINED_UNKNOWN_COMMIT' }), 'TERMINAL_INCOMPLETE');
  const r = rep(unknown);
  assert.deepEqual([r.reason, r.records.at(-1)!.liability, r.records.at(-1)!.casePass, unknown.server.monthCharged - before], ['UNKNOWN_SETTLEMENT_COMMIT', 'RETAINED_UNKNOWN_COMMIT', true, 300_000]);
  assert.equal(step(unknown, { kind: 'STUB' }), 'BLOCKED');
});

test('closure floor: never below the highest version ever observed; stale/foreign/incomplete receipts leave containment unconfirmed', () => {
  const run = newRun(ctx);
  run.server.version = 100n;
  assert.equal(run.sup.confirmCapability({ ...run.server.tuple(), active: true }), 'CONFIRMED');
  assert.equal(run.sup.confirmCapability({ admissionId: identity(ctx).admissionId, policyVersion: '99', active: true }), 'BLOCKED', 'floor never lowered');
  runUntilStop(run, () => ({ kind: 'STUB', settlement: 'RETAINED_KNOWN' }));
  assert.equal(run.sup.state, 'RESUMABLE_DAY');
  assert.equal(run.sup.close({ admissionId: identity(ctx).admissionId, paused: true, policyVersion: '1', fenceEpoch: '2' }), 'CONTAINMENT_UNCONFIRMED');
  assert.equal(run.sup.close({ admissionId: identity(ctx).admissionId, paused: true, policyVersion: '101', fenceEpoch: '2' }), 'CONTAINMENT_UNCONFIRMED', 'no second chance');
  run.clock.nextUtcMorning();
  assert.equal(run.sup.resume(run.clock.now(), identity(ctx)), 'RESUME_DENIED_CONTAINMENT');
  assert.equal(run.sup.confirmCapability({ admissionId: identity(ctx).admissionId, policyVersion: '2', active: true }), 'BLOCKED');
  // Correct path: pause receipt strictly newer than v100 and the opening fence; resume needs a strictly newer version.
  const good = newRun(ctx); good.server.version = 100n; good.sup.confirmCapability({ ...good.server.tuple(), active: true });
  runUntilStop(good, () => ({ kind: 'STUB', settlement: 'RETAINED_KNOWN' }));
  assert.equal(good.sup.close({ admissionId: identity(ctx).admissionId, paused: true, policyVersion: '101', fenceEpoch: '1' }), 'CONTAINMENT_UNCONFIRMED', 'fence not newer than opening');
  const fresh = newRun(ctx); fresh.server.version = 100n; fresh.sup.confirmCapability({ ...fresh.server.tuple(), active: true });
  runUntilStop(fresh, () => ({ kind: 'STUB', settlement: 'RETAINED_KNOWN' }));
  assert.equal(closeWithPause(fresh), 'CONFIRMED');
  fresh.clock.nextUtcMorning();
  assert.equal(fresh.sup.resume(fresh.clock.now(), identity(ctx)), 'RESUMED');
  for (const v of ['2', '100', '101']) assert.equal(fresh.sup.confirmCapability({ admissionId: identity(ctx).admissionId, policyVersion: v, active: true }), 'BLOCKED', v);
  assert.equal(fresh.sup.confirmCapability({ admissionId: identity(ctx).admissionId, policyVersion: '102', active: true }), 'CONFIRMED');
});

test('absorbing terminal states: an integrity stop during the in-flight case is never overwritten by its later outcome', () => {
  const run = newRun(ctx);
  for (let i = 0; i < 199; i += 1) step(run, { kind: 'STUB' });
  const { result, id } = dispatchNext(run);
  assert.equal(result, 'DISPATCH');
  assert.equal(run.sup.integrityViolation('DUPLICATE_DISPATCH'), 'TERMINAL_FAILED');
  assert.equal(run.sup.close({ admissionId: identity(ctx).admissionId, paused: true, ...run.server.pause() }), 'PENDING', 'no closure while a case is in flight');
  assert.equal(deliver(run, id!, { kind: 'STUB' }), 'TERMINAL_FAILED');
  assert.equal(run.sup.close({ admissionId: identity(ctx).admissionId, paused: true, ...run.server.pause() }), 'CONFIRMED');
  const r = rep(run);
  assert.deepEqual([r.state, r.reason, r.consumed, r.records.length, r.thresholdsMet], ['TERMINAL_FAILED', 'DUPLICATE_DISPATCH', 200, 200, false]);
  const drift = newRun(ctx); toGroup(drift, true);
  const d = dispatchNext(drift).id!;
  drift.sup.integrityViolation('ARTIFACT_DRIFT');
  assert.equal(deliver(drift, d, { kind: 'ERROR', code: 'ASK_REMOTE_UNAVAILABLE', commit: 'KNOWN', reserved: true, settlement: 'RETAINED_KNOWN' }), 'TERMINAL_FAILED');
  assert.equal(drift.sup.reason, 'ARTIFACT_DRIFT');
  // INCOMPLETE escalates to FAILED, never the reverse.
  const esc = newRun(ctx); toGroup(esc, true);
  step(esc, { kind: 'ERROR', code: 'ASK_REMOTE_UNAVAILABLE', commit: 'KNOWN', reserved: true, settlement: 'RETAINED_KNOWN' });
  assert.equal(esc.sup.integrityViolation('ARTIFACT_DRIFT'), 'TERMINAL_FAILED');
});

test('thresholdsMet: only a COMPLETE run with confirmed closure and zero safety in every category; late safety failures never pass', () => {
  const run = newRun(ctx);
  runUntilStop(run, () => ({ kind: 'STUB' }));
  assert.deepEqual([rep(run).state, rep(run).thresholdsMet], ['COMPLETE_PENDING_REVIEW', false], 'closure still pending');
  closeWithPause(run);
  assert.equal(rep(run).thresholdsMet, true);
  const unconfirmed = newRun(ctx); runUntilStop(unconfirmed, () => ({ kind: 'STUB' })); unconfirmed.sup.close(null);
  assert.equal(rep(unconfirmed).thresholdsMet, false);
  for (const [code, category] of [['ASK_REMOTE_INVALID', 'SCHEMA'], ['ASK_REMOTE_MODEL_MISMATCH', 'MODEL_TIER']] as const) {
    const last = newRun(ctx);
    runUntilStop(last, (_c, i) => i === 199 ? { kind: 'ERROR', code, commit: 'KNOWN', reserved: true, settlement: 'CONFIRMED' } : { kind: 'STUB' });
    closeWithPause(last);
    const r = rep(last);
    assert.deepEqual([r.state, r.safetyByCategory[category], r.safetyViolations, r.thresholdsMet], ['TERMINAL_FAILED', 1, 1, false], code);
  }
});

test('post-submission text deviation: consumed CASE_FAIL (in flight or found after the record); a refusal deviation fails the run', () => {
  const run = newRun(ctx); toGroup(run, true);
  const id = dispatchNext(run).id!;
  assert.equal(run.sup.submittedTextDeviation(id), 'RECORDED');
  assert.equal(deliver(run, id, { kind: 'STUB' }), 'ACTIVE');
  assert.deepEqual([rep(run).records.at(-1)!.outcome, rep(run).records.at(-1)!.casePass], ['SUBMITTED_TEXT_DEVIATION', false]);
  const late = newRun(ctx); toGroup(late, false);
  const rid = late.sup.nextCaseId!;
  step(late, { kind: 'STUB' });
  assert.equal(late.sup.state, 'ACTIVE');
  assert.equal(late.sup.submittedTextDeviation(rid), 'RECORDED');
  assert.deepEqual([late.sup.state, late.sup.reason], ['TERMINAL_FAILED', 'THRESHOLD_UNREACHABLE']);
  assert.equal(late.sup.submittedTextDeviation(order[199]!), 'BLOCKED', 'never-submitted case');
});
