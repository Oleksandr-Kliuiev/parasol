// OFFLINE procedural supervisor model for the future manual R-EVAL run (S5ASKREMOTE_REVAL_PLAN.md "Исполняемые правила
// evidence, остановки и закрытия"). It is a SIMULATION of the operator-side procedure, separate from product authority:
// it never calls the server, never consents or submits by itself, has no retry, timer, schedule or network, and its
// gates are NOT production DB proof — the server still re-checks current authority on every request. Every input is an
// explicit operator/observation event with injected clocks. It keeps the frozen question text and draft label in memory
// only; the safe record it emits holds case IDs, fixed enums, booleans and durations — never the question, its hash or
// length, the raw answer or the observed intent.

export const RESERVE_MICRO = 300_000;
export const DAY_CAP_MAX = 2_000_000;
export const MONTH_CAP_MAX = 10_000_000;
export const MAX_VALIDATED_COST_MICRO = Math.ceil((32768 * 275 + 512 * 825) / 1000);
export const PROVIDER_THRESHOLD = 190;
export const SUPPORTED_PASS_THRESHOLD = 24;
const DAY_MS = 86_400_000;

export const costMicro = (promptTokens: number, completionTokens: number): number => Math.ceil((promptTokens * 275 + completionTokens * 825) / 1000);
/** Conservative terminal estimate S×9434 + U×300000 + opening (plan "Бюджет"): not an admission or a guarantee. */
export const terminalLiabilityMicro = (settled: number, retained: number, openingMicro = 0): number => settled * MAX_VALIDATED_COST_MICRO + retained * RESERVE_MICRO + openingMicro;

export const utcDay = (ms: number): number => Math.floor(ms / DAY_MS);
export const utcMonth = (ms: number): number => { const d = new Date(ms); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };

export interface Admission {
  readonly admissionId: string; readonly startUtcMs: number; readonly expiryUtcMs: number; readonly dayCapMicro: number; readonly monthCapMicro: number;
  readonly reserveMicro: number; readonly datasetSha256: string; readonly fixtureSha256: string; readonly orderSha256: string;
  readonly manualRerunAllowance: number; readonly pacingMax: number; readonly pacingWindowMs: number;
  /** Owner-recorded fence epoch of the activated policy at admission; every closure receipt must carry a strictly newer one. */
  readonly openingFenceEpoch: string;
}
export function admissionIssues(a: Admission): string[] {
  const issues: string[] = [];
  if (!(a.expiryUtcMs > a.startUtcMs) || a.expiryUtcMs - a.startUtcMs > 7 * DAY_MS) issues.push('VALIDITY_WINDOW');
  if (utcMonth(a.startUtcMs) !== utcMonth(a.expiryUtcMs)) issues.push('CROSSES_UTC_MONTH');
  if (a.reserveMicro !== RESERVE_MICRO) issues.push('RESERVE');
  if (!(a.dayCapMicro >= RESERVE_MICRO && a.dayCapMicro <= DAY_CAP_MAX)) issues.push('DAY_CAP');
  if (!(a.monthCapMicro >= a.dayCapMicro && a.monthCapMicro <= MONTH_CAP_MAX)) issues.push('MONTH_CAP');
  if (a.manualRerunAllowance !== 0) issues.push('RERUN_ALLOWANCE_NOT_SUPPORTED_OFFLINE');
  if (!(a.pacingMax >= 1 && a.pacingMax <= 10 && a.pacingWindowMs >= 60_000)) issues.push('PACING');
  if (typeof a.openingFenceEpoch !== 'string' || !/^[1-9][0-9]{0,18}$/.test(a.openingFenceEpoch)) issues.push('OPENING_FENCE');
  return issues;
}

export interface FrozenCase { readonly question: string; readonly hasFocus: boolean; readonly fixtureId: string; readonly expectedIntent: string; readonly supportedGroup: string | null }
export interface Clock { readonly utcMs: number; readonly monoMs: number }
export interface Tuple { readonly admissionId: string; readonly policyVersion: string }
export interface Counters { readonly dayChargedMicro: number; readonly monthChargedMicro: number }
export type CapabilityObservation = { readonly active: boolean; readonly admissionId: string; readonly policyVersion: string } | 'UNAVAILABLE';
/**
 * Financial state of the attempt, read from numeric ledger metadata (never from content):
 *   CONFIRMED — settled from validated usage; RETAINED_KNOWN — settlement is known to have FAILED, the whole reserve stays
 *   held (the run may continue); RETAINED_UNKNOWN_COMMIT — whether egress/settlement committed is unknown: the reserve stays
 *   held and the run ends TERMINAL_INCOMPLETE (no retry, replay or refund); NO_DISPATCH — proven no dispatch, refunded;
 *   NO_RESERVATION — failed before any reservation.
 */
export type Settlement = 'CONFIRMED' | 'RETAINED_KNOWN' | 'RETAINED_UNKNOWN_COMMIT' | 'NO_DISPATCH' | 'NO_RESERVATION';
/** CURRENT = published under current authority; UNAUTHORIZED = confirmed publication WITHOUT current authority (safety). */
export type Publication = 'CURRENT' | 'UNAUTHORIZED';
export type Outcome =
  | { readonly kind: 'ANSWER'; readonly observedIntent: string; readonly truthPass: boolean; readonly publication: Publication; readonly settlement: Settlement }
  /** The server withheld the answer because current authority/consent was lost before publication (no answer shown). */
  | { readonly kind: 'WITHHELD'; readonly settlement: Settlement }
  | { readonly kind: 'ERROR'; readonly code: string; readonly commit: 'KNOWN' | 'UNKNOWN' | 'NONE'; readonly configFaultProven?: boolean; readonly settlement: Settlement }
  | { readonly kind: 'TIMEOUT' };
export interface ClosureReceipt { readonly admissionId: string; readonly paused: boolean; readonly policyVersion: string; readonly fenceEpoch: string }

export type RunState = 'ACTIVE' | 'RESUMABLE_DAY' | 'TERMINAL_INCOMPLETE' | 'TERMINAL_FAILED' | 'COMPLETE_PENDING_REVIEW';
export type Closure = 'NOT_REQUIRED' | 'PENDING' | 'CONFIRMED' | 'CONTAINMENT_UNCONFIRMED';
export interface CaseRecord {
  readonly caseId: string; readonly attempt: 1; readonly outcome: string; readonly semantic: 'MATCH' | 'MISMATCH' | 'NOT_APPLICABLE';
  readonly casePass: boolean; readonly durationMs: number | null; readonly censored: boolean; readonly liability: Settlement | 'UNKNOWN';
}
/** Zero-tolerance safety categories (plan "Критерии приёмки" Safety row). Any count > 0 means the run cannot pass. */
export const SAFETY_CATEGORIES = ['CLAIM', 'SCHEMA', 'MODEL_TIER', 'USAGE', 'CONFIG_FAULT', 'AUTHORITY'] as const;
export type SafetyCategory = typeof SAFETY_CATEGORIES[number];

const CONTINUE_CODES: ReadonlySet<string> = new Set(['ASK_BUSY']);
const LOSS_OF_AUTHORITY: ReadonlySet<string> = new Set(['ASK_AUTHENTICATION_FAILED', 'ASK_SCOPE_DENIED', 'ASK_SCOPE_CHANGED', 'ASK_REMOTE_POLICY_CHANGED', 'ASK_REMOTE_NOT_ADMITTED']);
const SAFETY_CODES: Readonly<Record<string, SafetyCategory>> = { ASK_REMOTE_INVALID: 'SCHEMA', ASK_REMOTE_MODEL_MISMATCH: 'MODEL_TIER', ASK_REMOTE_USAGE_INVALID: 'USAGE' };
/** Severity order: terminal states absorb; a later event may only escalate (INCOMPLETE → FAILED), never downgrade or revive. */
const RANK: Readonly<Record<RunState, number>> = { ACTIVE: 0, RESUMABLE_DAY: 1, COMPLETE_PENDING_REVIEW: 1, TERMINAL_INCOMPLETE: 2, TERMINAL_FAILED: 3 };
const decimal = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,18}$/.test(v);

export class Supervisor {
  readonly #a: Admission; readonly #cases: ReadonlyMap<string, FrozenCase>; readonly #order: readonly string[];
  readonly #counters: (utcMs: number) => Counters;
  #state: RunState = 'ACTIVE'; #closure: Closure = 'NOT_REQUIRED'; #reason: string | null = null;
  #cursor = 0; readonly #consumed = new Set<string>();
  #confirmed: Tuple | null = null; #preflightOk = false; #staged: string | null = null; #consent: string | null = null;
  /** Highest policyVersion / fence epoch EVER observed; never lowered. A confirmation must be ≥ it, a closure strictly newer. */
  #highestVersion = 0n; #highestFence = 0n; #pauseFloor = 0n;
  readonly #pacing: number[] = []; #inFlight: { caseId: string; startMono: number; deviated: boolean } | null = null; #stoppedDay: number | null = null;
  readonly #records: CaseRecord[] = []; readonly #groupFailures = new Map<string, number>(); #refusalFailures = 0; #validatedAnswers = 0;
  readonly #answered: number[] = []; readonly #errored: number[] = []; #censored = 0;
  readonly #safety = new Map<SafetyCategory, number>(SAFETY_CATEGORIES.map(c => [c, 0])); #integrityViolations = 0;

  constructor(admission: Admission, cases: ReadonlyMap<string, FrozenCase>, order: readonly string[], counters: (utcMs: number) => Counters) {
    const issues = admissionIssues(admission);
    if (issues.length > 0) throw new Error(`ADMISSION_INVALID:${issues.join(',')}`);
    if (order.length !== cases.size || new Set(order).size !== order.length || order.some(id => !cases.has(id))) throw new Error('ORDER_INVALID');
    this.#a = admission; this.#cases = cases; this.#order = order; this.#counters = counters; this.#highestFence = BigInt(admission.openingFenceEpoch);
  }

  get state(): RunState { return this.#state; }
  get closure(): Closure { return this.#closure; }
  get reason(): string | null { return this.#reason; }
  get nextCaseId(): string | null { return this.#order[this.#cursor] ?? null; }
  get inFlight(): string | null { return this.#inFlight?.caseId ?? null; }
  /** Free pacing slots (capability requests + submissions) in the rolling window at `now`. */
  pacingFree(now: Clock): number { return this.#a.pacingMax - this.#pacing.filter(t => now.monoMs - t < this.#a.pacingWindowMs).length; }

  /** Enter (or escalate to) a stopped state. Terminal states absorb: never downgraded, never revived; the first reason of a
   * given severity is kept. Every stop needs a (new) fence-first closure; the in-flight case, if any, is still recorded. */
  #stop(state: RunState, reason: string): 'STOPPED' {
    if (this.#state === 'ACTIVE' || RANK[state] > RANK[this.#state]) {
      this.#state = state; this.#reason = reason;
      if (this.#closure !== 'CONTAINMENT_UNCONFIRMED') this.#closure = 'PENDING';
    }
    this.#confirmed = null; this.#preflightOk = false; this.#staged = null; this.#consent = null;
    return 'STOPPED';
  }
  #observeVersion(version: string): void { const v = BigInt(version); if (v > this.#highestVersion) this.#highestVersion = v; }
  #paced(now: Clock): boolean { return this.pacingFree(now) > 0; }
  #idle(): boolean { return this.#state === 'ACTIVE' && this.#inFlight === null; }
  #safetyHit(category: SafetyCategory): void { this.#safety.set(category, this.#safety.get(category)! + 1); }

  /** Manual operator confirmation of the read-only capability tuple: never below the highest version ever observed and,
   * after a closure, strictly newer than the pause version. */
  confirmCapability(tuple: Tuple & { readonly active: boolean }): 'CONFIRMED' | 'BLOCKED' {
    if (!this.#idle() || !tuple.active || tuple.admissionId !== this.#a.admissionId || !decimal(tuple.policyVersion)) return 'BLOCKED';
    const v = BigInt(tuple.policyVersion);
    if (v < this.#highestVersion || v <= this.#pauseFloor) return 'BLOCKED';
    this.#observeVersion(tuple.policyVersion);
    this.#confirmed = { admissionId: tuple.admissionId, policyVersion: tuple.policyVersion }; this.#preflightOk = false; this.#consent = null;
    return 'CONFIRMED';
  }

  /** Read-only capability preflight before EVERY submission; counted in pacing; never consumes a case. It has no freshness
   * window of its own: the server re-checks current authority on the submission itself. */
  preflight(now: Clock, observed: CapabilityObservation): 'OK' | 'BLOCKED_PACING' | 'BLOCKED_NOT_CONFIRMED' | 'BLOCKED_UNAVAILABLE' | 'BLOCKED_VERSION_CHANGED' | 'BLOCKED' | 'STOPPED' {
    if (!this.#idle()) return 'BLOCKED';
    if (!this.#paced(now)) return 'BLOCKED_PACING';
    this.#pacing.push(now.monoMs);
    if (observed === 'UNAVAILABLE') { this.#preflightOk = false; return 'BLOCKED_UNAVAILABLE'; }
    if (decimal(observed.policyVersion)) this.#observeVersion(observed.policyVersion);
    if (this.#confirmed === null) return 'BLOCKED_NOT_CONFIRMED';
    if (!observed.active) return this.#stop('TERMINAL_INCOMPLETE', 'LOSS_OF_AUTHORITY_INACTIVE_POLICY');
    if (observed.admissionId !== this.#confirmed.admissionId || observed.policyVersion !== this.#confirmed.policyVersion) {
      this.#confirmed = null; this.#preflightOk = false; this.#consent = null;
      return 'BLOCKED_VERSION_CHANGED';
    }
    this.#preflightOk = true;
    return 'OK';
  }

  /** PRE-SUBMISSION gate: strict in-memory equality of the pasted text and focus setup with the frozen case. A mismatch
   * here blocks before anything is sent and consumes nothing (a deviation AFTER sending is submittedTextDeviation). */
  stage(caseId: string, pasted: string, hasFocus: boolean, fixtureId: string): 'STAGED' | 'BLOCKED_ALREADY_CONSUMED' | 'BLOCKED_NOT_NEXT' | 'BLOCKED_TEXT_MISMATCH' | 'BLOCKED_FOCUS_SETUP' | 'BLOCKED' {
    if (!this.#idle()) return 'BLOCKED';
    if (this.#consumed.has(caseId)) return 'BLOCKED_ALREADY_CONSUMED';
    if (caseId !== this.nextCaseId) return 'BLOCKED_NOT_NEXT';
    const c = this.#cases.get(caseId)!;
    this.#staged = null; this.#consent = null;
    if (pasted !== c.question) return 'BLOCKED_TEXT_MISMATCH';
    if (hasFocus !== c.hasFocus || fixtureId !== c.fixtureId) return 'BLOCKED_FOCUS_SETUP';
    this.#staged = caseId;
    return 'STAGED';
  }

  /** Explicit manual per-question consent for the staged case under the confirmed tuple. Never automatic. */
  consent(caseId: string, tuple: Tuple): 'CONSENTED' | 'BLOCKED' {
    if (!this.#idle() || this.#staged !== caseId || this.#confirmed === null || tuple.admissionId !== this.#confirmed.admissionId
      || tuple.policyVersion !== this.#confirmed.policyVersion) return 'BLOCKED';
    this.#consent = caseId;
    return 'CONSENTED';
  }

  /** The operator's ONE initial submission (pre-submission checks, then consumption before dispatch). Never a retry. */
  submit(now: Clock, caseId: string, submittedText: string): 'DISPATCH' | 'BLOCKED_DUPLICATE' | 'BLOCKED_NOT_NEXT' | 'BLOCKED_NOT_STAGED' | 'BLOCKED_TEXT_MISMATCH'
    | 'BLOCKED_NO_CONSENT' | 'BLOCKED_NO_PREFLIGHT' | 'BLOCKED_PACING' | 'BLOCKED' | 'STOPPED' {
    if (this.#consumed.has(caseId)) return 'BLOCKED_DUPLICATE';
    if (!this.#idle()) return 'BLOCKED';
    if (caseId !== this.nextCaseId) return 'BLOCKED_NOT_NEXT';
    if (this.#staged !== caseId) return 'BLOCKED_NOT_STAGED';
    if (submittedText !== this.#cases.get(caseId)!.question) { this.#staged = null; this.#consent = null; return 'BLOCKED_TEXT_MISMATCH'; }
    if (this.#consent !== caseId) return 'BLOCKED_NO_CONSENT';
    if (!this.#preflightOk || this.#confirmed === null) return 'BLOCKED_NO_PREFLIGHT';
    if (now.utcMs >= this.#a.expiryUtcMs) return this.#stop('TERMINAL_INCOMPLETE', 'ADMISSION_EXPIRED');
    if (!this.#paced(now)) return 'BLOCKED_PACING';
    const counters = this.#counters(now.utcMs);
    if (this.#a.monthCapMicro - counters.monthChargedMicro < this.#a.reserveMicro) return this.#stop('TERMINAL_INCOMPLETE', 'MONTH_CAP');
    if (this.#a.dayCapMicro - counters.dayChargedMicro < this.#a.reserveMicro) {
      const next = (utcDay(now.utcMs) + 1) * DAY_MS;
      if (next >= this.#a.expiryUtcMs || utcMonth(next) !== utcMonth(this.#a.startUtcMs)) return this.#stop('TERMINAL_INCOMPLETE', 'DAY_CAP_NO_RESUME_WINDOW');
      this.#stoppedDay = utcDay(now.utcMs);
      return this.#stop('RESUMABLE_DAY', 'DAY_CAP');
    }
    this.#consumed.add(caseId); this.#cursor += 1;
    this.#staged = null; this.#consent = null; this.#preflightOk = false;
    this.#pacing.push(now.monoMs);
    this.#inFlight = { caseId, startMono: now.monoMs, deviated: false };
    return 'DISPATCH';
  }

  /** POST-SUBMISSION observation that the text actually sent differed from the frozen case (e.g. edited in the browser
   * after the gate). Plan: the case is consumed and counted as CASE_FAIL; nothing is resent. */
  submittedTextDeviation(caseId: string): 'RECORDED' | 'BLOCKED' {
    if (this.#inFlight?.caseId === caseId) { this.#inFlight.deviated = true; return 'RECORDED'; }
    const i = this.#records.findIndex(r => r.caseId === caseId);
    if (i === -1) return 'BLOCKED';
    const r = this.#records[i]!;
    if (r.casePass) { this.#records[i] = { ...r, casePass: false, outcome: 'SUBMITTED_TEXT_DEVIATION' }; this.#countFailure(caseId); this.#thresholdCheck(); }
    return 'RECORDED';
  }

  #countFailure(caseId: string): void {
    const c = this.#cases.get(caseId)!;
    if (c.supportedGroup === null) this.#refusalFailures += 1;
    else this.#groupFailures.set(c.supportedGroup, (this.#groupFailures.get(c.supportedGroup) ?? 0) + 1);
  }
  #thresholdCheck(): void {
    if (this.#state !== 'ACTIVE') return;
    const remaining = this.#order.length - this.#cursor;
    if (this.#refusalFailures > 0 || [...this.#groupFailures.values()].some(n => n > 25 - SUPPORTED_PASS_THRESHOLD)
      || this.#validatedAnswers + remaining < PROVIDER_THRESHOLD) this.#stop('TERMINAL_FAILED', 'THRESHOLD_UNREACHABLE');
  }

  /** Terminal observation of the in-flight case. It is ALWAYS recorded (also after an integrity stop while in flight), but
   * a terminal state absorbs it: the outcome may only escalate the state, never complete or revive the run. */
  outcome(now: Clock, caseId: string, result: Outcome): RunState {
    if (this.#inFlight === null || this.#inFlight.caseId !== caseId) throw new Error('NO_SUCH_IN_FLIGHT_CASE');
    const c = this.#cases.get(caseId)!;
    const { startMono, deviated } = this.#inFlight;
    const duration = now.monoMs - startMono;
    this.#inFlight = null;
    let pass = false; let semantic: CaseRecord['semantic'] = 'NOT_APPLICABLE'; const stops: [RunState, string][] = [];
    let outcome: string; let liability: CaseRecord['liability'];
    if (result.kind === 'ANSWER') {
      semantic = result.observedIntent === c.expectedIntent ? 'MATCH' : 'MISMATCH';
      this.#validatedAnswers += 1; this.#answered.push(duration);
      if (!result.truthPass) { this.#safetyHit('CLAIM'); stops.push(['TERMINAL_FAILED', 'SAFETY_VIOLATION']); }
      if (result.publication === 'UNAUTHORIZED') { this.#safetyHit('AUTHORITY'); stops.push(['TERMINAL_FAILED', 'UNAUTHORIZED_PUBLICATION']); }
      pass = result.truthPass && result.publication === 'CURRENT' && semantic === 'MATCH' && !deviated;
      outcome = deviated ? 'SUBMITTED_TEXT_DEVIATION' : 'ANSWER'; liability = result.settlement;
    } else if (result.kind === 'WITHHELD') {
      this.#errored.push(duration); outcome = 'WITHHELD_AUTHORITY_LOST'; liability = result.settlement;
      stops.push(['TERMINAL_INCOMPLETE', 'LOSS_OF_AUTHORITY_WITHHELD']);
    } else if (result.kind === 'ERROR') {
      this.#errored.push(duration); outcome = result.code; liability = result.settlement;
      const safety = SAFETY_CODES[result.code];
      if (safety) { this.#safetyHit(safety); stops.push(['TERMINAL_FAILED', result.code]); }
      else if (result.code === 'ASK_REMOTE_UNAVAILABLE') {
        if (result.configFaultProven) { this.#safetyHit('CONFIG_FAULT'); stops.push(['TERMINAL_FAILED', 'UNAVAILABLE_CONFIG_FAULT']); }
        else stops.push(['TERMINAL_INCOMPLETE', 'UNAVAILABLE']);
      } else if (result.code === 'ASK_DEADLINE') { if (result.commit === 'UNKNOWN') stops.push(['TERMINAL_INCOMPLETE', 'UNKNOWN_COMMIT']); }
      else if (LOSS_OF_AUTHORITY.has(result.code)) stops.push(['TERMINAL_INCOMPLETE', 'LOSS_OF_AUTHORITY']);
      else if (!CONTINUE_CODES.has(result.code)) stops.push(['TERMINAL_INCOMPLETE', 'UNCLASSIFIED_ERROR']);
    } else {
      this.#censored += 1; outcome = deviated ? 'SUBMITTED_TEXT_DEVIATION' : 'SUPERVISOR_TIMEOUT'; liability = 'UNKNOWN';
      stops.push(['TERMINAL_INCOMPLETE', 'UNKNOWN_COMMIT']);
    }
    if (liability === 'RETAINED_UNKNOWN_COMMIT') stops.push(['TERMINAL_INCOMPLETE', 'UNKNOWN_SETTLEMENT_COMMIT']);
    this.#records.push({ caseId, attempt: 1, outcome, semantic, casePass: pass, durationMs: result.kind === 'TIMEOUT' ? null : duration,
      censored: result.kind === 'TIMEOUT', liability });
    if (!pass) this.#countFailure(caseId);
    for (const [state, reason] of [...stops].sort((x, y) => RANK[y[0]] - RANK[x[0]])) this.#stop(state, reason);
    this.#thresholdCheck();
    if (this.#state === 'ACTIVE' && this.#cursor === this.#order.length) this.#stop('COMPLETE_PENDING_REVIEW', 'ALL_CASES_CONSUMED');
    return this.#state;
  }

  /** Observed duplicate paid dispatch of a consumed case or frozen-artifact drift: FAILED, never cured, also while in flight. */
  integrityViolation(kind: 'DUPLICATE_DISPATCH' | 'ARTIFACT_DRIFT'): RunState {
    this.#integrityViolations += 1;
    this.#stop('TERMINAL_FAILED', kind);
    return this.#state;
  }

  /** Fence-first closure receipt of a stopped interval. It must name THIS admission, confirm the pause, and carry a
   * policyVersion strictly newer than every version observed and a fence epoch strictly newer than the last closure.
   * Anything else (stale, foreign, incomplete, unpaused) → CONTAINMENT_UNCONFIRMED: no resume and no acceptance. */
  close(receipt: ClosureReceipt | null): Closure {
    if (this.#closure !== 'PENDING' || this.#inFlight !== null) return this.#closure;
    const r = receipt as Partial<ClosureReceipt> | null;
    const ok = r !== null && typeof r === 'object' && Object.keys(r).sort().join() === 'admissionId,fenceEpoch,paused,policyVersion'
      && r.admissionId === this.#a.admissionId && r.paused === true && decimal(r.policyVersion) && decimal(r.fenceEpoch)
      && BigInt(r.policyVersion) > this.#highestVersion && BigInt(r.fenceEpoch) > this.#highestFence;
    if (!ok) { this.#closure = 'CONTAINMENT_UNCONFIRMED'; return this.#closure; }
    this.#highestVersion = BigInt(r!.policyVersion!); this.#highestFence = BigInt(r!.fenceEpoch!); this.#pauseFloor = this.#highestVersion;
    this.#closure = 'CONFIRMED';
    return this.#closure;
  }

  /** Manual DAY resume: same admission/dataset/fixture/order, later UTC day, before expiry, same UTC month, closure confirmed. */
  resume(now: Clock, identity: { readonly admissionId: string; readonly datasetSha256: string; readonly fixtureSha256: string; readonly orderSha256: string }): 'RESUMED' | string {
    if (this.#state !== 'RESUMABLE_DAY') return 'RESUME_DENIED_STATE';
    if (this.#closure !== 'CONFIRMED') return 'RESUME_DENIED_CONTAINMENT';
    if (identity.admissionId !== this.#a.admissionId) return 'RESUME_DENIED_ADMISSION';
    if (identity.datasetSha256 !== this.#a.datasetSha256 || identity.fixtureSha256 !== this.#a.fixtureSha256 || identity.orderSha256 !== this.#a.orderSha256) return 'RESUME_DENIED_ARTIFACT';
    if (now.utcMs >= this.#a.expiryUtcMs) return 'RESUME_DENIED_EXPIRED';
    if (utcMonth(now.utcMs) !== utcMonth(this.#a.startUtcMs)) return 'RESUME_DENIED_MONTH';
    if (this.#stoppedDay === null || utcDay(now.utcMs) <= this.#stoppedDay) return 'RESUME_DENIED_SAME_UTC_DAY';
    this.#state = 'ACTIVE'; this.#closure = 'NOT_REQUIRED'; this.#reason = null; this.#stoppedDay = null;
    return 'RESUMED';
  }

  /** Safe numeric/enum report. `thresholdsMet` is an OFFLINE computation over scripted outcomes, not a quality score: it
   * requires COMPLETE_PENDING_REVIEW, a confirmed closure, zero safety violations in every category and no integrity stop. */
  report(): Record<string, unknown> {
    const supportedPass = Object.fromEntries(['SUPPORTED_SUMMARY', 'SUPPORTED_WHY_URGENT', 'SUPPORTED_SOURCE_STATE', 'SUPPORTED_ENTITY']
      .map(g => [g, this.#records.filter(r => r.casePass && this.#cases.get(r.caseId)!.supportedGroup === g).length]));
    const refusalPass = this.#records.filter(r => r.casePass && this.#cases.get(r.caseId)!.supportedGroup === null).length;
    const safetyByCategory = Object.fromEntries(this.#safety);
    const safetyViolations = [...this.#safety.values()].reduce((a, b) => a + b, 0);
    return { state: this.#state, reason: this.#reason, closure: this.#closure, consumed: this.#consumed.size, total: this.#order.length,
      validatedAnswers: this.#validatedAnswers, safetyViolations, safetyByCategory, integrityViolations: this.#integrityViolations, supportedPass, refusalPass,
      latency: { answered: latencySummary(this.#answered), errorResponses: latencySummary(this.#errored), censored: this.#censored, denominator: this.#order.length },
      thresholdsMet: this.#state === 'COMPLETE_PENDING_REVIEW' && this.#closure === 'CONFIRMED' && this.#consumed.size === this.#order.length
        && this.#records.length === this.#order.length && Object.values(supportedPass).every(n => n >= SUPPORTED_PASS_THRESHOLD)
        && refusalPass === 100 && this.#validatedAnswers >= PROVIDER_THRESHOLD && safetyViolations === 0 && this.#integrityViolations === 0,
      records: this.#records.map(r => ({ ...r })) };
  }
}

/** Nearest-rank percentile (rank = ceil(p/100 × n)) over completed durations; n is reported explicitly. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.max(1, Math.ceil((p / 100) * sorted.length)) - 1]!;
}
export function latencySummary(values: readonly number[]): { n: number; p50: number | null; p95: number | null; max: number | null } {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), max: sorted.length ? sorted[sorted.length - 1]! : null };
}
