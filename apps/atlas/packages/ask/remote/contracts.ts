import { ASK_HTTP_STATUS, isAskFailure } from '../contracts.ts';
import type { AskAnswerV1, AskErrorCode, AskStatus } from '../contracts.ts';
import { ASK_REMOTE_PROFILE, RESERVE_MICRO_USD } from './budget.ts';

/**
 * ASK-REMOTE V2 server contracts (docs/stage5/ask/remote/02_CONTRACTS.md). The accepted V1 lists in ../contracts.ts stay
 * byte-identical (the browser parity test compares them); the remote codes live here and use the SAME AskErrorV1 envelope.
 * Errors carry a fixed code only: never a message, upstream status/body/header, question or model output.
 */
export const ASK_REMOTE_ERROR_CODES = ['ASK_REMOTE_NOT_ADMITTED', 'ASK_REMOTE_POLICY_CHANGED', 'ASK_REMOTE_BUDGET', 'ASK_REMOTE_UNAVAILABLE',
  'ASK_REMOTE_INVALID', 'ASK_REMOTE_MODEL_MISMATCH', 'ASK_REMOTE_USAGE_INVALID'] as const;
export type AskRemoteErrorCode = typeof ASK_REMOTE_ERROR_CODES[number];
export const ASK_REMOTE_HTTP_STATUS: Readonly<Record<AskRemoteErrorCode, number>> = Object.freeze({
  ASK_REMOTE_NOT_ADMITTED: 503, ASK_REMOTE_POLICY_CHANGED: 409, ASK_REMOTE_BUDGET: 429, ASK_REMOTE_UNAVAILABLE: 503,
  ASK_REMOTE_INVALID: 503, ASK_REMOTE_MODEL_MISMATCH: 503, ASK_REMOTE_USAGE_INVALID: 503
});
/** Every code a remote reply can carry: the accepted Ask codes with their meanings, plus the fixed remote codes. */
export type RemoteReplyCode = AskErrorCode | AskRemoteErrorCode;
const isRemoteCode = (code: string): code is AskRemoteErrorCode => (ASK_REMOTE_ERROR_CODES as readonly string[]).includes(code);
export const remoteStatus = (code: RemoteReplyCode): number => isRemoteCode(code) ? ASK_REMOTE_HTTP_STATUS[code] : ASK_HTTP_STATUS[code];

export class AskRemoteFailure extends Error {
  readonly code: AskRemoteErrorCode;
  constructor(code: AskRemoteErrorCode) { super(code); this.name = 'AskRemoteFailure'; this.code = code; }
}
export function remoteFailure(code: AskRemoteErrorCode): never { throw new AskRemoteFailure(code); }
/** The fixed code of a decided failure (accepted Ask or remote), else null. */
export function decidedCode(error: unknown): RemoteReplyCode | null {
  if (error instanceof AskRemoteFailure) return error.code;
  return isAskFailure(error) ? error.code : null;
}

export const ASK_REMOTE_PROVIDER = 'openai';
export const ASK_REMOTE_MODEL = 'gpt-6-luna';
export const ASK_REMOTE_TIER = 'default';
export const ASK_REMOTE_RULE_VERSION = 'ask-remote-intent-v1';
export const ASK_REMOTE_PERMISSIONS: readonly string[] = Object.freeze(['context:read', 'ask:remote']);
/** Original remaining time required before the attempt INSERT, before egress returns and before dispatch (04). */
export const EGRESS_FLOOR_MS = 4500;
/** Publication floor kept free by the pre-publication settlement wait (04). */
export const PUBLICATION_FLOOR_MS = 500;
export const PROVIDER_PHASE_MS = 2000;
export const SETTLEMENT_PHASE_MS = 2000;
export const PAUSE_PHASE_MS = 2000;

export interface AskRemoteDisclosureV1 {
  contractVersion: 'AskRemoteDisclosureV1'; admissionId: string; policyVersion: string; provider: 'openai'; model: 'gpt-6-luna';
  profile: 'ask-remote-openai-luna-v1'; sent: 'QUESTION_AND_FOCUS_FLAG'; dataClass: 'SYNTHETIC'; region: 'EU';
  retention: 'OWNER_VERIFIED_ACCOUNT_POLICY'; reserveMicroUsd: 300000;
}
export interface AskCapabilityV2 { contractVersion: 'AskCapabilityV2'; mode: 'remote'; questionMaxCodepoints: 2000; disclosure: AskRemoteDisclosureV1 }
/** Exact remote capability (all keys, contract order). policyVersion is the canonical decimal string, never a Number. */
export function capabilityV2(admissionId: string, policyVersion: string): AskCapabilityV2 {
  if (ASK_REMOTE_PROFILE !== 'ask-remote-openai-luna-v1' || RESERVE_MICRO_USD !== 300_000n) throw new Error('ASK_REMOTE_PROFILE_DRIFT');
  return { contractVersion: 'AskCapabilityV2', mode: 'remote', questionMaxCodepoints: 2000,
    disclosure: { contractVersion: 'AskRemoteDisclosureV1', admissionId, policyVersion, provider: 'openai', model: 'gpt-6-luna',
      profile: 'ask-remote-openai-luna-v1', sent: 'QUESTION_AND_FOCUS_FLAG', dataClass: 'SYNTHETIC', region: 'EU',
      retention: 'OWNER_VERIFIED_ACCOUNT_POLICY', reserveMicroUsd: 300000 } };
}

export interface AskRemoteAcknowledgement { readonly admissionId: string; readonly policyVersion: string }
export interface AskRequestV2 {
  readonly requestId: string; readonly question: string; readonly observationId: string | null; readonly acknowledgement: AskRemoteAcknowledgement;
}

export const ASK_REMOTE_PROVENANCE = Object.freeze({ provider: 'openai', model: 'gpt-6-luna', profile: 'ask-remote-openai-luna-v1', dataPolicy: 'QUESTION_ONLY_V1' } as const);
export type AskAnswerV2 = Omit<AskAnswerV1, 'contractVersion' | 'mode'> & {
  contractVersion: 'AskAnswerV2'; mode: 'remote'; provenance: typeof ASK_REMOTE_PROVENANCE;
};

/** Final client audit of a remote request: the SAME allowlisted keys as MOCK with the fixed remote labels; nothing else. */
export type RemoteAuditOutcome =
  | { readonly event: 'completed'; readonly status: AskStatus; readonly itemCount: number }
  | { readonly event: 'failed'; readonly code: RemoteReplyCode; readonly itemCount: number };
export function remoteAuditRecord(outcome: RemoteAuditOutcome): { eventType: string; metadata: Record<string, string> } {
  const metadata: Record<string, string> = { provider: ASK_REMOTE_PROVIDER, ruleVersion: ASK_REMOTE_RULE_VERSION, itemCount: String(outcome.itemCount) };
  if (outcome.event === 'completed') return { eventType: 'ask.completed', metadata: { ...metadata, outcome: outcome.status } };
  return { eventType: 'ask.failed', metadata: { ...metadata, outcome: 'FAILED', safeErrorCode: outcome.code } };
}
