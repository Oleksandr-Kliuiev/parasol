// ObservationSummary / ObservationPage (packages/core/contracts.ts) for the context page and the standalone queue. DOM-free.
// The whole page is validated before anything is returned; the result is an explicit projection in server order.
import {
  ACTIVE_OBSERVATION_STATUSES, CONTEXT_RESOURCE_TYPES, CURSOR_PATTERN, DOMAINS, EVENT_KINDS, LIMITS, PRIORITIES, PROVIDERS, ROUTES, SEVERITIES, SYSTEMS
} from './contracts.ts';
import type { ContextMode, ObservationItem, ObservationStatus, QueuePage, QueueQuery, Severity } from './contracts.ts';
import {
  array, boolean, count, fail, identifier, nullableIdentifier, nullableString, nullableTime, object, oneOf, string, time, unitInterval
} from './validate-core.ts';
import type { Json } from './validate-core.ts';

export interface Scope { readonly workspaceId: string; readonly clientId: string }
export const inScope = (row: Json, scope: Scope): void => {
  if (row.workspaceId !== scope.workspaceId || row.clientId !== scope.clientId) fail();
};

/**
 * One ObservationSummary of the captured scope with a status from `statuses`. Source references (connectionId,
 * externalEventId) are typed text here; their request formats are checked by the evidence plan, where an invalid reference
 * is a visible evidence-unavailable state, not a queue failure.
 */
function observation(raw: unknown, scope: Scope, statuses: readonly ObservationStatus[]): ObservationItem {
  const row = object(raw); inScope(row, scope);
  const reasonCodes = array(row.reasonCodes, LIMITS.reasonCodes).map(string);
  return Object.freeze({
    id: identifier(row.id), eventKey: identifier(row.eventKey), source: oneOf(row.source, SYSTEMS), connectionId: string(row.connectionId),
    resourceType: oneOf(row.resourceType, CONTEXT_RESOURCE_TYPES), externalEventId: string(row.externalEventId), revision: string(row.revision),
    entityId: nullableIdentifier(row.entityId), decisionRunId: nullableIdentifier(row.decisionRunId), kind: oneOf(row.kind, EVENT_KINDS),
    domain: oneOf(row.domain, DOMAINS), severity: oneOf(row.severity, SEVERITIES), priority: oneOf(row.priority, PRIORITIES),
    route: oneOf(row.route, ROUTES), confidence: unitInterval(row.confidence), provider: oneOf(row.provider, PROVIDERS),
    reasonCodes: Object.freeze(reasonCodes), conflictOfEventKey: nullableString(row.conflictOfEventKey), status: oneOf(row.status, statuses),
    acknowledgedAt: nullableTime(row.acknowledgedAt), resolvedAt: nullableTime(row.resolvedAt), supersededById: nullableIdentifier(row.supersededById),
    summary: string(row.summary), occurredAt: time(row.occurredAt), createdAt: time(row.createdAt), updatedAt: time(row.updatedAt)
  });
}

/**
 * Selection a page must satisfy. Fixture: the fixed demo page (active statuses, at most 100, never a cursor or truncation).
 * DB: every item within the captured statuses/severities and at most the requested limit. Server order is kept as is.
 */
export type PageSelection = { readonly mode: 'fixture' } | { readonly mode: 'db'; readonly query: QueueQuery | null };

export function validatePage(value: unknown, scope: Scope, selection: PageSelection): QueuePage {
  const page = object(value);
  const query = selection.mode === 'db' ? selection.query : null;
  const items = array(page.items, LIMITS.queueItems);
  if (query && items.length > query.limit) fail();
  // A fixture page and the context page list active observations only; a DB queue page lists exactly the selected statuses.
  const statuses = query ? query.statuses : ACTIVE_OBSERVATION_STATUSES;
  const projected = items.map(raw => observation(raw, scope, statuses));
  const ids = new Set(projected.map(o => o.id));
  if (ids.size !== projected.length) fail();
  if (query && projected.some(o => !query.severities.includes(o.severity))) fail();
  const rawCounts = object(page.counts);
  const counts = {} as Record<Severity, number>;
  for (const severity of SEVERITIES) counts[severity] = count(rawCounts[severity]);
  const total = count(page.total);
  if (total < projected.length) fail();
  const truncated = boolean(page.truncated);
  const nextCursor = page.nextCursor === null ? null : string(page.nextCursor);
  if (nextCursor !== null && !CURSOR_PATTERN.test(nextCursor)) fail();
  if (selection.mode === 'fixture' && (truncated || nextCursor !== null)) fail();
  return Object.freeze({ mode: selection.mode, items: Object.freeze(projected), counts: Object.freeze(counts), total, truncated, nextCursor });
}

/** The context's own observation page: active statuses only, mode-specific paging rules, validated but not retained. */
export function validateContextPage(value: unknown, scope: Scope, mode: ContextMode): void {
  validatePage(value, scope, mode === 'fixture' ? { mode } : { mode, query: null });
}
