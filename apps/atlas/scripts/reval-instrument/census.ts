// The instrument's process-census checks (05 "Capture guard PRE before arming and POST after task release/handoff, on the same
// uninterrupted epoch"; 02 "Correlation, census and zero attempts"; rs-d brief A §6). Pure: S's census records (without their task
// items), the case's terminal record and the DB attempt delta in; a fixed verdict out. The ONE submission of a consumed case has
// exactly one fate — NONE (never clicked), REJECTED at the gate, UNATTRIBUTED (claimed, no Binding) or BOUND (a terminal record) —
// and every other counter must agree with that fate; more than one submission, reservation or dispatch is EXTRA_ACTIVITY (RC5's
// duplicate-dispatch integrity failure). Between two cases nothing but capability/handoff traffic may move.
import { CENSUS_COUNTERS } from '../../packages/reval/census-payloads.ts';
import type { CensusCounter, Drain, ProcessCensus } from '../../packages/reval/census-payloads.ts';
import type { TerminalObservation } from '../../packages/reval/eval-wire.ts';

export type CensusRecord = Omit<ProcessCensus, 'tasks'>;
export const CENSUS_RECORD_KEYS = ['censusId', 'guardEpoch', ...CENSUS_COUNTERS, 'activeTaskCount', 'pendingCommitCount', 'coverage'] as const;
export const toRecord = (c: ProcessCensus): CensusRecord => Object.freeze(Object.fromEntries(CENSUS_RECORD_KEYS.map(k => [k, c[k]]))) as CensusRecord;
export type CensusVerdict = 'MATCH' | 'EXTRA_ACTIVITY' | 'CENSUS_MISMATCH' | 'CENSUS_UNAVAILABLE';
export const CENSUS_VERDICTS: readonly CensusVerdict[] = ['MATCH', 'EXTRA_ACTIVITY', 'CENSUS_MISMATCH', 'CENSUS_UNAVAILABLE'];
export const CENSUS_REASONS = ['EPOCH', 'COVERAGE', 'DECREASE', 'SUBMIT', 'FATE', 'CAPABILITY', 'HANDOFF', 'RESERVATION', 'DISPATCH', 'PUBLICATION',
  'RELEASE', 'UNCOLLECTED', 'GAUGES', 'DB_ATTEMPTS', 'UNAVAILABLE'] as const;
export type CensusReason = typeof CENSUS_REASONS[number];
export interface CensusResult { readonly verdict: CensusVerdict; readonly reason: CensusReason | null }
const MATCH: CensusResult = Object.freeze({ verdict: 'MATCH', reason: null });
const mismatch = (reason: CensusReason): CensusResult => ({ verdict: 'CENSUS_MISMATCH', reason });
const delta = (pre: CensusRecord, post: CensusRecord) => (k: CensusCounter): bigint => BigInt(post[k]) - BigInt(pre[k]);

/**
 * PRE → POST of one consumed case; `attemptsDelta` = POST − PRE projectAttemptCount of the controller snapshots (null: unavailable).
 * `deferred`: the POST was taken at the next GO (the record became FINAL only then), so the between-case traffic of compareGap —
 * capability requests with their owners, browser handoff/PAIR posts — may also have moved; nothing else may.
 */
export function compareCase(pre: CensusRecord, post: CensusRecord, terminal: TerminalObservation | null, attemptsDelta: bigint | null, deferred = false): CensusResult {
  if (pre.guardEpoch !== post.guardEpoch) return mismatch('EPOCH');
  if (pre.coverage !== 'COMPLETE' || post.coverage !== 'COMPLETE') return mismatch('COVERAGE');
  const d = delta(pre, post);
  // rc2 (review N3): event counters are monotonic within one guard epoch.
  if (CENSUS_COUNTERS.some(k => d(k) < 0n)) return mismatch('DECREASE');
  const reserved = d('reservationConfirmedCount') + d('commitUnknownCount');
  if (d('submitIngressCount') > 1n || reserved > 1n || d('capabilityConsumedCount') > 1n || d('transportEntryCount') > 1n) {
    return { verdict: 'EXTRA_ACTIVITY', reason: d('submitIngressCount') > 1n ? 'SUBMIT' : reserved > 1n ? 'RESERVATION' : 'DISPATCH' };
  }
  const submitted = d('submitIngressCount') === 1n; const rejected = d('rejectedUnpairedCount'); const unattributed = d('unattributedCount');
  // Exactly one fate for the one submission (or none at all).
  const fates = [rejected === 1n, unattributed === 1n, terminal !== null].filter(Boolean).length;
  if (rejected < 0n || rejected > 1n || unattributed < 0n || unattributed > 1n || fates !== (submitted ? 1 : 0)) return mismatch('FATE');
  if (d('capabilityIngressCount') < 0n || (!deferred && d('capabilityIngressCount') !== 0n)) return mismatch('CAPABILITY');
  if (d('handoffIngressCount') < 0n || (!deferred && d('handoffIngressCount') > (submitted ? 1n : 0n))) return mismatch('HANDOFF');
  const want = terminal === null ? 'NONE_CONFIRMED' : terminal.reservation;
  if (d('reservationConfirmedCount') !== (want === 'COMMITTED' ? 1n : 0n) || d('commitUnknownCount') !== (want === 'COMMIT_UNKNOWN' ? 1n : 0n)) return mismatch('RESERVATION');
  if (d('capabilityConsumedCount') !== d('transportEntryCount') || d('capabilityConsumedCount') > d('reservationConfirmedCount')) return mismatch('DISPATCH');
  const bound = terminal !== null || unattributed === 1n; // the submission got past the gate (an owner, possibly a publication)
  if (d('publicationCount') < 0n || d('publicationCount') > (bound ? 1n : 0n)) return mismatch('PUBLICATION');
  if (d('physicalReleaseCount') < 0n || d('physicalReleaseCount') > (bound ? 1n : 0n) + (deferred ? d('capabilityIngressCount') : 0n)) return mismatch('RELEASE');
  if (d('uncollectedTerminalCount') !== 0n) return mismatch('UNCOLLECTED');
  if (post.activeTaskCount !== '0' || post.pendingCommitCount !== '0') return mismatch('GAUGES');
  if (attemptsDelta === null) return { verdict: 'CENSUS_UNAVAILABLE', reason: 'UNAVAILABLE' };
  if (attemptsDelta < d('reservationConfirmedCount') || attemptsDelta > reserved) return mismatch('DB_ATTEMPTS');
  return MATCH;
}

/** POST of the previous case → PRE of the next: same epoch; only capability requests, browser handoff (re-PAIR) and their owners may move. */
export function compareGap(post: CensusRecord, pre: CensusRecord): CensusResult {
  if (post.guardEpoch !== pre.guardEpoch) return mismatch('EPOCH');
  if (pre.coverage !== 'COMPLETE') return mismatch('COVERAGE');
  const d = delta(post, pre);
  for (const k of CENSUS_COUNTERS) if (d(k) < 0n) return mismatch('DECREASE');
  if (d('submitIngressCount') !== 0n || d('rejectedUnpairedCount') !== 0n || d('unattributedCount') !== 0n || d('publicationCount') !== 0n) return mismatch('SUBMIT');
  if (d('reservationConfirmedCount') !== 0n || d('commitUnknownCount') !== 0n) return mismatch('RESERVATION');
  if (d('capabilityConsumedCount') !== 0n || d('transportEntryCount') !== 0n) return mismatch('DISPATCH');
  if (d('uncollectedTerminalCount') !== 0n) return mismatch('UNCOLLECTED');
  if (d('physicalReleaseCount') > d('capabilityIngressCount')) return mismatch('RELEASE');
  return MATCH;
}

/**
 * The segment-boundary DRAIN rule (brief A §6; rc2 review N4): QUIESCENT, INTACT, and taken in the paused state of that very closure —
 * its policyVersion AND fenceEpoch (a fence-advancing fixture switch or a resume after the closure makes a later DRAIN not count).
 */
export function boundaryDrainOk(drain: Drain, closurePolicyVersion: string | null, closureFenceEpoch: string | null): boolean {
  return drain.state === 'QUIESCENT' && drain.continuity === 'INTACT' && closurePolicyVersion !== null && drain.policyVersion === closurePolicyVersion
    && closureFenceEpoch !== null && drain.fenceEpoch === closureFenceEpoch;
}
/** A DRAIN the operator took, with the previous finished case and the confirmed voluntary closure it stood in (or nulls). */
export interface DrainEntry { readonly afterCaseId: string | null; readonly closurePolicyVersion: string | null; readonly closureFenceEpoch: string | null; readonly drain: Drain }
interface Closure { readonly kind: string; readonly result: string; readonly policyVersion: string | null; readonly fenceEpoch: string | null }
/**
 * Segment boundary (owner decisions D1/D2): before the first case of a new fixture segment, a voluntary-pause closure CONFIRMED after
 * the previous case (`closuresSince` = the RC5 closure history entries recorded since that case finished) and a DRAIN taken after
 * that case, inside that closure's paused state, that is QUIESCENT and INTACT. null = the boundary is satisfied.
 */
export function segmentBoundaryProblem(previousCaseId: string, closuresSince: readonly Closure[], drains: readonly DrainEntry[]): string | null {
  const closures = closuresSince.filter(e => e.kind === 'VOLUNTARY' && e.result === 'CONFIRMED');
  if (closures.length === 0) return 'BLOCKED_SEGMENT_CLOSURE_REQUIRED';
  const ok = drains.some(e => e.afterCaseId === previousCaseId && closures.some(c => c.policyVersion === e.closurePolicyVersion && c.fenceEpoch === e.closureFenceEpoch)
    && boundaryDrainOk(e.drain, e.closurePolicyVersion, e.closureFenceEpoch));
  return ok ? null : 'BLOCKED_SEGMENT_DRAIN_REQUIRED';
}
