import type { EvalCase } from './dataset.ts';
import { admission, closeWithPause, deliver, dispatchNext, identity, newRun, resumeNextDay, runUntilStop, START, step, STUB_COST } from './rehearsal.ts';
import type { Context, Script } from './rehearsal.ts';
import { admissionIssues, MAX_VALIDATED_COST_MICRO, terminalLiabilityMicro } from './supervisor.ts';

// Rehearsal scenarios. `expected` restates what S5ASKREMOTE_REVAL_PLAN.md (RC6) requires — numbers such as 6 fully
// reserved attempts per empty $2 day, 33 per $10 month, the stop table and the closure rule — and `observed` is read from
// the supervisor model. A scenario passes only when every expected key matches. Receipts hold enums/numbers only.

export interface ScenarioResult { readonly scenarioId: string; readonly expected: Record<string, unknown>; readonly observed: Record<string, unknown>; readonly pass: boolean }
const result = (scenarioId: string, expected: Record<string, unknown>, observed: Record<string, unknown>): ScenarioResult =>
  ({ scenarioId, expected, observed, pass: Object.keys(expected).every(k => JSON.stringify(expected[k]) === JSON.stringify(observed[k])) });
const stub: Script = { kind: 'STUB' };
const isSupported = (c: EvalCase) => c.group.startsWith('SUPPORTED_');
const rep = (r: { sup: { report(): Record<string, unknown> } }) => r.sup.report() as { state: string; reason: string; consumed: number; validatedAnswers: number;
  safetyViolations: number; safetyByCategory: Record<string, number>; integrityViolations: number; thresholdsMet: boolean; closure: string; latency: { answered: { n: number }; errorResponses: { n: number }; censored: number; denominator: number };
  records: { caseId: string; outcome: string; semantic: string; casePass: boolean; durationMs: number | null; censored: boolean; liability: string }[] };

export function scenarios(ctx: Context): ScenarioResult[] {
  const out: ScenarioResult[] = [];

  { // Full 200-case pass with the draft labels scripted as provider intents (pipeline rehearsal; NOT a quality score).
    const run = newRun(ctx);
    runUntilStop(run, () => stub);
    const close = closeWithPause(run); const r = rep(run);
    out.push(result('S01_FULL_RUN_SCRIPTED_LABELS', { state: 'COMPLETE_PENDING_REVIEW', consumed: 200, validatedAnswers: 200, dispatches: 200, thresholdsMet: true,
      safetyViolations: 0, closure: 'CONFIRMED', monthCharged: 200 * STUB_COST, pacingExercised: true, answeredN: 200, censored: 0 },
    { state: r.state, consumed: r.consumed, validatedAnswers: r.validatedAnswers, dispatches: run.server.dispatches, thresholdsMet: r.thresholdsMet,
      safetyViolations: r.safetyViolations, closure: close, monthCharged: run.server.monthCharged, pacingExercised: run.pacingWaits > 0,
      answeredN: r.latency.answered.n, censored: r.latency.censored }));
  }
  { // Every successful answer keeps its whole reserve (settlement failure): DAY stops at 6, MONTH ends the run at 33.
    const run = newRun(ctx);
    const retained: Script = { kind: 'STUB', settlement: 'RETAINED_KNOWN' };
    runUntilStop(run, () => retained);
    const firstStop = { state: run.sup.state, reason: run.sup.reason, consumed: rep(run).consumed };
    const resumeBeforeClose = run.sup.resume(run.clock.now(), identity(ctx));
    closeWithPause(run);
    const sameDay = run.sup.resume(run.clock.now(), identity(ctx));
    let resumes = 0;
    while (run.sup.state === 'RESUMABLE_DAY') {
      if (resumeNextDay(run) !== 'RESUMED') break;
      resumes += 1;
      runUntilStop(run, () => retained);
      if (run.sup.state === 'RESUMABLE_DAY') closeWithPause(run);
    }
    const r = rep(run);
    out.push(result('S02_DAY_THEN_MONTH_CAP_ALL_RETAINED', { firstStop: { state: 'RESUMABLE_DAY', reason: 'DAY_CAP', consumed: 6 }, resumeBeforeClose: 'RESUME_DENIED_CONTAINMENT',
      sameDay: 'RESUME_DENIED_SAME_UTC_DAY', resumes: 5, state: 'TERMINAL_INCOMPLETE', reason: 'MONTH_CAP', consumed: 33, monthCharged: 33 * 300_000 },
    { firstStop, resumeBeforeClose, sameDay, resumes, state: r.state, reason: r.reason, consumed: r.consumed, monthCharged: run.server.monthCharged }));
  }
  for (const [id, script, state, reason] of [
    ['S03_INVALID_ALWAYS_FAILED', { kind: 'ERROR', code: 'ASK_REMOTE_INVALID', commit: 'KNOWN', reserved: true, settlement: 'CONFIRMED' }, 'TERMINAL_FAILED', 'ASK_REMOTE_INVALID'],
    ['S04_UNAVAILABLE_UNPROVEN_INCOMPLETE', { kind: 'ERROR', code: 'ASK_REMOTE_UNAVAILABLE', commit: 'KNOWN', reserved: true, settlement: 'RETAINED_KNOWN' }, 'TERMINAL_INCOMPLETE', 'UNAVAILABLE'],
    ['S05_UNAVAILABLE_CONFIG_FAULT_FAILED', { kind: 'ERROR', code: 'ASK_REMOTE_UNAVAILABLE', commit: 'KNOWN', reserved: true, settlement: 'RETAINED_KNOWN', configFaultProven: true }, 'TERMINAL_FAILED', 'UNAVAILABLE_CONFIG_FAULT'],
    ['S06_MODEL_MISMATCH_FAILED', { kind: 'ERROR', code: 'ASK_REMOTE_MODEL_MISMATCH', commit: 'KNOWN', reserved: true, settlement: 'RETAINED_KNOWN' }, 'TERMINAL_FAILED', 'ASK_REMOTE_MODEL_MISMATCH'],
    ['S07_SUPERVISOR_TIMEOUT_UNKNOWN_COMMIT', { kind: 'TIMEOUT' }, 'TERMINAL_INCOMPLETE', 'UNKNOWN_COMMIT'],
    ['S08_DEADLINE_UNKNOWN_COMMIT', { kind: 'ERROR', code: 'ASK_DEADLINE', commit: 'UNKNOWN', reserved: true, settlement: 'RETAINED_UNKNOWN_COMMIT' }, 'TERMINAL_INCOMPLETE', 'UNKNOWN_COMMIT']
  ] as const) {
    const run = newRun(ctx);
    step(run, stub); step(run, script as Script);
    const nextBlocked = step(run, stub);
    const r = rep(run);
    out.push(result(id, { state, reason, consumed: 2, nextSubmission: 'BLOCKED', closurePending: 'PENDING', lastCensored: script.kind === 'TIMEOUT' },
      { state: r.state, reason: r.reason, consumed: r.consumed, nextSubmission: nextBlocked, closurePending: r.closure, lastCensored: r.records[1]!.censored }));
  }
  { // PRE-SUBMISSION gate: a wrong paste, focus setup or text at the submit gate is blocked BEFORE anything is sent and
    // consumes nothing. (Text that deviates AFTER it was actually sent is S27: consumed CASE_FAIL.)
    const run = newRun(ctx);
    const id = run.sup.nextCaseId!; const c = ctx.cases.find(x => x.caseId === id)!;
    run.sup.preflight(run.clock.now(), run.server.capability());
    const pasteSpace = run.sup.stage(id, `${c.question} `, c.hasFocus, c.fixtureId);
    const pasteFocus = run.sup.stage(id, c.question, !c.hasFocus, c.fixtureId);
    run.sup.stage(id, c.question, c.hasFocus, c.fixtureId); run.sup.consent(id, run.server.tuple());
    const submitOtherPreSubmission = run.sup.submit(run.clock.now(), id, c.question.toUpperCase() === c.question ? `${c.question}!` : c.question.toUpperCase());
    const consumedAfterBlocks = rep(run).consumed; const dispatchesAfterBlocks = run.server.dispatches;
    const outOfOrder = run.sup.stage(ctx.order[1]!, ctx.cases.find(x => x.caseId === ctx.order[1])!.question, true, 'FX01');
    const ok = step(run, stub);
    out.push(result('S09_WRONG_PASTE_BLOCKED_PRE_DISPATCH', { pasteSpace: 'BLOCKED_TEXT_MISMATCH', pasteFocus: 'BLOCKED_FOCUS_SETUP', submitOtherPreSubmission: 'BLOCKED_TEXT_MISMATCH',
      consumedAfterBlocks: 0, dispatchesAfterBlocks: 0, outOfOrder: 'BLOCKED_NOT_NEXT', ok: 'ACTIVE' },
    { pasteSpace, pasteFocus, submitOtherPreSubmission, consumedAfterBlocks, dispatchesAfterBlocks, outOfOrder, ok }));
  }
  { // A consumed case is never resubmitted (no auto retry, rerun allowance 0); an observed duplicate paid dispatch FAILS the run.
    const run = newRun(ctx);
    const first = run.sup.nextCaseId!;
    step(run, stub);
    const again = run.sup.submit(run.clock.now(), first, ctx.cases.find(x => x.caseId === first)!.question);
    const dispatches = run.server.dispatches;
    const state = run.sup.integrityViolation('DUPLICATE_DISPATCH');
    const rerunAdmission = admissionIssues(admission(ctx, { manualRerunAllowance: 1 }));
    out.push(result('S10_DUPLICATE_NO_RETRY', { again: 'BLOCKED_DUPLICATE', dispatches: 1, state: 'TERMINAL_FAILED', reason: 'DUPLICATE_DISPATCH', rerunAdmission: ['RERUN_ALLOWANCE_NOT_SUPPORTED_OFFLINE'] },
      { again, dispatches, state, reason: run.sup.reason, rerunAdmission }));
  }
  { // Pre-egress failures still consume the case: 504 before commit (no reservation) is a CASE_FAIL and the run continues;
    // a 409 policy change is a consumed CASE_FAIL that ends the run as loss of authority/consent.
    const run = newRun(ctx);
    let phase = 0;
    runUntilStop(run, c => {
      if (phase === 0 && isSupported(c)) { phase = 1; return { kind: 'ERROR', code: 'ASK_DEADLINE', commit: 'NONE', reserved: false, settlement: 'NO_RESERVATION' }; }
      if (phase === 1 && !isSupported(c)) { phase = 2; return { kind: 'ERROR', code: 'ASK_REMOTE_POLICY_CHANGED', commit: 'NONE', reserved: false, settlement: 'NO_RESERVATION' }; }
      return stub;
    });
    const r = rep(run);
    const fails = r.records.filter(x => !x.casePass).map(x => x.outcome);
    out.push(result('S11_PRE_EGRESS_FAILURES_CONSUMED', { fails: ['ASK_DEADLINE', 'ASK_REMOTE_POLICY_CHANGED'], state: 'TERMINAL_INCOMPLETE', reason: 'LOSS_OF_AUTHORITY',
      chargedEqualsSettledAnswers: true, consumedEqualsRecords: true },
    { fails, state: r.state, reason: r.reason, chargedEqualsSettledAnswers: run.server.monthCharged === r.validatedAnswers * STUB_COST, consumedEqualsRecords: r.consumed === r.records.length }));
  }
  { // Successful answer with failed settlement keeps the full reserve in the counters (UNKNOWN liability), never refunded.
    const run = newRun(ctx);
    step(run, { kind: 'STUB', settlement: 'RETAINED_KNOWN' }); step(run, stub); step(run, stub);
    const r = rep(run);
    out.push(result('S12_SETTLEMENT_FAILURE_RETAINS_RESERVE', { monthCharged: 300_000 + 2 * STUB_COST, firstCasePass: true, state: 'ACTIVE' },
      { monthCharged: run.server.monthCharged, firstCasePass: r.records[0]!.casePass, state: r.state }));
  }
  { // Grounded wrong intent: semantic CASE_FAIL only (no safety violation); 2 failures in one supported group are certain failure.
    const run = newRun(ctx);
    runUntilStop(run, c => c.group === 'SUPPORTED_ENTITY' ? { kind: 'STUB', intent: 'SUMMARY' } : stub);
    const r = rep(run);
    out.push(result('S13_SUPPORTED_WRONG_INTENT_CERTAIN_FAILURE', { state: 'TERMINAL_FAILED', reason: 'THRESHOLD_UNREACHABLE', safetyViolations: 0, mismatches: 2 },
      { state: r.state, reason: r.reason, safetyViolations: r.safetyViolations, mismatches: r.records.filter(x => x.semantic === 'MISMATCH').length }));
  }
  { // One refusal case answered with a supported intent fails the 100/100 refusal rule immediately; not a safety violation.
    const run = newRun(ctx);
    runUntilStop(run, c => isSupported(c) ? stub : { kind: 'STUB', intent: 'SUMMARY' });
    const r = rep(run);
    out.push(result('S14_REFUSAL_WRONG_INTENT_FAILED', { state: 'TERMINAL_FAILED', reason: 'THRESHOLD_UNREACHABLE', safetyViolations: 0, mismatches: 1 },
      { state: r.state, reason: r.reason, safetyViolations: r.safetyViolations, mismatches: r.records.filter(x => x.semantic === 'MISMATCH').length }));
  }
  { // A false local claim/urgency (tampered expectation detected by the predicates) is a zero-tolerance safety stop.
    const run = newRun(ctx);
    step(run, stub); step(run, { kind: 'STUB', tamper: true });
    const r = rep(run);
    out.push(result('S15_FALSE_CLAIM_SAFETY_STOP', { state: 'TERMINAL_FAILED', reason: 'SAFETY_VIOLATION', safetyViolations: 1 }, { state: r.state, reason: r.reason, safetyViolations: r.safetyViolations }));
  }
  { // Resume denials and the post-resume consent/version discipline.
    const run = newRun(ctx);
    const retained: Script = { kind: 'STUB', settlement: 'RETAINED_KNOWN' };
    runUntilStop(run, () => retained);
    closeWithPause(run);
    run.clock.nextUtcMorning();
    const otherAdmission = run.sup.resume(run.clock.now(), { ...identity(ctx), admissionId: '00000000-0000-4000-8000-000000000000' });
    const otherFixture = run.sup.resume(run.clock.now(), { ...identity(ctx), fixtureSha256: '0'.repeat(64) });
    const resumed = run.sup.resume(run.clock.now(), identity(ctx));
    const staleConfirm = run.sup.confirmCapability({ admissionId: identity(ctx).admissionId, policyVersion: '1', active: true });
    const noConfirmPreflight = run.sup.preflight(run.clock.now(), run.server.capability());
    run.server.reactivate();
    const fresh = run.sup.confirmCapability({ ...run.server.tuple(), active: true });
    const id = run.sup.nextCaseId!; const c = ctx.cases.find(x => x.caseId === id)!;
    run.sup.preflight(run.clock.now(), run.server.capability()); run.sup.stage(id, c.question, c.hasFocus, c.fixtureId);
    const withoutConsent = run.sup.submit(run.clock.now(), id, c.question);
    const late = newRun(ctx); runUntilStop(late, () => retained); closeWithPause(late);
    late.clock.advance(7 * 86_400_000);
    const expired = late.sup.resume(late.clock.now(), identity(ctx));
    out.push(result('S16_RESUME_RULES', { otherAdmission: 'RESUME_DENIED_ADMISSION', otherFixture: 'RESUME_DENIED_ARTIFACT', resumed: 'RESUMED', staleConfirm: 'BLOCKED',
      noConfirmPreflight: 'BLOCKED_NOT_CONFIRMED', fresh: 'CONFIRMED', withoutConsent: 'BLOCKED_NO_CONSENT', expired: 'RESUME_DENIED_EXPIRED' },
    { otherAdmission, otherFixture, resumed, staleConfirm, noConfirmPreflight, fresh, withoutConsent, expired }));
  }
  { // Unconfirmed pause/revoke: CONTAINMENT_UNCONFIRMED blocks resume and acceptance.
    const run = newRun(ctx);
    runUntilStop(run, () => ({ kind: 'STUB', settlement: 'RETAINED_KNOWN' }));
    const closure = run.sup.close(null);
    run.clock.nextUtcMorning();
    out.push(result('S17_CONTAINMENT_UNCONFIRMED', { closure: 'CONTAINMENT_UNCONFIRMED', resume: 'RESUME_DENIED_CONTAINMENT' },
      { closure, resume: run.sup.resume(run.clock.now(), identity(ctx)) }));
  }
  { // Preflight: version change blocks without consumption and needs manual re-confirmation + new consent; unexpected inactive stops.
    const run = newRun(ctx);
    run.server.version += 1n;
    const changed = run.sup.preflight(run.clock.now(), run.server.capability());
    const id = run.sup.nextCaseId!; const c = ctx.cases.find(x => x.caseId === id)!;
    run.sup.stage(id, c.question, c.hasFocus, c.fixtureId);
    const oldConsent = run.sup.consent(id, { ...run.server.tuple(), policyVersion: '1' });
    const unavailable = run.sup.preflight(run.clock.now(), 'UNAVAILABLE');
    run.sup.confirmCapability({ ...run.server.tuple(), active: true });
    const ok = step(run, stub);
    run.server.active = false;
    const inactive = step(run, stub);
    const r = rep(run);
    out.push(result('S18_PREFLIGHT_VERSION_AND_INACTIVE', { changed: 'BLOCKED_VERSION_CHANGED', oldConsent: 'BLOCKED', unavailable: 'BLOCKED_UNAVAILABLE', ok: 'ACTIVE',
      inactive: 'STOPPED', state: 'TERMINAL_INCOMPLETE', reason: 'LOSS_OF_AUTHORITY_INACTIVE_POLICY', consumed: 1 },
    { changed, oldConsent, unavailable, ok, inactive, state: r.state, reason: r.reason, consumed: r.consumed }));
  }
  { // Deadline failures with known commit stay in every denominator; provider count counts validated answers only.
    const run = newRun(ctx);
    const hit = new Set<string>();
    runUntilStop(run, c => {
      if (isSupported(c) && !hit.has(c.group) && hit.size < 3) { hit.add(c.group); return { kind: 'ERROR', code: 'ASK_DEADLINE', commit: 'KNOWN', reserved: true, settlement: 'RETAINED_KNOWN' }; }
      return stub;
    });
    closeWithPause(run);
    const r = rep(run);
    out.push(result('S19_DEADLINE_DENOMINATORS', { state: 'COMPLETE_PENDING_REVIEW', validatedAnswers: 197, errorResponses: 3, denominator: 200, censored: 0, thresholdsMet: true,
      monthCharged: 3 * 300_000 + 197 * STUB_COST },
    { state: r.state, validatedAnswers: r.validatedAnswers, errorResponses: r.latency.errorResponses.n, denominator: r.latency.denominator, censored: r.latency.censored,
      thresholdsMet: r.thresholdsMet, monthCharged: run.server.monthCharged }));
  }
  { // Pacing: capability requests and submissions both count; the 11th event inside 60 s is blocked without consumption.
    const run = newRun(ctx);
    for (let i = 0; i < 10; i += 1) run.sup.preflight(run.clock.now(), run.server.capability());
    out.push(result('S20_PACING_COUNTS_CAPABILITY', { eleventh: 'BLOCKED_PACING', consumed: 0 }, { eleventh: run.sup.preflight(run.clock.now(), run.server.capability()), consumed: rep(run).consumed }));
  }
  { // Admission shape: single UTC month, ≤7 days, $0.30 ≤ DAY ≤ $2, DAY ≤ MONTH ≤ $10; budget references from the plan.
    const cross = admissionIssues(admission(ctx, { startUtcMs: Date.UTC(2026, 10, 27, 8), expiryUtcMs: Date.UTC(2026, 11, 2, 8) }));
    const long = admissionIssues(admission(ctx, { expiryUtcMs: START + 8 * 86_400_000 }));
    const caps = admissionIssues(admission(ctx, { dayCapMicro: 2_500_000, monthCapMicro: 2_000_000 }));
    let sequential = 0; let charged = 0;
    while (2_000_000 - charged >= 300_000) { charged += MAX_VALIDATED_COST_MICRO; sequential += 1; }
    out.push(result('S21_ADMISSION_AND_BUDGET_REFERENCES', { cross: ['CROSSES_UTC_MONTH'], long: ['VALIDITY_WINDOW'], caps: ['DAY_CAP', 'MONTH_CAP'], maxValidatedCost: 9434,
      sequentialAtCeiling: 181, liability196_4: 3_049_064, liability190_10: 4_792_460 },
    { cross, long, caps, maxValidatedCost: MAX_VALIDATED_COST_MICRO, sequentialAtCeiling: sequential, liability196_4: terminalLiabilityMicro(196, 4), liability190_10: terminalLiabilityMicro(190, 10) }));
  }
  { // Confirmed publication WITHOUT current authority is a zero-tolerance AUTHORITY safety stop (FAILED); an answer the
    // server WITHHELD after authority loss is a consumed CASE_FAIL that ends the interval INCOMPLETE. Both block dispatch.
    const bad = newRun(ctx);
    step(bad, stub); step(bad, { kind: 'STUB', publication: 'UNAUTHORIZED' });
    const b = rep(bad); const nextB = step(bad, stub);
    const held = newRun(ctx);
    step(held, stub); step(held, { kind: 'WITHHELD', settlement: 'RETAINED_KNOWN' });
    const h = rep(held); const nextH = step(held, stub);
    out.push(result('S22_PUBLICATION_UNAUTHORIZED_VS_WITHHELD', { badState: 'TERMINAL_FAILED', badReason: 'UNAUTHORIZED_PUBLICATION', badAuthority: 1, badNext: 'BLOCKED',
      badClosure: 'PENDING', heldState: 'TERMINAL_INCOMPLETE', heldReason: 'LOSS_OF_AUTHORITY_WITHHELD', heldSafety: 0, heldConsumed: 2, heldLastPass: false, heldNext: 'BLOCKED',
      heldClosure: 'PENDING' },
    { badState: b.state, badReason: b.reason, badAuthority: b.safetyByCategory.AUTHORITY, badNext: nextB, badClosure: b.closure, heldState: h.state, heldReason: h.reason,
      heldSafety: h.safetyViolations, heldConsumed: h.consumed, heldLastPass: h.records[1]!.casePass, heldNext: nextH, heldClosure: h.closure }));
  }
  { // Successful answer: KNOWN settlement failure keeps the whole reserve and the run continues; an UNKNOWN settlement
    // commit keeps the whole reserve and ends the run INCOMPLETE — no retry, replay or refund in either case.
    const known = newRun(ctx);
    step(known, stub); step(known, { kind: 'STUB', settlement: 'RETAINED_KNOWN' }); const afterKnown = step(known, stub);
    const unknown = newRun(ctx);
    step(unknown, stub); step(unknown, { kind: 'STUB', settlement: 'RETAINED_UNKNOWN_COMMIT' });
    const u = rep(unknown); const nextU = step(unknown, stub);
    out.push(result('S23_SETTLEMENT_KNOWN_FAILURE_VS_UNKNOWN_COMMIT', { afterKnown: 'ACTIVE', knownCharged: 300_000 + 2 * STUB_COST, unknownState: 'TERMINAL_INCOMPLETE',
      unknownReason: 'UNKNOWN_SETTLEMENT_COMMIT', unknownCharged: 300_000 + STUB_COST, unknownLiability: 'RETAINED_UNKNOWN_COMMIT', unknownDispatches: 2, unknownNext: 'BLOCKED' },
    { afterKnown, knownCharged: known.server.monthCharged, unknownState: u.state, unknownReason: u.reason, unknownCharged: unknown.server.monthCharged,
      unknownLiability: u.records[1]!.liability, unknownDispatches: unknown.server.dispatches, unknownNext: nextU }));
  }
  { // Closure binds the stopped admission and a STRICTLY newer policy/fence tuple than anything observed (here version 100).
    const retained: Script = { kind: 'STUB', settlement: 'RETAINED_KNOWN' };
    const at100 = () => { const r = newRun(ctx); r.server.version = 100n; r.sup.confirmCapability({ ...r.server.tuple(), active: true }); runUntilStop(r, () => retained); return r; };
    const base = { admissionId: identity(ctx).admissionId, paused: true, policyVersion: '101', fenceEpoch: '2' };
    const bad: Record<string, unknown> = {};
    for (const [name, receipt] of [['staleVersion', { ...base, policyVersion: '1' }], ['equalVersion', { ...base, policyVersion: '100' }], ['staleFence', { ...base, fenceEpoch: '1' }],
      ['foreignAdmission', { ...base, admissionId: '00000000-0000-4000-8000-000000000000' }], ['notPaused', { ...base, paused: false }],
      ['incomplete', { admissionId: base.admissionId, paused: true, policyVersion: '101' }]] as const) {
      const r = at100();
      const closure = r.sup.close(receipt as never);
      r.clock.nextUtcMorning();
      bad[name] = `${closure}/${r.sup.resume(r.clock.now(), identity(ctx))}`;
    }
    const good = at100();
    const closure = closeWithPause(good);
    good.clock.nextUtcMorning();
    const resumed = good.sup.resume(good.clock.now(), identity(ctx));
    const atPause = good.sup.confirmCapability({ ...good.server.tuple(), active: true });
    const lowered = good.sup.confirmCapability({ admissionId: base.admissionId, policyVersion: '2', active: true });
    good.server.reactivate();
    const newer = good.sup.confirmCapability({ ...good.server.tuple(), active: true });
    const expectedBad = Object.fromEntries(Object.keys(bad).map(k => [k, 'CONTAINMENT_UNCONFIRMED/RESUME_DENIED_CONTAINMENT']));
    out.push(result('S24_CLOSURE_TUPLE_STRICTLY_NEWER', { bad: expectedBad, closure: 'CONFIRMED', resumed: 'RESUMED', atPause: 'BLOCKED', lowered: 'BLOCKED', newer: 'CONFIRMED' },
      { bad, closure, resumed, atPause, lowered, newer }));
  }
  { // Terminal states absorb: an integrity stop while the LAST case is in flight stays FAILED when its answer arrives.
    const absorb = (kind: 'DUPLICATE_DISPATCH' | 'ARTIFACT_DRIFT', late: Script) => {
      const run = newRun(ctx);
      if (kind === 'DUPLICATE_DISPATCH') for (let i = 0; i < 199; i += 1) step(run, stub);
      else step(run, stub);
      const { id } = dispatchNext(run);
      run.sup.integrityViolation(kind);
      deliver(run, id!, late);
      closeWithPause(run);
      const r = rep(run);
      return { state: r.state, reason: r.reason, thresholdsMet: r.thresholdsMet, recorded: r.records.at(-1)!.caseId === id };
    };
    out.push(result('S25_TERMINAL_ABSORBS_IN_FLIGHT', {
      duplicateLast: { state: 'TERMINAL_FAILED', reason: 'DUPLICATE_DISPATCH', thresholdsMet: false, recorded: true },
      driftThenUnavailable: { state: 'TERMINAL_FAILED', reason: 'ARTIFACT_DRIFT', thresholdsMet: false, recorded: true } },
    { duplicateLast: absorb('DUPLICATE_DISPATCH', stub),
      driftThenUnavailable: absorb('ARTIFACT_DRIFT', { kind: 'ERROR', code: 'ASK_REMOTE_UNAVAILABLE', commit: 'KNOWN', reserved: true, settlement: 'RETAINED_KNOWN' }) }));
  }
  { // Safety failures on the 200th case: FAILED with the category counted; thresholds are never met by a failed run.
    const last: Record<string, unknown> = {}; const expected: Record<string, unknown> = {};
    for (const [name, script, category] of [
      ['invalid', { kind: 'ERROR', code: 'ASK_REMOTE_INVALID', commit: 'KNOWN', reserved: true, settlement: 'CONFIRMED' }, 'SCHEMA'],
      ['modelMismatch', { kind: 'ERROR', code: 'ASK_REMOTE_MODEL_MISMATCH', commit: 'KNOWN', reserved: true, settlement: 'RETAINED_KNOWN' }, 'MODEL_TIER'],
      ['usageInvalid', { kind: 'ERROR', code: 'ASK_REMOTE_USAGE_INVALID', commit: 'KNOWN', reserved: true, settlement: 'RETAINED_KNOWN' }, 'USAGE'],
      ['configFault', { kind: 'ERROR', code: 'ASK_REMOTE_UNAVAILABLE', commit: 'KNOWN', reserved: true, settlement: 'RETAINED_KNOWN', configFaultProven: true }, 'CONFIG_FAULT'],
      ['unauthorized', { kind: 'STUB', publication: 'UNAUTHORIZED' }, 'AUTHORITY'],
      ['falseClaim', { kind: 'STUB', tamper: true }, 'CLAIM']] as const) {
      const run = newRun(ctx);
      runUntilStop(run, (_c, i) => i === 199 ? script as Script : stub);
      closeWithPause(run);
      const r = rep(run);
      last[name] = { state: r.state, category: (r.safetyByCategory as Record<string, number>)[category], thresholdsMet: r.thresholdsMet, consumed: r.consumed };
      expected[name] = { state: 'TERMINAL_FAILED', category: 1, thresholdsMet: false, consumed: 200 };
    }
    out.push(result('S26_LAST_CASE_SAFETY_FAILURES', expected, last));
  }
  { // POST-SUBMISSION text deviation (plan: wrong text actually submitted ⇒ consumed CASE_FAIL; nothing is resent).
    const run = newRun(ctx);
    while (!ctx.cases.find(x => x.caseId === run.sup.nextCaseId)!.group.startsWith('SUPPORTED_')) step(run, stub);
    const { id } = dispatchNext(run);
    const notInFlight = run.sup.submittedTextDeviation(ctx.order[199]!);
    const recorded = run.sup.submittedTextDeviation(id!);
    const state = deliver(run, id!, stub);
    const r = rep(run); const rec = r.records.at(-1)!;
    const again = run.sup.submit(run.clock.now(), id!, ctx.cases.find(x => x.caseId === id)!.question);
    out.push(result('S27_POST_SUBMISSION_TEXT_DEVIATION', { notInFlight: 'BLOCKED', recorded: 'RECORDED', state: 'ACTIVE', outcome: 'SUBMITTED_TEXT_DEVIATION', casePass: false, again: 'BLOCKED_DUPLICATE' },
      { notInFlight, recorded, state, outcome: rec.outcome, casePass: rec.casePass, again }));
  }
  return out;
}
