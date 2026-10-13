import type { PrismaClient } from '@prisma/client';
import { EXECUTE_PERMISSIONS, actionError } from './contracts.ts';
import type { ActionErrorCode, ActionRecoveryResult } from './contracts.ts';
import { isUuid } from './canonical.ts';
import type { ActionComposition } from './policy.ts';
import { clientAudit, withFencedAdmission } from './authority.ts';
import type { ActionCredential, AdmissionOutcome } from './authority.ts';
import { assertComposition } from './requests.ts';
import { bindingHolds, lockApproval, lockRequest, lockedClock, refusal } from './guard.ts';
import { claimRecoveryDue, currentSummary, deployedVersions, executionSummary, lockActiveOrdinal, lockAttempt, reservationRecoveryDue } from './attempts.ts';
import { abandonClaim, markUnknown } from './publication.ts';

/**
 * action-recover (docs/stage3/04_EXECUTION_AND_PORT.md): explicit, freshly authorized (context:read + actions:read +
 * actions:execute on ONE membership) and fenced — fence → request → approval → attempt → active ordinal, DB clock after the
 * last lock, deployed versions and the exact stored FIXTURE binding re-checked. It never dispatches, never refunds an
 * ordinal and never resets the attempt identity or budget:
 *   - RESERVED at/after reservedAt + 35 s → UNKNOWN / OUTCOME_UNKNOWN (a restart cannot prove whether the call happened);
 *   - an ACTIVE claim at/after its deadline (startedAt + 35 s) → that ordinal ABANDONED and the claim released; the last
 *     established create/verification outcome stays;
 *   - earlier → ACTION_RECOVERY_NOT_DUE; nothing to recover → the current summary (recovered NONE), no mutation or audit.
 * Published NOT_DISPATCHED/CREATED_UNVERIFIED/MISMATCH/VERIFIED are never downgraded (only RESERVED is ever marked UNKNOWN).
 */
export async function recoverAction(db: PrismaClient, composition: ActionComposition, credential: ActionCredential, clientId: string,
  requestId: string): Promise<ActionRecoveryResult> {
  assertComposition(composition);
  if (!isUuid(requestId)) throw actionError('ACTION_INPUT_INVALID');
  return withFencedAdmission(db, credential, clientId, { permissions: EXECUTE_PERMISSIONS, deniedEvent: 'action.recover_denied' },
    async (tx, admission): Promise<AdmissionOutcome<ActionRecoveryResult>> => {
      const request = await lockRequest(tx, admission, requestId);
      if (!request) return { refused: 'ACTION_NOT_FOUND' };
      await lockApproval(tx, admission, request.id);
      const attempt = await lockAttempt(tx, admission, request.id);
      const active = attempt ? await lockActiveOrdinal(tx, admission, attempt) : null;
      const now = await lockedClock(tx, admission);
      if (!now) return { refused: 'ACTION_AUTHENTICATION_FAILED' };
      const refuse = (code: ActionErrorCode) => refusal<ActionRecoveryResult>(tx, admission, 'action.recover_refused', request.id, code);
      if (!attempt) return refuse('ACTION_STATE_CONFLICT');
      if (!deployedVersions(composition, request)) return refuse('ACTION_CONTRACT_VERSION_CHANGED');
      if (!await bindingHolds(tx, admission, request)) return refuse('ACTION_AUTHORITY_CHANGED');
      const ids = { actionRequestId: request.id, actionAttemptId: attempt.id };
      if (attempt.state === 'RESERVED') {
        if (!reservationRecoveryDue(attempt, now)) return refuse('ACTION_RECOVERY_NOT_DUE');
        await markUnknown(tx, admission, request.id, attempt.id, now);
        await clientAudit(tx, admission, 'action.recovered', { ...ids, requestState: 'OUTCOME_UNKNOWN', attemptState: 'UNKNOWN',
          safeErrorCode: 'ACTION_OUTCOME_UNKNOWN' });
        return { ok: { ...await currentSummary(tx, admission, request.id, attempt.id, now), recovered: 'OUTCOME_UNKNOWN' } };
      }
      if (attempt.verificationState === 'ACTIVE' && active !== null) {
        if (!claimRecoveryDue(attempt, now)) return refuse('ACTION_RECOVERY_NOT_DUE');
        await abandonClaim(tx, admission, attempt.id, active.ordinal, now, 'ACTION_VERIFICATION_FAILED');
        await clientAudit(tx, admission, 'action.claim_abandoned', { ...ids, verificationOrdinal: String(active.ordinal), targetKind: active.targetKind,
          verificationResult: 'ABANDONED' });
        return { ok: { ...await currentSummary(tx, admission, request.id, attempt.id, now), recovered: 'CLAIM_ABANDONED' } };
      }
      return { ok: { ...executionSummary(request, attempt, now), recovered: 'NONE' } };
    });
}
