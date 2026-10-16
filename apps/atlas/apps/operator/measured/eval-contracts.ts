// Browser copies of the R-EVAL evaluation handoff contracts (04 "Pairing and arm", "Synthetic evaluation focus choice", "The server
// must bind the actual values"; server DTOs packages/reval/eval-handoff-dto.ts, parity: tests/operator-eval-contracts.test.ts).
// DOM-free and token-free: the PAIR200 session token is returned to the measured credential holder only, never to state or view.
// Measured console build only (apps/operator/measured); the ordinary console never contains these modules.
import { SCOPE_ID_PATTERN } from '../src/contracts.ts';
import { UUID_V4 } from '../src/ask-contracts.ts';

export const HANDOFF_V1 = 'RevalBrowserHandoffV1';
export const HANDOFF_PATH_SUFFIX = '/ask/evaluation-handoff';
export const SESSION_HEADER = 'X-Atlas-Evaluation-Session';
export const RECEIPT_HEADER = 'X-Atlas-Evaluation-Receipt';
/** packages/reval/eval-handoff-dto.ts caps: PAIR200 ≤ 2 KiB, RESPONSE ≤ 288 KiB. */
export const PAIR200_CAP = 2048;
export const RESPONSE_BODY_CAP = 288 * 1024;
/** The canonical 256-bit base64url Token (43 characters; the last one carries 2 zero padding bits). */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const FIXTURE_ID = /^FX(0[1-9]|1[01])$/;
const POSITIVE_DEC64 = /^[1-9][0-9]{0,18}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isTime = (v: unknown): v is string => typeof v === 'string' && TIME.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString() === v;
const positiveDec64 = (v: unknown): v is string => typeof v === 'string' && POSITIVE_DEC64.test(v) && BigInt(v) <= 9223372036854775807n;

export type FocusState = 'NONE' | 'FOUND' | 'MISSING';
/** The exact closed `evaluationFocus` of PAIR200: the ONE fixed choice of the installed fixture (never a browser parameter). */
export interface EvaluationFocus {
  readonly registrationId: string; readonly fixtureId: string; readonly fixtureGeneration: string; readonly requestedFocus: string | null;
  readonly focusState: FocusState; readonly syntheticFreshnessAt: string;
}
/** The safe part of a validated PAIR200 (the session token goes to the holder only). */
export interface PairView { readonly pairId: string; readonly serverBootId: string; readonly expiresAt: string; readonly focus: EvaluationFocus }

class Invalid extends Error { constructor() { super('RESPONSE_INVALID'); } }
const fail = (): never => { throw new Invalid(); };
function exactKeys(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || !keys.every(k => Object.hasOwn(row, k))) fail();
  return row;
}

export function validateEvaluationFocus(value: unknown): EvaluationFocus {
  const o = exactKeys(value, ['registrationId', 'fixtureId', 'fixtureGeneration', 'requestedFocus', 'focusState', 'syntheticFreshnessAt']);
  if (typeof o.registrationId !== 'string' || !UUID_V4.test(o.registrationId) || typeof o.fixtureId !== 'string' || !FIXTURE_ID.test(o.fixtureId)
    || !positiveDec64(o.fixtureGeneration) || !isTime(o.syntheticFreshnessAt)) fail();
  if (o.focusState === 'NONE') { if (o.requestedFocus !== null) fail(); }
  else if (o.focusState === 'FOUND' || o.focusState === 'MISSING') { if (typeof o.requestedFocus !== 'string' || !SCOPE_ID_PATTERN.test(o.requestedFocus)) fail(); }
  else fail();
  return Object.freeze({ registrationId: o.registrationId as string, fixtureId: o.fixtureId as string, fixtureGeneration: o.fixtureGeneration as string,
    requestedFocus: o.requestedFocus as string | null, focusState: o.focusState as FocusState, syntheticFreshnessAt: o.syntheticFreshnessAt as string });
}

/** The whole PAIR200 or Invalid: exact keys, UUIDs, canonical Token, exact Time and the exact evaluation focus. */
export function validatePair200(value: unknown): { readonly pair: PairView; readonly sessionToken: string } {
  const o = exactKeys(value, ['contractVersion', 'pairId', 'sessionToken', 'serverBootId', 'expiresAt', 'evaluationFocus']);
  if (o.contractVersion !== HANDOFF_V1 || typeof o.pairId !== 'string' || !UUID_V4.test(o.pairId) || typeof o.sessionToken !== 'string'
    || !TOKEN_PATTERN.test(o.sessionToken) || typeof o.serverBootId !== 'string' || !UUID_V4.test(o.serverBootId) || !isTime(o.expiresAt)) fail();
  const pair: PairView = Object.freeze({ pairId: o.pairId as string, serverBootId: o.serverBootId as string, expiresAt: o.expiresAt as string,
    focus: validateEvaluationFocus(o.evaluationFocus) });
  return Object.freeze({ pair, sessionToken: o.sessionToken as string });
}

/** The exact PAIR body for a manually entered nonce, or null (malformed input is refused, never trimmed). */
export function pairBody(nonce: string): string | null {
  return typeof nonce === 'string' && TOKEN_PATTERN.test(nonce) ? JSON.stringify({ contractVersion: HANDOFF_V1, operation: 'PAIR', pairingNonce: nonce }) : null;
}

/** The one receipt nonce of an evaluation Ask response: exactly one canonical Token header, else null (no handoff possible). */
export function receiptOf(headers: Headers): string | null {
  const value = headers.get(RECEIPT_HEADER);
  return value !== null && TOKEN_PATTERN.test(value) ? value : null;
}

/** What the browser actually exchanged: the exact submitted request object and the exact parsed response (never re-built). */
export interface HandoffValues {
  readonly pairId: string; readonly receiptNonce: string; readonly request: Readonly<Record<string, unknown>>;
  readonly response: { readonly status: number; readonly correlationId: string; readonly body: Readonly<Record<string, unknown>> };
}
/** The exact RESPONSE body (≤ 288 KiB, else null: rejected without truncation, never partially sent). */
export function responseBody(v: HandoffValues): string | null {
  if (!UUID_V4.test(v.pairId) || !TOKEN_PATTERN.test(v.receiptNonce) || !UUID_V4.test(v.response.correlationId)
    || !Number.isInteger(v.response.status) || v.response.status < 200 || v.response.status > 599) return null;
  const body = JSON.stringify({ contractVersion: HANDOFF_V1, operation: 'RESPONSE', pairId: v.pairId, receiptNonce: v.receiptNonce, request: v.request,
    response: { status: v.response.status, correlationId: v.response.correlationId, body: v.response.body } });
  return new TextEncoder().encode(body).byteLength <= RESPONSE_BODY_CAP ? body : null;
}

/** Origin-relative handoff path of one client; null for a malformed client ID. */
export function handoffPath(clientId: string): string | null {
  return SCOPE_ID_PATTERN.test(clientId) ? `/clients/${encodeURIComponent(clientId)}${HANDOFF_PATH_SUFFIX}` : null;
}
