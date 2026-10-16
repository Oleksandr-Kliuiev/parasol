import { askRemoteRequest } from '../ask/remote/input.ts';
import { isFailureCode } from './codes.ts';
import type { FailureCode } from './codes.ts';
import { decodeBinding, isPublicErrorCode } from './eval-wire.ts';
import type { Binding } from './eval-wire.ts';
import { exact, isBool, isIntIn, isPositiveDec64, isScopeId, isUuid, req, shapeFail } from './scalars.ts';

/**
 * The SEPARATE raw S<->I transient protocol (06 "Exact transient transfer and acknowledgements"). Its own decoder module and
 * socket capability: these objects are never a RevalOwnerEvidenceV1 kind/payload and no persistence API accepts them. Only the
 * separately constructed RevalHandoffSummaryV1 (bindings, transferId, SafeResult) is persistable. Caps: transfer ≤288 KiB, ACK
 * ≤8 KiB, COMMIT ≤4 KiB, READY/READY_ACK ≤4 KiB.
 */
export const TRANSFER_FRAME_CAP = 288 * 1024;
export const READY_V1 = 'RevalTransientReadyV1'; export const READY_ACK_V1 = 'RevalTransientReadyAckV1';
export const TRANSFER_V1 = 'RevalTransientTransferV1'; export const ACK_V1 = 'RevalTransientAckV1'; export const COMMIT_V1 = 'RevalTransientCommitV1';
export const SUMMARY_V1 = 'RevalHandoffSummaryV1';
const SEQ_KEYS = ['connectionId', 'sequence', 'challenge'] as const;
const seq = (o: Record<string, unknown>) => { req(isUuid, o.connectionId); req(isPositiveDec64, o.sequence); req(isUuid, o.challenge); };

export interface Ready {
  readonly contractVersion: typeof READY_V1; readonly registrationId: string; readonly serverBootId: string; readonly connectionId: string;
  readonly sequence: string; readonly challenge: string; readonly pairId: string; readonly armId: string; readonly caseId: string; readonly fixtureId: string;
  readonly fixtureGeneration: string; readonly admissionId: string; readonly policyVersion: string; readonly preSnapshotId: string;
}
export const READY_KEYS = ['contractVersion', 'registrationId', 'serverBootId', ...SEQ_KEYS, 'pairId', 'armId', 'caseId', 'fixtureId', 'fixtureGeneration',
  'admissionId', 'policyVersion', 'preSnapshotId'] as const;
export function decodeReady(v: unknown): Ready {
  const o = exact(v, READY_KEYS);
  if (o.contractVersion !== READY_V1) shapeFail();
  seq(o); for (const k of ['registrationId', 'serverBootId', 'pairId', 'armId', 'admissionId', 'preSnapshotId']) req(isUuid, o[k]);
  req(isScopeId, o.caseId); if (typeof o.fixtureId !== 'string' || !/^FX(0[1-9]|1[01])$/.test(o.fixtureId)) shapeFail();
  req(isPositiveDec64, o.fixtureGeneration); req(isPositiveDec64, o.policyVersion);
  return o as unknown as Ready;
}
export interface ReadyAck {
  readonly contractVersion: typeof READY_ACK_V1; readonly registrationId: string; readonly serverBootId: string; readonly connectionId: string;
  readonly sequence: string; readonly challenge: string; readonly readySequence: string; readonly armId: string; readonly disposition: 'READY' | 'FAILED';
  readonly failureCode: FailureCode | null;
}
export function decodeReadyAck(v: unknown): ReadyAck {
  const o = exact(v, ['contractVersion', 'registrationId', 'serverBootId', ...SEQ_KEYS, 'readySequence', 'armId', 'disposition', 'failureCode']);
  if (o.contractVersion !== READY_ACK_V1) shapeFail();
  seq(o); req(isUuid, o.registrationId); req(isUuid, o.serverBootId); req(isPositiveDec64, o.readySequence); req(isUuid, o.armId);
  if (o.disposition === 'READY') { if (o.failureCode !== null) shapeFail(); } else if (o.disposition !== 'FAILED' || !isFailureCode(o.failureCode)) shapeFail();
  return o as unknown as ReadyAck;
}

export interface WireResponse { readonly status: number; readonly correlationId: string; readonly body: Readonly<Record<string, unknown>> }
export function decodeWireResponse(v: unknown): WireResponse {
  const o = exact(v, ['status', 'correlationId', 'body']);
  if (!isIntIn(o.status, 200, 599)) shapeFail();
  req(isUuid, o.correlationId);
  if (typeof o.body !== 'object' || o.body === null || Array.isArray(o.body)) shapeFail();
  return o as unknown as WireResponse;
}
export interface Transfer {
  readonly contractVersion: typeof TRANSFER_V1; readonly connectionId: string; readonly sequence: string; readonly challenge: string;
  readonly readySequence: string; readonly transferId: string; readonly ackChallenge: string; readonly binding: Binding;
  readonly bindingResult: 'SERVER_VALUES_MATCHED'; readonly publicationAuthority: 'CONFIRMED' | 'NOT_APPLICABLE'; readonly handoffAuthority: 'CONFIRMED';
  readonly request: unknown; readonly response: WireResponse;
}
export function decodeTransfer(v: unknown): Transfer {
  const o = exact(v, ['contractVersion', ...SEQ_KEYS, 'readySequence', 'transferId', 'ackChallenge', 'binding', 'bindingResult', 'publicationAuthority',
    'handoffAuthority', 'request', 'response']);
  if (o.contractVersion !== TRANSFER_V1 || o.bindingResult !== 'SERVER_VALUES_MATCHED' || o.handoffAuthority !== 'CONFIRMED') shapeFail();
  seq(o); req(isPositiveDec64, o.readySequence); req(isUuid, o.transferId); req(isUuid, o.ackChallenge);
  const binding = decodeBinding(o.binding);
  if (binding.handoffConnectionId !== o.connectionId) shapeFail();
  askRemoteRequest(o.request);
  const response = decodeWireResponse(o.response);
  if (response.correlationId !== binding.correlationId) shapeFail();
  if (o.publicationAuthority !== (response.status === 200 ? 'CONFIRMED' : 'NOT_APPLICABLE')) shapeFail();
  return o as unknown as Transfer;
}

export interface SafeResult {
  readonly requestMatchesFrozen: boolean; readonly semantic: 'MATCH' | 'MISMATCH' | 'NOT_EVALUATED'; readonly schema: boolean;
  readonly claims: boolean | null; readonly coverage: boolean | null; readonly urgency: boolean | null; readonly publicOutcome: 'ANSWER' | 'ERROR';
  readonly publicErrorCode: string | null;
}
export const SAFE_RESULT_KEYS = ['requestMatchesFrozen', 'semantic', 'schema', 'claims', 'coverage', 'urgency', 'publicOutcome', 'publicErrorCode'] as const;
export function decodeSafeResult(v: unknown): SafeResult {
  const o = exact(v, SAFE_RESULT_KEYS);
  req(isBool, o.requestMatchesFrozen);
  if (o.schema !== true) shapeFail();
  if (o.publicOutcome === 'ANSWER') {
    if (o.publicErrorCode !== null || !isBool(o.claims) || !isBool(o.coverage) || !isBool(o.urgency)) shapeFail();
    if (o.requestMatchesFrozen ? !(o.semantic === 'MATCH' || o.semantic === 'MISMATCH') : o.semantic !== 'NOT_EVALUATED') shapeFail();
  } else if (o.publicOutcome === 'ERROR') {
    if (o.semantic !== 'NOT_EVALUATED' || o.claims !== null || o.coverage !== null || o.urgency !== null || !isPublicErrorCode(o.publicErrorCode)) shapeFail();
  } else shapeFail();
  return o as unknown as SafeResult;
}
export interface Ack {
  readonly contractVersion: typeof ACK_V1; readonly connectionId: string; readonly sequence: string; readonly challenge: string; readonly transferSequence: string;
  readonly transferId: string; readonly binding: Binding; readonly commitChallenge: string; readonly disposition: 'ACCEPTED' | 'REJECTED';
  readonly result: SafeResult | null; readonly failureCode: FailureCode | null;
}
export function decodeAck(v: unknown): Ack {
  const o = exact(v, ['contractVersion', ...SEQ_KEYS, 'transferSequence', 'transferId', 'binding', 'commitChallenge', 'disposition', 'result', 'failureCode']);
  if (o.contractVersion !== ACK_V1) shapeFail();
  seq(o); req(isPositiveDec64, o.transferSequence); req(isUuid, o.transferId); decodeBinding(o.binding); req(isUuid, o.commitChallenge);
  if (o.disposition === 'ACCEPTED') { decodeSafeResult(o.result); if (o.failureCode !== null) shapeFail(); }
  else if (o.disposition === 'REJECTED') {
    if (o.result !== null || !['VALUE_VALIDATION_FAILED', 'WRONG_BINDING', 'METADATA_PERSIST_FAILED'].includes(o.failureCode as string)) shapeFail();
  } else shapeFail();
  return o as unknown as Ack;
}
export interface Commit {
  readonly contractVersion: typeof COMMIT_V1; readonly connectionId: string; readonly sequence: string; readonly challenge: string; readonly ackSequence: string;
  readonly transferId: string; readonly binding: Binding; readonly disposition: 'COMMITTED' | 'FAILED'; readonly failureCode: FailureCode | null;
}
export function decodeCommit(v: unknown): Commit {
  const o = exact(v, ['contractVersion', ...SEQ_KEYS, 'ackSequence', 'transferId', 'binding', 'disposition', 'failureCode']);
  if (o.contractVersion !== COMMIT_V1) shapeFail();
  seq(o); req(isPositiveDec64, o.ackSequence); req(isUuid, o.transferId); decodeBinding(o.binding);
  if (o.disposition === 'COMMITTED') { if (o.failureCode !== null) shapeFail(); }
  else if (o.disposition !== 'FAILED' || !['ACK_INVALID', 'ACK_TIMEOUT', 'PAIR_REVOKED', 'RAW_EXPIRED', 'IPC_LOST'].includes(o.failureCode as string)) shapeFail();
  return o as unknown as Commit;
}
export interface HandoffSummary {
  readonly contractVersion: typeof SUMMARY_V1; readonly binding: Binding; readonly transferId: string; readonly state: 'PENDING' | 'COMMITTED' | 'UNVERIFIED';
  readonly result: SafeResult | null; readonly failureCode: FailureCode | null;
}
export function decodeHandoffSummary(v: unknown): HandoffSummary {
  const o = exact(v, ['contractVersion', 'binding', 'transferId', 'state', 'result', 'failureCode']);
  if (o.contractVersion !== SUMMARY_V1) shapeFail();
  decodeBinding(o.binding); req(isUuid, o.transferId);
  if (o.state === 'PENDING' || o.state === 'COMMITTED') { decodeSafeResult(o.result); if (o.failureCode !== null) shapeFail(); }
  else if (o.state === 'UNVERIFIED') { if (o.result !== null) decodeSafeResult(o.result); if (!isFailureCode(o.failureCode)) shapeFail(); }
  else shapeFail();
  return o as unknown as HandoffSummary;
}
