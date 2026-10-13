import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { AtlasError } from '../core/contracts.ts';
import {
  EXECUTE_PERMISSIONS, READ_DEADLINE_MS, RECONCILIATION_DTO, RECONCILIATION_KIND, TICKET_ID_PATTERN, VERIFICATION_BUDGET, actionError,
} from './contracts.ts';
import type { ActionErrorCode, ActionVerificationResult } from './contracts.ts';
import { isUuid } from './canonical.ts';
import type { ActionComposition } from './policy.ts';
import { clientAudit, withFencedAdmission } from './authority.ts';
import type { ActionCredential, AdmissionOutcome } from './authority.ts';
import { readProtectedJson } from './private-file.ts';
import { assertComposition } from './requests.ts';
import { bindingHolds, lockApproval, lockRequest, lockedClock, refusal } from './guard.ts';
import { claimDeadline, claimRecoveryDue, deployedVersions, executionSummary, lockActiveOrdinal, lockAttempt } from './attempts.ts';
import { publishVerification } from './publication.ts';
import type { ClaimIdentity, PublisherContext, ReadOutcome } from './publication.ts';
import type { ActionPorts, TicketRecord } from './mock-port.ts';

/**
 * Durable verification claims (docs/stage3/04_EXECUTION_AND_PORT.md "Durable verification claims"). Every NEW read is a
 * freshly authorized claim: fenced admission with the caller's current context:read + actions:read + actions:execute on
 * ONE membership, locks fence → request → approval → attempt → active ordinal, DB clock after the last lock, deployed
 * versions and the exact stored FIXTURE binding re-checked (signer revocation or epoch drift after reservation alone does not
 * bar a read; binding drift does). The claim consumes the next unused ordinal 1..3 — row, count/seq, active claim fields and
 * audit in one commit — before any port call; it is never refunded. The read runs outside any transaction with an
 * AbortSignal at startedAt + 15 s; its result is published by publication.ts only with this claim's private capability while
 * the row is ACTIVE and DB clock < startedAt + 35 s.
 *
 * Target: a known original ID always (a candidate file then refuses: it can never replace the original); otherwise the one
 * candidate ID from the protected reconciliation file. No search, listing, name matching or caller assertion. VERIFIED needs
 * the exact ID, customer key, complete marked title (with the marker) and description; VERIFIED replays with zero reads.
 */
export interface VerificationClaim { readonly kind: 'ActionVerificationClaim' }
interface ClaimState {
  readonly identity: ClaimIdentity; readonly ctx: PublisherContext; readonly connectionId: string; readonly readDeadline: number;
  readonly expected: { readonly customerKey: string; readonly markedTitle: string; readonly description: string; readonly marker: string };
  used: boolean;
}
const claims = new WeakMap<VerificationClaim, ClaimState>();
export type Claimed = { replay: ActionVerificationResult } | { claim: VerificationClaim; ordinal: number; targetKind: 'ORIGINAL' | 'CANDIDATE' };
type Admitted = { replay: ActionVerificationResult } | { state: ClaimState } | { busy: boolean };

const RECONCILIATION_MAX_BYTES = 1024;
/** The protected reconciliation file: exactly {kind, dto, requestId, candidateTicketId} for THIS request; never echoed. */
export async function readReconciliationFile(path: string, requestId: string): Promise<string> {
  const value = await readProtectedJson(path, RECONCILIATION_MAX_BYTES);
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!record || Object.keys(record).sort().join(',') !== 'candidateTicketId,dto,kind,requestId' || record.kind !== RECONCILIATION_KIND
    || record.dto !== RECONCILIATION_DTO || record.requestId !== requestId || typeof record.candidateTicketId !== 'string'
    || !TICKET_ID_PATTERN.test(record.candidateTicketId)) throw actionError('ACTION_INPUT_INVALID');
  return record.candidateTicketId;
}

/**
 * The claim admission alone (the first half of action-verify; also the executor's initial read). Returns the VERIFIED
 * replay, or a private claim whose ordinal is already committed. ACTIVE (even expired) is ACTION_VERIFICATION_BUSY with a
 * recoveryRequired detail; three consumed ordinals are ACTION_VERIFICATION_BUDGET. Refusals are audited once.
 */
export async function claimVerification(db: PrismaClient, composition: ActionComposition, credential: ActionCredential, clientId: string,
  requestId: string, candidate: string | null): Promise<Claimed> {
  assertComposition(composition);
  if (!isUuid(requestId) || (candidate !== null && !TICKET_ID_PATTERN.test(candidate))) throw actionError('ACTION_INPUT_INVALID');
  const admitted = await withFencedAdmission(db, credential, clientId, { permissions: EXECUTE_PERMISSIONS, deniedEvent: 'action.verify_denied' },
    async (tx, admission): Promise<AdmissionOutcome<Admitted>> => {
      const request = await lockRequest(tx, admission, requestId);
      if (!request) return { refused: 'ACTION_NOT_FOUND' };
      await lockApproval(tx, admission, request.id);
      const attempt = await lockAttempt(tx, admission, request.id);
      if (attempt) await lockActiveOrdinal(tx, admission, attempt);
      const mark = performance.now(); // before the DB clock read: the local read deadline is never later than the stored one
      const now = await lockedClock(tx, admission);
      if (!now) return { refused: 'ACTION_AUTHENTICATION_FAILED' };
      const refuse = (code: ActionErrorCode) => refusal<Admitted>(tx, admission, 'action.verify_refused', request.id, code);
      if (!attempt) return refuse('ACTION_STATE_CONFLICT');
      if (attempt.state === 'VERIFIED') {
        return { ok: { replay: { ...executionSummary(request, attempt, now), ordinal: null, targetKind: null, verificationResult: null, idempotent: true } } };
      }
      if (attempt.state === 'NOT_DISPATCHED') return refuse('ACTION_NOT_DISPATCHED');
      if (attempt.state === 'RESERVED') return refuse('ACTION_STATE_CONFLICT'); // no create outcome yet: recover after the grace
      if (attempt.verificationState === 'ACTIVE') {
        await clientAudit(tx, admission, 'action.verify_refused', { actionRequestId: request.id, safeErrorCode: 'ACTION_VERIFICATION_BUSY' });
        return { ok: { busy: claimRecoveryDue(attempt, now) } };
      }
      if (attempt.verificationCount >= VERIFICATION_BUDGET) return refuse('ACTION_VERIFICATION_BUDGET');
      if (!deployedVersions(composition, request)) return refuse('ACTION_CONTRACT_VERSION_CHANGED');
      if (!await bindingHolds(tx, admission, request)) return refuse('ACTION_AUTHORITY_CHANGED');
      const original = attempt.originalTicketId;
      if (original !== null && candidate !== null) return refuse('ACTION_STATE_CONFLICT'); // a candidate never replaces the original
      if (original === null && candidate === null) return refuse('ACTION_OUTCOME_UNKNOWN'); // nothing to read without evidence
      const targetKind = original !== null ? 'ORIGINAL' as const : 'CANDIDATE' as const;
      const target = (original ?? candidate)!;
      const ordinal = attempt.verificationCount + 1;
      const token = randomUUID(); const nonce = randomUUID(); const deadlineAt = claimDeadline(now);
      const scope = { workspaceId: admission.workspaceId, clientId: admission.clientId };
      await tx.actionVerification.create({ data: { ...scope, attemptId: attempt.id, ordinal, targetKind, nonce, targetTicketId: target,
        requestHash: request.inputHash, createNonce: attempt.createNonce, startedAt: now, deadlineAt }, select: { ordinal: true } });
      await tx.actionAttempt.update({ where: { workspaceId_clientId_id: { ...scope, id: attempt.id } }, select: { id: true },
        data: { verificationCount: ordinal, verificationSeq: attempt.verificationSeq + 1, verificationState: 'ACTIVE', activeVerificationToken: token,
          activeVerificationOrdinal: ordinal, activeStartedAt: now, activeDeadlineAt: deadlineAt, activeCandidateId: targetKind === 'CANDIDATE' ? target : null,
          updatedAt: now } });
      await clientAudit(tx, admission, 'action.verification_claimed', { actionRequestId: request.id, actionAttemptId: attempt.id,
        verificationOrdinal: String(ordinal), targetKind });
      return { ok: { state: {
        identity: { requestId: request.id, attemptId: attempt.id, ordinal, token, nonce, targetKind, targetTicketId: target,
          candidate: targetKind === 'CANDIDATE' ? target : null, requestHash: request.inputHash, createNonce: attempt.createNonce },
        ctx: { ...scope, actorId: admission.actor.id, correlationId: admission.correlationId }, connectionId: request.connectionId,
        // Millisecond storage may round the DB clock down by < 1 ms: one more millisecond keeps the local deadline earlier.
        readDeadline: mark + READ_DEADLINE_MS - 1,
        expected: { customerKey: request.customerKey, markedTitle: request.markedTitle, description: request.description, marker: request.marker },
        used: false } } };
    });
  if ('replay' in admitted) return { replay: admitted.replay };
  if ('busy' in admitted) throw new AtlasError('ACTION_VERIFICATION_BUSY', 'PERMANENT', { recoveryRequired: String(admitted.busy) });
  const claim: VerificationClaim = Object.freeze({ kind: 'ActionVerificationClaim' as const });
  claims.set(claim, admitted.state);
  return { claim, ordinal: admitted.state.identity.ordinal, targetKind: admitted.state.identity.targetKind };
}

const RECORD_KEYS = 'customerKey,description,markedTitle,synthetic,ticketId';
/** Exact whitelist shape, then exact equality of ID, customer, complete marked title (marker included) and description. */
function classify(record: TicketRecord | null, state: ClaimState): ReadOutcome {
  if (record === null) return 'MISMATCH';
  if (typeof record !== 'object' || Array.isArray(record) || Object.keys(record).sort().join(',') !== RECORD_KEYS || record.synthetic !== true
    || [record.ticketId, record.customerKey, record.markedTitle, record.description].some(v => typeof v !== 'string')) return 'FAILED';
  const e = state.expected;
  return record.ticketId === state.identity.targetTicketId && record.customerKey === e.customerKey && record.markedTitle === e.markedTitle
    && record.markedTitle.endsWith(` ${e.marker}`) && record.description === e.description ? 'VERIFIED' : 'MISMATCH';
}
/** One bounded read through the port, outside any transaction; every exception, timeout or malformed reply is FAILED. */
async function readOnce(ports: ActionPorts, state: ClaimState): Promise<ReadOutcome> {
  const remaining = state.readDeadline - performance.now();
  if (remaining <= 0) return 'FAILED'; // the read window already closed: no call
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'TIMEOUT'>(resolve => { timer = setTimeout(() => { controller.abort(); resolve('TIMEOUT'); }, remaining); });
  try {
    const read = Promise.resolve().then(() => ports.ticketPort({ workspaceId: state.ctx.workspaceId, clientId: state.ctx.clientId, connectionId: state.connectionId })
      .readOne({ connectionId: state.connectionId, ticketId: state.identity.targetTicketId }, { signal: controller.signal, deadline: state.readDeadline }));
    const result = await Promise.race([read.then(record => ({ record }), () => 'ERROR' as const), timeout]);
    return result === 'TIMEOUT' || result === 'ERROR' ? 'FAILED' : classify(result.record, state);
  } finally { clearTimeout(timer); }
}

/** The second half: one read for a claim (single use), then its publication (or STALE). */
export async function completeVerification(db: PrismaClient, ports: ActionPorts, claim: VerificationClaim): Promise<ActionVerificationResult> {
  const state = claims.get(claim);
  if (!state || state.used) throw actionError('ACTION_VERIFICATION_FAILED');
  state.used = true;
  const outcome = await readOnce(ports, state);
  const published = await publishVerification(db, state.ctx, state.identity, outcome);
  return { ...published.summary, ordinal: state.identity.ordinal, targetKind: state.identity.targetKind, verificationResult: published.result, idempotent: false };
}

/** action-verify --request [--reconciliation-file]: claim, read, publish; VERIFIED replays without a read. */
export async function verifyAction(db: PrismaClient, composition: ActionComposition, ports: ActionPorts, credential: ActionCredential, clientId: string,
  requestId: string, reconciliationFile?: string): Promise<ActionVerificationResult> {
  assertComposition(composition);
  if (!isUuid(requestId)) throw actionError('ACTION_INPUT_INVALID');
  const candidate = reconciliationFile === undefined ? null : await readReconciliationFile(reconciliationFile, requestId);
  const claimed = await claimVerification(db, composition, credential, clientId, requestId, candidate);
  return 'replay' in claimed ? claimed.replay : completeVerification(db, ports, claimed.claim);
}
