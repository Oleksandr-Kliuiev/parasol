import type { Prisma } from '@prisma/client';
import { hasClientPermissions } from '../core/contracts.ts';
import { ACTION_MODE, ACTION_VERSION, APPROVE_PERMISSIONS, REQUEST_PERMISSIONS, RESERVED_STATES } from './contracts.ts';
import type { ActionErrorCode, RequestState } from './contracts.ts';
import { secretRefDigest } from './canonical.ts';
import type { ActionComposition } from './policy.ts';
import { clientAudit, setLocal } from './authority.ts';
import type { Admission, AdmissionOutcome } from './authority.ts';

/**
 * Shared stored signer/binding guard of every S3-B mutation (docs/stage3/02_CONTRACTS.md "Authority epochs, approval and
 * reservation", 03_DATA_AND_CONCURRENCY.md "Original credential validity" and "Locking"). Inside a fenced admission, in
 * lock order fence → request → approval (READ COMMITTED; Connection and auth rows are never row-locked, plain reads behind
 * the fence suffice); the DB clock is read only AFTER the last row lock, and the caller's own current token is re-checked
 * on it before ANY outcome — replay, refusal, loss or decision (lockedClock). The guard then checks, without any ApiToken read:
 * deployed contract versions, the exact authority epoch (equal epoch proves that no signer token, actor, membership or
 * Connection row mutated since signing), the stored signers' ACTIVE status and rights, the exact Connection binding, and
 * natural expiry of both immutable token-expiry snapshots and of the approval. A loss is a decided outcome: the caller
 * commits it (INVALIDATED or EXPIRED, unconsumed approval REVOKED, safe audit) and only then returns the fixed refusal.
 */
export type RequestRow = Prisma.ActionRequestGetPayload<{}>;
export type ApprovalRow = Prisma.ActionApprovalGetPayload<{}>;
export interface Loss { state: 'INVALIDATED' | 'EXPIRED'; code: ActionErrorCode }
type Tx = Prisma.TransactionClient;

const key = (admission: Admission, id: string) => ({ workspaceId_clientId_id: { workspaceId: admission.workspaceId, clientId: admission.clientId, id } });
export const isReserved = (state: string): boolean => (RESERVED_STATES as readonly string[]).includes(state as RequestState);

/** Locks the request row of this client (FOR UPDATE, after the fence) and reads it; null when it is not visible here. */
export async function lockRequest(tx: Tx, admission: Admission, requestId: string): Promise<RequestRow | null> {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM public."ActionRequest"
    WHERE "workspaceId" = ${admission.workspaceId} AND "clientId" = ${admission.clientId} AND id = ${requestId}::uuid FOR UPDATE`;
  return locked.length === 1 ? tx.actionRequest.findUnique({ where: key(admission, requestId) }) : null;
}
/** Locks the request's single decision row (after the request lock), whatever its decision; null when there is none. */
export async function lockApproval(tx: Tx, admission: Admission, requestId: string): Promise<ApprovalRow | null> {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM public."ActionApproval"
    WHERE "workspaceId" = ${admission.workspaceId} AND "clientId" = ${admission.clientId} AND "requestId" = ${requestId}::uuid FOR UPDATE`;
  return locked.length === 1 ? tx.actionApproval.findUnique({ where: key(admission, locked[0]!.id) }) : null;
}
const elapsed = (at: Date | null, now: Date): boolean => at !== null && at.getTime() <= now.getTime();
/**
 * The DB clock read after the LAST row lock of the transaction (never a caller-supplied or pre-lock time), or null when the
 * caller's own current token (captured at admission) expired while the transaction waited for those locks. Every command
 * calls it once, after all of its locks and before any outcome, and returns ACTION_AUTHENTICATION_FAILED on null: no
 * replayed result, refusal audit, terminal commit, decision or permit for an expired bearer.
 */
export async function lockedClock(tx: Tx, admission: Admission): Promise<Date | null> {
  const now = (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0]!.now;
  return elapsed(admission.signer.tokenExpiresAt, now) ? null : now;
}

/**
 * Does a stored signer still hold `permissions` (all of them, on ONE membership of this client) as an ACTIVE actor? Read
 * through the existing confined actor context (app.actor_id: the Actor_self/ClientMembership_self policies), never ApiToken;
 * the caller's client scope is restored and the token hash kept clear afterwards.
 */
async function storedSignerHolds(tx: Tx, admission: Admission, actorId: string, permissions: readonly string[]): Promise<boolean> {
  await setLocal(tx, { 'app.actor_id': actorId });
  const row = await tx.actor.findUnique({ where: { workspaceId_id: { workspaceId: admission.workspaceId, id: actorId } },
    select: { status: true, memberships: { select: { clientId: true, permissions: true } } } });
  await setLocal(tx, { 'app.token_hash': '', 'app.actor_id': '', 'app.workspace_id': admission.workspaceId, 'app.client_ids': admission.clientId });
  return row?.status === 'ACTIVE' && hasClientPermissions({ id: actorId, workspaceId: admission.workspaceId, workspacePermissions: [],
    memberships: row.memberships.map(m => ({ clientId: m.clientId, permissions: [...m.permissions] })) }, admission.clientId, permissions);
}
/** The stored request's exact atera FIXTURE binding, re-read (plain, no row lock) behind the fence (also S3-C read/recovery admission). */
export async function bindingHolds(tx: Tx, admission: Admission, request: RequestRow): Promise<boolean> {
  const c = await tx.connection.findUnique({ where: key(admission, request.connectionId),
    select: { system: true, status: true, externalTenantId: true, secretRef: true, lifecycleVersion: true } });
  return c !== null && c.system === 'atera' && c.status === 'FIXTURE' && c.system === request.connectionSystem && c.externalTenantId === request.customerKey
    && secretRefDigest(c.secretRef) === request.secretRefDigest && c.lifecycleVersion === request.connectionLifecycleVersion;
}

/**
 * The first loss of the stored intent at `now`, or null while it is still authorized. `approval` is the unconsumed APPROVED
 * decision when one exists. Version drift and epoch/signer/binding loss invalidate; elapsed snapshots or approval expire.
 */
export async function storedAuthorityLoss(tx: Tx, admission: Admission, composition: ActionComposition, request: RequestRow,
  approval: ApprovalRow | null, now: Date): Promise<Loss | null> {
  const deployed = (v: { actionVersion: string; policyVersion: string; portVersion: string; mode: string }) => v.actionVersion === ACTION_VERSION
    && v.policyVersion === composition.policyVersion && v.portVersion === composition.portVersion && v.mode === ACTION_MODE;
  if (!deployed(request) || (approval !== null && !deployed(approval))) return { state: 'INVALIDATED', code: 'ACTION_CONTRACT_VERSION_CHANGED' };
  const changed: Loss = { state: 'INVALIDATED', code: 'ACTION_AUTHORITY_CHANGED' };
  if (request.authorityEpoch !== admission.epoch || (approval !== null && approval.authorityEpoch !== admission.epoch)) return changed;
  if (!await storedSignerHolds(tx, admission, request.requesterActorId, REQUEST_PERMISSIONS)) return changed;
  if (approval !== null && !await storedSignerHolds(tx, admission, approval.signerActorId, APPROVE_PERMISSIONS)) return changed;
  if (!await bindingHolds(tx, admission, request)) return changed;
  if (elapsed(request.requesterTokenExpiresAt, now) || (approval !== null && (elapsed(approval.approverTokenExpiresAt, now) || elapsed(approval.expiresAt, now)))) {
    return { state: 'EXPIRED', code: 'APPROVAL_NOT_VALID' };
  }
  return null;
}

/** Sets the request state (and terminalAt once for a terminal outcome); the lifecycle trigger refuses any other transition. */
export async function setRequestState(tx: Tx, admission: Admission, requestId: string, state: RequestState, now: Date, terminal: boolean,
  safeErrorCode?: ActionErrorCode): Promise<void> {
  await tx.actionRequest.update({ where: key(admission, requestId), select: { id: true },
    data: { state, updatedAt: now, ...(terminal ? { terminalAt: now } : {}), ...(safeErrorCode ? { safeErrorCode } : {}) } });
}
export async function revokeApprovalRow(tx: Tx, admission: Admission, approvalId: string, now: Date, safeErrorCode?: ActionErrorCode): Promise<void> {
  await tx.actionApproval.update({ where: key(admission, approvalId), select: { id: true },
    data: { decision: 'REVOKED', revokedAt: now, ...(safeErrorCode ? { safeErrorCode } : {}) } });
}
/** Commits a guarded loss as the terminal outcome (unconsumed approval REVOKED, safe audit); the refusal follows the commit. */
export async function commitLoss<T>(tx: Tx, admission: Admission, request: RequestRow, approval: ApprovalRow | null, loss: Loss, now: Date):
  Promise<AdmissionOutcome<T>> {
  await setRequestState(tx, admission, request.id, loss.state, now, true, loss.code);
  if (approval?.decision === 'APPROVED') await revokeApprovalRow(tx, admission, approval.id, now, loss.code);
  await clientAudit(tx, admission, loss.state === 'EXPIRED' ? 'action.expired' : 'action.invalidated', { actionRequestId: request.id,
    requestState: loss.state, safeErrorCode: loss.code, ...(approval ? { actionApprovalId: approval.id } : {}) });
  return { refused: loss.code };
}
/** An authorized refusal without state change: one safe client audit row, then the fixed code. */
export async function refusal<T>(tx: Tx, admission: Admission, eventType: string, requestId: string, code: ActionErrorCode): Promise<AdmissionOutcome<T>> {
  await clientAudit(tx, admission, eventType, { actionRequestId: requestId, safeErrorCode: code });
  return { refused: code };
}
