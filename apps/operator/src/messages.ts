// Fixed user-facing text. DOM-free. No server text, body or exception message is ever shown; only these strings and
// the fixed failure code. Mode labels describe the actual contract value and never imply LIVE or production data.
import type { Completeness, ContextMode, EvidenceTool, FailureCode, ResourceStatus, Severity } from './contracts.ts';
import type { EvidenceUnavailable } from './evidence-plan.ts';
import type { SessionNotice } from './state.ts';

export const NOTICE_TEXT: Record<SessionNotice, string> = {
  TOKEN_FORMAT: 'That token is not in the accepted format. Nothing was sent.',
  UNAUTHORIZED: 'The API did not accept the token. You are disconnected and all loaded data was cleared.',
  DISCONNECTED: 'Disconnected. The token and all loaded data were cleared from this page. The token itself is not revoked.',
  PAGE_HIDDEN: 'The page was left or hidden, so the session was cleared. Enter the token again to continue.',
  ORIGIN_REFUSED: 'Token entry is only available at http://127.0.0.1:<port>/operator/ served by the local Atlas API.'
};

export const FAILURE_TEXT: Record<FailureCode, string> = {
  UNAUTHORIZED: 'The API did not accept the token.',
  FORBIDDEN: 'The API refused access.',
  NETWORK: 'The local API could not be reached or the request was interrupted.',
  TIMEOUT: 'The request did not complete within 10 seconds. Nothing was retried.',
  HTTP_ERROR: 'The API answered with an error.',
  RESPONSE_INVALID: 'The response did not match the expected contract and was discarded.',
  RESPONSE_TOO_LARGE: 'The response exceeded this console\'s size limits and was discarded.'
};

export const MODE_LABEL: Record<ContextMode, string> = {
  fixture: 'Synthetic fixture context',
  db: 'Database-backed context'
};

export const SCOPE_DENIED_TEXT = 'The API refused access to the previously selected client. Its data was cleared and the client list was reloaded once.';

export const COMPLETENESS_TEXT: Record<Completeness, string> = {
  COMPLETE_FIXTURE: 'Complete synthetic fixture',
  COMPLETE: 'Complete: every stored source read is current',
  PARTIAL: 'Partial: at least one stored source read is stale, failed or missing'
};

/** Stored read status, always as text next to the affected resource or evidence (never colour alone). */
export const READ_STATUS_TEXT: Record<ResourceStatus, string> = {
  OK: 'Stored read within its freshness limit',
  STALE: 'STALE stored read: older than its freshness limit or its last refresh failed',
  ERROR: 'Stored read unavailable (ERROR). This is not an empty result.',
  MISSING: 'No stored read available (MISSING). This is not an empty result.',
  FIXTURE: 'Synthetic fixture data, not a source read'
};
export const NOT_ATOMIC_TEXT = 'Overview, queue and evidence are separate reads with their own times; they are not one atomic snapshot.';
export const EMPTY_READ_TEXT = 'No stored items in this read.';
export const TRUNCATED_READ_TEXT = 'This stored read was bounded (truncated): more source items exist than it holds.';

export const FIXTURE_QUEUE_TEXT = 'Fixed synthetic demo page: all active (open and acknowledged) observations, at most 100. This demo has no filters or pagination.';
export const COUNTS_TEXT = 'Counts and total describe this response\'s selection only; they are not a stable snapshot and can change between requests.';
export const QUEUE_SELECTION_REFUSED = 'Choose at least one status and one severity. Nothing was sent.';

export const CONFIDENCE_NOTE = 'explanatory only; it never lowers source urgency';
export const urgentText = (severity: Severity): string => `Urgent: source severity ${severity}`;
export const URGENT_DETAIL = 'Source HIGH/CRITICAL stays urgent regardless of confidence, route or priority label.';

export const ENTITY_TEXT = {
  UNRESOLVED: 'Unresolved: this observation is not linked to a known person or device.',
  UNAVAILABLE: 'Reference unavailable: this context cannot confirm the stored entity reference. Nothing is inferred from names or hostnames.',
  PERSON_UNAVAILABLE: 'stored person reference unavailable in this context'
} as const;

export const EVIDENCE_TOOL_LABEL: Record<EvidenceTool, string> = {
  'atera.alert.list': 'Read the stored Atera alert list and find this alert',
  'atera.ticket.get': 'Read this stored Atera ticket',
  'huntress.incident.get': 'Read this stored Huntress incident'
};
export const EVIDENCE_UNAVAILABLE_TEXT: Record<EvidenceUnavailable, string> = {
  FIXTURE_HUNTRESS: 'Stored Huntress incident lookup is not available in this synthetic demo. No request is made, and this says nothing about whether the incident exists.',
  UNSUPPORTED: 'This console has no stored-evidence read for this source and type; no request is made.',
  INVALID_REFERENCE: 'The stored source reference is not in an accepted format, so evidence is unavailable. No request is made.'
};
export const EVIDENCE_NOT_FOUND = 'Not in this stored read.';
export const EVIDENCE_NOT_FOUND_TRUNCATED = 'Not in this stored read. The read was bounded (truncated), so the object may exist beyond it.';
export const EVIDENCE_HINT = 'Reads only what Atlas already stored, through the API tool gateway (recorded in its tool execution log). No source system is contacted.';
