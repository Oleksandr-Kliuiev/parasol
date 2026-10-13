/**
 * ASK-REMOTE R-A pure financial/domain transitions (docs/stage5/ask/remote/04_AUTHORITY_AND_BILLING.md). Integer micro-USD
 * as BigInt only (never Number for money or policyVersion); no clock, I/O or randomness except the explicit `at`/`nowMs`
 * arguments. The SQL routines of migration 202610111020 enforce the same rules durably; these functions are the
 * application-side mirror for prechecks and the later R-B composition, never a substitute for the routine boundary.
 */

export const ASK_REMOTE_PERMISSION = 'ask:remote';
export const ASK_REMOTE_PROFILE = 'ask-remote-openai-luna-v1';
/** Fixed reservation per attempt: full window × worst input rate + 512 × worst output rate, rounded UP (04). */
export const RESERVE_MICRO_USD = 300_000n;
/** Conservative settlement rates of this profile: micro-USD per 1000 prompt / completion tokens (US$0.275 / US$0.825 per MTok). */
export const PROMPT_RATE = 275n;
export const COMPLETION_RATE = 825n;
/** Proposed architecture caps; an owner admission may only lower them. They authorize no spending by themselves. */
export const DAY_CAP_LIMIT_MICRO_USD = 2_000_000n;
export const MONTH_CAP_LIMIT_MICRO_USD = 10_000_000n;
/** Usage anomaly gate of the profile (not an input-token billing bound). */
export const MAX_PROMPT_TOKENS = 32_768;
export const MAX_COMPLETION_TOKENS = 512;
export const MAX_POLICY_VERSION = 9_223_372_036_854_775_807n;
/**
 * NO_DISPATCH (settle 0) is refused later than this after the attempt. A coarse backstop on HOW LATE a zero refund can be
 * claimed — not a proof: elapsed time, a reconnect or a persisted attempt/correlation ID cannot show that the same process
 * owned the attempt or that nothing was dispatched. That private in-process proof is an R-B obligation.
 */
export const NO_DISPATCH_WINDOW_MS = 10_000;
/** The ECMAScript time-value range: ±8.64e15 ms around the epoch (what a valid Date can hold). */
export const MAX_TIME_VALUE_MS = 8_640_000_000_000_000;

/** A valid instant: a safe integer millisecond time value inside the Date range. NaN, ±Infinity and fractions fail. */
export function validInstantMs(value: unknown): value is number {
  return Number.isSafeInteger(value) && Math.abs(value as number) <= MAX_TIME_VALUE_MS;
}

export type AttemptState = 'EGRESS_COMMITTED' | 'SETTLED' | 'UNKNOWN';
export type SettlementOutcome = 'USAGE_VERIFIED' | 'NO_DISPATCH' | 'DELIVERY_UNKNOWN' | 'USAGE_INVALID' | 'MODEL_MISMATCH' | 'UPSTREAM_REJECTED';
export const SETTLEMENT_OUTCOMES: readonly SettlementOutcome[] =
  ['USAGE_VERIFIED', 'NO_DISPATCH', 'DELIVERY_UNKNOWN', 'USAGE_INVALID', 'MODEL_MISMATCH', 'UPSTREAM_REJECTED'];
export type PolicyState = 'INACTIVE' | 'ACTIVE' | 'PAUSED' | 'REVOKED' | 'TOMBSTONE';
export type PauseReason = 'MODEL_MISMATCH' | 'USAGE_INVALID' | 'UPSTREAM_AUTH';

const CANONICAL_POSITIVE = /^[1-9][0-9]{0,18}$/;
/** Canonical positive decimal policyVersion (no sign, no leading zero, ≤ max bigint) → BigInt; anything else → null. */
export function parsePolicyVersion(value: unknown): bigint | null {
  if (typeof value !== 'string' || !CANONICAL_POSITIVE.test(value)) return null;
  const v = BigInt(value);
  return v <= MAX_POLICY_VERSION ? v : null;
}

/** The next policyVersion of a material mutation: exactly +1; reaching max makes the policy a terminal TOMBSTONE. */
export function nextPolicyVersion(current: bigint): { version: bigint; tombstone: boolean } {
  if (current < 1n || current >= MAX_POLICY_VERSION) throw new RangeError('ASK_REMOTE_VERSION_EXHAUSTED');
  const version = current + 1n;
  return { version, tombstone: version === MAX_POLICY_VERSION };
}

/** UTC period keys of an instant (independent of the process/session time zone): YYYY-MM-DD day, YYYY-MM-01 month. */
export function utcPeriods(at: Date): { day: string; month: string } {
  const ms = at.getTime();
  if (!Number.isFinite(ms)) throw new RangeError('invalid instant');
  const day = new Date(ms).toISOString().slice(0, 10);
  return { day, month: `${day.slice(0, 7)}-01` };
}

/** Owner-admitted caps must stay within the proposed limits (lowering only); negative or non-integer caps are refused. */
export function validCaps(dayCap: bigint, monthCap: bigint): boolean {
  return dayCap >= 0n && dayCap <= DAY_CAP_LIMIT_MICRO_USD && monthCap >= 0n && monthCap <= MONTH_CAP_LIMIT_MICRO_USD;
}

export interface Counters { month: bigint; day: bigint }
/**
 * Reservation against the ORIGINAL project counters (MONTH then DAY, both or neither): admitted iff charged + reserve ≤ cap
 * for each. A cap lowered below current spend refuses every new reservation and never rewrites the counters.
 */
export function reserve(counters: Counters, caps: Counters):
  { admitted: true; counters: Counters } | { admitted: false; code: 'ASK_REMOTE_BUDGET' } {
  if (counters.month < 0n || counters.day < 0n || !validCaps(caps.day, caps.month)) throw new RangeError('invalid counters or caps');
  if (counters.month + RESERVE_MICRO_USD > caps.month || counters.day + RESERVE_MICRO_USD > caps.day) return { admitted: false, code: 'ASK_REMOTE_BUDGET' };
  return { admitted: true, counters: { month: counters.month + RESERVE_MICRO_USD, day: counters.day + RESERVE_MICRO_USD } };
}

export interface Usage { promptTokens: number; completionTokens: number }
/** Validated usage only: safe integers within the profile's anomaly gate. */
export function validUsage(usage: unknown): usage is Usage {
  if (typeof usage !== 'object' || usage === null) return false;
  const { promptTokens, completionTokens } = usage as Record<string, unknown>;
  return Number.isSafeInteger(promptTokens) && Number.isSafeInteger(completionTokens)
    && (promptTokens as number) >= 0 && (promptTokens as number) <= MAX_PROMPT_TOKENS
    && (completionTokens as number) >= 0 && (completionTokens as number) <= MAX_COMPLETION_TOKENS;
}
/** Conservative token cost: ceil((prompt × 275 + completion × 825) / 1000) micro-USD, integer arithmetic. */
export function settlementCost(usage: Usage): bigint {
  if (!validUsage(usage)) throw new RangeError('ASK_REMOTE_USAGE_INVALID');
  return (BigInt(usage.promptTokens) * PROMPT_RATE + BigInt(usage.completionTokens) * COMPLETION_RATE + 999n) / 1000n;
}

export interface AttemptLedger { state: AttemptState; reservedMicroUsd: bigint; createdAtMs: number }
export type SettlementResult =
  | { settled: true; state: 'SETTLED' | 'UNKNOWN'; accountedMicroUsd: bigint; refundMicroUsd: bigint }
  | { settled: false; code: 'ASK_REMOTE_SETTLEMENT_REFUSED' };
/**
 * Exactly-once settlement of one EGRESS_COMMITTED attempt. USAGE_VERIFIED keeps the conservative token cost; NO_DISPATCH
 * keeps 0 when the CALLER asserts it and creation ≤ now ≤ creation + window (the caller's assertion is trusted here, as in
 * SQL); every other outcome keeps the whole reserve (UNKNOWN). The refund is subtracted from the attempt's ORIGINAL
 * day/month counters. A second, late or time-invalid settlement (invalid instants, now before creation) is refused.
 */
export function settle(attempt: AttemptLedger, outcome: SettlementOutcome, usage: Usage | null, nowMs: number): SettlementResult {
  const refused = { settled: false, code: 'ASK_REMOTE_SETTLEMENT_REFUSED' } as const;
  if (attempt.state !== 'EGRESS_COMMITTED' || attempt.reservedMicroUsd !== RESERVE_MICRO_USD || !SETTLEMENT_OUTCOMES.includes(outcome)) return refused;
  // Fail closed on time: both instants valid and chronological (SQL: settledAt >= createdAt), compared exactly as BigInt.
  if (!validInstantMs(attempt.createdAtMs) || !validInstantMs(nowMs) || nowMs < attempt.createdAtMs) return refused;
  if ((outcome === 'USAGE_VERIFIED') !== (usage !== null)) return refused;
  let accounted: bigint;
  if (outcome === 'USAGE_VERIFIED') {
    if (!validUsage(usage)) return refused;
    accounted = settlementCost(usage);
  } else if (outcome === 'NO_DISPATCH') {
    if (BigInt(nowMs) - BigInt(attempt.createdAtMs) > BigInt(NO_DISPATCH_WINDOW_MS)) return refused;
    accounted = 0n;
  } else accounted = attempt.reservedMicroUsd;
  if (accounted < 0n || accounted > attempt.reservedMicroUsd) return refused;
  const state = outcome === 'USAGE_VERIFIED' || outcome === 'NO_DISPATCH' ? 'SETTLED' : 'UNKNOWN';
  return { settled: true, state, accountedMicroUsd: accounted, refundMicroUsd: attempt.reservedMicroUsd - accounted };
}

export interface PolicySnapshot {
  admissionId: string; policyVersion: bigint; state: PolicyState; expiresAtMs: number; profile: string; priceRevision: string;
  reserveMicroUsd: bigint; clientAdmitted: boolean;
}
export interface ConsentTuple { admissionId: string; policyVersion: bigint }
export type AdmissionDecision = 'ADMITTED' | 'ASK_REMOTE_POLICY_CHANGED' | 'ASK_REMOTE_NOT_ADMITTED';
/**
 * The order the reserve routine re-evaluates: the consent tuple first (a stale tuple is a changed policy, even when a newer
 * authority epoch was captured), then active/expiry/profile/price/reserve/client. Missing policy or an invalid instant (now or
 * expiry NaN/±Infinity/fractional/out of the Date range): not admitted.
 */
export function admissionDecision(policy: PolicySnapshot | null, consent: ConsentTuple, expected: { profile: string; priceRevision: string },
  nowMs: number): AdmissionDecision {
  if (policy === null) return 'ASK_REMOTE_NOT_ADMITTED';
  if (policy.admissionId !== consent.admissionId || policy.policyVersion !== consent.policyVersion) return 'ASK_REMOTE_POLICY_CHANGED';
  if (policy.state !== 'ACTIVE' || !validInstantMs(nowMs) || !validInstantMs(policy.expiresAtMs) || nowMs >= policy.expiresAtMs
    || policy.profile !== expected.profile
    || policy.profile !== ASK_REMOTE_PROFILE || policy.priceRevision !== expected.priceRevision || policy.reserveMicroUsd !== RESERVE_MICRO_USD
    || !policy.clientAdmitted) return 'ASK_REMOTE_NOT_ADMITTED';
  return 'ADMITTED';
}
