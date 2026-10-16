import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { APPROVAL_TTL_MS, APPROVE_PERMISSIONS, CANCEL_PERMISSIONS, INPUT_MAX_BYTES, PREVIEW_FIELDS, actionError } from './contracts.ts';
import type { ActionDecisionResult, ActionErrorCode, ApprovalDecision, RequestState } from './contracts.ts';
import { isHash, isUuid, parsePreviewDocument } from './canonical.ts';
import type { ActionComposition } from './policy.ts';
import { clientAudit, withFencedAdmission } from './authority.ts';
import type { ActionCredential, Admission, AdmissionOutcome } from './authority.ts';
import { readProtectedJson } from './private-file.ts';
import { assertComposition, storedPreview } from './requests.ts';
import {
  commitLoss, isReserved, lockApproval, lockRequest, lockedClock, refusal, revokeApprovalRow, setRequestState, storedAuthorityLoss,
} from './guard.ts';
import type { ApprovalRow, RequestRow } from './guard.ts';

/**
 * Approval, rejection, revocation and cancellation (02_CONTRACTS "Exact protected preview and approval" and "Authority
 * epochs, approval and reservation"; 04 state machine). Each runs in one fenced admission with fresh current bearer
 * authority — context:read + actions:read + the command grant on ONE membership of the client — then locks request →
 * approval, reads the DB clock and re-checks the caller's own token on it (all before any replay, refusal or decision),
 * and runs the shared stored guard before deciding. A guarded loss is committed as the terminal
 * outcome and refused afterwards. Caller input never supplies an actor, a timestamp or replacement content.
 *   approve: approve/read/context, never the requester; exact STORED_ACTION_PREVIEW file + expected hash compared with the
 *            locked immutable request. Fresh approval only on AWAITING_APPROVAL; the same signer's APPROVED decision is
 *            replayed without mutation, audit or renewal. Lifetime: DB clock + 15 min, capped by both token-expiry snapshots.
 *   reject:  approve/read/context on AWAITING_APPROVAL → REJECTED (a REJECTED decision row, no lifetime).
 *   revoke:  the original signer only, exact request/hash: APPROVED → REVOKED with its approval; a repeat returns the stored result.
 *   cancel:  the original requester only, before reservation: → CANCELLED, an APPROVED decision REVOKED with it.
 * After reservation, reject/revoke/cancel return ACTION_ALREADY_RESERVED (nothing is claimed to be prevented).
 */
type Outcome = AdmissionOutcome<ActionDecisionResult>;

function decision(request: Pick<RequestRow, 'id' | 'inputHash' | 'authorityEpoch'>, state: RequestState, approval: ApprovalRow | null,
  idempotent: boolean): ActionDecisionResult {
  return { requestId: request.id, state, inputHash: request.inputHash, authorityEpoch: request.authorityEpoch, approvalId: approval?.id ?? null,
    decision: (approval?.decision ?? null) as ApprovalDecision | null, decidedAt: approval?.decidedAt.toISOString() ?? null,
    expiresAt: approval?.expiresAt?.toISOString() ?? null, idempotent, synthetic: true };
}
/** Every whitelisted field of the supplied preview equals the projection of the locked stored request (and nothing else is present). */
function previewMatches(material: unknown, request: RequestRow): boolean {
  let doc;
  try { doc = parsePreviewDocument(material); } catch { return false; }
  const stored = storedPreview(request);
  return PREVIEW_FIELDS.every(field => doc[field] === stored[field]);
}
function validated(composition: ActionComposition, requestId: string, expectedHash?: string): void {
  assertComposition(composition);
  if (!isUuid(requestId) || (expectedHash !== undefined && !isHash(expectedHash))) throw actionError('ACTION_INPUT_INVALID');
}
/** The new decision row: the request's exact hash/epoch/versions/mode, the caller's verified token row and expiry snapshot. */
async function insertDecision(tx: Prisma.TransactionClient, admission: Admission, request: RequestRow,
  kind: 'APPROVED' | 'REJECTED', now: Date, expiresAt: Date | null): Promise<ApprovalRow> {
  return tx.actionApproval.create({ data: { workspaceId: admission.workspaceId, clientId: admission.clientId, id: randomUUID(), requestId: request.id,
    requesterActorId: request.requesterActorId, requestHash: request.inputHash, authorityEpoch: request.authorityEpoch, actionVersion: request.actionVersion,
    policyVersion: request.policyVersion, portVersion: request.portVersion, mode: request.mode, signerActorId: admission.signer.actorId,
    signerTokenId: admission.signer.tokenId, approverTokenExpiresAt: admission.signer.tokenExpiresAt, decision: kind, decidedAt: now,
    approvedAt: kind === 'APPROVED' ? now : null, expiresAt } });
}

/** action-approve --request --hash --preview-file. */
export async function approveAction(db: PrismaClient, composition: ActionComposition, credential: ActionCredential, clientId: string,
  requestId: string, expectedHash: string, previewFile: string): Promise<ActionDecisionResult> {
  validated(composition, requestId, expectedHash);
  const material = await readProtectedJson(previewFile, INPUT_MAX_BYTES);
  return withFencedAdmission(db, credential, clientId, { permissions: APPROVE_PERMISSIONS, deniedEvent: 'action.approve_denied' },
    async (tx, admission): Promise<Outcome> => {
      const request = await lockRequest(tx, admission, requestId);
      if (!request) return { refused: 'ACTION_NOT_FOUND' };
      const approval = request.state === 'APPROVED' ? await lockApproval(tx, admission, request.id) : null;
      const now = await lockedClock(tx, admission);
      if (!now) return { refused: 'ACTION_AUTHENTICATION_FAILED' };
      const refuse = (code: ActionErrorCode) => refusal<ActionDecisionResult>(tx, admission, 'action.approve_refused', request.id, code);
      if (request.inputHash !== expectedHash) return refuse('APPROVAL_HASH_MISMATCH');
      if (!previewMatches(material, request)) return refuse('APPROVAL_PREVIEW_MISMATCH');
      if (admission.actor.id === request.requesterActorId) return refuse('APPROVAL_SELF_REFUSED');
      const replay = approval?.decision === 'APPROVED' && approval.signerActorId === admission.actor.id ? approval : null;
      if (request.state !== 'AWAITING_APPROVAL' && !replay) return refuse('APPROVAL_NOT_VALID');
      const loss = await storedAuthorityLoss(tx, admission, composition, request, replay, now);
      if (loss) return commitLoss(tx, admission, request, replay, loss, now);
      if (replay) return { ok: decision(request, 'APPROVED', replay, true) }; // no new decision, audit or renewal
      const caps = [request.requesterTokenExpiresAt, admission.signer.tokenExpiresAt].filter((d): d is Date => d !== null).map(d => d.getTime());
      const expiresAt = new Date(Math.min(now.getTime() + APPROVAL_TTL_MS, ...caps));
      if (expiresAt.getTime() <= now.getTime()) return refuse('APPROVAL_NOT_VALID'); // a cap within this very millisecond
      const created = await insertDecision(tx, admission, request, 'APPROVED', now, expiresAt);
      await setRequestState(tx, admission, request.id, 'APPROVED', now, false);
      await clientAudit(tx, admission, 'action.approved', { actionRequestId: request.id, actionApprovalId: created.id, requestState: 'APPROVED',
        approvalDecision: 'APPROVED' });
      return { ok: decision(request, 'APPROVED', created, false) };
    });
}

/** action-reject --request --hash: a pending request becomes REJECTED. */
export async function rejectAction(db: PrismaClient, composition: ActionComposition, credential: ActionCredential, clientId: string,
  requestId: string, expectedHash: string): Promise<ActionDecisionResult> {
  validated(composition, requestId, expectedHash);
  return withFencedAdmission(db, credential, clientId, { permissions: APPROVE_PERMISSIONS, deniedEvent: 'action.reject_denied' },
    async (tx, admission): Promise<Outcome> => {
      const request = await lockRequest(tx, admission, requestId);
      if (!request) return { refused: 'ACTION_NOT_FOUND' };
      const now = await lockedClock(tx, admission); // a pending request has no decision row to lock
      if (!now) return { refused: 'ACTION_AUTHENTICATION_FAILED' };
      const refuse = (code: ActionErrorCode) => refusal<ActionDecisionResult>(tx, admission, 'action.reject_refused', request.id, code);
      if (request.inputHash !== expectedHash) return refuse('APPROVAL_HASH_MISMATCH');
      if (isReserved(request.state)) return refuse('ACTION_ALREADY_RESERVED');
      if (admission.actor.id === request.requesterActorId) return refuse('APPROVAL_SELF_REFUSED');
      if (request.state !== 'AWAITING_APPROVAL') return refuse('APPROVAL_NOT_VALID');
      const loss = await storedAuthorityLoss(tx, admission, composition, request, null, now);
      if (loss) return commitLoss(tx, admission, request, null, loss, now);
      const created = await insertDecision(tx, admission, request, 'REJECTED', now, null);
      await setRequestState(tx, admission, request.id, 'REJECTED', now, true);
      await clientAudit(tx, admission, 'action.rejected', { actionRequestId: request.id, actionApprovalId: created.id, requestState: 'REJECTED',
        approvalDecision: 'REJECTED' });
      return { ok: decision(request, 'REJECTED', created, false) };
    });
}

/** action-revoke --request --hash: only the original signer of the unconsumed APPROVED decision. */
export async function revokeApproval(db: PrismaClient, composition: ActionComposition, credential: ActionCredential, clientId: string,
  requestId: string, expectedHash: string): Promise<ActionDecisionResult> {
  validated(composition, requestId, expectedHash);
  return withFencedAdmission(db, credential, clientId, { permissions: APPROVE_PERMISSIONS, deniedEvent: 'action.revoke_denied' },
    async (tx, admission): Promise<Outcome> => {
      const request = await lockRequest(tx, admission, requestId);
      if (!request) return { refused: 'ACTION_NOT_FOUND' };
      const approval = await lockApproval(tx, admission, request.id);
      const now = await lockedClock(tx, admission); // also before the stored REVOKED replay
      if (!now) return { refused: 'ACTION_AUTHENTICATION_FAILED' };
      const refuse = (code: ActionErrorCode) => refusal<ActionDecisionResult>(tx, admission, 'action.revoke_refused', request.id, code);
      if (request.inputHash !== expectedHash) return refuse('APPROVAL_HASH_MISMATCH');
      if (isReserved(request.state)) return refuse('ACTION_ALREADY_RESERVED');
      if (!approval || approval.signerActorId !== admission.actor.id) return refuse('APPROVAL_NOT_VALID'); // another signer, even with approve
      if (request.state === 'REVOKED' && approval.decision === 'REVOKED') return { ok: decision(request, 'REVOKED', approval, true) };
      if (request.state !== 'APPROVED' || approval.decision !== 'APPROVED') return refuse('APPROVAL_NOT_VALID');
      const loss = await storedAuthorityLoss(tx, admission, composition, request, approval, now);
      if (loss) return commitLoss(tx, admission, request, approval, loss, now);
      await revokeApprovalRow(tx, admission, approval.id, now);
      await setRequestState(tx, admission, request.id, 'REVOKED', now, true);
      await clientAudit(tx, admission, 'action.revoked', { actionRequestId: request.id, actionApprovalId: approval.id, requestState: 'REVOKED',
        approvalDecision: 'REVOKED' });
      return { ok: decision(request, 'REVOKED', { ...approval, decision: 'REVOKED' }, false) };
    });
}

/** action-cancel --request: only the original requester, before reservation. */
export async function cancelAction(db: PrismaClient, composition: ActionComposition, credential: ActionCredential, clientId: string,
  requestId: string): Promise<ActionDecisionResult> {
  validated(composition, requestId);
  return withFencedAdmission(db, credential, clientId, { permissions: CANCEL_PERMISSIONS, deniedEvent: 'action.cancel_denied' },
    async (tx, admission): Promise<Outcome> => {
      const request = await lockRequest(tx, admission, requestId);
      if (!request) return { refused: 'ACTION_NOT_FOUND' };
      const approval = await lockApproval(tx, admission, request.id);
      const now = await lockedClock(tx, admission); // also before the stored CANCELLED replay
      if (!now) return { refused: 'ACTION_AUTHENTICATION_FAILED' };
      const refuse = (code: ActionErrorCode) => refusal<ActionDecisionResult>(tx, admission, 'action.cancel_refused', request.id, code);
      if (isReserved(request.state)) return refuse('ACTION_ALREADY_RESERVED');
      if (request.requesterActorId !== admission.actor.id) return refuse('ACTION_STATE_CONFLICT');
      if (request.state === 'CANCELLED') return { ok: decision(request, 'CANCELLED', approval, true) };
      if (request.state !== 'AWAITING_APPROVAL' && request.state !== 'APPROVED') return refuse('ACTION_STATE_CONFLICT');
      const pending = approval?.decision === 'APPROVED' ? approval : null;
      const loss = await storedAuthorityLoss(tx, admission, composition, request, pending, now);
      if (loss) return commitLoss(tx, admission, request, pending, loss, now);
      if (pending) await revokeApprovalRow(tx, admission, pending.id, now);
      await setRequestState(tx, admission, request.id, 'CANCELLED', now, true);
      await clientAudit(tx, admission, 'action.cancelled', { actionRequestId: request.id, requestState: 'CANCELLED',
        ...(pending ? { actionApprovalId: pending.id, approvalDecision: 'REVOKED' } : {}) });
      return { ok: decision(request, 'CANCELLED', pending ? { ...pending, decision: 'REVOKED' } : approval, false) };
    });
}
