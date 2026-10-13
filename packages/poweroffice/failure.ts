import type { PrismaClient } from '@prisma/client';
import { setLocal } from '../auth/transaction-token.ts';
import { ACTION_FENCE_READY_SQL, actionFenceProblems } from '../graph/fence-role.ts';
import type { ActionFenceFacts } from '../graph/fence-role.ts';
import { POWEROFFICE_READY_SQL, powerOfficeProblems } from '../graph/poweroffice-role.ts';
import type { PowerOfficeFacts } from '../graph/poweroffice-role.ts';
import { sqlState } from '../graph/fence-errors.ts';
import { POWEROFFICE_ATTEMPT_CODES, powerOfficeError } from './contracts.ts';
import type { PowerOfficeErrorCode } from './contracts.ts';
import { powerOfficeFailure } from './authority.ts';
import { lockState } from './locks.ts';
import { factAuditId, failureIdentity } from './capabilities.ts';
import type { ClaimIdentity, FailureContinuation } from './capabilities.ts';
import { claimKey, sameIdentity } from './page.ts';
import { attemptClock, closeClaim, insertAudit, lockAttemptRow } from './rows.ts';

/**
 * Private failure continuation (docs/stage4/03_DATA_AND_CONCURRENCY.md "A private failure continuation…", 04 step 4). The
 * capability minted at admission closes ONLY its own still-ACTIVE claim as FAILED with a fixed attempt code, even after
 * the caller's revocation or a binding loss — it carries no credential and confers no read, source or publication
 * authority, reads no Connection, token, actor or membership and never touches the snapshot pointer or lastSuccessAt.
 * One runtime transaction in the write lock order: workspace fence FOR UPDATE → readiness (fail closed) → State FOR UPDATE
 * → the owned Attempt FOR UPDATE → exact ownership (ID, claim token, sequence, allocated snapshot, version, asOf, actor)
 * → the DB clock strictly before the ORIGINAL stored deadlineAt (also the local original deadline before any work). Then
 * FAILED + lastAttempt/lastCompleted + the FAILED audit row (stable ID) commit together.
 * Outcomes: FAILED; NO_OP for a terminal attempt (replay; no second audit); EXPIRED at/after the deadline (no mutation —
 * explicit recovery closes it). The same bounded rule as publication applies: only a positively known rollback
 * (40P01/40001) re-runs, at most three transactions in total, without minting any new authority or time window. An audit
 * or persistence failure leaves the claim ACTIVE for explicit recovery and surfaces its fixed code.
 */
export type FailureOutcome = 'FAILED' | 'NO_OP' | 'EXPIRED';
export const FAILURE_ATTEMPTS = 3;
const FENCE_UPDATE = `SELECT version FROM public."ActionAuthorityFence" WHERE "workspaceId" = $1 FOR UPDATE`;

async function closeOnce(db: PrismaClient, id: ClaimIdentity, code: PowerOfficeErrorCode): Promise<FailureOutcome> {
  const key = claimKey(id);
  return db.$transaction(async tx => {
    await setLocal(tx, { 'app.token_hash': '', 'app.actor_id': '', 'app.poweroffice_connection_id': '', 'app.workspace_id': id.workspaceId, 'app.client_ids': '' });
    const fence = await tx.$queryRawUnsafe<{ version: number }[]>(FENCE_UPDATE, id.workspaceId)
      .catch((error: unknown) => { throw sqlState(error) === '42501' ? powerOfficeError('POWEROFFICE_RUNTIME_NOT_READY') : error; });
    if (fence.length !== 1) throw powerOfficeError('POWEROFFICE_RUNTIME_NOT_READY');
    const actionFacts = await tx.$queryRawUnsafe<ActionFenceFacts[]>(ACTION_FENCE_READY_SQL);
    const poFacts = await tx.$queryRawUnsafe<PowerOfficeFacts[]>(POWEROFFICE_READY_SQL);
    if (actionFenceProblems(actionFacts[0]).length > 0 || powerOfficeProblems(poFacts[0]).length > 0) throw powerOfficeError('POWEROFFICE_RUNTIME_NOT_READY');
    await setLocal(tx, { 'app.workspace_id': id.workspaceId, 'app.client_ids': id.clientId });
    const state = await lockState(tx, key, 'UPDATE');
    const row = state ? await lockAttemptRow(tx, key, id.attemptId) : null;
    if (state === null || !sameIdentity(row, id)) throw powerOfficeError('POWEROFFICE_CLAIM_STALE');
    if (row.state !== 'ACTIVE') return 'NO_OP';
    if (state.activeAttemptId !== id.attemptId) throw powerOfficeError('POWEROFFICE_CLAIM_STALE');
    const clock = await attemptClock(tx, key, id.attemptId);
    if (!clock.open) return 'EXPIRED';
    await closeClaim(tx, key, id.attemptId, 'FAILED', code, clock.at);
    await insertAudit(tx, key, { id: factAuditId(id.claimToken, 'poweroffice.sync.failed', id.attemptId), actorId: id.actorId,
      correlationId: id.correlationId, eventType: 'poweroffice.sync.failed' },
      { connectionId: id.connectionId, attemptId: id.attemptId, sequence: String(id.sequence), outcome: 'FAILED', safeErrorCode: code });
    return 'FAILED';
  }, { maxWait: 10_000, timeout: 20_000 });
}

/** Closes the continuation's own ACTIVE claim as FAILED with `code` (an attempt code; anything else is UNEXPECTED_ERROR). */
export async function closeFailed(db: PrismaClient, failure: FailureContinuation, code: PowerOfficeErrorCode): Promise<FailureOutcome> {
  const id = failureIdentity(failure);
  const fixed: PowerOfficeErrorCode = POWEROFFICE_ATTEMPT_CODES.includes(code) ? code : 'UNEXPECTED_ERROR';
  for (let attempt = 1; ; attempt++) {
    if (performance.now() >= id.deadline) return 'EXPIRED'; // the original deadline: no new window, no work
    try { return await closeOnce(db, id, fixed); }
    catch (error) {
      const state = sqlState(error);
      if ((state === '40P01' || state === '40001') && attempt < FAILURE_ATTEMPTS) continue;
      const mapped = powerOfficeFailure(error);
      if (mapped.code === 'POWEROFFICE_DEADLINE') return 'EXPIRED'; // the guards refused at the boundary: nothing committed
      throw mapped;
    }
  }
}
