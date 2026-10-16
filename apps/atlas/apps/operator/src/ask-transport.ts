// Bounded Ask exchanges (docs/stage5/ask/03 "Browser state"). DOM-free. Reuses the console's original-deadline runner and
// capped JSON reader (transport.ts): ONE browser budget (10 s) covers the request serialization in the holder, the send,
// the incremental read (≤256 KiB), fatal UTF-8 decoding, JSON.parse and whole-response validation. Success is exactly 200.
// 401/403 are status-only (the caller disconnects / resets scope when current). Any other status is a fixed error state;
// its body is read only as a bounded AskErrorV1 for the fixed code and correlation UUID, never echoed. Capability 404 is
// status-only (OFF routes answer with an ordinary 404). No retry, no polling. ASK-REMOTE (docs/stage5/ask/remote/02) uses
// the SAME two operations, budget, cap and status rules with the V2 bodies; nothing here selects or downgrades a mode.
import { ASK_LIMITS } from './ask-contracts.ts';
import type { AskAnswerView, AskDisclosure, AskErrorView } from './ask-contracts.ts';
import type { CredentialHolder } from './credential.ts';
import type { AskOperation, AskRemoteOperation } from './operations.ts';
import { bounded, failure, readJson, sendWithin, validated } from './transport.ts';
import type { Budget, TransportOptions, TransportResult } from './transport.ts';
import { validateAnswer, validateAskError, validateCapability, validateRemoteAnswer, validateRemoteCapability } from './validate-ask.ts';
import type { AskExpectation } from './validate-ask.ts';

/** A completed Ask exchange: the validated 200 value, or a non-200 status with its validated AskErrorV1 (null if none). */
export type AskReply<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'error'; readonly status: number; readonly error: AskErrorView | null };

/** The exchange's fixed AskErrorV1 code list: V1 only (MOCK question) or V1 plus the remote codes (REMOTE question, discovery). */
type ErrorCodes = 'v1' | 'remote';

async function askExchange<T>(send: (signal: AbortSignal) => Promise<Response>, signal: AbortSignal, budget: Budget,
  validate: (value: unknown, headers: Headers) => T, statusOnly404: boolean, codes: ErrorCodes): Promise<TransportResult<AskReply<T>>> {
  const sent = await sendWithin(send, signal, budget);
  if (!sent.ok) return sent;
  const response = sent.value;
  if (response.status === 401 || response.status === 403 || (statusOnly404 && response.status === 404)) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 404) return { ok: true, value: { kind: 'error', status: 404, error: null } };
    return failure(response.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN');
  }
  const body = await readJson(response, ASK_LIMITS.responseBytes, budget);
  if (response.status === 200) {
    if (!body.ok) return body;
    return validated((): AskReply<T> => ({ kind: 'ok', value: validate(body.value, response.headers) }), budget);
  }
  if (!body.ok && body.code === 'TIMEOUT') return body;
  let error: AskErrorView | null = null;
  if (body.ok) {
    const checked = validated(() => validateAskError(body.value, response.headers, response.status, codes === 'remote'), budget);
    if (!checked.ok && checked.code === 'TIMEOUT') return checked;
    error = checked.ok ? checked.value : null;
  }
  return { ok: true, value: { kind: 'error', status: response.status, error } };
}

const askOptions = (options: TransportOptions): TransportOptions => ({ deadlineMs: options.deadlineMs, now: options.now });

/** A validated capability: the exact MOCK V1 ('mock', unchanged) or the exact REMOTE V2 with its admission tuple. */
export type AskCapabilityValue = 'mock' | { readonly mode: 'remote'; readonly disclosure: AskDisclosure };
/** Exact V1 or exact V2, chosen by the body's own contractVersion; each validator rejects anything else (no mode mixing). */
function validateAnyCapability(value: unknown, headers: Headers): AskCapabilityValue {
  const version = value !== null && typeof value === 'object' ? (value as { contractVersion?: unknown }).contractVersion : undefined;
  if (version === 'AskCapabilityV2') return Object.freeze({ mode: 'remote' as const, disclosure: validateRemoteCapability(value, headers) });
  return validateCapability(value, headers);
}

/**
 * GET /ask/capabilities once: 200 → 'mock' or the remote disclosure (exact body, header correlation), 404 → OFF, anything
 * else a fixed state (a 503 ASK_REMOTE_NOT_ADMITTED is unavailable, never OFF).
 */
export function fetchAskCapability(holder: CredentialHolder, signal: AbortSignal, options: TransportOptions = {}): Promise<TransportResult<AskReply<AskCapabilityValue>>> {
  return bounded(signal, askOptions(options), (combined, budget) =>
    askExchange(s => holder.get({ kind: 'askCapability' }, s), combined, budget, validateAnyCapability, true, 'remote'));
}

/** POST one question; the 200 answer must be the whole valid AskAnswerV1 for exactly `expected` (else RESPONSE_INVALID). */
export function sendAskQuestion(holder: CredentialHolder, operation: AskOperation, expected: AskExpectation, signal: AbortSignal,
  options: TransportOptions = {}): Promise<TransportResult<AskReply<AskAnswerView>>> {
  return bounded(signal, askOptions(options), (combined, budget) =>
    askExchange(s => holder.ask(operation, s), combined, budget, (value, headers) => validateAnswer(value, headers, expected), false, 'v1'));
}

/**
 * POST one REMOTE question (AskRequestV2, built and checked inside the holder within the same budget); the 200 answer must be
 * the whole valid AskAnswerV2 for exactly `expected`. Same 10 s budget, 256 KiB cap and status handling; errors may carry the
 * fixed remote codes. A 503 ASK_REMOTE_UNAVAILABLE (any upstream failure) is an error state, never an auth/scope signal.
 */
export function sendAskRemoteQuestion(holder: CredentialHolder, operation: AskRemoteOperation, expected: AskExpectation, signal: AbortSignal,
  options: TransportOptions = {}): Promise<TransportResult<AskReply<AskAnswerView>>> {
  return bounded(signal, askOptions(options), (combined, budget) =>
    askExchange(s => holder.askRemote(operation, s), combined, budget, (value, headers) => validateRemoteAnswer(value, headers, expected), false, 'remote'));
}
