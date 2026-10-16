// One R-EVAL execution session: the ACCEPTED supervisor model (scripts/ask-remote-eval/supervisor.ts, unchanged and
// still not product authority) wrapped with the inputs a manual run actually has: operator-entered admission/counters/
// ledger/closure values (ATTESTED), transient V2 request/reply pastes validated by the accepted validators, artifact
// identity re-checked before every submission, a per-case consent challenge, ONE closure floor, a liability book and
// safety evidence with provenance. Every method returns a fixed result code or throws ExecError(code) WITHOUT changing
// state. Nothing here sends a request, consents, submits, retries or schedules: each step is an explicit call made by the
// operator (TTY) or, in the offline rehearsal only, by a scripted driver whose receipts are labelled SIMULATED.
// Clocks are canonicalised to integer milliseconds (floor) at this boundary, so durations are exact non-negative integers.
import { Supervisor, utcDay, utcMonth } from '../ask-remote-eval/supervisor.ts';
import type { Admission, Clock, FrozenCase, Outcome, RunState, Settlement } from '../ask-remote-eval/supervisor.ts';
import type { EvalCase } from '../ask-remote-eval/dataset.ts';
import type { FixtureFile } from '../ask-remote-eval/fixtures.ts';
import type { PreparedFixture } from '../ask-remote-eval/harness.ts';
import { sameIdentity } from './artifact.ts';
import type { Snapshot } from './artifact.ts';
import { LiabilityBook, ledgerMatchesReply, replyClassOf } from './book.ts';
import type { Totals } from './book.ts';
import { ClosureFloor } from './closure.ts';
import type { ClosureEntry } from './closure.ts';
import { checkCapability, checkRequest, checkResponse } from './transient.ts';
import type { CaseContext, HandoffDetail, Observed, Truth, TransientHttp, Tuple } from './transient.ts';
import { admissionValues, caseId as validCaseId, counterValues, decimal, ExecError, focusId, ledgerValues, reject, transientText, uuid } from './validate.ts';
import type { AdmissionInput, CountersInput, Ledger, LedgerInput } from './validate.ts';

export type RunClass = 'OFFLINE_FAKE_V2_REHEARSAL' | 'UNADMITTED_LOCAL_OBSERVATION';
export interface Corpus {
  readonly cases: ReadonlyMap<string, EvalCase>; readonly order: readonly string[]; readonly fixtures: ReadonlyMap<string, PreparedFixture>;
  readonly scope: FixtureFile['scope'];
}
export interface SessionDeps { readonly runClass: RunClass; readonly clock: () => Clock; readonly verify: () => Snapshot; readonly nonce: () => string; readonly corpus: Corpus }

export const SAFETY = ['SCHEMA', 'MODEL_TIER', 'USAGE', 'AUTHORITY', 'EGRESS', 'PRIVACY', 'CLAIMS', 'COVERAGE', 'URGENCY', 'CONFIG'] as const;
export type SafetyRow = typeof SAFETY[number];
export const LOCAL_REASONS = ['LOCAL_HANDOFF_UNVERIFIED', 'LEDGER_REPLY_CONTRADICTION', 'ABANDONED_IN_FLIGHT', 'UNRECORDED_CLICK',
  'COUNTERS_BELOW_ACCOUNTED_FLOOR', 'CLOCK_REGRESSION', 'MONTH_BUCKET_CHANGED',
  'SAFETY_VIOLATION_UNDER_CONTRADICTORY_LEDGER', 'THRESHOLD_UNREACHABLE_UNDER_CONTRADICTORY_LEDGER',
  'ANSWER_LIABILITY_UNKNOWN', 'SAFETY_VIOLATION_UNDER_UNKNOWN_LIABILITY', 'THRESHOLD_UNREACHABLE_UNDER_UNKNOWN_LIABILITY'] as const;
export type LocalReason = typeof LOCAL_REASONS[number];
export interface CaseEvidence {
  readonly correlationId: string | null; readonly submittedPolicyVersion: string; readonly utcDay: number; readonly preDayMicro: number; readonly preMonthMicro: number;
  readonly ledger: 'BOUND' | 'MISSING' | 'UNBOUND' | 'CONTRADICTS_REPLY'; readonly ledgerAttempts: number | null; readonly ledgerSettlement: Settlement | null;
  readonly chargedMicro: number | null; readonly postDayMicro: number | null; readonly postMonthMicro: number | null;
  readonly reconciliation: 'RECONCILED' | 'UNRECONCILED' | 'UNKNOWN';
  readonly text: 'REQUEST_MATCHED' | 'REQUEST_DEVIATION' | 'OPERATOR_REPORTED_DEVIATION' | 'REQUEST_UNVERIFIED';
  readonly reply: 'V2_ANSWER_VALID' | 'ERROR_ENVELOPE_VALID' | 'LOCAL_HANDOFF_UNVERIFIED' | 'TIMEOUT' | 'ABANDONED' | 'NOT_OBSERVED';
  readonly handoffDetail: HandoffDetail | null; readonly truth: Omit<Truth, 'pass'> | null; readonly localOutcome: LocalReason | null; readonly configFaultAttested: boolean;
  /** Semantic result of a validated answer with unknown/contradicted liability (the supervisor saw a no-credit error); else null. */
  readonly semantic: 'MATCH' | 'MISMATCH' | null;
}
export type Voluntary = 'NONE' | 'PENDING' | 'CONFIRMED' | 'CONTAINMENT_UNCONFIRMED';
export type ClosureState = 'NOT_REQUIRED' | 'PENDING' | 'CONFIRMED' | 'CONTAINMENT_UNCONFIRMED';
export interface OutcomeInput {
  readonly request: unknown; readonly reply: TransientHttp | 'TIMEOUT'; readonly replyUnparseable?: boolean;
  readonly ledger: LedgerInput | null; readonly configFaultAttested?: boolean;
}
interface InFlight { caseId: string; tuple: Tuple; pre: { dayChargedMicro: number; monthChargedMicro: number }; utcMs: number; arrived: Clock | null }
const RANK: Readonly<Record<RunState, number>> = { ACTIVE: 0, RESUMABLE_DAY: 1, COMPLETE_PENDING_REVIEW: 1, TERMINAL_INCOMPLETE: 2, TERMINAL_FAILED: 3 };

export class ExecutionSession {
  readonly runClass: RunClass; readonly admission: Admission; readonly start: Snapshot;
  readonly #d: SessionDeps; readonly #sup: Supervisor; readonly #consumed = new Set<string>(); readonly #seen = new Set<string>();
  #tuple: Tuple | null = null; #staged: string | null = null; #challenge: { caseId: string; nonce: string } | null = null; #consented: string | null = null;
  #counters: { dayChargedMicro: number; monthChargedMicro: number; utcDay: number } | null = null; #inFlight: InFlight | null = null;
  readonly #closures: ClosureFloor; #closure: ClosureState = 'NOT_REQUIRED'; #lastState: RunState = 'ACTIVE'; #voluntary: Voluntary = 'NONE'; #voluntaryPauses = 0;
  #local: { state: RunState; reason: LocalReason } | null = null; readonly #book = new LiabilityBook();
  readonly #evidence = new Map<string, CaseEvidence>(); readonly #extra: { caseId: string; outcome: 'UNRECORDED_CLICK' }[] = [];
  readonly #safety = new Map<SafetyRow, number>(SAFETY.map(s => [s, 0])); #compared = 0; #handoff = 0; #preSubmitChecks = 0; readonly #integrity: string[] = [];

  constructor(deps: SessionDeps, input: AdmissionInput) {
    const start = deps.verify();
    if (!start.ok || start.identity === null) reject('ARTIFACT_IDENTITY_NOT_VERIFIED');
    const v = admissionValues(input);
    const id = start.identity!;
    this.admission = { admissionId: v.admissionId, startUtcMs: v.startUtcMs, expiryUtcMs: v.expiryUtcMs, dayCapMicro: v.dayCapMicro, monthCapMicro: v.monthCapMicro,
      reserveMicro: 300_000, datasetSha256: id.datasetCorpusSha256, fixtureSha256: id.fixtureSha256, orderSha256: id.orderSha256, manualRerunAllowance: 0,
      pacingMax: v.pacingMax, pacingWindowMs: 60_000, openingFenceEpoch: v.openingFenceEpoch };
    const frozen = new Map<string, FrozenCase>([...deps.corpus.cases].map(([k, c]) => [k, { question: c.question, hasFocus: c.hasFocus, fixtureId: c.fixtureId,
      expectedIntent: c.expectedIntent, supportedGroup: c.group.startsWith('SUPPORTED_') ? c.group : null }]));
    try { this.#sup = new Supervisor(this.admission, frozen, deps.corpus.order, () => this.#counters ?? reject('NO_COUNTERS')); }
    catch { throw new ExecError('ADMISSION_INVALID'); }
    this.runClass = deps.runClass; this.start = start; this.#d = deps; this.#closures = new ClosureFloor(v.openingFenceEpoch);
  }

  /** Effective run state: the supervisor's, escalated by any local stop (never lowered). */
  get state(): RunState { return this.#local && RANK[this.#local.state] > RANK[this.#sup.state] ? this.#local.state : this.#sup.state; }
  get closureState(): ClosureState { return this.#closures.containment ? 'CONTAINMENT_UNCONFIRMED' : this.#closure; }
  get voluntary(): Voluntary { return this.#voluntary; }
  get nextCaseId(): string | null { return this.#sup.nextCaseId; }
  get inFlight(): string | null { return this.#inFlight?.caseId ?? null; }
  nextSetup(): { caseId: string; fixtureId: string; requestedFocus: string | null } | null {
    const id = this.#sup.nextCaseId; if (id === null) return null;
    const c = this.#d.corpus.cases.get(id)!;
    return { caseId: id, fixtureId: c.fixtureId, requestedFocus: this.#d.corpus.fixtures.get(c.fixtureId)!.spec.requestedFocus };
  }
  /** Canonical integer-millisecond clock (floor keeps monotonic order); a non-finite or negative sample is refused. */
  #now(): Clock {
    const c = this.#d.clock();
    if (!Number.isFinite(c.utcMs) || !Number.isFinite(c.monoMs) || c.utcMs < 0 || c.monoMs < 0) reject('CLOCK_INVALID');
    return { utcMs: Math.floor(c.utcMs), monoMs: Math.floor(c.monoMs) };
  }
  /** Local wall-clock admission window (LOCAL_PROCESS_WALL_CLOCK_UNVERIFIED): start ≤ now < expiry, inside the admitted month. */
  #window(now: Clock): string | null {
    if (now.utcMs >= this.admission.expiryUtcMs) return 'ADMISSION_EXPIRED';
    if (now.utcMs < this.admission.startUtcMs) return 'BEFORE_ADMISSION_START';
    return utcMonth(now.utcMs) !== utcMonth(this.admission.startUtcMs) ? 'OUTSIDE_ADMITTED_MONTH' : null;
  }
  #ctx(id: string): CaseContext { const frozen = this.#d.corpus.cases.get(id)!; return { frozen, fixture: this.#d.corpus.fixtures.get(frozen.fixtureId)!, scope: this.#d.corpus.scope }; }
  #paused(): boolean { return this.#voluntary !== 'NONE'; }
  #clearCase(): void { this.#staged = null; this.#challenge = null; this.#consented = null; }
  /** Any escalation of the effective state opens a (new) closure requirement unless containment is already unconfirmed. */
  #sync(): void {
    const s = this.state;
    if (RANK[s] > RANK[this.#lastState] && this.#closure !== 'CONTAINMENT_UNCONFIRMED') this.#closure = 'PENDING';
    this.#lastState = s;
  }
  #stopLocal(state: RunState, reason: LocalReason): void {
    if (!this.#local || RANK[state] > RANK[this.#local.state]) this.#local = { state, reason };
    this.#clearCase(); this.#counters = null; this.#sync();
  }
  #idle(): boolean { return this.state === 'ACTIVE' && this.#inFlight === null && !this.#paused(); }

  confirmTuple(admissionId: unknown, policyVersion: unknown): string {
    const a = uuid(admissionId, 'ADMISSION_ID_INVALID'); const p = decimal(policyVersion, 'POLICY_VERSION_INVALID');
    if (this.#paused()) return 'BLOCKED_VOLUNTARY_PAUSE';
    if (!this.#idle()) return 'BLOCKED';
    if (BigInt(p) <= this.#closures.pauseVersion) return 'BLOCKED_NOT_NEWER_THAN_PAUSE';
    const r = this.#sup.confirmCapability({ active: true, admissionId: a, policyVersion: p });
    this.#clearCase();
    if (r === 'CONFIRMED') { this.#tuple = { admissionId: a, policyVersion: p }; this.#closures.observe(p); }
    return r;
  }

  /** Read-only capability observation before EVERY submission (counted in pacing). A re-pasted reply (seen correlation)
   * is refused; that guards against stale pastes only and proves no server freshness. */
  capability(http: TransientHttp): string {
    if (this.#paused()) return 'BLOCKED_VOLUNTARY_PAUSE';
    if (!this.#idle()) return 'BLOCKED';
    // Expiry is not blocked here: the next submit lets the supervisor end the run TERMINAL_INCOMPLETE (ADMISSION_EXPIRED).
    const now = this.#now(); const w = this.#window(now);
    if (w !== null && w !== 'ADMISSION_EXPIRED') return `BLOCKED_${w}`;
    const c = checkCapability(http);
    if (c.kind !== 'UNAVAILABLE') { if (this.#seen.has(c.correlationId)) reject('CORRELATION_REUSED'); this.#seen.add(c.correlationId); }
    const observed = c.kind === 'ACTIVE' ? { active: true, ...c.tuple } : c.kind === 'INACTIVE' ? { active: false, admissionId: this.admission.admissionId, policyVersion: '' } : 'UNAVAILABLE' as const;
    if (c.kind === 'ACTIVE') this.#closures.observe(c.tuple.policyVersion);
    const r = this.#sup.preflight(now, observed);
    if (r === 'BLOCKED_VERSION_CHANGED') { this.#tuple = null; this.#clearCase(); }
    this.#sync();
    return r;
  }

  stage(id: unknown, focus: unknown, pasted: unknown): string {
    const caseId = validCaseId(id); const requested = focusId(focus); const text = transientText(pasted, 'PASTE_REJECTED');
    if (this.#paused()) return 'BLOCKED_VOLUNTARY_PAUSE';
    if (!this.#idle()) return 'BLOCKED';
    if (!this.#d.corpus.cases.has(caseId)) return 'BLOCKED_UNKNOWN_CASE';
    const c = this.#d.corpus.cases.get(caseId)!;
    const focusOk = requested === this.#d.corpus.fixtures.get(c.fixtureId)!.spec.requestedFocus;
    this.#clearCase();
    // A focus mismatch still goes through the supervisor with a non-matching fixture so ITS staged/consent state is cleared too.
    const r = this.#sup.stage(caseId, text, c.hasFocus, focusOk ? c.fixtureId : '#FOCUS_MISMATCH');
    if (r === 'STAGED') this.#staged = caseId;
    return r;
  }
  consentChallenge(id: unknown): string {
    const caseId = validCaseId(id);
    if (!this.#idle() || this.#staged !== caseId || this.#tuple === null) return reject('CONSENT_NOT_AVAILABLE');
    this.#challenge = { caseId, nonce: this.#d.nonce() }; this.#consented = null;
    return this.#challenge.nonce;
  }
  consent(id: unknown, typedNonce: unknown, checkboxTickedManually: unknown): string {
    const caseId = validCaseId(id); const challenge = this.#challenge; this.#challenge = null;
    if (checkboxTickedManually !== true || challenge === null || challenge.caseId !== caseId || typedNonce !== challenge.nonce || this.#tuple === null || !this.#idle()) return 'BLOCKED';
    const r = this.#sup.consent(caseId, this.#tuple);
    if (r === 'CONSENTED') this.#consented = caseId;
    return r;
  }

  /** Current DAY/MONTH accounted spend read immediately before this submission. Below an accounted floor of the same
   * bucket (or a clock/month regression) is an UNKNOWN external reconciliation: the run stops TERMINAL_INCOMPLETE. */
  counters(input: CountersInput): string {
    const c = counterValues(input, { day: this.admission.dayCapMicro, month: this.admission.monthCapMicro });
    if (!this.#idle()) return 'BLOCKED';
    const now = this.#now(); const w = this.#window(now);
    // Before start / outside the admitted month nothing is recorded, so no pre-start month floor can poison the run.
    if (w !== null && w !== 'ADMISSION_EXPIRED') return `BLOCKED_${w}`;
    const check = this.#book.checkCounters(now.utcMs, c);
    if (check !== 'OK') { this.#stopLocal('TERMINAL_INCOMPLETE', check); return `STOPPED_${check}`; }
    this.#counters = { ...c, utcDay: utcDay(now.utcMs) };
    return 'RECORDED';
  }

  /** GO/NO-GO gate: only 'DISPATCH' means the case is consumed and the operator may click Ask (after the receipt is
   * persisted). Every other result means DO NOT CLICK; nothing was consumed unless the result says integrity/STOPPED. */
  submit(id: unknown): string {
    const caseId = validCaseId(id);
    if (this.#consumed.has(caseId)) return this.#duplicate();
    if (this.#paused()) return 'BLOCKED_VOLUNTARY_PAUSE';
    if (!this.#idle()) return 'BLOCKED';
    const now = this.#now(); const w = this.#window(now);
    if (w !== null && w !== 'ADMISSION_EXPIRED') return `BLOCKED_${w}`;
    this.#preSubmitChecks += 1;
    if (!sameIdentity(this.start, this.#d.verify())) { this.#integrity.push('ARTIFACT_DRIFT'); this.#sup.integrityViolation('ARTIFACT_DRIFT'); this.#sync(); return 'INTEGRITY_ARTIFACT_DRIFT'; }
    if (this.#counters === null) return 'BLOCKED_NO_COUNTERS';
    if (this.#counters.utcDay !== utcDay(now.utcMs)) { this.#counters = null; return 'BLOCKED_COUNTERS_STALE_DAY'; }
    if (this.#consented !== caseId || this.#tuple === null) return 'BLOCKED_NO_CONSENT';
    const pre = { dayChargedMicro: this.#counters.dayChargedMicro, monthChargedMicro: this.#counters.monthChargedMicro };
    const r = this.#sup.submit(now, caseId, this.#d.corpus.cases.get(caseId)!.question);
    if (r === 'DISPATCH') {
      this.#consumed.add(caseId); this.#inFlight = { caseId, tuple: this.#tuple, pre, utcMs: now.utcMs, arrived: null };
      this.#counters = null; this.#clearCase();
    }
    this.#sync();
    return r;
  }
  #duplicate(): string {
    this.#integrity.push('DUPLICATE_SUBMISSION'); this.#sup.integrityViolation('DUPLICATE_DISPATCH'); this.#sync();
    return 'INTEGRITY_DUPLICATE_SUBMISSION';
  }
  /** The operator clicked Ask WITHOUT a GO for this case (or again): the paid attempt is recorded as consumed with UNKNOWN
   * liability and the run fails integrity permanently. Never a retry path. */
  unrecordedClick(id: unknown): string {
    const caseId = validCaseId(id);
    if (!this.#d.corpus.cases.has(caseId)) return 'BLOCKED_UNKNOWN_CASE';
    if (this.#consumed.has(caseId)) return this.#duplicate();
    this.#consumed.add(caseId); this.#extra.push({ caseId, outcome: 'UNRECORDED_CLICK' }); this.#book.unknown();
    this.#integrity.push('UNRECORDED_CLICK'); this.#stopLocal('TERMINAL_FAILED', 'UNRECORDED_CLICK');
    return 'INTEGRITY_UNRECORDED_CLICK';
  }

  arrived(id: unknown): string {
    const caseId = validCaseId(id);
    if (this.#inFlight?.caseId !== caseId) return 'BLOCKED_NOT_IN_FLIGHT';
    if (this.#inFlight.arrived !== null) return 'BLOCKED_ALREADY_ARRIVED';
    this.#inFlight.arrived = this.#now();
    return 'RECORDED';
  }

  /** Record the in-flight case. Input errors throw (nothing recorded); afterwards the case is recorded exactly once. */
  outcome(id: unknown, input: OutcomeInput): RunState | 'BLOCKED_NOT_IN_FLIGHT' | 'BLOCKED_NOT_ARRIVED' {
    const caseId = validCaseId(id); const f = this.#inFlight;
    if (f === null || f.caseId !== caseId) return 'BLOCKED_NOT_IN_FLIGHT';
    if (input.reply !== 'TIMEOUT' && f.arrived === null) return 'BLOCKED_NOT_ARRIVED';
    const ctx = this.#ctx(caseId);
    const request = checkRequest(input.request, ctx, f.tuple);
    let observed: Observed | null = input.reply === 'TIMEOUT' ? null : checkResponse(input.reply, ctx, request.requestId, input.replyUnparseable === true);
    // An unparsed request paste cannot attribute an ANSWER (checkResponse already returns REQUEST_UNPARSED for it), but a
    // validated ERROR envelope does not depend on the request: its code, correlation and safety tally are kept, the text is
    // REQUEST_UNVERIFIED, and the local handoff uncertainty still stops the run INCOMPLETE unless the code proves FAILED.
    const requestUnverified = !request.parsed && observed?.kind === 'ERROR';
    const correlation = observed !== null && observed.kind !== 'LOCAL_HANDOFF_UNVERIFIED' ? observed.correlationId : null;
    if (correlation !== null && this.#seen.has(correlation)) reject('CORRELATION_REUSED');
    const ledger: Ledger | null = input.ledger === null ? null : ledgerValues(input.ledger, { day: this.admission.dayCapMicro, month: this.admission.monthCapMicro });
    // ---- every input validated: from here on nothing throws and the case is recorded exactly once ----
    if (correlation !== null) this.#seen.add(correlation);
    const bound = ledger !== null && correlation !== null && ledger.correlationId === correlation;
    const replyClass = replyClassOf(observed?.kind === 'ANSWER' ? 'ANSWER' : observed?.kind === 'ERROR' ? 'ERROR' : 'NONE', observed?.kind === 'ERROR' ? observed.code : null);
    const consistent = bound && ledgerMatchesReply(replyClass, ledger);
    const reconciled = consistent && ledger.monthChargedMicro === f.pre.monthChargedMicro + ledger.chargedMicro && ledger.dayChargedMicro === f.pre.dayChargedMicro + ledger.chargedMicro;
    // Missing, unbound, contradictory or unreconciled metadata is an UNKNOWN settlement commit: reserve retained, run ends.
    const settlement: Settlement = reconciled ? ledger!.settlement : 'RETAINED_UNKNOWN_COMMIT';
    const commit = !reconciled || settlement === 'RETAINED_UNKNOWN_COMMIT' ? 'UNKNOWN' as const : ledger!.attempts === 0 ? 'NONE' as const : 'KNOWN' as const;
    const configFault = input.configFaultAttested === true && observed?.kind === 'ERROR' && observed.code === 'ASK_REMOTE_UNAVAILABLE';
    const contradiction = bound && !consistent;
    let local: LocalReason | null = null; let result: Outcome;
    if (observed === null) result = { kind: 'TIMEOUT' };
    else if (observed.kind === 'LOCAL_HANDOFF_UNVERIFIED') { local = 'LOCAL_HANDOFF_UNVERIFIED'; result = { kind: 'ERROR', code: local, commit: 'UNKNOWN', settlement: 'RETAINED_UNKNOWN_COMMIT' }; }
    else if (observed.kind === 'ANSWER' && contradiction) { local = 'LEDGER_REPLY_CONTRADICTION'; result = { kind: 'ERROR', code: local, commit: 'UNKNOWN', settlement }; }
    // Missing, unbound, unreconciled or explicitly RETAINED_UNKNOWN_COMMIT accounting: the answer gets NO pass and NO validated
    // provider credit (the supervisor sees a no-credit error); the full reserve stays retained, never retried or refunded.
    else if (observed.kind === 'ANSWER' && settlement === 'RETAINED_UNKNOWN_COMMIT') { local = 'ANSWER_LIABILITY_UNKNOWN'; result = { kind: 'ERROR', code: local, commit: 'UNKNOWN', settlement }; }
    else if (observed.kind === 'ANSWER') result = { kind: 'ANSWER', observedIntent: observed.observedIntent, truthPass: observed.truth.pass, publication: 'CURRENT', settlement };
    else { if (contradiction) local = 'LEDGER_REPLY_CONTRADICTION'; else if (requestUnverified) local = 'LOCAL_HANDOFF_UNVERIFIED'; result = { kind: 'ERROR', code: observed.code, commit, configFaultProven: configFault, settlement }; }
    // Unknown or contradicted LIABILITY (no credit, no pass, INCOMPLETE) never masks what the validated answer itself proves:
    // a truth failure stays a zero-tolerance safety FAILED, and a certain case failure (semantic mismatch or deviation) that
    // makes a threshold unreachable (any refusal; a second failure in a supported group) stays FAILED. Only MATCH/MISMATCH
    // persists; the observed intent stays transient.
    let uncertain: { semantic: 'MATCH' | 'MISMATCH'; escalate: LocalReason | null } | null = null;
    if (observed?.kind === 'ANSWER' && (contradiction || settlement === 'RETAINED_UNKNOWN_COMMIT')) {
      const semantic = observed.observedIntent === ctx.frozen.expectedIntent ? 'MATCH' as const : 'MISMATCH' as const;
      const supported = ctx.frozen.group.startsWith('SUPPORTED_');
      const priorFails = (this.#sup.report().records as { caseId: string; casePass: boolean }[])
        .filter(x => !x.casePass && (supported ? this.#d.corpus.cases.get(x.caseId)!.group === ctx.frozen.group : !this.#d.corpus.cases.get(x.caseId)!.group.startsWith('SUPPORTED_'))).length;
      const certainFail = semantic === 'MISMATCH' || request.deviation;
      uncertain = { semantic, escalate: !observed.truth.pass
        ? (contradiction ? 'SAFETY_VIOLATION_UNDER_CONTRADICTORY_LEDGER' : 'SAFETY_VIOLATION_UNDER_UNKNOWN_LIABILITY')
        : certainFail && (!supported || priorFails + 1 > 1)
          ? (contradiction ? 'THRESHOLD_UNREACHABLE_UNDER_CONTRADICTORY_LEDGER' : 'THRESHOLD_UNREACHABLE_UNDER_UNKNOWN_LIABILITY') : null };
    }
    if (request.deviation) this.#sup.submittedTextDeviation(caseId);
    this.#sup.outcome(f.arrived ?? this.#now(), caseId, result);
    if (bound && ledger.attempts >= 2) { this.#integrity.push('DUPLICATE_DISPATCH'); this.#sup.integrityViolation('DUPLICATE_DISPATCH'); }
    if (reconciled) this.#book.reconciled(f.utcMs, ledger!); else this.#book.unknown();
    if (local !== null) this.#local = this.#local ?? { state: 'TERMINAL_INCOMPLETE', reason: local };
    if (uncertain?.escalate) this.#stopLocal('TERMINAL_FAILED', uncertain.escalate);
    this.#tally(observed, configFault);
    if (requestUnverified) this.#handoff += 1;
    const kept = bound ? ledger : null;
    this.#evidence.set(caseId, { correlationId: correlation, submittedPolicyVersion: f.tuple.policyVersion, utcDay: utcDay(f.utcMs), preDayMicro: f.pre.dayChargedMicro,
      preMonthMicro: f.pre.monthChargedMicro, ledger: ledger === null ? 'MISSING' : !bound ? 'UNBOUND' : contradiction ? 'CONTRADICTS_REPLY' : 'BOUND',
      ledgerAttempts: kept?.attempts ?? null, ledgerSettlement: kept?.settlement ?? null, chargedMicro: kept?.chargedMicro ?? null,
      postDayMicro: kept?.dayChargedMicro ?? null, postMonthMicro: kept?.monthChargedMicro ?? null,
      reconciliation: !consistent ? 'UNKNOWN' : reconciled ? 'RECONCILED' : 'UNRECONCILED',
      text: !request.parsed ? 'REQUEST_UNVERIFIED' : request.deviation ? 'REQUEST_DEVIATION' : 'REQUEST_MATCHED',
      reply: observed === null ? 'TIMEOUT' : observed.kind === 'ANSWER' ? 'V2_ANSWER_VALID' : observed.kind === 'ERROR' ? 'ERROR_ENVELOPE_VALID' : 'LOCAL_HANDOFF_UNVERIFIED',
      handoffDetail: observed?.kind === 'LOCAL_HANDOFF_UNVERIFIED' ? observed.detail : requestUnverified ? 'REQUEST_UNPARSED' : null,
      truth: observed?.kind === 'ANSWER' ? { claims: observed.truth.claims, coverage: observed.truth.coverage, urgency: observed.truth.urgency, schema: observed.truth.schema } : null,
      localOutcome: local, configFaultAttested: configFault, semantic: uncertain?.semantic ?? null });
    this.#inFlight = null; this.#sync();
    return this.state;
  }

  /** Quit, Ctrl-C, signal, save failure or fatal error with a case in flight: consumed, UNKNOWN commit (censored), run ends
   * TERMINAL_INCOMPLETE with closure pending. Never hides the attempt. */
  abandonInFlight(): string {
    const f = this.#inFlight;
    if (f === null) return 'NO_CASE_IN_FLIGHT';
    this.#sup.outcome(this.#now(), f.caseId, { kind: 'TIMEOUT' });
    this.#book.unknown();
    this.#evidence.set(f.caseId, { correlationId: null, submittedPolicyVersion: f.tuple.policyVersion, utcDay: utcDay(f.utcMs), preDayMicro: f.pre.dayChargedMicro,
      preMonthMicro: f.pre.monthChargedMicro, ledger: 'MISSING', ledgerAttempts: null, ledgerSettlement: null, chargedMicro: null, postDayMicro: null, postMonthMicro: null,
      reconciliation: 'UNKNOWN', text: 'REQUEST_UNVERIFIED', reply: 'ABANDONED', handoffDetail: null, truth: null, localOutcome: 'ABANDONED_IN_FLIGHT', configFaultAttested: false, semantic: null });
    this.#inFlight = null; this.#stopLocal('TERMINAL_INCOMPLETE', 'ABANDONED_IN_FLIGHT');
    return 'ABANDONED_IN_FLIGHT';
  }

  #tally(observed: Observed | null, configFault: boolean): void {
    const hit = (row: SafetyRow): void => { this.#safety.set(row, this.#safety.get(row)! + 1); };
    if (observed === null) return;
    if (observed.kind === 'LOCAL_HANDOFF_UNVERIFIED') { this.#handoff += 1; return; }
    if (observed.kind === 'ANSWER') {
      this.#compared += 1;
      if (!observed.truth.claims) hit('CLAIMS'); if (!observed.truth.coverage) hit('COVERAGE');
      if (!observed.truth.urgency) hit('URGENCY'); if (!observed.truth.schema) hit('SCHEMA');
    } else if (observed.code === 'ASK_REMOTE_INVALID') hit('SCHEMA');
    else if (observed.code === 'ASK_REMOTE_MODEL_MISMATCH') hit('MODEL_TIER');
    else if (observed.code === 'ASK_REMOTE_USAGE_INVALID') hit('USAGE');
    else if (configFault) hit('CONFIG');
  }

  deviation(id: unknown): string {
    const caseId = validCaseId(id);
    const r = this.#sup.submittedTextDeviation(caseId);
    const e = this.#evidence.get(caseId);
    if (r === 'RECORDED' && e) this.#evidence.set(caseId, { ...e, text: 'OPERATOR_REPORTED_DEVIATION' });
    this.#sync();
    return r;
  }

  /** Owner fence-first closure receipt (attested) against the ONE run-wide floor; failure is absorbing containment. */
  closure(input: unknown): string {
    if (this.#inFlight !== null) return 'BLOCKED_IN_FLIGHT';
    if (this.closureState !== 'PENDING') return 'BLOCKED_NO_CLOSURE_PENDING';
    const kind = this.#voluntary === 'PENDING' ? 'VOLUNTARY' as const : this.state === 'RESUMABLE_DAY' ? 'DAY' as const : 'TERMINAL' as const;
    const receipt = this.#closures.evaluate(input, this.admission.admissionId, kind);
    const supOk = receipt === null ? (this.#sup.closure === 'PENDING' ? this.#sup.close(null) : null) : this.#sup.closure === 'PENDING' ? this.#sup.close(receipt) : 'CONFIRMED';
    if (receipt === null || supOk !== 'CONFIRMED') {
      this.#closure = 'CONTAINMENT_UNCONFIRMED';
      if (this.#voluntary === 'PENDING') this.#voluntary = 'CONTAINMENT_UNCONFIRMED';
      return 'CONTAINMENT_UNCONFIRMED';
    }
    if (this.#voluntary === 'PENDING') this.#voluntary = 'CONFIRMED';
    this.#closure = 'CONFIRMED';
    return 'CONFIRMED';
  }

  resumeDay(): string {
    if (this.state !== 'RESUMABLE_DAY' || this.#paused()) return 'RESUME_DENIED_STATE';
    if (this.closureState !== 'CONFIRMED') return 'RESUME_DENIED_CONTAINMENT';
    const at = this.#now(); const w = this.#window(at);
    if (w !== null) return `RESUME_DENIED_${w}`;
    const now = this.#d.verify();
    if (!sameIdentity(this.start, now)) return 'RESUME_DENIED_ARTIFACT';
    const r = this.#sup.resume(at, { admissionId: this.admission.admissionId, datasetSha256: now.identity!.datasetCorpusSha256,
      fixtureSha256: now.identity!.fixtureSha256, orderSha256: now.identity!.orderSha256 });
    if (r === 'RESUMED') { this.#tuple = null; this.#clearCase(); this.#closure = 'NOT_REQUIRED'; this.#lastState = 'ACTIVE'; }
    return r;
  }
  voluntaryPause(): string {
    if (!this.#idle()) return 'BLOCKED';
    this.#voluntary = 'PENDING'; this.#closure = 'PENDING'; this.#voluntaryPauses += 1; this.#tuple = null; this.#clearCase(); this.#counters = null;
    return 'PAUSED_CLOSURE_PENDING';
  }
  resumeVoluntary(): string {
    if (this.#voluntary !== 'CONFIRMED' || this.closureState !== 'CONFIRMED') return 'RESUME_DENIED_CONTAINMENT';
    const w = this.#window(this.#now());
    if (w !== null) return `RESUME_DENIED_${w}`;
    if (!sameIdentity(this.start, this.#d.verify())) return 'RESUME_DENIED_ARTIFACT';
    this.#voluntary = 'NONE'; this.#closure = 'NOT_REQUIRED';
    return 'RESUMED_CONFIRM_NEWER_TUPLE';
  }

  /** Safe data for the receipt builder (no transient content exists in this object). */
  facts(): { report: Record<string, unknown>; state: RunState; localReason: LocalReason | null; closure: ClosureState; closureHistory: readonly ClosureEntry[];
    inFlight: { caseId: string; submittedPolicyVersion: string } | null; evidence: ReadonlyMap<string, CaseEvidence>; extra: readonly { caseId: string; outcome: 'UNRECORDED_CLICK' }[];
    totals: Totals; safety: ReadonlyMap<SafetyRow, number>; compared: number; handoffFailures: number; preSubmitChecks: number; integrity: readonly string[];
    voluntary: Voluntary; voluntaryPauses: number; thresholdsMet: boolean } {
    const report = this.#sup.report();
    return { report, state: this.state, localReason: this.#local?.reason ?? null, closure: this.closureState, closureHistory: this.#closures.history,
      inFlight: this.#inFlight && { caseId: this.#inFlight.caseId, submittedPolicyVersion: this.#inFlight.tuple.policyVersion },
      evidence: new Map(this.#evidence), extra: this.#extra.map(e => ({ ...e })), totals: this.#book.totals, safety: new Map(this.#safety), compared: this.#compared,
      handoffFailures: this.#handoff, preSubmitChecks: this.#preSubmitChecks, integrity: [...this.#integrity], voluntary: this.#voluntary, voluntaryPauses: this.#voluntaryPauses,
      thresholdsMet: report.thresholdsMet === true && this.#local === null && this.closureState === 'CONFIRMED' && this.#extra.length === 0 && this.#handoff === 0 };
  }
}
