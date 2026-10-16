// Bounded evaluation exchanges of the measured console (rs-c brief C §3; 04 "Pairing and arm", "The server must bind the actual
// values"). DOM-free. Reuses the accepted original-deadline runner, capped JSON reader and whole-response validators unchanged:
// one 10 s budget per exchange, no retry, no polling, fixed codes only. An evaluation Ask additionally keeps — for the handoff
// only — the exact parsed body of a whole-valid AskAnswerV2 (or of a valid AskErrorV1), its correlation header and the one
// receipt nonce; these values are returned to the controller's private closure and never enter state, view or storage.
import { ASK_LIMITS } from '../src/ask-contracts.ts';
import type { AskAnswerView, AskErrorView } from '../src/ask-contracts.ts';
import type { FailureCode } from '../src/contracts.ts';
import type { AskRemoteOperation } from '../src/operations.ts';
import { bounded, failure, readJson, sendWithin, validated } from '../src/transport.ts';
import type { Budget, TransportOptions, TransportResult } from '../src/transport.ts';
import { validateAskError, validateRemoteAnswer } from '../src/validate-ask.ts';
import type { AskExpectation } from '../src/validate-ask.ts';
import type { MeasuredHolder } from './credential-measured.ts';
import { PAIR200_CAP, receiptOf, validatePair200 } from './eval-contracts.ts';
import type { HandoffValues, PairView } from './eval-contracts.ts';

/** packages/reval/codes.ts FAILURE_CODES (06): the only codes a RevalBrowserHandoffErrorV1 may carry (parity test). */
export const HANDOFF_CODES = ['UNAUTHORIZED', 'SCOPE_MISMATCH', 'OWNER_REQUIRED', 'IDENTITY_UNVERIFIED', 'REGISTRATION_MISMATCH',
  'PROTOCOL_INVALID', 'WRONG_DIRECTION', 'WRONG_BINDING', 'SEQUENCE_INVALID', 'CHALLENGE_INVALID', 'OPERATION_BUSY',
  'FRAME_TOO_LARGE', 'DEADLINE', 'PAIR_UNAVAILABLE', 'PAIR_EXPIRED', 'PAIR_REVOKED', 'ARM_UNAVAILABLE', 'ARM_EXPIRED',
  'CASE_CONSUMED', 'ADMISSION_NOT_ACTIVE', 'POLICY_CHANGED', 'FIXTURE_MISMATCH', 'SNAPSHOT_STALE',
  'CENSUS_LIMIT_EXCEEDED', 'CENSUS_UNAVAILABLE', 'CENSUS_CHANGED_UNEXPECTEDLY', 'CONTENT_MISMATCH',
  'VALUE_VALIDATION_FAILED', 'ACK_INVALID', 'ACK_TIMEOUT', 'ACK_UNCONFIRMED', 'IPC_LOST', 'RAW_EXPIRED',
  'LOCAL_HANDOFF_UNVERIFIED', 'UNATTRIBUTED_PRE_RESERVE_FAILURE', 'OBSERVATION_UNAVAILABLE', 'OBSERVATION_GAP',
  'METADATA_PERSIST_FAILED', 'CONTAINMENT_UNCONFIRMED', 'DRAIN_NOT_QUIESCENT', 'PRIVACY_UNVERIFIED',
  'PLATFORM_UNVERIFIED', 'INTERNAL_FAILURE'] as const;
export type HandoffCode = typeof HANDOFF_CODES[number];
const HANDOFF_ERROR_CAP = 1024;

/** A failed handoff exchange: a transport code, or the server's fixed RevalBrowserHandoffErrorV1 code (null when not one). */
export interface HandoffFailure { readonly code: FailureCode; readonly status: number | null; readonly handoff: HandoffCode | null }
const transportFailure = (code: FailureCode): HandoffFailure => ({ code, status: null, handoff: null });

/** The exact error body of the handoff route, or null: `{contractVersion:'RevalBrowserHandoffErrorV1', code}` with a known code. */
async function handoffError(response: Response, budget: Budget): Promise<HandoffFailure> {
  if (response.status === 404) { await response.body?.cancel().catch(() => undefined); return { code: 'HTTP_ERROR', status: 404, handoff: null }; }
  const body = await readJson(response, HANDOFF_ERROR_CAP, budget);
  if (!body.ok) return body.code === 'TIMEOUT' ? transportFailure('TIMEOUT') : { code: 'HTTP_ERROR', status: response.status, handoff: null };
  const v = body.value as Record<string, unknown> | null;
  const ok = v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 2 && v.contractVersion === 'RevalBrowserHandoffErrorV1'
    && (HANDOFF_CODES as readonly unknown[]).includes(v.code);
  return { code: 'HTTP_ERROR', status: response.status, handoff: ok ? v.code as HandoffCode : null };
}

export type PairResult = { readonly ok: true; readonly pair: PairView; readonly sessionToken: string } | { readonly ok: false; readonly failure: HandoffFailure };
/** POST PAIR once: 200 → the whole valid PAIR200 (≤ 2 KiB); anything else a fixed failure (an unregistered server is 404). */
export function pairExchange(holder: MeasuredHolder, clientId: string, nonce: string, signal: AbortSignal, options: TransportOptions = {}): Promise<PairResult> {
  return bounded(signal, options, async (combined, budget): Promise<TransportResult<PairResult>> => {
    const sent = await sendWithin(s => holder.pair(clientId, nonce, s), combined, budget);
    if (!sent.ok) return { ok: true, value: { ok: false, failure: transportFailure(sent.code) } };
    const response = sent.value;
    if (response.status !== 200) return { ok: true, value: { ok: false, failure: await handoffError(response, budget) } };
    const body = await readJson(response, PAIR200_CAP, budget);
    if (!body.ok) return { ok: true, value: { ok: false, failure: transportFailure(body.code) } };
    const checked = validated(() => validatePair200(body.value), budget);
    return { ok: true, value: checked.ok ? { ok: true, ...checked.value } : { ok: false, failure: transportFailure(checked.code) } };
  }).then(r => r.ok ? r.value : { ok: false, failure: transportFailure(r.code) });
}

/** What an evaluation Ask returned: the validated view, plus the handoff values when the server bound a receipt. */
export type EvalAskReply =
  | { readonly kind: 'answer'; readonly view: AskAnswerView; readonly handoff: Omit<HandoffValues, 'pairId' | 'request'> | null }
  | { readonly kind: 'error'; readonly status: number; readonly error: AskErrorView | null; readonly handoff: Omit<HandoffValues, 'pairId' | 'request'> | null };

/**
 * POST the evaluation question (AskRequestV2 + session header). 200 must be the whole valid AskAnswerV2 for exactly `expected`;
 * other statuses keep only a valid AskErrorV1. 401/403 are status-only failures. A receipt is kept only with a valid body.
 */
export function evalAskExchange(holder: MeasuredHolder, operation: AskRemoteOperation, expected: AskExpectation, signal: AbortSignal,
  options: TransportOptions = {}): Promise<TransportResult<EvalAskReply>> {
  return bounded(signal, options, async (combined, budget): Promise<TransportResult<EvalAskReply>> => {
    const sent = await sendWithin(s => holder.askEvaluation(operation, s), combined, budget);
    if (!sent.ok) return sent;
    const response = sent.value;
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      return failure(response.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN');
    }
    const body = await readJson(response, ASK_LIMITS.responseBytes, budget);
    const receipt = receiptOf(response.headers);
    if (response.status === 200) {
      if (!body.ok) return body;
      const checked = validated(() => validateRemoteAnswer(body.value, response.headers, expected), budget);
      if (!checked.ok) return checked;
      const handoff = receipt === null ? null : { receiptNonce: receipt, response: { status: 200, correlationId: checked.value.correlationId,
        body: body.value as Record<string, unknown> } };
      return { ok: true, value: { kind: 'answer', view: checked.value, handoff } };
    }
    if (!body.ok && body.code === 'TIMEOUT') return body;
    let error: AskErrorView | null = null;
    if (body.ok) {
      const checked = validated(() => validateAskError(body.value, response.headers, response.status, true), budget);
      if (!checked.ok && checked.code === 'TIMEOUT') return checked;
      error = checked.ok ? checked.value : null;
    }
    const handoff = error === null || receipt === null || !body.ok ? null
      : { receiptNonce: receipt, response: { status: response.status, correlationId: error.correlationId, body: body.value as Record<string, unknown> } };
    return { ok: true, value: { kind: 'error', status: response.status, error, handoff } };
  });
}

/** POST RESPONSE once: success is exactly 204 with no body (it does not prove that the instrument committed). */
export function respondExchange(holder: MeasuredHolder, clientId: string, values: HandoffValues, signal: AbortSignal,
  options: TransportOptions = {}): Promise<{ readonly ok: true } | { readonly ok: false; readonly failure: HandoffFailure }> {
  return bounded(signal, options, async (combined, budget): Promise<TransportResult<{ ok: true } | { ok: false; failure: HandoffFailure }>> => {
    const sent = await sendWithin(s => holder.respond(clientId, values, s), combined, budget);
    if (!sent.ok) return { ok: true, value: { ok: false, failure: transportFailure(sent.code) } };
    const response = sent.value;
    if (response.status === 204) { await response.body?.cancel().catch(() => undefined); return { ok: true, value: { ok: true } }; }
    return { ok: true, value: { ok: false, failure: await handoffError(response, budget) } };
  }).then(r => r.ok ? r.value : { ok: false, failure: transportFailure(r.code) });
}
