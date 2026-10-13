import type { PrismaClient } from '@prisma/client';
import { AtlasError } from '../core/contracts.ts';
import { CLAIM_WINDOW_MS, CREATE_DEADLINE_MS, TICKET_ID_PATTERN, actionError } from './contracts.ts';
import type { ActionErrorCode, ActionExecutionResult, ActionExecutionSummary } from './contracts.ts';
import type { ActionComposition } from './policy.ts';
import { actionFailure } from './authority.ts';
import type { ActionCredential } from './authority.ts';
import { reserveAction, takeReservationPermit } from './reservation.ts';
import type { PermitExpectation, ReservationPermit, ReservedDispatch } from './reservation.ts';
import { publishCreateFact } from './publication.ts';
import type { CreateFact, CreatePublication } from './publication.ts';
import { claimVerification, completeVerification } from './verification.ts';
import type { ActionPorts, TicketPort } from './mock-port.ts';

/**
 * Create dispatch (docs/stage3/04_EXECUTION_AND_PORT.md "State machine and create ownership"). action-execute reuses the
 * accepted atomic reservation (its commit is the authorization linearization point: later revocation, token, actor or
 * epoch changes cannot retroactively stop this bounded approved create), then consumes the private permit ONCE before the
 * single lifetime createOne, within the original start deadline. No transaction is open during a port call; no create is
 * ever retried or repeated.
 *   - a positively known local pre-call refusal (late permit, port unavailable for the binding) → NOT_DISPATCHED, zero calls;
 *   - a valid bounded ID → CREATED_UNVERIFIED (never success by itself);
 *   - any exception, malformed reply (429/5xx-like failures included) or the 15 s AbortSignal deadline → OUTCOME_UNKNOWN;
 *   - a failed publication leaves RESERVED for explicit recovery after reservedAt + 35 s (fixed code, never success).
 * After a timeout the owned private continuation may still observe THIS invocation's late result and publish it with the
 * same dispatch capability (UNKNOWN → CREATED_UNVERIFIED, candidate rules in publication.ts); it never creates or reads.
 * After a CREATED publication the initial distinct read is a separate, freshly authorized verification claim (ordinal 1);
 * if that admission refuses, the observed create outcome stays and no read happens.
 */
export interface ExecuteOptions {
  /** How long a timed-out invocation's late result is still awaited by this process (bounded; default 20 s = 35 − 15). */
  lateGraceMs?: number;
}
export const LATE_GRACE_MS = CLAIM_WINDOW_MS - CREATE_DEADLINE_MS;
export type LateOutcome = { publication: CreatePublication } | { code: ActionErrorCode } | null;
export interface DispatchOutcome {
  summary: ActionExecutionSummary; created: boolean; code: ActionErrorCode | null;
  /** Only after a create timeout: the owned continuation's publication of a late result (null if none arrived in time). */
  late: Promise<LateOutcome> | null;
}

/** Publication of a create fact; a failure keeps its fixed conflict/audit code, anything else is the fact's uncertainty code. */
async function record(db: PrismaClient, dispatch: ReservedDispatch, fact: CreateFact): Promise<CreatePublication> {
  try { return await publishCreateFact(db, dispatch, fact); } catch (error) {
    const code = error instanceof AtlasError ? error.code : '';
    if (code === 'ACTION_PUBLICATION_CONFLICT' || code === 'ACTION_AUDIT_FAILED') throw error;
    throw actionError(fact.kind === 'NOT_DISPATCHED' ? 'ACTION_NOT_DISPATCHED' : 'ACTION_OUTCOME_UNKNOWN');
  }
}
const validId = (value: unknown): value is string => typeof value === 'string' && TICKET_ID_PATTERN.test(value);

async function lateContinuation(db: PrismaClient, dispatch: ReservedDispatch, settled: Promise<{ id: unknown }>, graceMs: number): Promise<LateOutcome> {
  let timer: NodeJS.Timeout | undefined;
  const observed = await Promise.race([settled, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), graceMs); })]);
  clearTimeout(timer);
  if (!observed || !validId(observed.id)) return null;
  try { return { publication: await publishCreateFact(db, dispatch, { kind: 'CREATED', ticketId: observed.id }) }; }
  catch (error) { return { code: actionFailure(error).code as ActionErrorCode }; }
}

/** Consumes a committed reservation's permit and performs (or positively refuses) the one create invocation. */
export async function dispatchReserved(db: PrismaClient, ports: ActionPorts, permit: ReservationPermit, expected: PermitExpectation,
  options: ExecuteOptions = {}): Promise<DispatchOutcome> {
  const use = takeReservationPermit(permit, expected);
  const notDispatched = async (d: ReservedDispatch): Promise<DispatchOutcome> =>
    ({ summary: (await record(db, d, { kind: 'NOT_DISPATCHED' })).summary, created: false, code: 'ACTION_NOT_DISPATCHED', late: null });
  if ('refused' in use) {
    if (use.spent) return notDispatched(use.spent); // late first use: the start deadline passed, no call was made
    throw actionError('APPROVAL_NOT_VALID');
  }
  const d = use.dispatch;
  let port: TicketPort;
  try { port = ports.ticketPort({ workspaceId: d.workspaceId, clientId: d.clientId, connectionId: d.connectionId }); } catch { return notDispatched(d); }
  // The single lifetime create invocation. From here on a call may have happened: never NOT_DISPATCHED, never a retry.
  const controller = new AbortController();
  const deadline = performance.now() + CREATE_DEADLINE_MS; // the instant the signal fires; the port binds its work to it
  let invocation: Promise<string>;
  try {
    invocation = Promise.resolve(port.createOne({ customerKey: d.customerKey, markedTitle: d.markedTitle, description: d.description, nonce: d.createNonce },
      { signal: controller.signal, deadline }));
  } catch (error) { invocation = Promise.reject(error); }
  const settled: Promise<{ id: unknown }> = invocation.then(id => ({ id }), () => ({ id: null }));
  let timer: NodeJS.Timeout | undefined;
  const first = await Promise.race([settled, new Promise<'TIMEOUT'>(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve('TIMEOUT'); }, Math.max(0, deadline - performance.now()));
  })]);
  clearTimeout(timer);
  if (first !== 'TIMEOUT' && validId(first.id)) {
    return { summary: (await record(db, d, { kind: 'CREATED', ticketId: first.id })).summary, created: true, code: null, late: null };
  }
  const unknown = (await record(db, d, { kind: 'UNKNOWN' })).summary;
  return { summary: unknown, created: false, code: 'ACTION_OUTCOME_UNKNOWN',
    late: first === 'TIMEOUT' ? lateContinuation(db, d, settled, options.lateGraceMs ?? LATE_GRACE_MS) : null };
}

const executionOnly = (s: ActionExecutionSummary): ActionExecutionSummary => ({ requestId: s.requestId, state: s.state, inputHash: s.inputHash,
  attemptId: s.attemptId, attemptState: s.attemptState, reservedAt: s.reservedAt, outcomeAt: s.outcomeAt, verificationCount: s.verificationCount,
  verificationBudget: s.verificationBudget, verificationState: s.verificationState, activeVerificationOrdinal: s.activeVerificationOrdinal,
  safeErrorCode: s.safeErrorCode, recoveryRequired: s.recoveryRequired, synthetic: true });

/** action-execute --request --hash: reservation → one create → the separately authorized initial read. */
export async function executeAction(db: PrismaClient, composition: ActionComposition, ports: ActionPorts, credential: ActionCredential, clientId: string,
  requestId: string, expectedHash: string, options: ExecuteOptions = {}): Promise<ActionExecutionResult> {
  const { reservation, permit, expected } = await reserveAction(db, composition, credential, clientId, requestId, expectedHash);
  const dispatched = await dispatchReserved(db, ports, permit, expected, options);
  const result = (summary: ActionExecutionSummary, verificationCode: ActionErrorCode | null): ActionExecutionResult =>
    ({ ...executionOnly(summary), approvalId: reservation.approvalId, startDeadlineAt: reservation.startDeadlineAt, verificationCode });
  if (dispatched.late) {
    const late = await dispatched.late; // a late observation is published, never followed by a read from this continuation
    return result(late && 'publication' in late ? late.publication.summary : dispatched.summary, null);
  }
  if (!dispatched.created) return result(dispatched.summary, null);
  const code = (error: unknown) => actionFailure(error).code as ActionErrorCode;
  let claimed;
  try { claimed = await claimVerification(db, composition, credential, clientId, requestId, null); }
  catch (error) { return result(dispatched.summary, code(error)); } // refused admission: created stays, no ordinal, zero read
  if ('replay' in claimed) return result(claimed.replay, null);
  try {
    const verified = await completeVerification(db, ports, claimed.claim);
    const failed = verified.verificationResult === 'FAILED' || verified.verificationResult === 'STALE';
    return result(verified, failed ? 'ACTION_VERIFICATION_FAILED' : null);
  } catch (error) {
    // The claim committed (its ordinal is consumed) but its result was not recorded: it stays ACTIVE for explicit recovery.
    return result({ ...dispatched.summary, verificationCount: claimed.ordinal, verificationState: 'ACTIVE', activeVerificationOrdinal: claimed.ordinal }, code(error));
  }
}
