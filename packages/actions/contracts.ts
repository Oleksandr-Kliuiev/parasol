import { AtlasError } from '../core/contracts.ts';
import type { ErrorKind } from '../core/contracts.ts';

/**
 * Stage 3 governed-action contracts (docs/stage3/01_SPEC.md, 02_CONTRACTS.md). S3-A: typed input, deterministic preview,
 * immutable request and idempotent retrieval. S3-B: stored-preview approval, rejection, revocation, cancellation and the
 * atomic reservation with its private single-use permit. S3-C: the built-in synthetic port, one create dispatch, durable
 * verification claims, explicit recovery and their safe public results.
 */
export const ACTION_TYPE = 'atera.create_ticket';
/** Atlas port contract version (not a claim about Atera's HTTP payload). */
export const ACTION_VERSION = 'atlas-ticket-port/1/mock';
export const ACTION_POLICY_VERSION = 'atlas-action-policy/1';
export const ACTION_PORT_VERSION = 'atlas-synthetic-ticket-port/1';
export const ACTION_MODE = 'MOCK';
export const ACTION_REQUEST_DTO = 'atlas-action-request/1';
export const ACTION_ID_DTO = 'action-id/1';
export const ACTION_INTENT_DTO = 'action-intent/1';
export const ACTION_PREVIEW_DTO = 'atlas-action-preview/1';

/** Same-client permissions (ClientMembership vocabulary, migration 202610091000). Every command also needs context:read. */
export const ACTIONS_READ = 'actions:read';
export const ACTIONS_REQUEST = 'actions:request';
export const ACTIONS_APPROVE = 'actions:approve';
export const ACTIONS_EXECUTE = 'actions:execute';
export const CONTEXT_READ = 'context:read';
export const ACTION_PERMISSIONS: readonly string[] = [ACTIONS_READ, ACTIONS_REQUEST, ACTIONS_APPROVE, ACTIONS_EXECUTE];
/** Permissions per S3-A operation, all-of on ONE membership of the client (never merged across memberships). */
export const PREVIEW_PERMISSIONS: readonly string[] = [CONTEXT_READ, ACTIONS_READ, ACTIONS_REQUEST];
export const REQUEST_PERMISSIONS: readonly string[] = [CONTEXT_READ, ACTIONS_READ, ACTIONS_REQUEST];
export const READ_PERMISSIONS: readonly string[] = [CONTEXT_READ, ACTIONS_READ];
/** S3-B: approve/reject/revoke need approve (never request); cancel is the requester's; reservation needs execute. */
export const APPROVE_PERMISSIONS: readonly string[] = [CONTEXT_READ, ACTIONS_READ, ACTIONS_APPROVE];
export const CANCEL_PERMISSIONS: readonly string[] = [CONTEXT_READ, ACTIONS_READ, ACTIONS_REQUEST];
export const EXECUTE_PERMISSIONS: readonly string[] = [CONTEXT_READ, ACTIONS_READ, ACTIONS_EXECUTE];
/** Approval lifetime from the DB clock (capped by both signer token-expiry snapshots) and the reservation start window. */
export const APPROVAL_TTL_MS = 15 * 60_000;
export const START_DEADLINE_MS = 5_000;
/**
 * S3-C (04_EXECUTION_AND_PORT): create and read deadlines (AbortSignal), recovery grace of a RESERVED attempt after
 * reservedAt, claim window (startedAt + 35 s, the last 20 s persistence/crash grace), verification ordinal budget and the
 * bounded same-fact publication attempts on a known rollback (40P01/40001).
 */
export const CREATE_DEADLINE_MS = 15_000;
export const READ_DEADLINE_MS = 15_000;
export const RECOVERY_GRACE_MS = 35_000;
export const CLAIM_WINDOW_MS = 35_000;
export const VERIFICATION_BUDGET = 3;
export const PUBLICATION_ATTEMPTS = 3;
/** Bounded synthetic ticket ID (same pattern as the stored CHECKs). Anything else from a port is malformed. */
export const TICKET_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
export const RECONCILIATION_KIND = 'ACTION_RECONCILIATION_CANDIDATE';
export const RECONCILIATION_DTO = 'action-candidate/1';

export const TITLE_MAX = 160;
export const DESCRIPTION_MAX = 2000;
export const MARKED_TITLE_MAX = 240;
export const INPUT_MAX_BYTES = 16 * 1024;
export const LIST_DEFAULT = 50;
export const LIST_MAX = 100;

export type RequestState = 'AWAITING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'REVOKED' | 'INVALIDATED' | 'EXPIRED'
  | 'DISPATCH_RESERVED' | 'NOT_DISPATCHED' | 'OUTCOME_UNKNOWN' | 'CREATED_UNVERIFIED' | 'VERIFICATION_MISMATCH' | 'VERIFIED';
export const PENDING_STATES: readonly RequestState[] = ['AWAITING_APPROVAL', 'APPROVED'];
/** Reached only through reservation: cancel/revoke/reject afterwards return ACTION_ALREADY_RESERVED. */
export const RESERVED_STATES: readonly RequestState[] = ['DISPATCH_RESERVED', 'NOT_DISPATCHED', 'OUTCOME_UNKNOWN', 'CREATED_UNVERIFIED',
  'VERIFICATION_MISMATCH', 'VERIFIED'];
export type ApprovalDecision = 'APPROVED' | 'REJECTED' | 'REVOKED' | 'CONSUMED';

/** Fixed error codes (02_CONTRACTS "Public output and fixed errors"). No value, body or SQL diagnostic ever follows. */
export const ACTION_ERROR_CODES = [
  'ACTION_AUTHENTICATION_FAILED', 'SCOPE_DENIED', 'PERMISSION_DENIED', 'ACTION_MODE_DISABLED', 'ACTION_MODE_REFUSED', 'ACTION_CONNECTION_REFUSED',
  'ACTION_INPUT_INVALID', 'ACTION_PREVIEW_STALE', 'ACTION_OUTPUT_INVALID', 'ACTION_OUTPUT_FAILED', 'IDEMPOTENCY_CONFLICT',
  'APPROVAL_SELF_REFUSED', 'APPROVAL_HASH_MISMATCH', 'APPROVAL_PREVIEW_MISMATCH', 'APPROVAL_NOT_VALID', 'ACTION_AUTHORITY_CHANGED',
  'ACTION_FENCE_NOT_READY', 'ACTION_CONTRACT_VERSION_CHANGED', 'ACTION_PUBLICATION_CONFLICT', 'ACTION_STATE_CONFLICT', 'ACTION_ALREADY_RESERVED',
  'ACTION_RECOVERY_NOT_DUE', 'ACTION_DB_CONFLICT', 'ACTION_NOT_DISPATCHED', 'ACTION_OUTCOME_UNKNOWN', 'ACTION_VERIFICATION_BUSY',
  'ACTION_VERIFICATION_FAILED', 'ACTION_VERIFICATION_BUDGET', 'ACTION_AUDIT_FAILED', 'ACTION_NOT_FOUND', 'UNEXPECTED_ERROR',
] as const;
export type ActionErrorCode = typeof ACTION_ERROR_CODES[number];
const KINDS: Partial<Record<ActionErrorCode, ErrorKind>> = {
  SCOPE_DENIED: 'SCOPE', PERMISSION_DENIED: 'SCOPE', ACTION_AUTHENTICATION_FAILED: 'SCOPE', ACTION_INPUT_INVALID: 'VALIDATION',
  ACTION_OUTPUT_INVALID: 'VALIDATION', ACTION_PREVIEW_STALE: 'CONFLICT', IDEMPOTENCY_CONFLICT: 'CONFLICT', ACTION_STATE_CONFLICT: 'CONFLICT',
  ACTION_DB_CONFLICT: 'TRANSIENT', ACTION_CONNECTION_REFUSED: 'VALIDATION', ACTION_NOT_FOUND: 'VALIDATION',
};
/** The one way action code raises: a fixed code, no details. */
export const actionError = (code: ActionErrorCode): AtlasError => new AtlasError(code, KINDS[code] ?? 'PERMANENT');

/** User-entered input file (02_CONTRACTS): exactly these four fields. Client and actor come from trusted scope/bearer. */
export interface ActionInput { connectionId: string; title: string; description: string; idempotencyKey: string }
/** Normalized, validated content (NFC, trimmed); title is the unmarked user title. */
export interface NormalizedInput { connectionId: string; title: string; description: string; idempotencyKey: string }

/** Private preview document (exact whitelist). Written only to a protected file, never to stdout, audit or errors. */
export interface ActionPreviewDocument {
  kind: 'ACTION_INPUT_PREVIEW' | 'STORED_ACTION_PREVIEW'; dto: typeof ACTION_PREVIEW_DTO; requestId: string;
  workspaceId: string; clientId: string; connectionId: string; actionType: string; actionVersion: string;
  policyVersion: string; portVersion: string; mode: typeof ACTION_MODE; title: string; description: string; marker: string; inputHash: string;
}
export const PREVIEW_FIELDS: readonly (keyof ActionPreviewDocument)[] = ['kind', 'dto', 'requestId', 'workspaceId', 'clientId', 'connectionId',
  'actionType', 'actionVersion', 'policyVersion', 'portVersion', 'mode', 'title', 'description', 'marker', 'inputHash'];

/**
 * Why a stored request could no longer be approved now, without changing it (retrieval is not admission): CURRENT, or the
 * first applicable loss — not pending any more, the workspace authority epoch moved, or the requester's token snapshot expired.
 */
export type ValidityHint = 'CURRENT' | 'NOT_PENDING' | 'AUTHORITY_CHANGED' | 'SIGNER_EXPIRED';

/** Safe public summary: local IDs, statuses, times, hashes/versions, hints. No bodies, customer/token IDs, refs or digests. */
export interface ActionRequestSummary {
  requestId: string; state: RequestState; actionType: string; actionVersion: string; policyVersion: string; portVersion: string;
  mode: typeof ACTION_MODE; inputHash: string; authorityEpoch: number; createdAt: string; updatedAt: string;
  validity: ValidityHint; synthetic: true;
}
export interface ActionPreviewResult { requestId: string; inputHash: string; idempotent: boolean; validity: ValidityHint; synthetic: true }
export interface ActionRequestResult extends ActionRequestSummary { idempotent: boolean }
export interface ActionListPage { items: ActionRequestSummary[]; nextCursor: string | null; synthetic: true }
/** Approve/reject/revoke/cancel result: local IDs, states, times and hashes only (no body, customer, token or file path). */
export interface ActionDecisionResult {
  requestId: string; state: RequestState; inputHash: string; authorityEpoch: number; approvalId: string | null;
  decision: ApprovalDecision | null; decidedAt: string | null; expiresAt: string | null; idempotent: boolean; synthetic: true;
}
/** Public reservation result. The attempt token, create nonce, binding and content stay in the private permit. */
export interface ActionReservationResult {
  requestId: string; state: 'DISPATCH_RESERVED'; inputHash: string; authorityEpoch: number; approvalId: string; attemptId: string;
  reservedAt: string; startDeadlineAt: string; synthetic: true;
}

export type AttemptState = 'RESERVED' | 'NOT_DISPATCHED' | 'UNKNOWN' | 'CREATED' | 'VERIFIED' | 'MISMATCH';
export type VerificationState = 'IDLE' | 'ACTIVE' | 'FAILED' | 'ABANDONED' | 'VERIFIED' | 'MISMATCH';
/**
 * Safe execution summary (S3-C): local IDs, states, times, counts and fixed codes. Never a ticket ID (original, candidate
 * or verified), customer key, title/body, token, nonce or create nonce. `recoveryRequired`: an expired ACTIVE claim or a
 * RESERVED attempt past its grace awaits an explicit action-recover.
 */
export interface ActionExecutionSummary {
  requestId: string; state: RequestState; inputHash: string; attemptId: string; attemptState: AttemptState; reservedAt: string;
  outcomeAt: string | null; verificationCount: number; verificationBudget: number; verificationState: VerificationState;
  activeVerificationOrdinal: number | null; safeErrorCode: string | null; recoveryRequired: boolean; synthetic: true;
}
/** action-execute: the reservation, the create outcome and the separately authorized initial read (ordinal 1), if any. */
export interface ActionExecutionResult extends ActionExecutionSummary {
  approvalId: string; startDeadlineAt: string;
  /** Fixed code of the initial read when it was refused or failed (no read happened when its admission refused). */
  verificationCode: ActionErrorCode | null;
}
/** action-verify: the stored outcome after this ordinal (or the VERIFIED replay with zero read). */
export interface ActionVerificationResult extends ActionExecutionSummary {
  ordinal: number | null; targetKind: 'ORIGINAL' | 'CANDIDATE' | null; verificationResult: 'VERIFIED' | 'MISMATCH' | 'FAILED' | 'STALE' | null;
  idempotent: boolean;
}
/** action-recover: what the explicit recovery did (never a dispatch, never a refund). */
export interface ActionRecoveryResult extends ActionExecutionSummary {
  recovered: 'OUTCOME_UNKNOWN' | 'CLAIM_ABANDONED' | 'NONE';
}
