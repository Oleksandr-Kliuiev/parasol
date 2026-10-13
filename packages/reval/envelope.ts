import { isFailureCode, isKind, isOperation } from './codes.ts';
import type { FailureCode, Kind, Operation } from './codes.ts';
import { exact, isDec64, isIntIn, isPositiveDec64, isScopeId, isTime, isUuid, req, RevalShapeError, shapeFail } from './scalars.ts';

/**
 * The exact 06 envelopes (RevalOwnerCommandV1 / RevalOwnerEvidenceV1), operation payloads and per-connection sequence/
 * challenge state. Sequences are positive Dec64 strings, one per direction, starting at 1 and advancing by exactly one.
 */
export const COMMAND_V1 = 'RevalOwnerCommandV1';
export const EVIDENCE_V1 = 'RevalOwnerEvidenceV1';
const REQUEST_KEYS = ['contractVersion', 'registrationId', 'serverBootId', 'connectionId', 'challenge', 'sequence', 'operation', 'payload'];
const RESPONSE_KEYS = ['contractVersion', 'registrationId', 'serverBootId', 'connectionId', 'challenge', 'sequence', 'requestSequence',
  'observedAt', 'emitter', 'databaseInstanceId', 'kind', 'payload'];

export interface Request {
  readonly contractVersion: typeof COMMAND_V1; readonly registrationId: string; readonly serverBootId: string; readonly connectionId: string;
  readonly challenge: string; readonly sequence: string; readonly operation: Operation; readonly payload: Record<string, unknown>;
}
export interface Response {
  readonly contractVersion: typeof EVIDENCE_V1; readonly registrationId: string; readonly serverBootId: string; readonly connectionId: string;
  readonly challenge: string; readonly sequence: string; readonly requestSequence: string; readonly observedAt: string;
  readonly emitter: 'CONTROLLER' | 'SERVER'; readonly databaseInstanceId: string; readonly kind: Kind; readonly payload: unknown;
}

const caseId = (v: unknown): v is string => isScopeId(v);
const fixtureId = (v: unknown): v is string => typeof v === 'string' && /^FX(0[1-9]|1[01])$/.test(v);
/** Exact payload of each operation (06 table). */
export function decodeOperationPayload(op: Operation, v: unknown): Record<string, unknown> {
  switch (op) {
    case 'IDENTITY': case 'SNAPSHOT': case 'PROCESS_CENSUS': case 'DRAIN': case 'PLATFORM_PROOF': case 'PRIVACY_PROOF': case 'FIXTURE_CHECK':
      return exact(v, []);
    case 'TERMINAL_OBSERVATION': { const o = exact(v, ['armId']); req(isUuid, o.armId); return o; }
    case 'PAIR': { const o = exact(v, ['instrumentControlConnectionId', 'instrumentHandoffConnectionId']);
      req(isUuid, o.instrumentControlConnectionId); req(isUuid, o.instrumentHandoffConnectionId); return o; }
    case 'END_PAIR': { const o = exact(v, ['pairId']); req(isUuid, o.pairId); return o; }
    case 'ARM_CASE': { const o = exact(v, ['caseId', 'fixtureId', 'fixtureGeneration', 'admissionId', 'policyVersion', 'preSnapshotId', 'browserPairId']);
      req(caseId, o.caseId); req(fixtureId, o.fixtureId); req(isPositiveDec64, o.fixtureGeneration); req(isUuid, o.admissionId);
      req(isPositiveDec64, o.policyVersion); req(isUuid, o.preSnapshotId); req(isUuid, o.browserPairId); return o; }
    case 'PAUSE_EXPORT': { const o = exact(v, ['admissionId', 'expectedPolicyVersion', 'policyFloor', 'fenceFloor']);
      req(isUuid, o.admissionId); req(isPositiveDec64, o.expectedPolicyVersion); req(isDec64, o.policyFloor); req(isDec64, o.fenceFloor); return o; }
    case 'OBSERVATION_COLLECTED': { const o = exact(v, ['armId', 'observationId', 'revision']);
      req(isUuid, o.armId); req(isUuid, o.observationId); if (!isIntIn(o.revision, 1, 16)) shapeFail(); return o; }
  }
}

export type DecodedRequest =
  | { readonly ok: true; readonly request: Request }
  /** Parsed, challenge/sequence extractable, but schema-invalid: answer PROTOCOL_INVALID echoing them, then close. */
  | { readonly ok: false; readonly addressable: { readonly challenge: string; readonly sequence: string } | null };
export function decodeRequest(v: unknown): DecodedRequest {
  try {
    const o = exact(v, REQUEST_KEYS);
    if (o.contractVersion !== COMMAND_V1) shapeFail();
    req(isUuid, o.registrationId); req(isUuid, o.serverBootId); req(isUuid, o.connectionId); req(isUuid, o.challenge);
    req(isPositiveDec64, o.sequence); req(isOperation, o.operation);
    const payload = decodeOperationPayload(o.operation as Operation, o.payload);
    return { ok: true, request: { ...(o as unknown as Request), payload } };
  } catch (error) {
    if (!(error instanceof RevalShapeError)) throw error;
    const o = typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};
    return { ok: false, addressable: isUuid(o.challenge) && isPositiveDec64(o.sequence) ? { challenge: o.challenge, sequence: o.sequence } : null };
  }
}
/** Exact response envelope (payload decoded by the caller against the outstanding operation). */
export function decodeResponse(v: unknown): Response {
  const o = exact(v, RESPONSE_KEYS);
  if (o.contractVersion !== EVIDENCE_V1) shapeFail();
  req(isUuid, o.registrationId); req(isUuid, o.serverBootId); req(isUuid, o.connectionId); req(isUuid, o.challenge);
  req(isPositiveDec64, o.sequence); req(isPositiveDec64, o.requestSequence); req(isTime, o.observedAt);
  if (o.emitter !== 'CONTROLLER' && o.emitter !== 'SERVER') shapeFail();
  req(isUuid, o.databaseInstanceId); req(isKind, o.kind);
  return o as unknown as Response;
}
export function decodeFailurePayload(v: unknown): { code: FailureCode } {
  const o = exact(v, ['code']); req(isFailureCode, o.code); return o as { code: FailureCode };
}

/** Binding identity of one connection: what every frame on it must carry. */
export interface ConnectionBinding { readonly registrationId: string; readonly serverBootId: string; readonly connectionId: string }

/** Monotonic per-direction sequence counter (Dec64 strings, never wraps). */
export class Sequence {
  private next = 1n;
  take(): string { if (this.next > 9223372036854775807n) throw new RevalShapeError(); const s = String(this.next); this.next += 1n; return s; }
  expect(v: string): boolean { if (v !== String(this.next)) return false; this.next += 1n; return true; }
}

/**
 * Responder-side checks of one decoded request against its connection, in order; returns the fixed failure or null.
 * Challenges are never reused on a connection.
 */
export class ResponderState {
  readonly recv = new Sequence();
  readonly send = new Sequence();
  private readonly seen = new Set<string>();
  busy = false;
  readonly binding: ConnectionBinding;
  constructor(binding: ConnectionBinding) { this.binding = binding; }
  check(r: Request): FailureCode | null {
    if (r.registrationId !== this.binding.registrationId) return 'REGISTRATION_MISMATCH';
    if (r.serverBootId !== this.binding.serverBootId || r.connectionId !== this.binding.connectionId) return 'WRONG_BINDING';
    if (!this.recv.expect(r.sequence)) return 'SEQUENCE_INVALID';
    if (this.seen.has(r.challenge)) return 'CHALLENGE_INVALID';
    this.seen.add(r.challenge);
    if (this.busy) return 'OPERATION_BUSY';
    return null;
  }
}
/** Builds the response envelope (the caller passes the next send sequence). */
export function buildResponse(b: ConnectionBinding, request: { challenge: string; sequence: string }, sequence: string, emitter: 'CONTROLLER' | 'SERVER',
  databaseInstanceId: string, kind: Kind, payload: unknown, observedAt: string): Response {
  return { contractVersion: EVIDENCE_V1, registrationId: b.registrationId, serverBootId: b.serverBootId, connectionId: b.connectionId,
    challenge: request.challenge, sequence, requestSequence: request.sequence, observedAt, emitter, databaseInstanceId, kind, payload };
}
export function buildRequest(b: ConnectionBinding, challenge: string, sequence: string, operation: Operation, payload: Record<string, unknown>): Request {
  return { contractVersion: COMMAND_V1, registrationId: b.registrationId, serverBootId: b.serverBootId, connectionId: b.connectionId,
    challenge, sequence, operation, payload };
}

/** Requester-side validation of a response to the single outstanding request. */
export interface Outstanding { readonly challenge: string; readonly sequence: string; readonly operation: Operation }
export function checkResponse(b: ConnectionBinding, recv: Sequence, out: Outstanding, r: Response, expectedEmitter: 'CONTROLLER' | 'SERVER',
  databaseInstanceId: string | null): FailureCode | null {
  if (r.registrationId !== b.registrationId) return 'REGISTRATION_MISMATCH';
  if (r.serverBootId !== b.serverBootId || r.connectionId !== b.connectionId) return 'WRONG_BINDING';
  if (!recv.expect(r.sequence) || r.requestSequence !== out.sequence) return 'SEQUENCE_INVALID';
  if (r.challenge !== out.challenge) return 'CHALLENGE_INVALID';
  if (databaseInstanceId !== null && r.databaseInstanceId !== databaseInstanceId) return 'REGISTRATION_MISMATCH';
  if (r.kind !== 'FAILURE' && r.emitter !== expectedEmitter) return 'PROTOCOL_INVALID';
  return null;
}
