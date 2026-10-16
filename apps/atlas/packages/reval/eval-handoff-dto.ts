import type { FailureCode } from './codes.ts';
import { decodeWireResponse } from './eval-transient.ts';
import type { WireResponse } from './eval-transient.ts';
import { isFixtureIdText, isToken } from './eval-wire.ts';
import { exact, isPositiveDec64, isScopeId, isTime, isUuid, req, shapeFail } from './scalars.ts';

/**
 * Browser handoff DTOs of `POST /clients/:id/ask/evaluation-handoff` (04 "Pairing and arm", "The server must bind the actual
 * values"; 06 "Closed codes"). PAIR ≤1 KiB, PAIR200 ≤2 KiB, RESPONSE ≤288 KiB; failures are exactly RevalBrowserHandoffErrorV1
 * with fixed statuses, no body echo, no-store. The route exists only while the measured registered server is paired-capable.
 */
export const HANDOFF_V1 = 'RevalBrowserHandoffV1';
export const HANDOFF_ERROR_V1 = 'RevalBrowserHandoffErrorV1';
export const PAIR_BODY_CAP = 1024; export const PAIR200_CAP = 2048; export const RESPONSE_BODY_CAP = 288 * 1024;
export interface EvaluationFocus {
  readonly registrationId: string; readonly fixtureId: string; readonly fixtureGeneration: string; readonly requestedFocus: string | null;
  readonly focusState: 'NONE' | 'FOUND' | 'MISSING'; readonly syntheticFreshnessAt: string;
}
export function decodeEvaluationFocus(v: unknown): EvaluationFocus {
  const o = exact(v, ['registrationId', 'fixtureId', 'fixtureGeneration', 'requestedFocus', 'focusState', 'syntheticFreshnessAt']);
  req(isUuid, o.registrationId); req(isFixtureIdText, o.fixtureId); req(isPositiveDec64, o.fixtureGeneration); req(isTime, o.syntheticFreshnessAt);
  if (o.focusState === 'NONE') { if (o.requestedFocus !== null) shapeFail(); }
  else if (o.focusState === 'FOUND' || o.focusState === 'MISSING') req(isScopeId, o.requestedFocus);
  else shapeFail();
  return o as unknown as EvaluationFocus;
}
export interface PairRequest { readonly contractVersion: typeof HANDOFF_V1; readonly operation: 'PAIR'; readonly pairingNonce: string }
export interface ResponseRequest {
  readonly contractVersion: typeof HANDOFF_V1; readonly operation: 'RESPONSE'; readonly pairId: string; readonly receiptNonce: string;
  readonly request: unknown; readonly response: WireResponse;
}
export type HandoffRequest = PairRequest | ResponseRequest;
export function decodeHandoffRequest(v: unknown): HandoffRequest {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) shapeFail();
  const op = (v as Record<string, unknown>).operation;
  if (op === 'PAIR') {
    const o = exact(v, ['contractVersion', 'operation', 'pairingNonce']);
    if (o.contractVersion !== HANDOFF_V1) shapeFail();
    req(isToken, o.pairingNonce);
    return o as unknown as PairRequest;
  }
  if (op === 'RESPONSE') {
    const o = exact(v, ['contractVersion', 'operation', 'pairId', 'receiptNonce', 'request', 'response']);
    if (o.contractVersion !== HANDOFF_V1) shapeFail();
    req(isUuid, o.pairId); req(isToken, o.receiptNonce);
    if (typeof o.request !== 'object' || o.request === null || Array.isArray(o.request)) shapeFail();
    return { ...(o as unknown as ResponseRequest), response: decodeWireResponse(o.response) };
  }
  return shapeFail();
}
export interface Pair200 {
  readonly contractVersion: typeof HANDOFF_V1; readonly pairId: string; readonly sessionToken: string; readonly serverBootId: string; readonly expiresAt: string;
  readonly evaluationFocus: EvaluationFocus;
}
export function decodePair200(v: unknown): Pair200 {
  const o = exact(v, ['contractVersion', 'pairId', 'sessionToken', 'serverBootId', 'expiresAt', 'evaluationFocus']);
  if (o.contractVersion !== HANDOFF_V1) shapeFail();
  req(isUuid, o.pairId); req(isToken, o.sessionToken); req(isUuid, o.serverBootId); req(isTime, o.expiresAt); decodeEvaluationFocus(o.evaluationFocus);
  return o as unknown as Pair200;
}
/** Fixed status of a handoff failure (06): UNAUTHORIZED 401, SCOPE_MISMATCH 403, FRAME_TOO_LARGE 413, PROTOCOL_INVALID 400, DEADLINE 504, else 503. */
export function handoffStatus(code: FailureCode): number {
  switch (code) {
    case 'UNAUTHORIZED': return 401;
    case 'SCOPE_MISMATCH': return 403;
    case 'FRAME_TOO_LARGE': return 413;
    case 'PROTOCOL_INVALID': return 400;
    case 'DEADLINE': return 504;
    default: return 503;
  }
}
export const handoffErrorBody = (code: FailureCode): string => JSON.stringify({ contractVersion: HANDOFF_ERROR_V1, code });
