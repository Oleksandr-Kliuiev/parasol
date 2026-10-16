// OFFLINE fake-V2 REHEARSAL of the execution instrument (SIMULATED; not a live journey and not an operator session).
// A scripted driver plays each case through the SAME ExecutionSession the operator uses, with a fake clock, the fake V2
// server/ledger and deterministic consent challenges. Each scenario has a plan-derived expectation; the whole set runs
// twice with fresh state and must reproduce byte-identical safe results (deterministic replay). The fake returns the
// DRAFT label by default, so nothing here measures classification quality or provider behaviour.
import type { EvalCase, Intent } from '../ask-remote-eval/dataset.ts';
import type { Snapshot } from './artifact.ts';
import { loadContext } from './corpus.ts';
import type { Ctx } from './corpus.ts';
import { fakeRequest, fakeUuid, FakeV2 } from './fake-v2.ts';
import type { FakeScript } from './fake-v2.ts';
import { buildReceipt } from './receipt.ts';
import type { TransientHttp } from './transient.ts';
import { codeOf } from './validate.ts';
import type { CountersInput, LedgerInput } from './validate.ts';
import { ExecutionSession } from './session.ts';

export { loadContext };
export const ADMISSION_ID = fakeUuid('reval-execution-rehearsal-admission');
export const START = Date.UTC(2026, 9, 12, 6, 0, 0);
const HOUR = 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString();

export interface Rig { readonly session: ExecutionSession; readonly fake: FakeV2; readonly clock: { utcMs: number; monoMs: number }; readonly ctx: Ctx; drift: boolean; steps: string[] }
export function rig(ctx: Ctx, o: { dayCap?: number; monthCap?: number; expiryMs?: number; pacingMax?: number; clockOffsetMs?: number } = {}): Rig {
  const dayCap = o.dayCap ?? 2_000_000; const monthCap = o.monthCap ?? 10_000_000;
  const fake = new FakeV2(ctx.corpus.fixtures, ctx.corpus.scope, { admissionId: ADMISSION_ID, version: '7', fence: '40', dayCap, monthCap });
  // clockOffsetMs may be fractional/negative: an operator-equivalent clock (performance.now() is fractional).
  const clock = { utcMs: START + (o.clockOffsetMs ?? 0), monoMs: 1_000 + Math.abs(o.clockOffsetMs ?? 0) }; let nonce = 0;
  const r: Rig = { session: null as unknown as ExecutionSession, fake, clock, ctx, drift: false, steps: [] };
  const drifted: Snapshot = { ...ctx.snapshot, identity: ctx.snapshot.identity && { ...ctx.snapshot.identity, datasetCorpusSha256: '0'.repeat(64) } };
  (r as { session: ExecutionSession }).session = new ExecutionSession({ runClass: 'OFFLINE_FAKE_V2_REHEARSAL', clock: () => ({ ...clock }),
    verify: () => r.drift ? drifted : ctx.snapshot, nonce: () => `n${(nonce += 1).toString(36).padStart(5, '0')}`, corpus: ctx.corpus },
  { admissionId: ADMISSION_ID, startUtc: iso(START), expiryUtc: iso(o.expiryMs ?? START + 6 * 24 * HOUR), dayCapMicro: String(dayCap), monthCapMicro: String(monthCap),
    openingFenceEpoch: '40', pacingMax: String(o.pacingMax ?? 10) });
  r.steps.push(`confirm:${r.session.confirmTuple(fake.tuple.admissionId, fake.tuple.policyVersion)}`);
  return r;
}
export const advance = (r: Rig, ms: number): void => { r.clock.utcMs += ms; r.clock.monoMs += ms; };

export interface Play {
  readonly script?: (c: EvalCase) => FakeScript; readonly edited?: boolean; readonly ledger?: 'FAKE' | 'MISSING' | 'WRONG_CORRELATION';
  readonly configFault?: boolean; readonly latencyMs?: number; readonly gapMs?: number;
  /** Operator-supplied overrides of attested/pasted values (reproducers of wrong or contradictory inputs). */
  readonly counters?: (fake: CountersInput) => CountersInput; readonly ledgerFn?: (fake: LedgerInput) => LedgerInput;
  readonly request?: (sent: string) => string; readonly capability?: TransientHttp;
}
const caseOf = (r: Rig, id: string): EvalCase => r.ctx.corpus.cases.get(id)!;
const focusOf = (r: Rig, c: EvalCase): string | null => r.ctx.corpus.fixtures.get(c.fixtureId)!.spec.requestedFocus;

/** Every manual step of ONE case, scripted: counters → capability → stage → challenge+consent → submit → reply → outcome.
 * A fixed-code input refusal is logged as `error:<code>` (nothing was recorded by the session). */
export function playNext(r: Rig, p: Play = {}): string {
  const s = r.session; const log = (x: string): string => { r.steps.push(x); return x; };
  advance(r, p.gapMs ?? 13_000);
  const id = s.nextCaseId; if (id === null) return log('NO_NEXT_CASE');
  const c = caseOf(r, id); const focus = focusOf(r, c);
  try {
    const fakeCounters = r.fake.counters(r.clock.utcMs);
    const cr = s.counters(p.counters ? p.counters(fakeCounters) : fakeCounters);
    if (cr !== 'RECORDED') return log(`counters:${cr}`);
    const pre = s.capability(p.capability ?? r.fake.capability().http);
    if (pre !== 'OK') return log(`preflight:${pre}`);
    const staged = s.stage(id, focus ?? 'none', c.question);
    if (staged !== 'STAGED') return log(`stage:${staged}`);
    const tuple = r.fake.tuple;
    s.consent(id, s.consentChallenge(id), true);
    const sub = s.submit(id);
    if (sub !== 'DISPATCH') return log(`submit:${sub}`);
    const sent = fakeRequest(`${id}:${r.clock.monoMs}`, p.edited ? `${c.question} (edited)` : c.question, focus, tuple);
    const reply = r.fake.ask(sent, c.fixtureId, p.script ? p.script(c) : { kind: 'INTENT', intent: c.expectedIntent }, r.clock.utcMs);
    advance(r, p.latencyMs ?? 700 + (id.charCodeAt(id.length - 1) % 7) * 100);
    if (reply.http !== 'TIMEOUT') s.arrived(id);
    const fakeLedger = r.fake.ledgerFor(reply.correlationId);
    const ledger = p.ledger === 'MISSING' || fakeLedger === null ? null
      : p.ledger === 'WRONG_CORRELATION' ? { ...fakeLedger, correlationId: fakeUuid('unrelated-correlation') } : p.ledgerFn ? p.ledgerFn(fakeLedger) : fakeLedger;
    return log(`outcome:${s.outcome(id, { request: p.request ? p.request(sent) : sent, reply: reply.http, ledger, configFaultAttested: p.configFault === true })}`);
  } catch (e) { return log(`error:${codeOf(e)}`); }
}
/** Play correct cases until the NEXT case satisfies `want` (or the run stops). */
export function playUntil(r: Rig, want: (c: EvalCase) => boolean): void {
  while (r.session.state === 'ACTIVE' && r.session.nextCaseId !== null && !want(caseOf(r, r.session.nextCaseId))) playNext(r);
}
const supported = (c: EvalCase): boolean => c.group.startsWith('SUPPORTED_');
export const OTHER: Readonly<Record<string, Intent>> = { SUMMARY: 'ENTITY', WHY_URGENT: 'SUMMARY', SOURCE_STATE: 'SUMMARY', ENTITY: 'SUMMARY', UNSUPPORTED: 'SUMMARY' };

/** Safe observation of a rig: fixed enums, counts, step codes and the receipt's numeric-replay status only. */
export function observe(r: Rig): Record<string, unknown> {
  const f = r.session.facts(); const rep = f.report as Record<string, any>;
  const last = (rep.records as Record<string, unknown>[]).at(-1);
  const local = last ? f.evidence.get(last.caseId as string)?.localOutcome : null;
  let receipt: string;
  try { receipt = (buildReceipt(r.session, r.ctx.cases) as { replay: { numeric: string } }).replay.numeric; } catch (e) { receipt = codeOf(e); }
  return { state: f.state, reason: rep.reason, localReason: f.localReason, closure: f.closure, voluntary: f.voluntary, consumed: rep.consumed + f.extra.length,
    validatedAnswers: rep.validatedAnswers, safety: Object.fromEntries([...f.safety].filter(([, n]) => n > 0)), integrity: f.integrity, liability: f.totals,
    lastOutcome: f.extra.length ? 'UNRECORDED_CLICK' : local === 'ABANDONED_IN_FLIGHT' ? local : last?.outcome ?? null, lastPass: last?.casePass ?? null,
    lastSemantic: (last ? f.evidence.get(last.caseId as string)?.semantic : null) ?? last?.semantic ?? null, receipt, steps: r.steps.slice(-4) };
}

/** Attested ledger read that contradicts a validated answer (no reservation for the reply's own correlation). */
export const CONTRADICT = (l: LedgerInput): LedgerInput => ({ ...l, attempts: '0', settlement: 'NO_RESERVATION', chargedMicro: '0', dayChargedMicro: '0', monthChargedMicro: '0' });
/** Attested ledger read whose post counters do not equal pre + charged (arithmetically unreconciled). */
export const UNRECONCILE = (l: LedgerInput): LedgerInput => ({ ...l, dayChargedMicro: String(Number(l.dayChargedMicro) + 1), monthChargedMicro: String(Number(l.monthChargedMicro) + 1) });
/** A pasted request that is valid JSON but not an AskRequestV2 (e.g. the reply pasted at the wrong prompt). */
export const UNPARSED_REQUEST = (): string => '{"contractVersion":"AskErrorV1"}';
interface Scenario { readonly id: string; readonly expected: Record<string, unknown>; readonly run: (ctx: Ctx) => Rig }
const closeWith = (r: Rig, receipt: { admissionId: string; paused: string; policyVersion: string; fenceEpoch: string }): void => { r.steps.push(`closure:${r.session.closure(receipt)}`); };
export const SCENARIOS: readonly Scenario[] = [
  { id: 'X01_FULL_200_THEN_CLOSURE', expected: { state: 'COMPLETE_PENDING_REVIEW', reason: 'ALL_CASES_CONSUMED', closure: 'CONFIRMED', consumed: 200, safety: {} },
    run: ctx => { const r = rig(ctx); for (let i = 0; i < 200; i += 1) playNext(r); closeWith(r, r.fake.pause()); return r; } },
  { id: 'X02_PRESUBMIT_TEXT_AND_FOCUS_BLOCKED_UNCONSUMED', expected: { state: 'ACTIVE', consumed: 1, lastPass: true },
    run: ctx => { const r = rig(ctx); const id = r.session.nextCaseId!; const c = caseOf(r, id); const focus = focusOf(r, c);
      r.steps.push(`stage:${r.session.stage(id, focus ?? 'none', `${c.question} `)}`, `stage:${r.session.stage(id, focus === null ? 'syn-obs-wrong' : 'none', c.question)}`,
        `submit:${r.session.submit(id)}`);
      playNext(r); return r; } },
  { id: 'X03_POSTSUBMIT_DEVIATION_CONSUMED_FAIL', expected: { state: 'ACTIVE', lastOutcome: 'SUBMITTED_TEXT_DEVIATION', lastPass: false },
    run: ctx => { const r = rig(ctx); playUntil(r, supported); playNext(r, { edited: true }); return r; } },
  { id: 'X04_DUPLICATE_SUBMISSION_INTEGRITY', expected: { state: 'TERMINAL_FAILED', reason: 'DUPLICATE_DISPATCH', integrity: ['DUPLICATE_SUBMISSION'] },
    run: ctx => { const r = rig(ctx); const id = r.session.nextCaseId!; playNext(r); r.steps.push(`submit:${r.session.submit(id)}`); return r; } },
  { id: 'X05_DAY_CAP_RESUME_NEXT_UTC_DAY', expected: { state: 'ACTIVE', consumed: 3, closure: 'NOT_REQUIRED' },
    run: ctx => { const r = rig(ctx, { dayCap: 600_000 });
      const retained = { script: (c: EvalCase): FakeScript => ({ kind: 'INTENT', intent: c.expectedIntent, settlement: 'RETAINED_KNOWN' }) };
      playNext(r, retained); playNext(r, retained); playNext(r);
      r.steps.push(`resume-same-day-closed:${r.session.resumeDay()}`);
      closeWith(r, r.fake.pause()); r.steps.push(`resume-same-day:${r.session.resumeDay()}`);
      advance(r, 24 * HOUR); r.steps.push(`resume:${r.session.resumeDay()}`);
      r.fake.reactivate(); r.steps.push(`confirm:${r.session.confirmTuple(ADMISSION_ID, r.fake.tuple.policyVersion)}`);
      playNext(r); return r; } },
  { id: 'X06_MONTH_CAP_TERMINAL', expected: { state: 'TERMINAL_INCOMPLETE', reason: 'MONTH_CAP', consumed: 2 },
    run: ctx => { const r = rig(ctx, { dayCap: 600_000, monthCap: 600_000 });
      const retained = { script: (c: EvalCase): FakeScript => ({ kind: 'INTENT', intent: c.expectedIntent, settlement: 'RETAINED_KNOWN' }) };
      playNext(r, retained); playNext(r, retained); playNext(r); return r; } },
  { id: 'X07_UNAVAILABLE_INCOMPLETE', expected: { state: 'TERMINAL_INCOMPLETE', reason: 'UNAVAILABLE', lastOutcome: 'ASK_REMOTE_UNAVAILABLE' },
    run: ctx => { const r = rig(ctx); playNext(r, { script: () => ({ kind: 'ERROR', code: 'ASK_REMOTE_UNAVAILABLE', settlement: 'RETAINED_KNOWN' }) }); return r; } },
  { id: 'X08_UNAVAILABLE_CONFIG_FAULT_FAILED', expected: { state: 'TERMINAL_FAILED', reason: 'UNAVAILABLE_CONFIG_FAULT', safety: { CONFIG: 1 } },
    run: ctx => { const r = rig(ctx); playNext(r, { configFault: true, script: () => ({ kind: 'ERROR', code: 'ASK_REMOTE_UNAVAILABLE', settlement: 'RETAINED_KNOWN' }) }); return r; } },
  { id: 'X09_REMOTE_INVALID_FAILED_SCHEMA', expected: { state: 'TERMINAL_FAILED', reason: 'ASK_REMOTE_INVALID', safety: { SCHEMA: 1 } },
    run: ctx => { const r = rig(ctx); playNext(r, { script: () => ({ kind: 'ERROR', code: 'ASK_REMOTE_INVALID', settlement: 'RETAINED_KNOWN' }) }); return r; } },
  { id: 'X10_MODEL_MISMATCH_FAILED', expected: { state: 'TERMINAL_FAILED', reason: 'ASK_REMOTE_MODEL_MISMATCH', safety: { MODEL_TIER: 1 } },
    run: ctx => { const r = rig(ctx); playNext(r, { script: () => ({ kind: 'ERROR', code: 'ASK_REMOTE_MODEL_MISMATCH', settlement: 'RETAINED_KNOWN' }) }); return r; } },
  { id: 'X11_USAGE_INVALID_FAILED', expected: { state: 'TERMINAL_FAILED', reason: 'ASK_REMOTE_USAGE_INVALID', safety: { USAGE: 1 } },
    run: ctx => { const r = rig(ctx); playNext(r, { script: () => ({ kind: 'ERROR', code: 'ASK_REMOTE_USAGE_INVALID', settlement: 'RETAINED_KNOWN' }) }); return r; } },
  { id: 'X12_ALTERED_FACT_CLAIM_SAFETY', expected: { state: 'TERMINAL_FAILED', reason: 'SAFETY_VIOLATION', safety: { CLAIMS: 1 }, lastOutcome: 'ANSWER' },
    run: ctx => { const r = rig(ctx); while (r.session.state === 'ACTIVE') playNext(r, { script: c => ({ kind: 'INTENT', intent: c.expectedIntent, tamper: 'OBSERVATION_SUMMARY' }) }); return r; } },
  { id: 'X13_V2_VALIDATOR_REJECT_IS_UNATTRIBUTED_HANDOFF', expected: { state: 'TERMINAL_INCOMPLETE', localReason: 'LOCAL_HANDOFF_UNVERIFIED', safety: {},
    lastOutcome: 'LOCAL_HANDOFF_UNVERIFIED', receipt: 'VERIFIED_SAVED_ARITHMETIC' },
    run: ctx => { const r = rig(ctx); playNext(r, { script: c => ({ kind: 'INTENT', intent: c.expectedIntent, tamper: 'DROP_PROVENANCE' }) }); return r; } },
  { id: 'X14_GROUNDED_WRONG_INTENT_SEMANTIC_ONLY', expected: { state: 'TERMINAL_FAILED', reason: 'THRESHOLD_UNREACHABLE', safety: {}, lastSemantic: 'MISMATCH' },
    run: ctx => { const r = rig(ctx); while (r.session.state === 'ACTIVE') playNext(r, { script: c => ({ kind: 'INTENT', intent: supported(c) ? OTHER[c.expectedIntent]! : c.expectedIntent }) }); return r; } },
  { id: 'X15_REFUSAL_ANSWERED_TRUTHFULLY_STILL_FAILS', expected: { state: 'TERMINAL_FAILED', reason: 'THRESHOLD_UNREACHABLE', safety: {}, lastSemantic: 'MISMATCH', lastPass: false },
    run: ctx => { const r = rig(ctx); playUntil(r, c => !supported(c)); playNext(r, { script: () => ({ kind: 'INTENT', intent: 'SUMMARY' }) }); return r; } },
  { id: 'X16_MISSING_LEDGER_UNKNOWN_COMMIT', expected: { state: 'TERMINAL_INCOMPLETE', localReason: 'ANSWER_LIABILITY_UNKNOWN', validatedAnswers: 0, lastPass: false },
    run: ctx => { const r = rig(ctx); playNext(r, { ledger: 'MISSING' }); return r; } },
  { id: 'X17_UNBOUND_LEDGER_UNKNOWN_COMMIT', expected: { state: 'TERMINAL_INCOMPLETE', localReason: 'ANSWER_LIABILITY_UNKNOWN', validatedAnswers: 0, lastPass: false },
    run: ctx => { const r = rig(ctx); playNext(r, { ledger: 'WRONG_CORRELATION' }); return r; } },
  { id: 'X18_DEADLINE_KNOWN_COMMIT_AND_BUSY_CONTINUE', expected: { state: 'ACTIVE', lastOutcome: 'ASK_BUSY', lastPass: false, safety: {} },
    run: ctx => { const r = rig(ctx); playUntil(r, supported); const group = caseOf(r, r.session.nextCaseId!).group;
      playNext(r, { script: () => ({ kind: 'ERROR', code: 'ASK_DEADLINE', settlement: 'RETAINED_KNOWN' }) });
      playUntil(r, c => supported(c) && c.group !== group);
      playNext(r, { script: () => ({ kind: 'ERROR', code: 'ASK_BUSY', settlement: 'NO_RESERVATION' }) }); return r; } },
  { id: 'X19_TIMEOUT_CENSORED_INCOMPLETE', expected: { state: 'TERMINAL_INCOMPLETE', reason: 'UNKNOWN_COMMIT', lastOutcome: 'SUPERVISOR_TIMEOUT' },
    run: ctx => { const r = rig(ctx); playNext(r, { script: () => ({ kind: 'TIMEOUT' }), latencyMs: 10_000 }); return r; } },
  { id: 'X20_CONCURRENT_REVISION_409_CONSUMED', expected: { state: 'TERMINAL_INCOMPLETE', reason: 'LOSS_OF_AUTHORITY', consumed: 1, lastOutcome: 'ASK_REMOTE_POLICY_CHANGED' },
    run: ctx => { const r = rig(ctx); const realAsk = r.fake.ask.bind(r.fake);
      r.fake.ask = (req, fx, script, utc) => { r.fake.revise(); return realAsk(req, fx, script, utc); }; playNext(r); return r; } },
  { id: 'X21_INACTIVE_PREFLIGHT_TERMINAL_UNCONSUMED', expected: { state: 'TERMINAL_INCOMPLETE', reason: 'LOSS_OF_AUTHORITY_INACTIVE_POLICY', consumed: 0 },
    run: ctx => { const r = rig(ctx); r.fake.pause(); playNext(r); return r; } },
  { id: 'X22_VERSION_CHANGED_RECONFIRM', expected: { state: 'ACTIVE', consumed: 1 },
    run: ctx => { const r = rig(ctx); r.fake.revise(); playNext(r); r.steps.push(`confirm:${r.session.confirmTuple(ADMISSION_ID, r.fake.tuple.policyVersion)}`); playNext(r); return r; } },
  { id: 'X23_STALE_CLOSURE_CONTAINMENT_UNCONFIRMED', expected: { state: 'TERMINAL_INCOMPLETE', closure: 'CONTAINMENT_UNCONFIRMED' },
    run: ctx => { const r = rig(ctx); playNext(r, { ledger: 'MISSING' }); closeWith(r, { admissionId: ADMISSION_ID, paused: 'true', policyVersion: '99', fenceEpoch: '40' }); return r; } },
  { id: 'X24_VOLUNTARY_PAUSE_CLOSURE_RESUME', expected: { state: 'ACTIVE', voluntary: 'NONE', consumed: 2 },
    run: ctx => { const r = rig(ctx); playNext(r); r.steps.push(`pause:${r.session.voluntaryPause()}`, `resume-unclosed:${r.session.resumeVoluntary()}`);
      closeWith(r, r.fake.pause()); r.steps.push(`resume:${r.session.resumeVoluntary()}`, `confirm-old:${r.session.confirmTuple(ADMISSION_ID, '7')}`);
      r.fake.reactivate(); r.steps.push(`confirm:${r.session.confirmTuple(ADMISSION_ID, r.fake.tuple.policyVersion)}`); playNext(r); return r; } },
  { id: 'X25_ARTIFACT_DRIFT_BEFORE_SUBMIT', expected: { state: 'TERMINAL_FAILED', reason: 'ARTIFACT_DRIFT', consumed: 0, integrity: ['ARTIFACT_DRIFT'] },
    run: ctx => { const r = rig(ctx); r.drift = true; playNext(r); return r; } },
  { id: 'X26_DUPLICATE_DISPATCH_IN_LEDGER', expected: { state: 'TERMINAL_FAILED', reason: 'DUPLICATE_DISPATCH', integrity: ['DUPLICATE_DISPATCH'] },
    run: ctx => { const r = rig(ctx); playNext(r, { script: c => ({ kind: 'INTENT', intent: c.expectedIntent, attempts: 2 }) }); return r; } },
  { id: 'X27_PACING_BLOCKS_UNCONSUMED', expected: { state: 'ACTIVE', consumed: 1, steps: ['confirm:CONFIRMED', 'outcome:ACTIVE', 'preflight:BLOCKED_PACING'] },
    run: ctx => { const r = rig(ctx, { pacingMax: 2 }); playNext(r); playNext(r, { gapMs: 1_000 }); return r; } },
  { id: 'X28_CONSENT_REQUIRES_CHALLENGE_AND_CHECKBOX', expected: { state: 'ACTIVE', consumed: 0, steps: ['consent:BLOCKED', 'consent:BLOCKED', 'consent-replay:BLOCKED', 'submit:BLOCKED_NO_CONSENT'] },
    run: ctx => { const r = rig(ctx); const s = r.session; const id = s.nextCaseId!; const c = caseOf(r, id);
      s.counters(r.fake.counters(r.clock.utcMs)); s.capability(r.fake.capability().http); s.stage(id, focusOf(r, c) ?? 'none', c.question);
      const n1 = s.consentChallenge(id); r.steps.push(`consent:${s.consent(id, 'wrong', true)}`);
      const n2 = s.consentChallenge(id); r.steps.push(`consent:${s.consent(id, n2, false)}`, `consent-replay:${s.consent(id, n1, true)}`, `submit:${s.submit(id)}`); return r; } },
  { id: 'X29_SETTLEMENT_KNOWN_CONTINUE_UNKNOWN_TERMINAL', expected: { state: 'TERMINAL_INCOMPLETE', localReason: 'ANSWER_LIABILITY_UNKNOWN', consumed: 2,
    validatedAnswers: 1, liability: { confirmedChargedMicro: 0, retainedReserveMicro: 600_000, unknownLiabilityCases: 0 } },
    run: ctx => { const r = rig(ctx); playNext(r, { script: c => ({ kind: 'INTENT', intent: c.expectedIntent, settlement: 'RETAINED_KNOWN' }) });
      playNext(r, { script: c => ({ kind: 'INTENT', intent: c.expectedIntent, settlement: 'RETAINED_UNKNOWN_COMMIT' }) }); return r; } },
  { id: 'X30_EXPIRY_BEFORE_SUBMIT', expected: { state: 'TERMINAL_INCOMPLETE', reason: 'ADMISSION_EXPIRED', consumed: 0 },
    run: ctx => { const r = rig(ctx, { expiryMs: START + HOUR }); advance(r, 2 * HOUR); playNext(r); return r; } },
  { id: 'X31_FRACTIONAL_OPERATOR_CLOCK_EXPORTS', expected: { state: 'ACTIVE', consumed: 3, receipt: 'VERIFIED_SAVED_ARITHMETIC' },
    run: ctx => { const r = rig(ctx, { clockOffsetMs: 0.375 }); playNext(r, { latencyMs: 700.125 }); playNext(r, { latencyMs: 1234.999, gapMs: 13_000.5 });
      playNext(r, { latencyMs: 0.25 }); return r; } },
  { id: 'X32_ANSWER_WITH_NO_RESERVATION_LEDGER', expected: { state: 'TERMINAL_INCOMPLETE', localReason: 'LEDGER_REPLY_CONTRADICTION', validatedAnswers: 0,
    lastPass: false, lastOutcome: 'LEDGER_REPLY_CONTRADICTION', liability: { confirmedChargedMicro: 0, retainedReserveMicro: 0, unknownLiabilityCases: 1 } },
    run: ctx => { const r = rig(ctx); playNext(r, { ledgerFn: l => ({ ...l, attempts: '0', settlement: 'NO_RESERVATION', chargedMicro: '0', dayChargedMicro: '0', monthChargedMicro: '0' }) }); return r; } },
  { id: 'X33_ANSWER_WITH_NO_DISPATCH_LEDGER', expected: { state: 'TERMINAL_INCOMPLETE', localReason: 'LEDGER_REPLY_CONTRADICTION', validatedAnswers: 0, lastPass: false },
    run: ctx => { const r = rig(ctx); playNext(r, { ledgerFn: l => ({ ...l, settlement: 'NO_DISPATCH', chargedMicro: '0', dayChargedMicro: '0', monthChargedMicro: '0' }) }); return r; } },
  { id: 'X34_RETAINED_RESERVE_ERASED_BY_COUNTERS', expected: { state: 'TERMINAL_INCOMPLETE', localReason: 'COUNTERS_BELOW_ACCOUNTED_FLOOR', consumed: 1,
    liability: { confirmedChargedMicro: 0, retainedReserveMicro: 300_000, unknownLiabilityCases: 0 } },
    run: ctx => { const r = rig(ctx); playNext(r, { script: c => ({ kind: 'INTENT', intent: c.expectedIntent, settlement: 'RETAINED_KNOWN' }) });
      playNext(r, { counters: () => ({ dayChargedMicro: '0', monthChargedMicro: '0' }) }); return r; } },
  { id: 'X35_DAY_ROLLOVER_RESETS_DAY_ONLY', expected: { state: 'ACTIVE', consumed: 2, receipt: 'VERIFIED_SAVED_ARITHMETIC',
    liability: { confirmedChargedMicro: 337, retainedReserveMicro: 300_000, unknownLiabilityCases: 0 } },
    run: ctx => { const r = rig(ctx); playNext(r, { script: c => ({ kind: 'INTENT', intent: c.expectedIntent, settlement: 'RETAINED_KNOWN' }) });
      advance(r, 24 * HOUR); playNext(r); return r; } },
  { id: 'X36_MONTH_FLOOR_NEVER_RESETS', expected: { state: 'TERMINAL_INCOMPLETE', localReason: 'COUNTERS_BELOW_ACCOUNTED_FLOOR', consumed: 1 },
    run: ctx => { const r = rig(ctx); playNext(r, { script: c => ({ kind: 'INTENT', intent: c.expectedIntent, settlement: 'RETAINED_KNOWN' }) });
      advance(r, 24 * HOUR); playNext(r, { counters: () => ({ dayChargedMicro: '0', monthChargedMicro: '0' }) }); return r; } },
  { id: 'X37_BEFORE_ADMISSION_START_BLOCKED', expected: { state: 'ACTIVE', consumed: 0, steps: ['confirm:CONFIRMED', 'counters:BLOCKED_BEFORE_ADMISSION_START'] },
    run: ctx => { const r = rig(ctx, { clockOffsetMs: -24 * HOUR }); playNext(r, { gapMs: 0 }); return r; } },
  { id: 'X38_VOLUNTARY_FENCE_REUSED_BY_DAY_CLOSURE', expected: { state: 'RESUMABLE_DAY', closure: 'CONTAINMENT_UNCONFIRMED',
    steps: ['outcome:ACTIVE', 'submit:STOPPED', 'closure:CONTAINMENT_UNCONFIRMED', 'resume:RESUME_DENIED_CONTAINMENT'] },
    run: ctx => { const r = rig(ctx, { dayCap: 600_000 });
      const retained = { script: (c: EvalCase): FakeScript => ({ kind: 'INTENT', intent: c.expectedIntent, settlement: 'RETAINED_KNOWN' }) };
      playNext(r, retained); r.session.voluntaryPause(); const v = r.fake.pause(); r.session.closure(v); r.session.resumeVoluntary();
      r.fake.reactivate(); r.session.confirmTuple(ADMISSION_ID, r.fake.tuple.policyVersion); playNext(r, retained); playNext(r);
      closeWith(r, { admissionId: ADMISSION_ID, paused: 'true', policyVersion: '50', fenceEpoch: v.fenceEpoch });
      advance(r, 24 * HOUR); r.steps.push(`resume:${r.session.resumeDay()}`); return r; } },
  { id: 'X39_CLOSURE_ABOVE_SIGNED_64_BIT', expected: { voluntary: 'CONTAINMENT_UNCONFIRMED', closure: 'CONTAINMENT_UNCONFIRMED' },
    run: ctx => { const r = rig(ctx); r.session.voluntaryPause();
      closeWith(r, { admissionId: ADMISSION_ID, paused: 'true', policyVersion: '9223372036854775808', fenceEpoch: '9223372036854775808' }); return r; } },
  { id: 'X40_UNRECORDED_CLICK_CONSUMED_INTEGRITY', expected: { state: 'TERMINAL_FAILED', localReason: 'UNRECORDED_CLICK', consumed: 1, integrity: ['UNRECORDED_CLICK'],
    lastOutcome: 'UNRECORDED_CLICK', receipt: 'VERIFIED_SAVED_ARITHMETIC' },
    run: ctx => { const r = rig(ctx); r.steps.push(`click:${r.session.unrecordedClick(r.session.nextCaseId)}`); return r; } },
  { id: 'X41_ABANDONED_IN_FLIGHT', expected: { state: 'TERMINAL_INCOMPLETE', localReason: 'ABANDONED_IN_FLIGHT', closure: 'PENDING', consumed: 1,
    lastOutcome: 'ABANDONED_IN_FLIGHT', receipt: 'VERIFIED_SAVED_ARITHMETIC' },
    run: ctx => { const r = rig(ctx); const s = r.session; const id = s.nextCaseId!; const c = caseOf(r, id);
      s.counters(r.fake.counters(r.clock.utcMs)); s.capability(r.fake.capability().http); s.stage(id, focusOf(r, c) ?? 'none', c.question);
      s.consent(id, s.consentChallenge(id), true); r.steps.push(`submit:${s.submit(id)}`, `abandon:${s.abandonInFlight()}`); return r; } },
  { id: 'X42_REPASTED_CAPABILITY_REJECTED', expected: { state: 'ACTIVE', consumed: 1, steps: ['confirm:CONFIRMED', 'outcome:ACTIVE', 'error:CORRELATION_REUSED'] },
    run: ctx => { const r = rig(ctx); const old = r.fake.capability().http; playNext(r, { capability: old }); playNext(r, { capability: old }); return r; } },
  { id: 'X43_UNPARSED_REQUEST_IS_UNATTRIBUTED_HANDOFF', expected: { state: 'TERMINAL_INCOMPLETE', localReason: 'LOCAL_HANDOFF_UNVERIFIED', safety: {}, lastPass: false },
    run: ctx => { const r = rig(ctx); playNext(r, { request: () => '{"contractVersion":"AskRequestV2"}' }); return r; } },
  { id: 'X44_AUTHENTIC_MODEL_MISMATCH_WITH_CONTRADICTORY_LEDGER', expected: { state: 'TERMINAL_FAILED', reason: 'ASK_REMOTE_MODEL_MISMATCH',
    localReason: 'LEDGER_REPLY_CONTRADICTION', safety: { MODEL_TIER: 1 } },
    run: ctx => { const r = rig(ctx); playNext(r, { script: () => ({ kind: 'ERROR', code: 'ASK_REMOTE_MODEL_MISMATCH', settlement: 'NO_RESERVATION' }) }); return r; } },
  { id: 'X45_FALSE_CLAIM_WITH_CONTRADICTORY_LEDGER_STAYS_FAILED', expected: { state: 'TERMINAL_FAILED', localReason: 'SAFETY_VIOLATION_UNDER_CONTRADICTORY_LEDGER',
    safety: { CLAIMS: 1 }, lastOutcome: 'LEDGER_REPLY_CONTRADICTION', lastPass: false, receipt: 'VERIFIED_SAVED_ARITHMETIC' },
    run: ctx => { const r = rig(ctx); playUntil(r, c => r.ctx.corpus.fixtures.get(c.fixtureId)!.spec.expected.bank.some(id => id.startsWith('O:')));
      playNext(r, { script: c => ({ kind: 'INTENT', intent: c.expectedIntent, tamper: 'OBSERVATION_SUMMARY' }), ledgerFn: CONTRADICT }); return r; } },
  { id: 'X46_REFUSAL_MISMATCH_WITH_CONTRADICTORY_LEDGER_STAYS_FAILED', expected: { state: 'TERMINAL_FAILED', localReason: 'THRESHOLD_UNREACHABLE_UNDER_CONTRADICTORY_LEDGER',
    safety: {}, lastSemantic: 'MISMATCH', lastPass: false, validatedAnswers: 0, receipt: 'VERIFIED_SAVED_ARITHMETIC' },
    run: ctx => { const r = rig(ctx); playUntil(r, c => !supported(c)); playNext(r, { script: () => ({ kind: 'INTENT', intent: 'SUMMARY' }), ledgerFn: CONTRADICT }); return r; } },
  { id: 'X47_FIRST_SUPPORTED_MISMATCH_WITH_CONTRADICTION_INCOMPLETE', expected: { state: 'TERMINAL_INCOMPLETE', localReason: 'LEDGER_REPLY_CONTRADICTION',
    safety: {}, lastSemantic: 'MISMATCH', lastPass: false },
    run: ctx => { const r = rig(ctx); playUntil(r, supported); playNext(r, { script: c => ({ kind: 'INTENT', intent: OTHER[c.expectedIntent]! }), ledgerFn: CONTRADICT }); return r; } },
  { id: 'X48_PRESTART_COUNTERS_DO_NOT_POISON_MONTH_FLOOR', expected: { state: 'ACTIVE', consumed: 1, localReason: null },
    run: ctx => { const r = rig(ctx, { clockOffsetMs: -12 * 24 * HOUR }); playNext(r, { gapMs: 0, counters: () => ({ dayChargedMicro: '900', monthChargedMicro: '900' }) });
      advance(r, 12 * 24 * HOUR); playNext(r); return r; } },
  { id: 'X49_REFUSAL_MISMATCH_UNRECONCILED_STAYS_FAILED', expected: { state: 'TERMINAL_FAILED', localReason: 'THRESHOLD_UNREACHABLE_UNDER_UNKNOWN_LIABILITY',
    validatedAnswers: 0, lastPass: false, lastSemantic: 'MISMATCH', receipt: 'VERIFIED_SAVED_ARITHMETIC' },
    run: ctx => { const r = rig(ctx); playUntil(r, c => !supported(c)); playNext(r, { script: () => ({ kind: 'INTENT', intent: 'SUMMARY' }), ledgerFn: UNRECONCILE }); return r; } },
  { id: 'X50_GROUNDED_MATCH_UNRECONCILED_NO_CREDIT', expected: { state: 'TERMINAL_INCOMPLETE', localReason: 'ANSWER_LIABILITY_UNKNOWN', validatedAnswers: 0,
    lastPass: false, lastSemantic: 'MATCH', receipt: 'VERIFIED_SAVED_ARITHMETIC' },
    run: ctx => { const r = rig(ctx); playNext(r, { ledgerFn: UNRECONCILE }); return r; } },
  { id: 'X51_SECOND_SUPPORTED_MISMATCH_UNKNOWN_STAYS_FAILED', expected: { state: 'TERMINAL_FAILED', localReason: 'THRESHOLD_UNREACHABLE_UNDER_UNKNOWN_LIABILITY',
    lastPass: false, lastSemantic: 'MISMATCH', receipt: 'VERIFIED_SAVED_ARITHMETIC' },
    run: ctx => { const r = rig(ctx); playUntil(r, supported); const group = caseOf(r, r.session.nextCaseId!).group;
      playNext(r, { script: c => ({ kind: 'INTENT', intent: OTHER[c.expectedIntent]! }) });
      playUntil(r, c => c.group === group); playNext(r, { script: c => ({ kind: 'INTENT', intent: OTHER[c.expectedIntent]! }), ledger: 'MISSING' }); return r; } }
,
  ...(['ASK_REMOTE_INVALID', 'ASK_REMOTE_MODEL_MISMATCH', 'ASK_REMOTE_USAGE_INVALID'] as const).map((code, k): Scenario => ({
    id: `X5${2 + k}_${code}_WITH_UNPARSED_REQUEST_STAYS_FAILED`,
    expected: { state: 'TERMINAL_FAILED', reason: code, localReason: 'LOCAL_HANDOFF_UNVERIFIED', lastOutcome: code,
      safety: { [code === 'ASK_REMOTE_INVALID' ? 'SCHEMA' : code === 'ASK_REMOTE_MODEL_MISMATCH' ? 'MODEL_TIER' : 'USAGE']: 1 }, receipt: 'VERIFIED_SAVED_ARITHMETIC' },
    run: ctx => { const r = rig(ctx); playNext(r, { script: () => ({ kind: 'ERROR', code, settlement: 'RETAINED_KNOWN' }), request: UNPARSED_REQUEST }); return r; } })),
  { id: 'X55_UNAVAILABLE_CONFIG_FAULT_WITH_UNPARSED_REQUEST_STAYS_FAILED', expected: { state: 'TERMINAL_FAILED', reason: 'UNAVAILABLE_CONFIG_FAULT',
    localReason: 'LOCAL_HANDOFF_UNVERIFIED', safety: { CONFIG: 1 }, receipt: 'VERIFIED_SAVED_ARITHMETIC' },
    run: ctx => { const r = rig(ctx); playNext(r, { configFault: true, request: UNPARSED_REQUEST,
      script: () => ({ kind: 'ERROR', code: 'ASK_REMOTE_UNAVAILABLE', settlement: 'RETAINED_KNOWN' }) }); return r; } },
  { id: 'X56_BUSY_WITH_UNPARSED_REQUEST_INCOMPLETE', expected: { state: 'TERMINAL_INCOMPLETE', localReason: 'LOCAL_HANDOFF_UNVERIFIED', lastOutcome: 'ASK_BUSY',
    safety: {}, receipt: 'VERIFIED_SAVED_ARITHMETIC' },
    run: ctx => { const r = rig(ctx); playUntil(r, supported);
      playNext(r, { request: UNPARSED_REQUEST, script: () => ({ kind: 'ERROR', code: 'ASK_BUSY', settlement: 'NO_RESERVATION' }) }); return r; } }
];

/** Run every scenario once; `pass` compares only the expected keys (JSON equality). */
export function runScenarios(ctx: Ctx): { id: string; pass: boolean; observed: Record<string, unknown> }[] {
  return SCENARIOS.map(s => {
    const observed = observe(s.run(ctx));
    return { id: s.id, pass: Object.entries(s.expected).every(([k, v]) => JSON.stringify(observed[k]) === JSON.stringify(v)), observed };
  });
}
/** Rehearsal: all scenarios twice with fresh fakes/sessions + the full-run safe receipt; replay must be byte-identical. */
export function rehearse(): Record<string, unknown> {
  const ctx = loadContext();
  const once = () => { const results = runScenarios(ctx); const full = rig(ctx); for (let i = 0; i < 200; i += 1) playNext(full); closeWith(full, full.fake.pause());
    return { results, receipt: buildReceipt(full.session, ctx.cases) }; };
  const first = once(); const second = once();
  const replay = JSON.stringify(first) === JSON.stringify(second) ? 'DETERMINISTIC_REHEARSAL_REPLAY_VERIFIED' : 'REPLAY_MISMATCH';
  const ok = ctx.snapshot.ok && first.results.every(r => r.pass && r.observed.receipt === 'VERIFIED_SAVED_ARITHMETIC') && replay === 'DETERMINISTIC_REHEARSAL_REPLAY_VERIFIED';
  return { command: 'rehearse', ok, runClass: 'OFFLINE_FAKE_V2_REHEARSAL', semanticEvaluation: false, providerSemantics: 'NOT_TESTED',
    liveAcceptanceEligible: false, note: 'SIMULATED fake V2/ledger/clock; proves instrument measurement/assertion integration, not provider, server authority or ledger.',
    scenarios: { total: first.results.length, pass: first.results.filter(r => r.pass).length, results: first.results }, replay, fullRunReceipt: first.receipt };
}
