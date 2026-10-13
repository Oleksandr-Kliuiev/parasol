import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Actor } from '../core/contracts.ts';
import { AtlasError, hasClientPermissions } from '../core/contracts.ts';
import { BEARER_TOKEN_PATTERN, hashToken } from '../auth/token.ts';
import { currentToken, setLocal } from '../auth/transaction-token.ts';
import { auditText, sanitizeAuditMetadata } from '../audit/sanitize.ts';
import { clientAuditData } from '../audit/prisma.ts';
import { ACTION_FENCE_READY_SQL, actionFenceProblems } from '../graph/fence-role.ts';
import { SCOPE_ID_PATTERN } from '../graph/scope-context.ts';
import type { ActionFenceFacts } from '../graph/fence-role.ts';
import { isDbConflict, isFenceNotReady, sqlState } from '../graph/fence-errors.ts';
import { ACTION_ERROR_CODES, PENDING_STATES, actionError } from './contracts.ts';
import type { ActionErrorCode, RequestState, ValidityHint } from './contracts.ts';

/**
 * Fenced action admission (docs/stage3/03_DATA_AND_CONCURRENCY.md "Original credential validity" and "Locking"). One READ
 * COMMITTED transaction as the confined runtime role:
 *   1. accepted bearer-hash lookup (app.token_hash only) gives the workspace hint;
 *   2. the token hash is cleared, the one workspace fence row is locked SELECT ... FOR UPDATE (exactly one row, else
 *      ACTION_FENCE_NOT_READY) and the privileged surface is re-checked (ACTION_FENCE_READY_SQL);
 *   3. authentication is repeated after the lock with the DB clock (clock_timestamp after locks): the CURRENT token row ID
 *      and its exact nullable expiry, then — hash cleared — the ACTIVE actor and its memberships (app.actor_id lookup);
 *   4. the required permissions on ONE membership of the client, else exactly one workspace SecurityAuditEvent;
 *   5. the callback runs under the client scope with the fence version as the authority epoch.
 * Every setting is transaction-local. The fence version cannot change while the lock is held: every auth/Connection
 * mutation of the workspace increments it first. Refusals are committed (with their audit) and then raised.
 */
export interface ActionCredential { readonly kind: 'ActionCredential' }
const bearerHashes = new WeakMap<ActionCredential, string>();
/** Opaque private credential for one CLI process: only the SHA-256 digest of the bearer is kept, in memory. */
export function actionCredential(bearer: string): ActionCredential {
  if (typeof bearer !== 'string' || !BEARER_TOKEN_PATTERN.test(bearer)) throw actionError('ACTION_AUTHENTICATION_FAILED');
  const credential: ActionCredential = Object.freeze({ kind: 'ActionCredential' as const });
  bearerHashes.set(credential, hashToken(bearer));
  return credential;
}

/** The signer's verified current token row and its immutable expiry snapshot, captured after the fence lock. */
export interface SignerSnapshot { actorId: string; tokenId: string; tokenExpiresAt: Date | null }
export interface Admission { actor: Actor; signer: SignerSnapshot; workspaceId: string; clientId: string; epoch: number; now: Date; correlationId: string }
export type AdmissionOutcome<T> = { ok: T } | { refused: ActionErrorCode };
export interface AdmissionOptions { permissions: readonly string[]; deniedEvent: string }

/** Transaction-local settings and the current-token lookup: shared verbatim with Stage 4 (packages/auth/transaction-token.ts). */
export { setLocal };

/** Writes one workspace denial (requested client as escaped text, never a client audit row). */
async function securityDenial(tx: Prisma.TransactionClient, actor: Actor, clientId: string, eventType: string, code: ActionErrorCode, correlationId: string) {
  await setLocal(tx, { 'app.workspace_id': actor.workspaceId, 'app.client_ids': '' });
  await tx.securityAuditEvent.create({ data: { workspaceId: actor.workspaceId, id: randomUUID(), actorId: actor.id, eventType: auditText(eventType),
    outcome: 'DENIED', requestedClientId: auditText(clientId), reasonCode: code, correlationId, metadata: sanitizeAuditMetadata({}) }, select: { id: true } });
}
/**
 * Fixed code of a failed audit write (the whole transaction rolls back either way): a deadlock/serialization abort of the
 * audit INSERT itself (40P01/40001, Prisma P2034) is ACTION_DB_CONFLICT like any other pre-dispatch conflict; anything else
 * is ACTION_AUDIT_FAILED. Never the raw error, never a retry.
 */
const auditFailure = (error: unknown): AtlasError => actionError(isDbConflict(error) ? 'ACTION_DB_CONFLICT' : 'ACTION_AUDIT_FAILED');
/** Safe client audit inside the admission transaction (allowlisted metadata only); its failure rolls everything back. */
export async function clientAudit(tx: Prisma.TransactionClient, admission: Admission, eventType: string, metadata: Record<string, string>): Promise<void> {
  try {
    await tx.auditEvent.create({ data: clientAuditData({ workspaceId: admission.workspaceId, clientId: admission.clientId }, admission.actor.id,
      eventType, admission.correlationId, metadata), select: { id: true } });
  } catch (error) { throw auditFailure(error); }
}

const FIXED = new Set<string>(ACTION_ERROR_CODES);
/** Fixed public code of any failure: known action codes pass, fence/conflict SQLSTATEs map, everything else is unexpected. */
export function actionFailure(error: unknown): AtlasError {
  if (error instanceof AtlasError && FIXED.has(error.code)) return actionError(error.code as ActionErrorCode);
  if (isFenceNotReady(error)) return actionError('ACTION_FENCE_NOT_READY');
  if (isDbConflict(error) || (error as { code?: unknown } | null)?.code === 'P2028') return actionError('ACTION_DB_CONFLICT');
  return actionError('UNEXPECTED_ERROR');
}

export async function withFencedAdmission<T>(db: PrismaClient, credential: ActionCredential, clientId: string, options: AdmissionOptions,
  fn: (tx: Prisma.TransactionClient, admission: Admission) => Promise<AdmissionOutcome<T>>): Promise<T> {
  const hash = bearerHashes.get(credential);
  if (hash === undefined) throw actionError('ACTION_AUTHENTICATION_FAILED');
  let outcome: AdmissionOutcome<T>;
  try {
    outcome = await db.$transaction(async tx => {
      await setLocal(tx, { 'app.token_hash': '', 'app.workspace_id': '', 'app.client_ids': '', 'app.actor_id': '' });
      const hint = await currentToken(tx, hash);
      if (!hint) throw actionError('ACTION_AUTHENTICATION_FAILED');
      const workspaceId = hint.workspaceId;
      await setLocal(tx, { 'app.workspace_id': workspaceId });
      // The lock needs the runtime's UPDATE(workspaceId) grant: its absence is an unready surface, not an unexpected error.
      const fence = await tx.$queryRaw<{ version: number }[]>`
        SELECT version FROM public."ActionAuthorityFence" WHERE "workspaceId" = ${workspaceId} FOR UPDATE`
        .catch((error: unknown) => { throw sqlState(error) === '42501' ? actionError('ACTION_FENCE_NOT_READY') : error; });
      if (fence.length !== 1) throw actionError('ACTION_FENCE_NOT_READY');
      const facts = await tx.$queryRawUnsafe<ActionFenceFacts[]>(ACTION_FENCE_READY_SQL);
      if (actionFenceProblems(facts[0]).length > 0) throw actionError('ACTION_FENCE_NOT_READY');
      // Re-authentication behind the fence: current row, same workspace, DB clock.
      const token = await currentToken(tx, hash);
      if (!token || token.workspaceId !== workspaceId) throw actionError('ACTION_AUTHENTICATION_FAILED');
      await setLocal(tx, { 'app.actor_id': token.actorId });
      const row = await tx.actor.findUnique({ where: { workspaceId_id: { workspaceId, id: token.actorId } },
        select: { id: true, status: true, workspacePermissions: true, memberships: { select: { clientId: true, permissions: true }, orderBy: { clientId: 'asc' } } } });
      await setLocal(tx, { 'app.actor_id': '' });
      if (!row || row.status !== 'ACTIVE') throw actionError('ACTION_AUTHENTICATION_FAILED');
      const actor: Actor = { id: row.id, workspaceId, workspacePermissions: [...row.workspacePermissions],
        memberships: row.memberships.map(m => ({ clientId: m.clientId, permissions: [...m.permissions] })) };
      const correlationId = randomUUID();
      // A malformed client ID never reaches app.client_ids: it is no membership of this actor (SCOPE_DENIED, audited).
      const member = SCOPE_ID_PATTERN.test(clientId) && actor.memberships.some(m => m.clientId === clientId);
      if (!member || !hasClientPermissions(actor, clientId, options.permissions)) {
        const code: ActionErrorCode = member ? 'PERMISSION_DENIED' : 'SCOPE_DENIED';
        try { await securityDenial(tx, actor, clientId, options.deniedEvent, code, correlationId); } catch (error) { throw auditFailure(error); }
        return { refused: code };
      }
      await setLocal(tx, { 'app.workspace_id': workspaceId, 'app.client_ids': clientId });
      const admission: Admission = { actor, workspaceId, clientId, epoch: Number(fence[0]!.version), now: token.now, correlationId,
        signer: { actorId: actor.id, tokenId: token.id, tokenExpiresAt: token.expiresAt } };
      return fn(tx, admission);
    }, { maxWait: 10_000, timeout: 20_000 });
  } catch (error) { throw actionFailure(error); }
  if ('refused' in outcome) throw actionError(outcome.refused);
  return outcome.ok;
}

/** Why a stored request would (not) be approvable now; never changes it. Epoch mismatch first, then the token snapshot. */
export function validityHint(state: string, storedEpoch: number, currentEpoch: number, tokenExpiresAt: Date | null, now: Date): ValidityHint {
  if (!(PENDING_STATES as readonly string[]).includes(state as RequestState)) return 'NOT_PENDING';
  if (storedEpoch !== currentEpoch) return 'AUTHORITY_CHANGED';
  if (tokenExpiresAt !== null && tokenExpiresAt.getTime() <= now.getTime()) return 'SIGNER_EXPIRED';
  return 'CURRENT';
}
