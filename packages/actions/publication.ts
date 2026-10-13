import { createHmac } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { AtlasError } from '../core/contracts.ts';
import { clientAuditData } from '../audit/prisma.ts';
import { canonicalJson } from '../events/identity.ts';
import { isDbConflict } from '../graph/fence-errors.ts';
import { PUBLICATION_ATTEMPTS, TICKET_ID_PATTERN, actionError } from './contracts.ts';
import type { ActionErrorCode, ActionExecutionSummary, AttemptState, RequestState } from './contracts.ts';
import { actionFailure, setLocal } from './authority.ts';
import { CLEARED_CLAIM, currentSummary, dbClock, lockActiveOrdinal, lockAttempt, lockOrdinal, lockRequestRow } from './attempts.ts';
import type { ScopeIds } from './attempts.ts';
import type { ReservedDispatch } from './reservation.ts';

/**
 * Post-dispatch fact publication (docs/stage3/04_EXECUTION_AND_PORT.md "Durable verification claims" and "Late create
 * results and candidate ordering"). Every publication is ONE transaction that locks request → attempt → verification
 * ordinal (when one is involved) and never the fence, the approval, auth or Connection rows; it reads the DB clock after
 * those locks and calls no port. State, result fields and the safe audit row commit together or not at all.
 *
 * Only an exact private capability publishes: the create continuation is the ReservedDispatch of the consumed permit
 * (attempt token + create nonce); a read result needs the claim's token, ordinal, candidate, nonce, request hash and create
 * nonce, an ACTIVE row and DB clock < deadlineAt — otherwise the result is STALE (bounded audit, nothing else changes, no
 * refund). A known rollback (40P01/40001, Prisma P2034) re-runs the SAME publication of the SAME in-memory fact at most
 * PUBLICATION_ATTEMPTS times in total (no port call, no new ordinal, no deadline extension); exhaustion is
 * ACTION_PUBLICATION_CONFLICT and leaves the prior stored state for recovery. An identical fact that is already committed
 * is a no-op without a second audit row. Established outcomes are never downgraded.
 *
 * Stable committed fact identity: every fact's audit row carries a deterministic ID — a keyed digest (HMAC-SHA256, UUIDv8
 * layout) of the fact (event, ordinal/outcome or observed ticket ID), keyed by private capability material that never leaves
 * the database and trusted process (the attempt token for create facts, the claim's nonce for read results). Equal facts
 * get the same ID, distinct facts distinct IDs, and the ID reveals neither the ticket/candidate ID nor the key; metadata is
 * the same allowlist. Successful facts are already guarded by stored state; conflict and stale facts — which change no
 * state — are recognized by that ID inside the same locked transaction: an already committed one is a no-op (no second
 * audit), the first observation keeps its audit row. The receipt is the committed row itself, so it survives a process
 * restart, and a rolled-back attempt (audit failure, known rollback) leaves no receipt, so the retry records it once.
 */
export interface PublisherContext extends ScopeIds { readonly actorId: string; readonly correlationId: string }
type Tx = Prisma.TransactionClient;

/** One publication transaction under the explicit client scope, re-run only on a known rollback. */
export async function publish<T>(db: PrismaClient, ctx: PublisherContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.$transaction(async tx => {
        await setLocal(tx, { 'app.token_hash': '', 'app.actor_id': '', 'app.workspace_id': ctx.workspaceId, 'app.client_ids': ctx.clientId });
        return fn(tx);
      }, { maxWait: 10_000, timeout: 20_000 });
    } catch (error) {
      if (isDbConflict(error)) {
        if (attempt < PUBLICATION_ATTEMPTS) continue;
        throw actionError('ACTION_PUBLICATION_CONFLICT');
      }
      throw error instanceof AtlasError ? error : actionFailure(error);
    }
  }
}
/** Deterministic audit-row ID of one fact: HMAC-SHA256(key = private capability material, canonical fact) as UUIDv8. */
function factId(key: string, fact: Record<string, string | number>): string {
  const bytes = createHmac('sha256', key).update(canonicalJson({ dto: 'action-fact/1', ...fact }), 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
/** Is this fact's audit row already committed (read under the publication's locks)? */
const recorded = async (tx: Tx, ctx: ScopeIds, id: string): Promise<boolean> =>
  (await tx.auditEvent.findUnique({ where: { workspaceId_clientId_id: { workspaceId: ctx.workspaceId, clientId: ctx.clientId, id } }, select: { id: true } })) !== null;
/** Safe client audit of a published fact under its stable ID (allowlisted metadata). A conflict re-runs the publication; anything else is fixed. */
async function factAudit(tx: Tx, ctx: PublisherContext, id: string, eventType: string, metadata: Record<string, string>): Promise<void> {
  try {
    await tx.auditEvent.create({ data: { ...clientAuditData(ctx, ctx.actorId, eventType, ctx.correlationId, metadata), id }, select: { id: true } });
  } catch (error) {
    if (isDbConflict(error)) throw error;
    throw actionError('ACTION_AUDIT_FAILED');
  }
}
const rowKey = (ctx: ScopeIds, id: string) => ({ workspaceId_clientId_id: { workspaceId: ctx.workspaceId, clientId: ctx.clientId, id } });
async function setRequest(tx: Tx, ctx: ScopeIds, requestId: string, data: { state: RequestState; safeErrorCode: ActionErrorCode | null;
  terminal?: boolean; resultTicketId?: string }, now: Date): Promise<void> {
  await tx.actionRequest.update({ where: rowKey(ctx, requestId), select: { id: true }, data: { state: data.state, safeErrorCode: data.safeErrorCode,
    updatedAt: now, ...(data.terminal ? { terminalAt: now } : {}), ...(data.resultTicketId ? { resultTicketId: data.resultTicketId } : {}) } });
}
async function closeOrdinal(tx: Tx, ctx: ScopeIds, attemptId: string, ordinal: number, state: 'FAILED' | 'ABANDONED' | 'VERIFIED' | 'MISMATCH',
  now: Date, safeErrorCode: ActionErrorCode | null): Promise<void> {
  await tx.actionVerification.update({ where: { workspaceId_clientId_attemptId_ordinal: { workspaceId: ctx.workspaceId, clientId: ctx.clientId, attemptId, ordinal } },
    data: { state, completedAt: now, ...(safeErrorCode ? { safeErrorCode } : {}) }, select: { ordinal: true } });
}
/** Abandons an ACTIVE ordinal and releases the attempt's claim (no refund). Shared by recovery and late-original handling. */
export async function abandonClaim(tx: Tx, ctx: ScopeIds, attemptId: string, ordinal: number, now: Date, safeErrorCode: ActionErrorCode): Promise<void> {
  await closeOrdinal(tx, ctx, attemptId, ordinal, 'ABANDONED', now, safeErrorCode);
  await tx.actionAttempt.update({ where: rowKey(ctx, attemptId), data: { verificationState: 'ABANDONED', ...CLEARED_CLAIM, updatedAt: now }, select: { id: true } });
}
/** Marks a RESERVED attempt UNKNOWN (possible call, no observed result): the request becomes OUTCOME_UNKNOWN. */
export async function markUnknown(tx: Tx, ctx: ScopeIds, requestId: string, attemptId: string, now: Date): Promise<void> {
  await tx.actionAttempt.update({ where: rowKey(ctx, attemptId), select: { id: true },
    data: { state: 'UNKNOWN', outcomeAt: now, safeErrorCode: 'ACTION_OUTCOME_UNKNOWN', updatedAt: now } });
  await setRequest(tx, ctx, requestId, { state: 'OUTCOME_UNKNOWN', safeErrorCode: 'ACTION_OUTCOME_UNKNOWN' }, now);
}

// ---------------------------------------------------------------------------------------------------------------------
// Create facts: NOT_DISPATCHED (known zero calls), UNKNOWN (possible call, nothing valid observed), CREATED (observed ID)
// ---------------------------------------------------------------------------------------------------------------------
export type CreateFact = { kind: 'NOT_DISPATCHED' } | { kind: 'UNKNOWN' } | { kind: 'CREATED'; ticketId: string };
/** PUBLISHED: state changed; ATTACHED: original provenance added to the same VERIFIED ID; IDENTICAL: this fact (success or
 *  conflict) is already committed — no effect, no audit; PRESERVED: a later established outcome kept; CONFLICT: the first
 *  observation of a different ID, which never replaces the stored fact (audited once). */
export type FactEffect = 'PUBLISHED' | 'ATTACHED' | 'IDENTICAL' | 'PRESERVED' | 'CONFLICT';
export interface CreatePublication { effect: FactEffect; abandonedOrdinal: number | null; summary: ActionExecutionSummary }

/** Publishes one observed create fact with the continuation's own capability (the consumed permit's dispatch). */
export async function publishCreateFact(db: PrismaClient, dispatch: ReservedDispatch, fact: CreateFact): Promise<CreatePublication> {
  if (fact.kind === 'CREATED' && !TICKET_ID_PATTERN.test(fact.ticketId)) throw actionError('ACTION_OUTCOME_UNKNOWN');
  const ctx: PublisherContext = { workspaceId: dispatch.workspaceId, clientId: dispatch.clientId, actorId: dispatch.actorId, correlationId: dispatch.correlationId };
  return publish(db, ctx, async tx => {
    const request = await lockRequestRow(tx, ctx, dispatch.requestId);
    const attempt = request ? await lockAttempt(tx, ctx, request.id) : null;
    if (!request || !attempt || attempt.id !== dispatch.attemptId || attempt.attemptToken !== dispatch.attemptToken
      || attempt.createNonce !== dispatch.createNonce || request.inputHash !== dispatch.inputHash) throw actionError('ACTION_STATE_CONFLICT');
    const active = fact.kind === 'CREATED' ? await lockActiveOrdinal(tx, ctx, attempt) : null;
    const now = await dbClock(tx);
    const ids = { actionRequestId: request.id, actionAttemptId: attempt.id };
    const fid = (event: string) => factId(attempt.attemptToken, { event, attemptId: attempt.id, ...(fact.kind === 'CREATED' ? { ticketId: fact.ticketId } : {}) });
    const done = async (effect: FactEffect, abandonedOrdinal: number | null = null): Promise<CreatePublication> =>
      ({ effect, abandonedOrdinal, summary: await currentSummary(tx, ctx, request.id, attempt.id, now) });
    const conflict = async () => {
      const id = fid('action.create_result_conflict');
      if (await recorded(tx, ctx, id)) return done('IDENTICAL'); // this very conflicting fact is already committed: no second audit
      await factAudit(tx, ctx, id, 'action.create_result_conflict', { ...ids, attemptState: attempt.state, safeErrorCode: 'ACTION_PUBLICATION_CONFLICT' });
      return done('CONFLICT');
    };
    if (fact.kind === 'NOT_DISPATCHED' || fact.kind === 'UNKNOWN') {
      const target: AttemptState = fact.kind === 'NOT_DISPATCHED' ? 'NOT_DISPATCHED' : 'UNKNOWN';
      if (attempt.state === target) return done('IDENTICAL');
      if (attempt.state !== 'RESERVED') return done('PRESERVED'); // never downgrade an established outcome
      if (fact.kind === 'UNKNOWN') {
        await markUnknown(tx, ctx, request.id, attempt.id, now);
        await factAudit(tx, ctx, fid('action.outcome_unknown'), 'action.outcome_unknown', { ...ids, requestState: 'OUTCOME_UNKNOWN', attemptState: 'UNKNOWN', safeErrorCode: 'ACTION_OUTCOME_UNKNOWN' });
      } else {
        await tx.actionAttempt.update({ where: rowKey(ctx, attempt.id), select: { id: true },
          data: { state: 'NOT_DISPATCHED', outcomeAt: now, safeErrorCode: 'ACTION_NOT_DISPATCHED', updatedAt: now } });
        await setRequest(tx, ctx, request.id, { state: 'NOT_DISPATCHED', safeErrorCode: 'ACTION_NOT_DISPATCHED', terminal: true }, now);
        await factAudit(tx, ctx, fid('action.not_dispatched'), 'action.not_dispatched', { ...ids, requestState: 'NOT_DISPATCHED', attemptState: 'NOT_DISPATCHED', safeErrorCode: 'ACTION_NOT_DISPATCHED' });
      }
      return done('PUBLISHED');
    }
    const ticketId = fact.ticketId;
    if (attempt.originalTicketId !== null) return attempt.originalTicketId === ticketId ? done('IDENTICAL') : conflict();
    if (attempt.state === 'VERIFIED') {
      if (attempt.verifiedTicketId !== ticketId) return conflict(); // a different VERIFIED candidate stays the result
      await tx.actionAttempt.update({ where: rowKey(ctx, attempt.id), data: { originalTicketId: ticketId, updatedAt: now }, select: { id: true } });
      await factAudit(tx, ctx, fid('action.create_result_attached'), 'action.create_result_attached', { ...ids, requestState: request.state, attemptState: 'VERIFIED' });
      return done('ATTACHED');
    }
    if (attempt.state !== 'RESERVED' && attempt.state !== 'UNKNOWN') return conflict();
    // First original ID. A different active candidate claim is abandoned (no refund) and its later result is stale; the
    // same ID keeps the claim. Future verification targets this original ID.
    const abandon = active !== null && active.state === 'ACTIVE' && attempt.activeCandidateId !== ticketId ? active.ordinal : null;
    if (abandon !== null) await closeOrdinal(tx, ctx, attempt.id, abandon, 'ABANDONED', now, 'ACTION_STATE_CONFLICT');
    await tx.actionAttempt.update({ where: rowKey(ctx, attempt.id), select: { id: true }, data: { state: 'CREATED', originalTicketId: ticketId,
      outcomeAt: attempt.outcomeAt ?? now, safeErrorCode: null, updatedAt: now, ...(abandon !== null ? { verificationState: 'ABANDONED', ...CLEARED_CLAIM } : {}) } });
    await setRequest(tx, ctx, request.id, { state: 'CREATED_UNVERIFIED', safeErrorCode: null }, now);
    await factAudit(tx, ctx, fid('action.created'), 'action.created', { ...ids, requestState: 'CREATED_UNVERIFIED', attemptState: 'CREATED',
      ...(abandon !== null ? { verificationOrdinal: String(abandon), verificationResult: 'ABANDONED' } : {}) });
    return done('PUBLISHED', abandon);
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Verification results
// ---------------------------------------------------------------------------------------------------------------------
export type ReadOutcome = 'VERIFIED' | 'MISMATCH' | 'FAILED';
/** The immutable identity of one claimed ordinal, as held privately by its claim (verification.ts). */
export interface ClaimIdentity {
  readonly requestId: string; readonly attemptId: string; readonly ordinal: number; readonly token: string; readonly nonce: string;
  readonly targetKind: 'ORIGINAL' | 'CANDIDATE'; readonly targetTicketId: string; readonly candidate: string | null;
  readonly requestHash: string; readonly createNonce: string;
}
export interface VerificationPublication { result: ReadOutcome | 'STALE'; summary: ActionExecutionSummary }

/** Publishes the result of one claimed read; a late, expired, abandoned or superseded claim is STALE. */
export async function publishVerification(db: PrismaClient, ctx: PublisherContext, claim: ClaimIdentity, outcome: ReadOutcome): Promise<VerificationPublication> {
  return publish(db, ctx, async tx => {
    const request = await lockRequestRow(tx, ctx, claim.requestId);
    const attempt = request ? await lockAttempt(tx, ctx, request.id) : null;
    const row = attempt && attempt.id === claim.attemptId ? await lockOrdinal(tx, ctx, attempt.id, claim.ordinal) : null;
    if (!request || !attempt || !row || row.nonce !== claim.nonce || row.targetKind !== claim.targetKind || row.targetTicketId !== claim.targetTicketId
      || row.requestHash !== claim.requestHash || row.createNonce !== claim.createNonce || request.inputHash !== claim.requestHash
      || attempt.createNonce !== claim.createNonce) throw actionError('ACTION_STATE_CONFLICT');
    const now = await dbClock(tx);
    const done = async (result: ReadOutcome | 'STALE'): Promise<VerificationPublication> =>
      ({ result, summary: await currentSummary(tx, ctx, request.id, attempt.id, now) });
    if (row.state === outcome) return done(outcome); // this very result is already committed: no second audit
    const ids = { actionRequestId: request.id, actionAttemptId: attempt.id, verificationOrdinal: String(row.ordinal), targetKind: row.targetKind };
    const fid = (event: string) => factId(row.nonce, { event, attemptId: attempt.id, ordinal: row.ordinal, outcome });
    const live = row.state === 'ACTIVE' && attempt.verificationState === 'ACTIVE' && attempt.activeVerificationToken === claim.token
      && attempt.activeVerificationOrdinal === claim.ordinal && attempt.activeCandidateId === claim.candidate && now.getTime() < row.deadlineAt.getTime();
    if (!live) {
      const id = fid('action.verification_stale');
      if (!await recorded(tx, ctx, id)) await factAudit(tx, ctx, id, 'action.verification_stale', { ...ids, verificationResult: 'STALE' }); // first observation only
      return done('STALE');
    }
    const released = { verificationState: outcome, ...CLEARED_CLAIM, updatedAt: now };
    if (outcome === 'VERIFIED') {
      await closeOrdinal(tx, ctx, attempt.id, row.ordinal, 'VERIFIED', now, null);
      await tx.actionAttempt.update({ where: rowKey(ctx, attempt.id), select: { id: true },
        data: { ...released, state: 'VERIFIED', verifiedTicketId: row.targetTicketId, safeErrorCode: null } });
      await setRequest(tx, ctx, request.id, { state: 'VERIFIED', safeErrorCode: null, terminal: true, resultTicketId: row.targetTicketId }, now);
      await factAudit(tx, ctx, fid('action.verified'), 'action.verified', { ...ids, verificationResult: 'VERIFIED', requestState: 'VERIFIED', attemptState: 'VERIFIED' });
      return done('VERIFIED');
    }
    // An ORIGINAL mismatch records VERIFICATION_MISMATCH (non-terminal for the remaining ordinals); a CANDIDATE mismatch
    // or any failed read keeps the established outcome (UNKNOWN stays UNKNOWN, CREATED_UNVERIFIED stays).
    const originalMismatch = outcome === 'MISMATCH' && row.targetKind === 'ORIGINAL' && attempt.state === 'CREATED';
    await closeOrdinal(tx, ctx, attempt.id, row.ordinal, outcome, now, outcome === 'FAILED' ? 'ACTION_VERIFICATION_FAILED' : null);
    await tx.actionAttempt.update({ where: rowKey(ctx, attempt.id), select: { id: true }, data: { ...released, ...(originalMismatch ? { state: 'MISMATCH' } : {}) } });
    if (originalMismatch) await setRequest(tx, ctx, request.id, { state: 'VERIFICATION_MISMATCH', safeErrorCode: null }, now);
    const event = outcome === 'FAILED' ? 'action.verification_failed' : 'action.verification_mismatch';
    await factAudit(tx, ctx, fid(event), event, { ...ids, verificationResult: outcome,
      requestState: originalMismatch ? 'VERIFICATION_MISMATCH' : request.state, attemptState: originalMismatch ? 'MISMATCH' : attempt.state });
    return done(outcome);
  });
}
