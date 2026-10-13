// Ask Atlas OFF/MOCK contracts (docs/stage5/ask/02_CONTRACTS.md, 03_SECURITY_AND_STATE.md). Plain TypeScript, no enums,
// so every module runs under --experimental-strip-types. Errors carry a fixed code only: never a message, detail or input.

export const ASK_ERROR_CODES = [
  'ASK_REQUEST_INVALID', 'ASK_SCOPE_DENIED', 'ASK_AUTHENTICATION_FAILED', 'ASK_CONTEXT_UNAVAILABLE', 'ASK_TOO_LARGE',
  'ASK_SCOPE_CHANGED', 'ASK_BUSY', 'ASK_DEADLINE', 'ASK_PLANNER_INVALID', 'ASK_AUDIT_FAILED', 'ASK_RUNTIME_NOT_READY', 'ASK_SOURCE_INVALID'
] as const;
export type AskErrorCode = typeof ASK_ERROR_CODES[number];

/** Fixed HTTP status of every Ask error code (02 "Fixed HTTP surface"). */
export const ASK_HTTP_STATUS: Readonly<Record<AskErrorCode, number>> = Object.freeze({
  ASK_REQUEST_INVALID: 400, ASK_SCOPE_DENIED: 403, ASK_AUTHENTICATION_FAILED: 401, ASK_CONTEXT_UNAVAILABLE: 404, ASK_TOO_LARGE: 413,
  ASK_SCOPE_CHANGED: 409, ASK_BUSY: 429, ASK_DEADLINE: 504, ASK_PLANNER_INVALID: 503, ASK_AUDIT_FAILED: 503, ASK_RUNTIME_NOT_READY: 503,
  ASK_SOURCE_INVALID: 503
});

/** A decided Ask failure. Only the fixed code exists; the message is the code itself, never input or an upstream error. */
export class AskFailure extends Error {
  readonly code: AskErrorCode;
  constructor(code: AskErrorCode) { super(code); this.name = 'AskFailure'; this.code = code; }
}
export function askFailure(code: AskErrorCode): never { throw new AskFailure(code); }
export const isAskFailure = (error: unknown): error is AskFailure => error instanceof AskFailure;

/** Approved limits. Raw16KiB and the question's 2000 code points are independent caps. */
export const ASK_LIMITS = Object.freeze({
  questionCodePoints: 2000, rawBodyBytes: 16 * 1024, responseBytes: 256 * 1024, observationIdLength: 256,
  observationPage: 100, graphRows: 1000, resources: 100, resourceItems: 1000, contextBytes: 4 * 1024 * 1024,
  bankFacts: 32, bankObservations: 24, bankResources: 7, planRefs: 8, reasonCodes: 100, displayCodePoints: 4000,
  deadlineMs: 8000, phaseMs: 2000, poolWaitMs: 500, plannerMs: 2000,
  globalOwners: 4, actorEntries: 64, rollingQuestions: 10, rollingWindowMs: 60_000
});

/** Canonical lowercase UUIDv4 (requestId input and every server correlation ID). Uppercase is rejected. */
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const ASK_SOURCES = ['atera', 'huntress'] as const;
export type AskSource = typeof ASK_SOURCES[number];
export type SourceMode = 'fixture' | 'db';
export const ASK_INTENTS = ['SUMMARY', 'WHY_URGENT', 'SOURCE_STATE', 'ENTITY', 'UNSUPPORTED'] as const;
export type AskIntent = typeof ASK_INTENTS[number];
export type AskStatus = 'ANSWER' | 'INSUFFICIENT' | 'UNSUPPORTED';
export const CLAIM_CODES = [
  'OBSERVATION_RECORDED', 'RESOURCE_RECORDED', 'SOURCE_URGENT', 'SOURCE_NOT_URGENT_IN_READ', 'ENTITY_CONFIRMED', 'ENTITY_UNRESOLVED', 'ENTITY_UNAVAILABLE'
] as const;
export type ClaimCode = typeof CLAIM_CODES[number];
export type FactKind = 'OBSERVATION' | 'RESOURCE_STATE' | 'ENTITY';
export type EntityState = 'CONFIRMED' | 'UNRESOLVED' | 'UNAVAILABLE';

/** OBSERVATION data: the accepted ObservationSummary fields (ID renamed observationId), explicit keys in this order. */
export interface ObservationData {
  observationId: string; source: AskSource; resourceType: string; connectionId: string; externalEventId: string; summary: string;
  severity: string; priority: string; route: string; confidence: number; reasonCodes: string[]; status: string; entityId: string | null;
  conflictOfEventKey: string | null; supersededById: string | null; occurredAt: string; createdAt: string; updatedAt: string;
  acknowledgedAt: string | null; resolvedAt: string | null;
}
/** RESOURCE_STATE data: accepted ResourceView semantics with an explicit non-null connection; never items. */
export interface ResourceData {
  source: AskSource; resourceType: string; connectionId: string; status: string; asOf: string | null; lastSuccessAt: string | null; truncated: boolean;
}
export interface Confirmation { source: AskSource; resourceType: string; connectionId: string; externalId: string }
export interface EntityData {
  observationId: string; entityId: string | null; state: EntityState; entityKind: 'PERSON' | 'DEVICE' | null; displayName: string | null;
  confirmation: Confirmation | null;
}
export type BankFact =
  | { ref: string; kind: 'OBSERVATION'; data: ObservationData }
  | { ref: string; kind: 'RESOURCE_STATE'; data: ResourceData }
  | { ref: string; kind: 'ENTITY'; data: EntityData };

export interface AskCoverage {
  observationLimit: 100; bankLimit: 32; observationsRead: number; observationPageTruncated: boolean; focusExtra: boolean;
  observationFactsOmitted: boolean; urgentFactsOmitted: boolean; resourcesRead: number; resourceFactsOmitted: boolean; fixture: boolean;
}
export interface AskClaim { code: ClaimCode; refs: [string] }
export interface AskAnswerV1 {
  contractVersion: 'AskAnswerV1'; requestId: string; correlationId: string; workspaceId: string; clientId: string; mode: 'mock';
  sourceMode: SourceMode; status: AskStatus; intent: AskIntent; generatedAt: string; focusObservationId: string | null;
  coverage: AskCoverage; urgentRefs: string[]; claims: AskClaim[]; evidence: BankFact[];
}
export interface AskCapabilityV1 { contractVersion: 'AskCapabilityV1'; mode: 'mock'; questionMaxCodepoints: 2000 }
export const ASK_CAPABILITY: Readonly<AskCapabilityV1> = Object.freeze({ contractVersion: 'AskCapabilityV1', mode: 'mock', questionMaxCodepoints: 2000 });
export interface AskErrorV1 { contractVersion: 'AskErrorV1'; code: AskErrorCode; correlationId: string }
export const askErrorBody = (code: AskErrorCode, correlationId: string): AskErrorV1 => ({ contractVersion: 'AskErrorV1', code, correlationId });

/** Fixed audit vocabulary (03): existing allowlisted keys only; provider/ruleVersion are fixed MOCK labels. */
export const ASK_AUDIT = Object.freeze({
  completed: 'ask.completed', failed: 'ask.failed', denied: 'ask.scope_denied', provider: 'fixture', ruleVersion: 'ask-mock-v1', permission: 'context:read'
});
