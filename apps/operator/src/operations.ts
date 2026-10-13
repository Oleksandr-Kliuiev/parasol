// The only HTTP operations of the console, relative to this origin (docs/stage5/02_CONTRACTS.md). DOM-free.
// No caller-controlled URL, method, header, tool name or parameter exists: each operation is a closed typed value whose IDs
// are validated unshortened and percent-encoded into a fixed path, query or body. Anything malformed yields null (no request).
import { CURSOR_PATTERN, EXTERNAL_ID_PATTERN, REQUEST_ID_PATTERN, SCOPE_ID_PATTERN } from './contracts.ts';
import { ASK_LIMITS, UUID_V4, policyVersionValid, questionProblem } from './ask-contracts.ts';
import { queueQuery } from './queue-query.ts';
import type { QueueQuery } from './contracts.ts';

/** DB queue page request; a fixture queue is `null` (fixed demo page, no query at all). */
export interface ObservationQuery { readonly query: QueueQuery; readonly cursor: string | null }
export type GetOperation =
  | { readonly kind: 'clients' }
  | { readonly kind: 'overview'; readonly clientId: string }
  | { readonly kind: 'observations'; readonly clientId: string; readonly page: ObservationQuery | null }
  /** Ask Atlas capability discovery (docs/stage5/ask/02): fixed path, no query, no body. */
  | { readonly kind: 'askCapability' };

/** The one Ask question (AskRequestV1): captured client path, fresh UUIDv4, the question as typed, optional exact focus. */
export interface AskOperation { readonly clientId: string; readonly requestId: string; readonly question: string; readonly observationId: string | null }

/** The closed evidence allowlist: tool and parameter names are fixed here, values come from a validated selection. */
export type EvidenceOperation =
  | { readonly tool: 'atera.alert.list'; readonly clientId: string; readonly connectionId: string; readonly requestId: string }
  | { readonly tool: 'atera.ticket.get'; readonly clientId: string; readonly connectionId: string; readonly ticketId: string; readonly requestId: string }
  | { readonly tool: 'huntress.incident.get'; readonly clientId: string; readonly connectionId: string; readonly incidentId: string; readonly requestId: string };

const scopeId = (value: string) => SCOPE_ID_PATTERN.test(value);
const sourceId = (value: string) => EXTERNAL_ID_PATTERN.test(value);

function observationsQuery(page: ObservationQuery): string | null {
  const query = queueQuery(page.query.statuses, page.query.severities, page.query.limit);
  if (!query || (page.cursor !== null && !CURSOR_PATTERN.test(page.cursor))) return null;
  const params = new URLSearchParams({ status: query.statuses.join(','), severity: query.severities.join(','), limit: String(query.limit) });
  if (page.cursor !== null) params.set('cursor', page.cursor);
  return params.toString();
}

/** Origin-relative path of a GET operation; null when an ID or query value is malformed (no request is made). */
export function operationPath(operation: GetOperation): string | null {
  switch (operation.kind) {
    case 'clients': return '/clients';
    case 'overview': return scopeId(operation.clientId) ? `/clients/${encodeURIComponent(operation.clientId)}/overview` : null;
    case 'observations': {
      if (!scopeId(operation.clientId)) return null;
      const path = `/clients/${encodeURIComponent(operation.clientId)}/observations`;
      if (operation.page === null) return path;
      const query = observationsQuery(operation.page);
      return query === null ? null : `${path}?${query}`;
    }
    case 'askCapability': return '/ask/capabilities';
    default: return null;
  }
}

/** Origin-relative path of the Ask question of one client; null for a malformed client ID (no request is made). */
export function askPath(clientId: string): string | null {
  return scopeId(clientId) ? `/clients/${encodeURIComponent(clientId)}/ask` : null;
}

/**
 * The operator's explicit declaration for ONE remote question (docs/stage5/ask/remote/02 "Remote request exact DTO"): the
 * admission tuple of the disclosure they consented to, captured at that submit. It carries no authority. It is never defaulted
 * or added here: a remote operation without exactly this value sends nothing.
 */
export interface AskAcknowledgement {
  readonly contractVersion: 'AskRemoteDisclosureV1'; readonly admissionId: string; readonly policyVersion: string; readonly questionDataClass: 'SYNTHETIC';
}
/** The one REMOTE question (AskRequestV2): the V1 fields with the same rules plus the captured acknowledgement. */
export interface AskRemoteOperation extends AskOperation { readonly acknowledgement: AskAcknowledgement }

/** V1 field rules shared by both versions: canonical UUIDv4, question unchanged and valid, focus null or 1..256 characters. */
function questionFields(operation: AskOperation): boolean {
  if (!UUID_V4.test(operation.requestId) || questionProblem(operation.question) !== null) return false;
  const focus = operation.observationId;
  return focus === null || (typeof focus === 'string' && focus.length > 0 && focus.length <= ASK_LIMITS.observationIdLength);
}
const withinRequestBytes = (body: string): string | null => new TextEncoder().encode(body).byteLength <= ASK_LIMITS.requestBytes ? body : null;

/**
 * Exact AskRequestV1 JSON `{contractVersion, requestId, question, observationId}` as ordinary UTF-8, or null when any value
 * is malformed: requestId a canonical lowercase UUIDv4, the question accepted unchanged (never trimmed or truncated), the
 * focus null or a non-empty ID of at most 256 characters used unshortened, and the whole body within 16 KiB.
 */
export function askBody(operation: AskOperation): string | null {
  if (!questionFields(operation)) return null;
  return withinRequestBytes(JSON.stringify({ contractVersion: 'AskRequestV1', requestId: operation.requestId, question: operation.question,
    observationId: operation.observationId }));
}

const ACK_KEYS = ['contractVersion', 'admissionId', 'policyVersion', 'questionDataClass'];
/**
 * Exact AskRequestV2 JSON `{contractVersion, requestId, question, observationId, acknowledgement}` or null: the V1 field rules,
 * and an acknowledgement that is exactly the four-key operator declaration (lowercase UUIDv4 admission, canonical decimal
 * policyVersion string, SYNTHETIC). Its values are copied as given, never supplied or repaired here; within 16 KiB.
 */
export function askRemoteBody(operation: AskRemoteOperation): string | null {
  const ack: unknown = operation.acknowledgement;
  if (!questionFields(operation) || ack === null || typeof ack !== 'object' || Array.isArray(ack)) return null;
  const a = ack as Record<string, unknown>;
  if (Object.keys(a).length !== ACK_KEYS.length || !ACK_KEYS.every(key => Object.hasOwn(a, key))) return null;
  if (a.contractVersion !== 'AskRemoteDisclosureV1' || a.questionDataClass !== 'SYNTHETIC' || typeof a.admissionId !== 'string'
    || !UUID_V4.test(a.admissionId) || !policyVersionValid(a.policyVersion)) return null;
  return withinRequestBytes(JSON.stringify({ contractVersion: 'AskRequestV2', requestId: operation.requestId, question: operation.question,
    observationId: operation.observationId, acknowledgement: { contractVersion: 'AskRemoteDisclosureV1', admissionId: a.admissionId,
      policyVersion: a.policyVersion, questionDataClass: 'SYNTHETIC' } }));
}

export const EVIDENCE_PATH = '/tools/execute';

/** Exact JSON body `{version, clientId, tool, parameters, requestId}` of an evidence read, or null when any value is malformed. */
export function evidenceBody(operation: EvidenceOperation): string | null {
  if (!scopeId(operation.clientId) || !scopeId(operation.connectionId) || !REQUEST_ID_PATTERN.test(operation.requestId)) return null;
  let parameters: Record<string, string>;
  switch (operation.tool) {
    case 'atera.alert.list': parameters = { connectionId: operation.connectionId }; break;
    case 'atera.ticket.get':
      if (!sourceId(operation.ticketId)) return null;
      parameters = { connectionId: operation.connectionId, ticketId: operation.ticketId }; break;
    case 'huntress.incident.get':
      if (!sourceId(operation.incidentId)) return null;
      parameters = { connectionId: operation.connectionId, incidentId: operation.incidentId }; break;
    default: return null;
  }
  return JSON.stringify({ version: '1', clientId: operation.clientId, tool: operation.tool, parameters, requestId: operation.requestId });
}
