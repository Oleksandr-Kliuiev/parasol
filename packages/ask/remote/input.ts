import { ASK_LIMITS, UUID_V4, askFailure } from '../contracts.ts';
import { validQuestion } from '../input.ts';
import { parsePolicyVersion } from './budget.ts';
import type { AskRequestV2 } from './contracts.ts';

/**
 * Exact AskRequestV2 (docs/stage5/ask/remote/02 "Remote request exact DTO"): all five keys and nothing else; question and
 * observationId follow the V1 rules exactly; the acknowledgement is required (never defaulted) and exact:
 * {contractVersion:'AskRemoteDisclosureV1', admissionId: lower UUIDv4, policyVersion: positive canonical decimal ≤ max
 * bigint (kept as the string, never a Number), questionDataClass:'SYNTHETIC'}. Anything else — a V1 request included — is
 * ASK_REQUEST_INVALID (400). The acknowledgement is an operator declaration; it carries no authority.
 */
const REQUEST_KEYS = 'acknowledgement,contractVersion,observationId,question,requestId';
const ACK_KEYS = 'admissionId,contractVersion,policyVersion,questionDataClass';
const plain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

export function askRemoteRequest(body: unknown): AskRequestV2 {
  if (!plain(body) || Object.keys(body).sort().join() !== REQUEST_KEYS) return askFailure('ASK_REQUEST_INVALID');
  const { contractVersion, requestId, question, observationId, acknowledgement: ack } = body;
  if (contractVersion !== 'AskRequestV2' || typeof requestId !== 'string' || !UUID_V4.test(requestId) || !validQuestion(question)) return askFailure('ASK_REQUEST_INVALID');
  if (observationId !== null && (typeof observationId !== 'string' || observationId.length === 0 || observationId.length > ASK_LIMITS.observationIdLength)) {
    return askFailure('ASK_REQUEST_INVALID');
  }
  if (!plain(ack) || Object.keys(ack).sort().join() !== ACK_KEYS || ack.contractVersion !== 'AskRemoteDisclosureV1' || ack.questionDataClass !== 'SYNTHETIC'
    || typeof ack.admissionId !== 'string' || !UUID_V4.test(ack.admissionId) || parsePolicyVersion(ack.policyVersion) === null) return askFailure('ASK_REQUEST_INVALID');
  return Object.freeze({ requestId, question, observationId,
    acknowledgement: Object.freeze({ admissionId: ack.admissionId, policyVersion: ack.policyVersion as string }) });
}
