import type { M365ResourceType, Priority, ResourceStatus, Route, Severity } from '../core/contracts.ts';

/**
 * Stage 2 correlation read contract (docs/stage2/02_CONTRACTS.md §4–5, ruleVersion m365-correlation-v1). Types only; the
 * resolver/query/cursor live beside this file (S2-C). ClientContextV1 is deliberately not touched; the m365_* names are the core
 * internal resource types of the typed M365 links (task 2.2), never exposed by the Stage 1 projections.
 * Correlation is evidence presentation: no confidence score, no verdict, no change to the Stage 1 source urgency.
 */
export const CORRELATION_CONTRACT_VERSION = 'atlas.correlation.v1';
export const CORRELATION_RULE_VERSION = 'm365-correlation-v1';
export const CORRELATION_SOURCE_SCOPE = 'GRAPH_V1_USER_SIGNINS';

export type { M365ResourceType } from '../core/contracts.ts';
export type CorrelationResolutionState = 'RESOLVED' | 'UNRESOLVED' | 'AMBIGUOUS';
/**
 * Why a path is unresolved/ambiguous or degraded; fixed vocabulary, never vendor text or IDs. The first six codes keep
 * their S2-A meaning; the ten after them are the additive S2-C extension (brief RC3), sorted and deduplicated in output.
 */
export type CorrelationReasonCode =
  | 'DIRECTORY_STALE' | 'DIRECTORY_EXPIRED' | 'DIRECTORY_OBJECT_NOT_CURRENT'
  | 'SOURCE_DEVICE_REFERENCE_MISSING' | 'SOURCE_DEVICE_REFERENCE_INVALID' | 'SOURCE_CONNECTION_DISABLED'
  /** Valid source agent reference without a current confirmed Huntress DEVICE link (absent mirror, candidate, rejected, quarantined). */
  | 'SOURCE_DEVICE_MAPPING_MISSING'
  /** More than one eligible current source DEVICE mapping: fail closed. */
  | 'SOURCE_DEVICE_MAPPING_AMBIGUOUS'
  /** The resolved source DEVICE has no confirmed m365_device link on the selected connection. */
  | 'M365_DEVICE_MAPPING_MISSING'
  /** More than one confirmed m365_device link of the selected connection for that DEVICE. */
  | 'M365_DEVICE_MAPPING_AMBIGUOUS'
  /** A needed directory resource has no usable active generation/pointer (DIRECTORY_EXPIRED stays distinct). */
  | 'DIRECTORY_MISSING'
  /** The mapped current directory device has a null deviceId. */
  | 'M365_DEVICE_REFERENCE_MISSING'
  /** That deviceId occurs on several current directory devices; none is chosen. */
  | 'M365_DEVICE_REFERENCE_AMBIGUOUS'
  /** The resolved source DEVICE has personId = null (never asserted while the source DEVICE is unresolved). */
  | 'ASSIGNED_PERSON_MISSING'
  /** The assigned person has no confirmed m365_user link on the selected connection. */
  | 'ASSIGNED_PERSON_MAPPING_MISSING'
  /** Several confirmed m365_user links of the selected connection for the assigned person. */
  | 'ASSIGNED_PERSON_MAPPING_AMBIGUOUS';
/** How an item relates to the observation: what Microsoft reported, not attested hardware or ownership. */
export type CorrelationRelationCode = 'DEVICE_REFERENCE' | 'SIGNIN_USER_REFERENCE' | 'ASSIGNED_PERSON_ACTIVITY';
export type CorrelationEvidenceState = 'CURRENT' | 'CONFLICTED';
export type CoverageStatus = 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE';
export type CoverageFreshness = 'FRESH' | 'STALE' | 'MIXED' | 'UNKNOWN';

export interface CorrelationResource {
  resourceType: M365ResourceType; status: ResourceStatus;
  lastSuccessAt: string | null; asOf: string | null; safeErrorCode: string | null;
  generationId?: string;
  coverage: CoverageStatus;
}
export interface CorrelationResolution {
  device: CorrelationResolutionState; person: CorrelationResolutionState;
  reasonCodes: CorrelationReasonCode[];
}
/** One reason a relation holds: the vendor field compared, the evidence identity and the mappings it passed through. */
export interface CorrelationProof {
  relation: CorrelationRelationCode;
  /** Name of the Graph field that carried the reference (for example `deviceDetail.deviceId`), never its value. */
  vendorField: string;
  evidence: CorrelationEvidenceRef;
  linkIds: string[]; linkStatuses: string[];
  directoryGenerationIds: string[];
  ruleVersion: typeof CORRELATION_RULE_VERSION;
}
/** Sign-in evidence identity; the response order is occurredAt DESC, then sourceId ASC, then contentHash ASC. */
export interface CorrelationEvidenceRef { sourceId: string; contentHash: string }
export interface CorrelationItem {
  evidenceRef: CorrelationEvidenceRef; occurredAt: string;
  /** Sign-in status.errorCode as reported; a status, never a severity. */
  statusCode?: number;
  canonicalPersonId?: string;
  relationCodes: CorrelationRelationCode[]; proof: CorrelationProof[];
  evidenceState: CorrelationEvidenceState;
}
export interface CoverageWindow {
  rootWindowId: string; publishedAttemptId: string;
  fromInclusive: string; toExclusive: string; retrievedAt: string; freshness: 'FRESH' | 'STALE';
}
/** Time inside the query that no published retained attempt covers; never merely "older than freshness". */
export interface CoverageGap { fromInclusive: string; toExclusive: string; reasonCode: string }
/**
 * Traversal coverage only. traversalComplete is exactly (status === 'COMPLETE'); freshness is independent. Neither
 * COMPLETE nor FRESH means every real-world sign-in was reported, or that the client is safe.
 */
export interface CorrelationCoverage {
  status: CoverageStatus; traversalComplete: boolean;
  completedWindows: CoverageWindow[]; gaps: CoverageGap[];
  sourceScope: typeof CORRELATION_SOURCE_SCOPE; assessedAt: string; freshness: CoverageFreshness;
}
export interface CorrelationContextV1 {
  contractVersion: typeof CORRELATION_CONTRACT_VERSION; mode: 'fixture' | 'db';
  workspaceId: string; clientId: string; observationId: string; m365ConnectionId: string;
  ruleVersion: typeof CORRELATION_RULE_VERSION;
  /** Unchanged Stage 1 source facts of the Huntress observation. */
  source: { eventKey: string; severity: Severity; priority: Priority; route: Route };
  window: { fromInclusive: string; toExclusive: string };
  resources: CorrelationResource[];
  resolution: CorrelationResolution;
  /**
   * null iff coverage is UNAVAILABLE. [] means zero matching available evidence: it is not an all-clear for unresolved
   * paths or PARTIAL coverage; only COMPLETE establishes a complete traversal, and even that carries no safety verdict.
   */
  items: CorrelationItem[] | null;
  coverage: CorrelationCoverage;
  total: number; truncated: boolean; nextCursor: string | null;
}
