import type { FailureCode } from './codes.ts';
import type { Closure } from './payloads.ts';
import type { OwnerExecResult } from './private-frames.ts';

/**
 * PAUSE_EXPORT decisions (brief §4/§6): pure functions of the executor outcome, the single reread and the strict floors.
 * A closure exists only after a CONFIRMED commit whose exact committed tuple the reread shows, strictly above both floors.
 * Everything after the request frame was sent that is not a valid authenticated result is commit-uncertain: latch, no
 * closure, no retry. Killing the executor is never treated as proof of rollback.
 */
export type PauseDecision =
  | { readonly kind: 'CLOSURE'; readonly closure: Closure }
  | { readonly kind: 'FAILURE'; readonly code: FailureCode; readonly latch: boolean };

const fail = (code: FailureCode, latch: boolean): PauseDecision => ({ kind: 'FAILURE', code, latch });

/** Phase before the request frame was sent (spawn/HELLO/peer/budget): no commit is possible. */
export function beforeRequestFailure(peerFailed: boolean): PauseDecision {
  return fail(peerFailed ? 'IDENTITY_UNVERIFIED' : 'DEADLINE', false);
}
/**
 * After the request frame was sent: `result` is the validated executor result, or null for anything else (malformed,
 * unauthenticated, wrong challenge, no result by the deadline, EOF, exit, kill).
 */
export type AfterExec = { readonly reread: true; readonly policyVersion: string; readonly fenceEpoch: string } | PauseDecision;
export function afterRequest(result: OwnerExecResult | null, challenge: string): AfterExec {
  if (result === null || result.challenge !== challenge || result.outcome === 'COMMIT_UNKNOWN') return fail('CONTAINMENT_UNCONFIRMED', true);
  if (result.outcome === 'REFUSED') return fail(result.code!, false);
  return { reread: true, policyVersion: result.policyVersion!, fenceEpoch: result.fenceEpoch! };
}
/** The single atomic reread after a confirmed commit (null = any reread failure: RV code, cap, timeout, physical/build). */
export interface Reread { readonly admissionId: string; readonly policyState: string; readonly policyVersion: string; readonly fenceEpoch: string }
export function closureAfterReread(admissionId: string, committed: { policyVersion: string; fenceEpoch: string }, reread: Reread | null,
  floors: { policyFloor: string; fenceFloor: string }): PauseDecision {
  if (reread === null || reread.admissionId !== admissionId || reread.policyState !== 'PAUSED'
    || reread.policyVersion !== committed.policyVersion || reread.fenceEpoch !== committed.fenceEpoch
    || BigInt(committed.policyVersion) <= BigInt(floors.policyFloor) || BigInt(committed.fenceEpoch) <= BigInt(floors.fenceFloor)) {
    return fail('CONTAINMENT_UNCONFIRMED', true);
  }
  return { kind: 'CLOSURE', closure: { admissionId, paused: true, policyVersion: committed.policyVersion, fenceEpoch: committed.fenceEpoch } };
}

/** Executor-side map of a pre-COMMIT SQL/auth error to the REFUSED code (brief §6 table). */
export function refusedCodeFor(sqlState: string | undefined): FailureCode {
  switch (sqlState) {
    case 'AR004': return 'REGISTRATION_MISMATCH';
    case 'AR009': return 'POLICY_CHANGED';
    case 'AR008': case '22003': return 'CONTAINMENT_UNCONFIRMED';
    case '28P01': case '28000': case '42501': return 'OWNER_REQUIRED';
    case '55P03': case '57014': return 'DEADLINE';
    default: return 'INTERNAL_FAILURE';
  }
}

/** One controller budget per operation (brief §6): B = 1800 ms monotonic from receipt, strictly under O's 2 s. */
export const BUDGET_MS = 1800;
export const REQUESTER_DEADLINE_MS = 2000;
export interface PauseDeadlines { readonly D: number; readonly requestBy: number; readonly DE: number; readonly rereadBy: number }
export const pauseDeadlines = (t0: number): PauseDeadlines => ({ D: t0 + BUDGET_MS, requestBy: t0 + BUDGET_MS - 1200, DE: t0 + BUDGET_MS - 400, rereadBy: t0 + BUDGET_MS - 50 });
/** remainingMs for the executor: DE − now on C's monotonic clock, clamped to 1..1400 (never extends C's deadline). */
export function remainingForExecutor(DE: number, now: number): number | null {
  const left = Math.floor(DE - now);
  return left < 1 ? null : Math.min(1400, left);
}
/** Server-side timeouts inside E: max(1, min(1400, deadline − now − 50)). */
export const executorTimeout = (deadline: number, now: number): number => Math.max(1, Math.min(1400, Math.floor(deadline - now - 50)));
