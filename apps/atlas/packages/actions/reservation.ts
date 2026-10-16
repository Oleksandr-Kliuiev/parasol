import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { EXECUTE_PERMISSIONS, START_DEADLINE_MS, actionError } from './contracts.ts';
import type { ActionErrorCode, ActionReservationResult } from './contracts.ts';
import { isHash, isUuid } from './canonical.ts';
import type { ActionComposition } from './policy.ts';
import { clientAudit, withFencedAdmission } from './authority.ts';
import type { ActionCredential, AdmissionOutcome } from './authority.ts';
import { assertComposition } from './requests.ts';
import { commitLoss, isReserved, lockApproval, lockRequest, lockedClock, refusal, setRequestState, storedAuthorityLoss } from './guard.ts';

/**
 * Atomic reservation and its private single-use permit (02_CONTRACTS "Authority epochs, approval and reservation", 04
 * "State machine and create ownership"). One fenced READ COMMITTED transaction, lock order fence → request → approval, the
 * attempt only read (its unique keys are the durable latch). Fresh executor execute/read/context, then — DB clock after the
 * locks, the executor's own token re-checked on it before any outcome — the shared guard over the stored requester and approver, epoch, binding, versions and both expiries. Approval
 * CONSUMED + the unique lifetime attempt + DISPATCH_RESERVED + audit commit together, or nothing does. No port call and no
 * automatic retry: a deadlock/serialization abort is ACTION_DB_CONFLICT with zero effect. The commit is the authorization
 * linearization point; only after it does a permit exist.
 *
 * The permit is an opaque frozen object whose state lives in a module WeakMap: a serialized or fabricated copy is unknown.
 * It is bound to the committed attempt (mode, Connection binding, request hash, create nonce) and is consumed at most once,
 * before the start deadline = min(reservedAt + 5 s, approval expiry), measured on the monotonic clock from a mark taken
 * before the DB clock was read (never renewed at commit, never caller-supplied). A failed or late consumption spends the
 * permit: no second reservation, no reset. The S3-C dispatcher (execution.ts) is the only consumer; for a late first use it
 * publishes the known zero-call NOT_DISPATCHED, otherwise the attempt stays RESERVED until explicit recovery.
 */
export interface ReservationPermit { readonly kind: 'ActionReservationPermit' }
/** What a consumed permit hands to the trusted dispatcher (S3-C): the stored intent, its binding and the attempt identity. */
export interface ReservedDispatch {
  readonly workspaceId: string; readonly clientId: string; readonly requestId: string; readonly approvalId: string; readonly attemptId: string;
  readonly attemptToken: string; readonly createNonce: string; readonly mode: string; readonly inputHash: string; readonly connectionId: string;
  readonly customerKey: string; readonly secretRefDigest: string; readonly connectionLifecycleVersion: number; readonly markedTitle: string;
  readonly description: string; readonly startDeadlineAt: Date;
  /** S3-C: the executor and correlation of the reservation, for the safe audit of facts its continuation publishes. */
  readonly actorId: string; readonly correlationId: string;
}
export interface PermitExpectation { workspaceId: string; clientId: string; requestId: string; inputHash: string; mode: string }
interface PermitState { readonly dispatch: ReservedDispatch; readonly deadline: number; used: boolean }
const permits = new WeakMap<ReservationPermit, PermitState>();

interface Committed { reservation: ActionReservationResult; dispatch: ReservedDispatch; deadline: number }

/** action-execute's reservation step: request ID + expected hash, executor's fresh authority; returns the public result and the permit. */
export async function reserveAction(db: PrismaClient, composition: ActionComposition, credential: ActionCredential, clientId: string,
  requestId: string, expectedHash: string): Promise<{ reservation: ActionReservationResult; permit: ReservationPermit; expected: PermitExpectation }> {
  assertComposition(composition);
  if (!isUuid(requestId) || !isHash(expectedHash)) throw actionError('ACTION_INPUT_INVALID');
  const committed = await withFencedAdmission(db, credential, clientId, { permissions: EXECUTE_PERMISSIONS, deniedEvent: 'action.execute_denied' },
    async (tx, admission): Promise<AdmissionOutcome<Committed>> => {
      const request = await lockRequest(tx, admission, requestId);
      if (!request) return { refused: 'ACTION_NOT_FOUND' };
      const approval = await lockApproval(tx, admission, request.id);
      const attempt = await tx.actionAttempt.findUnique({ where: { workspaceId_clientId_requestId: { workspaceId: admission.workspaceId,
        clientId: admission.clientId, requestId: request.id } }, select: { id: true } });
      const mark = performance.now(); // before the DB clock read: the local deadline can only be earlier than the stored one
      const now = await lockedClock(tx, admission);
      if (!now) return { refused: 'ACTION_AUTHENTICATION_FAILED' };
      const refuse = (code: ActionErrorCode) => refusal<Committed>(tx, admission, 'action.execute_refused', request.id, code);
      if (request.inputHash !== expectedHash) return refuse('APPROVAL_HASH_MISMATCH');
      if (isReserved(request.state) || attempt) return refuse('ACTION_ALREADY_RESERVED');
      if (request.state !== 'APPROVED' || approval?.decision !== 'APPROVED' || approval.expiresAt === null) return refuse('APPROVAL_NOT_VALID');
      const loss = await storedAuthorityLoss(tx, admission, composition, request, approval, now);
      if (loss) return commitLoss(tx, admission, request, approval, loss, now);
      const startDeadlineAt = new Date(Math.min(now.getTime() + START_DEADLINE_MS, approval.expiresAt.getTime()));
      if (startDeadlineAt.getTime() <= now.getTime()) return refuse('APPROVAL_NOT_VALID');
      await tx.actionApproval.update({ where: { workspaceId_clientId_id: { workspaceId: admission.workspaceId, clientId: admission.clientId, id: approval.id } },
        data: { decision: 'CONSUMED', consumedAt: now }, select: { id: true } });
      const created = await tx.actionAttempt.create({ data: { workspaceId: admission.workspaceId, clientId: admission.clientId, id: randomUUID(),
        requestId: request.id, approvalId: approval.id, attemptToken: randomUUID(), createNonce: randomUUID(), reservedAt: now, startDeadlineAt, updatedAt: now },
        select: { id: true, attemptToken: true, createNonce: true } });
      await setRequestState(tx, admission, request.id, 'DISPATCH_RESERVED', now, false);
      await clientAudit(tx, admission, 'action.reserved', { actionRequestId: request.id, actionApprovalId: approval.id, actionAttemptId: created.id,
        requestState: 'DISPATCH_RESERVED' });
      return { ok: {
        reservation: { requestId: request.id, state: 'DISPATCH_RESERVED', inputHash: request.inputHash, authorityEpoch: request.authorityEpoch,
          approvalId: approval.id, attemptId: created.id, reservedAt: now.toISOString(), startDeadlineAt: startDeadlineAt.toISOString(), synthetic: true },
        dispatch: { workspaceId: admission.workspaceId, clientId: admission.clientId, requestId: request.id, approvalId: approval.id, attemptId: created.id,
          attemptToken: created.attemptToken, createNonce: created.createNonce, mode: request.mode, inputHash: request.inputHash,
          connectionId: request.connectionId, customerKey: request.customerKey, secretRefDigest: request.secretRefDigest,
          connectionLifecycleVersion: request.connectionLifecycleVersion, markedTitle: request.markedTitle, description: request.description, startDeadlineAt,
          actorId: admission.actor.id, correlationId: admission.correlationId },
        // Millisecond storage may round the DB clock down by < 1 ms: one more millisecond keeps the local deadline earlier.
        deadline: mark + (startDeadlineAt.getTime() - now.getTime()) - 1 } };
    });
  // Committed. A refusal, rollback, conflict or audit failure above threw before this line, so no permit exists for it.
  const permit: ReservationPermit = Object.freeze({ kind: 'ActionReservationPermit' as const });
  permits.set(permit, { dispatch: Object.freeze(committed.dispatch), deadline: committed.deadline, used: false });
  const d = committed.dispatch;
  return { reservation: committed.reservation, permit,
    expected: { workspaceId: d.workspaceId, clientId: d.clientId, requestId: d.requestId, inputHash: d.inputHash, mode: d.mode } };
}

/**
 * Consumes a permit exactly once, before its start deadline, for exactly the expected request/hash/mode. Any failure —
 * unknown or copied handle, second use, late, other request — is the fixed APPROVAL_NOT_VALID and spends the permit.
 */
export function consumeReservationPermit(permit: ReservationPermit, expected: PermitExpectation): ReservedDispatch {
  const use = takeReservationPermit(permit, expected);
  if ('dispatch' in use) return use.dispatch;
  throw actionError('APPROVAL_NOT_VALID');
}
/**
 * The same single consumption for the trusted S3-C dispatcher. A refusal of the FIRST use for the expected attempt (its
 * start deadline passed) still spends the permit, and additionally hands back that attempt's dispatch: the dispatcher
 * positively knows no create call happened and publishes NOT_DISPATCHED with it. An unknown, copied, reused or
 * other-request permit yields no dispatch at all (the attempt, if any, stays RESERVED for explicit recovery).
 */
export function takeReservationPermit(permit: ReservationPermit, expected: PermitExpectation):
  { dispatch: ReservedDispatch } | { refused: 'APPROVAL_NOT_VALID'; spent: ReservedDispatch | null } {
  const state = permits.get(permit);
  if (!state || state.used) return { refused: 'APPROVAL_NOT_VALID', spent: null };
  state.used = true;
  const d = state.dispatch;
  if (d.workspaceId !== expected.workspaceId || d.clientId !== expected.clientId || d.requestId !== expected.requestId
    || d.inputHash !== expected.inputHash || d.mode !== expected.mode) return { refused: 'APPROVAL_NOT_VALID', spent: null };
  if (performance.now() >= state.deadline) return { refused: 'APPROVAL_NOT_VALID', spent: d };
  return { dispatch: d };
}
