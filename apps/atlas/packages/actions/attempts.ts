import type { Prisma } from '@prisma/client';
import { ACTION_MODE, ACTION_VERSION, CLAIM_WINDOW_MS, RECOVERY_GRACE_MS, VERIFICATION_BUDGET } from './contracts.ts';
import type { ActionExecutionSummary, AttemptState, RequestState, VerificationState } from './contracts.ts';
import type { ActionComposition } from './policy.ts';

/**
 * Shared S3-C row access (docs/stage3/03_DATA_AND_CONCURRENCY.md "Locking and atomic outcomes"). Every helper here
 * locks in the ONE order request → attempt → verification ordinal: admissions (verify/recover) call them after the fence
 * and the approval lock; fact publications call them without ever taking the fence, the approval, auth or Connection rows.
 * The DB clock is read only after the last lock. Summaries carry no ticket ID, customer key, body, token or nonce.
 */
export type RequestRow = Prisma.ActionRequestGetPayload<{}>;
export type AttemptRow = Prisma.ActionAttemptGetPayload<{}>;
export type VerificationRow = Prisma.ActionVerificationGetPayload<{}>;
export interface ScopeIds { readonly workspaceId: string; readonly clientId: string }
type Tx = Prisma.TransactionClient;
/** Exactly the two scope keys (callers may pass a wider admission/publisher context). */
const only = (scope: ScopeIds): ScopeIds => ({ workspaceId: scope.workspaceId, clientId: scope.clientId });

/** Locks the request row (FOR UPDATE) and reads it; null when it is not visible in this scope. */
export async function lockRequestRow(tx: Tx, scope: ScopeIds, requestId: string): Promise<RequestRow | null> {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM public."ActionRequest"
    WHERE "workspaceId" = ${scope.workspaceId} AND "clientId" = ${scope.clientId} AND id = ${requestId}::uuid FOR UPDATE`;
  return locked.length === 1 ? tx.actionRequest.findUnique({ where: { workspaceId_clientId_id: { ...only(scope), id: requestId } } }) : null;
}
/** Locks the request's single lifetime attempt (after the request lock); null before reservation. */
export async function lockAttempt(tx: Tx, scope: ScopeIds, requestId: string): Promise<AttemptRow | null> {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM public."ActionAttempt"
    WHERE "workspaceId" = ${scope.workspaceId} AND "clientId" = ${scope.clientId} AND "requestId" = ${requestId}::uuid FOR UPDATE`;
  return locked.length === 1 ? tx.actionAttempt.findUnique({ where: { workspaceId_clientId_id: { ...only(scope), id: locked[0]!.id } } }) : null;
}
/** Locks one verification ordinal of the attempt (after the attempt lock); null when that ordinal was never claimed. */
export async function lockOrdinal(tx: Tx, scope: ScopeIds, attemptId: string, ordinal: number): Promise<VerificationRow | null> {
  const locked = await tx.$queryRaw<{ n: number }[]>`SELECT ordinal AS n FROM public."ActionVerification"
    WHERE "workspaceId" = ${scope.workspaceId} AND "clientId" = ${scope.clientId} AND "attemptId" = ${attemptId}::uuid AND ordinal = ${ordinal} FOR UPDATE`;
  return locked.length === 1 ? tx.actionVerification.findUnique({ where: { workspaceId_clientId_attemptId_ordinal: { ...only(scope), attemptId, ordinal } } }) : null;
}
/** The attempt's ACTIVE ordinal, locked; null without an active claim. */
export const lockActiveOrdinal = (tx: Tx, scope: ScopeIds, attempt: AttemptRow): Promise<VerificationRow | null> =>
  attempt.activeVerificationOrdinal === null ? Promise.resolve(null) : lockOrdinal(tx, scope, attempt.id, attempt.activeVerificationOrdinal);
/** DB clock (clock_timestamp), read after the transaction's last lock. */
export const dbClock = async (tx: Tx): Promise<Date> => (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0]!.now;

/** Released claim fields: the claim is no longer ACTIVE (its ordinal stays consumed — never a refund). */
export const CLEARED_CLAIM = Object.freeze({ activeVerificationToken: null, activeVerificationOrdinal: null, activeStartedAt: null,
  activeDeadlineAt: null, activeCandidateId: null });
/** Deployed contract versions equal the stored request's (every NEW verification/recovery admission). */
export const deployedVersions = (composition: ActionComposition, request: RequestRow): boolean => request.actionVersion === ACTION_VERSION
  && request.policyVersion === composition.policyVersion && request.portVersion === composition.portVersion && request.mode === ACTION_MODE;
/** A RESERVED attempt may be marked UNKNOWN at/after reservedAt + 35 s (deadline plus grace), never earlier. */
export const reservationRecoveryDue = (attempt: AttemptRow, now: Date): boolean =>
  attempt.state === 'RESERVED' && now.getTime() >= attempt.reservedAt.getTime() + RECOVERY_GRACE_MS;
/** An ACTIVE claim may be abandoned at/after its deadline (startedAt + 35 s), never earlier. */
export const claimRecoveryDue = (attempt: AttemptRow, now: Date): boolean =>
  attempt.verificationState === 'ACTIVE' && attempt.activeDeadlineAt !== null && now.getTime() >= attempt.activeDeadlineAt.getTime();
export const claimDeadline = (startedAt: Date): Date => new Date(startedAt.getTime() + CLAIM_WINDOW_MS);

/** Safe public summary of the stored request/attempt at `now`. */
export function executionSummary(request: Pick<RequestRow, 'id' | 'state' | 'inputHash'>, attempt: AttemptRow, now: Date): ActionExecutionSummary {
  return { requestId: request.id, state: request.state as RequestState, inputHash: request.inputHash, attemptId: attempt.id,
    attemptState: attempt.state as AttemptState, reservedAt: attempt.reservedAt.toISOString(), outcomeAt: attempt.outcomeAt?.toISOString() ?? null,
    verificationCount: attempt.verificationCount, verificationBudget: VERIFICATION_BUDGET, verificationState: attempt.verificationState as VerificationState,
    activeVerificationOrdinal: attempt.activeVerificationOrdinal, safeErrorCode: attempt.safeErrorCode,
    recoveryRequired: reservationRecoveryDue(attempt, now) || claimRecoveryDue(attempt, now), synthetic: true };
}
/** Re-reads both rows inside the same transaction (after its updates) for the summary of what was committed. */
export async function currentSummary(tx: Tx, scope: ScopeIds, requestId: string, attemptId: string, now: Date): Promise<ActionExecutionSummary> {
  const request = await tx.actionRequest.findUniqueOrThrow({ where: { workspaceId_clientId_id: { ...only(scope), id: requestId } }, select: { id: true, state: true, inputHash: true } });
  const attempt = await tx.actionAttempt.findUniqueOrThrow({ where: { workspaceId_clientId_id: { ...only(scope), id: attemptId } } });
  return executionSummary(request, attempt, now);
}
