// Browser copy of the approved Ask Atlas OFF/MOCK contract (docs/stage5/ask/02_CONTRACTS.md, 03_SECURITY_AND_STATE.md).
// DOM-free; imports only the accepted console contracts. Node parity tests (tests/operator-contracts.test.ts) compare these
// copies with packages/ask/{contracts,input,planner}.ts and packages/ask/remote/{contracts,budget}.ts (ASK-REMOTE V2)
// read-only: a change on either side must update both.
import type { ContextMode, EntityKind, ObservationStatus, Priority, ResourceStatus, ResourceType, Route, Severity } from './contracts.ts';

/** packages/ask/contracts.ts ASK_ERROR_CODES and their fixed HTTP status. */
export const ASK_ERROR_CODES = [
  'ASK_REQUEST_INVALID', 'ASK_SCOPE_DENIED', 'ASK_AUTHENTICATION_FAILED', 'ASK_CONTEXT_UNAVAILABLE', 'ASK_TOO_LARGE',
  'ASK_SCOPE_CHANGED', 'ASK_BUSY', 'ASK_DEADLINE', 'ASK_PLANNER_INVALID', 'ASK_AUDIT_FAILED', 'ASK_RUNTIME_NOT_READY', 'ASK_SOURCE_INVALID'
] as const;
export type AskErrorCode = typeof ASK_ERROR_CODES[number];
export const ASK_HTTP_STATUS: Readonly<Record<AskErrorCode, number>> = Object.freeze({
  ASK_REQUEST_INVALID: 400, ASK_SCOPE_DENIED: 403, ASK_AUTHENTICATION_FAILED: 401, ASK_CONTEXT_UNAVAILABLE: 404, ASK_TOO_LARGE: 413,
  ASK_SCOPE_CHANGED: 409, ASK_BUSY: 429, ASK_DEADLINE: 504, ASK_PLANNER_INVALID: 503, ASK_AUDIT_FAILED: 503, ASK_RUNTIME_NOT_READY: 503,
  ASK_SOURCE_INVALID: 503
});

/**
 * ASK-REMOTE (docs/stage5/ask/remote/02_CONTRACTS.md): packages/ask/remote/contracts.ts ASK_REMOTE_ERROR_CODES and their fixed
 * HTTP status. Accepted only on a REMOTE question (and on capability discovery, whose mode is not yet known); a MOCK answer
 * exchange keeps the V1 list above unchanged.
 */
export const ASK_REMOTE_ERROR_CODES = ['ASK_REMOTE_NOT_ADMITTED', 'ASK_REMOTE_POLICY_CHANGED', 'ASK_REMOTE_BUDGET', 'ASK_REMOTE_UNAVAILABLE',
  'ASK_REMOTE_INVALID', 'ASK_REMOTE_MODEL_MISMATCH', 'ASK_REMOTE_USAGE_INVALID'] as const;
export type AskRemoteErrorCode = typeof ASK_REMOTE_ERROR_CODES[number];
export const ASK_REMOTE_HTTP_STATUS: Readonly<Record<AskRemoteErrorCode, number>> = Object.freeze({
  ASK_REMOTE_NOT_ADMITTED: 503, ASK_REMOTE_POLICY_CHANGED: 409, ASK_REMOTE_BUDGET: 429, ASK_REMOTE_UNAVAILABLE: 503,
  ASK_REMOTE_INVALID: 503, ASK_REMOTE_MODEL_MISMATCH: 503, ASK_REMOTE_USAGE_INVALID: 503
});
/** The fixed values of AskRemoteDisclosureV1 besides the admission tuple (packages/ask/remote/contracts.ts capabilityV2). */
export const REMOTE_DISCLOSURE = Object.freeze({
  contractVersion: 'AskRemoteDisclosureV1', provider: 'openai', model: 'gpt-6-luna', profile: 'ask-remote-openai-luna-v1',
  sent: 'QUESTION_AND_FOCUS_FLAG', dataClass: 'SYNTHETIC', region: 'EU', retention: 'OWNER_VERIFIED_ACCOUNT_POLICY', reserveMicroUsd: 300000
} as const);
/** packages/ask/remote/contracts.ts ASK_REMOTE_PROVENANCE: the exact fixed provenance of every AskAnswerV2. */
export const REMOTE_PROVENANCE = Object.freeze({ provider: 'openai', model: 'gpt-6-luna', profile: 'ask-remote-openai-luna-v1', dataPolicy: 'QUESTION_ONLY_V1' } as const);

const POLICY_VERSION = /^[1-9][0-9]{0,18}$/;
const MAX_POLICY_VERSION = 9223372036854775807n;
/**
 * policyVersion: a positive canonical decimal string ≤ 9223372036854775807 (packages/ask/remote/budget.ts parsePolicyVersion),
 * compared as BigInt and kept as the original string. Never a Number: no coercion, rounding or exponent form.
 */
export function policyVersionValid(value: unknown): value is string {
  return typeof value === 'string' && POLICY_VERSION.test(value) && BigInt(value) <= MAX_POLICY_VERSION;
}

/** Canonical lowercase UUIDv4: the browser's requestId and every server correlation ID. Uppercase is rejected. */
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Approved bounds the browser enforces. The request and response caps count UTF-8 bytes; the question counts code points. */
export const ASK_LIMITS = Object.freeze({
  questionCodePoints: 2000, requestBytes: 16 * 1024, responseBytes: 256 * 1024, observationIdLength: 256,
  observationLimit: 100, bankLimit: 32, bankObservations: 24, bankResources: 7, claims: 8, reasonCodes: 100,
  displayCodePoints: 4000, resourcesRead: 100
});

export const ASK_SOURCES = ['atera', 'huntress'] as const;
export type AskSource = typeof ASK_SOURCES[number];
export const ASK_INTENTS = ['SUMMARY', 'WHY_URGENT', 'SOURCE_STATE', 'ENTITY', 'UNSUPPORTED'] as const;
export type AskIntent = typeof ASK_INTENTS[number];
export const ASK_STATUSES = ['ANSWER', 'INSUFFICIENT', 'UNSUPPORTED'] as const;
export type AskStatus = typeof ASK_STATUSES[number];
export const CLAIM_CODES = [
  'OBSERVATION_RECORDED', 'RESOURCE_RECORDED', 'SOURCE_URGENT', 'SOURCE_NOT_URGENT_IN_READ', 'ENTITY_CONFIRMED', 'ENTITY_UNRESOLVED', 'ENTITY_UNAVAILABLE'
] as const;
export type ClaimCode = typeof CLAIM_CODES[number];
export const ENTITY_STATES = ['CONFIRMED', 'UNRESOLVED', 'UNAVAILABLE'] as const;
export type EntityState = typeof ENTITY_STATES[number];

/**
 * Supported MOCK examples, shown exactly as the local recognizer matches them (packages/ask/planner.ts MOCK_PHRASES: exact
 * case-insensitive match after trimming, one optional final '?'). Anything else is answered as UNSUPPORTED. No LLM.
 */
export const MOCK_EXAMPLES: readonly { readonly intent: Exclude<AskIntent, 'UNSUPPORTED'>; readonly en: string; readonly ru: string }[] = Object.freeze([
  { intent: 'SUMMARY', en: 'What needs attention?', ru: 'Что требует внимания?' },
  { intent: 'WHY_URGENT', en: 'Why is this urgent?', ru: 'Почему это срочно?' },
  { intent: 'SOURCE_STATE', en: 'How fresh is the evidence?', ru: 'Насколько свежи данные?' },
  { intent: 'ENTITY', en: 'Which device is confirmed?', ru: 'Какое устройство подтверждено?' }
]);

// packages/ask/input.ts validQuestion: no NUL/C0 except TAB/LF/CR, no DEL, no lone surrogate, a non-whitespace character.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
export type QuestionProblem = 'EMPTY' | 'TOO_LONG' | 'INVALID';
/** Why a typed question cannot be sent, or null. Nothing is trimmed, normalized or truncated: a refusal sends nothing. */
export function questionProblem(value: string): QuestionProblem | null {
  if (typeof value !== 'string') return 'INVALID';
  if (CONTROL.test(value) || LONE_SURROGATE.test(value)) return 'INVALID';
  if (!/\S/u.test(value)) return 'EMPTY';
  let points = 0;
  for (const _ of value) if (++points > ASK_LIMITS.questionCodePoints) return 'TOO_LONG';
  return null;
}
/** Unicode code points of `value`, counted up to `stop` (so a huge paste is not walked to its end). */
export function codePoints(value: string, stop = Number.MAX_SAFE_INTEGER): number {
  let points = 0;
  for (const _ of value) if (++points >= stop) return points;
  return points;
}

// Validated projections retained by the console. Each is a fresh frozen copy made by validate-ask*.ts; no raw response
// object is ever retained, spread or rendered. Identifiers are kept unshortened; display strings are within the 4000 cap.
export interface AskObservationData {
  readonly observationId: string; readonly source: AskSource; readonly resourceType: ResourceType; readonly connectionId: string;
  readonly externalEventId: string; readonly summary: string; readonly severity: Severity; readonly priority: Priority; readonly route: Route;
  readonly confidence: number; readonly reasonCodes: readonly string[]; readonly status: ObservationStatus; readonly entityId: string | null;
  readonly conflictOfEventKey: string | null; readonly supersededById: string | null; readonly occurredAt: string; readonly createdAt: string;
  readonly updatedAt: string; readonly acknowledgedAt: string | null; readonly resolvedAt: string | null;
}
export interface AskResourceData {
  readonly source: AskSource; readonly resourceType: ResourceType; readonly connectionId: string; readonly status: ResourceStatus;
  readonly asOf: string | null; readonly lastSuccessAt: string | null; readonly truncated: boolean;
}
export interface AskConfirmation { readonly source: AskSource; readonly resourceType: ResourceType; readonly connectionId: string; readonly externalId: string }
export interface AskEntityData {
  readonly observationId: string; readonly entityId: string | null; readonly state: EntityState; readonly entityKind: EntityKind | null;
  readonly displayName: string | null; readonly confirmation: AskConfirmation | null;
}
export type AskFact =
  | { readonly ref: string; readonly kind: 'OBSERVATION'; readonly data: AskObservationData }
  | { readonly ref: string; readonly kind: 'RESOURCE_STATE'; readonly data: AskResourceData }
  | { readonly ref: string; readonly kind: 'ENTITY'; readonly data: AskEntityData };
export interface AskCoverage {
  readonly observationLimit: 100; readonly bankLimit: 32; readonly observationsRead: number; readonly observationPageTruncated: boolean;
  readonly focusExtra: boolean; readonly observationFactsOmitted: boolean; readonly urgentFactsOmitted: boolean; readonly resourcesRead: number;
  readonly resourceFactsOmitted: boolean; readonly fixture: boolean;
}
export interface AskClaim { readonly code: ClaimCode; readonly ref: string }
/**
 * The four supported REMOTE tasks (the accepted Ask intents). OpenAI GPT-6 Luna only chooses one of them (or UNSUPPORTED);
 * no exact phrase is required and nothing here is a MOCK example.
 */
export const REMOTE_TASKS: readonly Exclude<AskIntent, 'UNSUPPORTED'>[] = Object.freeze(['SUMMARY', 'WHY_URGENT', 'SOURCE_STATE', 'ENTITY']);
/** The validated admission tuple of an AskCapabilityV2 (every other disclosure value is the fixed REMOTE_DISCLOSURE). */
export interface AskDisclosure { readonly admissionId: string; readonly policyVersion: string }
export type AskAnswerMode = 'mock' | 'remote';

export interface AskAnswerView {
  /** 'mock' for a validated AskAnswerV1, 'remote' for a validated AskAnswerV2 with the fixed provenance. */
  readonly mode: AskAnswerMode;
  readonly requestId: string; readonly correlationId: string; readonly workspaceId: string; readonly clientId: string;
  readonly sourceMode: ContextMode; readonly status: AskStatus; readonly intent: AskIntent; readonly generatedAt: string;
  readonly focusObservationId: string | null; readonly coverage: AskCoverage; readonly urgentRefs: readonly string[];
  readonly claims: readonly AskClaim[]; readonly evidence: readonly AskFact[];
}
/** A validated AskErrorV1 (fixed code and server correlation UUID only; nothing else of the body is read). */
export interface AskErrorView { readonly code: AskErrorCode | AskRemoteErrorCode; readonly correlationId: string }
