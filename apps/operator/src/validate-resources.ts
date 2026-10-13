// ResourceView and its reviewed item shapes (docs/stage5/02_CONTRACTS.md, Display only these item shapes). DOM-free.
// Shared by the context resources and the evidence result. Items are copied field by field: never facts, externalDevice,
// receivedAt, safeErrorCode or any additive field. Unknown shapes are RESPONSE_INVALID, never displayed as raw JSON.
import { CONTEXT_RESOURCE_TYPES, CONTEXT_SYSTEMS, EVENT_KINDS, LIMITS, RESOURCE_STATUSES, SCOPE_ID_PATTERN, SEVERITIES } from './contracts.ts';
import type { ContextMode, FixtureEventView, FixtureTicketView, SnapshotItemView, StoredItem, StoredRead } from './contracts.ts';
import { inScope } from './validate-observations.ts';
import type { Scope } from './validate-observations.ts';
import {
  array, boolean, fail, identifier, matching, nullableOneOf, nullableString, nullableTime, object, oneOf, string, time
} from './validate-core.ts';

interface ResourceKey { readonly source: string; readonly resourceType: string; readonly connectionId: string | null }

/** DB SnapshotItem. `status` is the source's own free text (bounded by the response cap), not an Atlas enum. */
function snapshotItem(raw: unknown, view: ResourceKey): SnapshotItemView {
  const row = object(raw);
  if (row.source !== view.source || row.resourceType !== view.resourceType) fail();
  let device: SnapshotItemView['device'] = null;
  if (row.device !== null) {
    const ref = object(row.device);
    device = Object.freeze({ resourceType: oneOf(ref.resourceType, CONTEXT_RESOURCE_TYPES), externalId: identifier(ref.externalId) });
  }
  return Object.freeze({ shape: 'snapshot', externalId: identifier(row.externalId), title: string(row.title), status: string(row.status),
    severity: nullableOneOf(row.severity, SEVERITIES), priority: nullableString(row.priority), device,
    occurredAt: nullableTime(row.occurredAt), updatedAt: nullableTime(row.updatedAt) });
}
/** FIXTURE normalized alert/incident: its scope and source tuple must be the resource's. facts/externalDevice are not read. */
function fixtureEvent(raw: unknown, view: ResourceKey, scope: Scope): FixtureEventView {
  const row = object(raw); inScope(row, scope);
  if (row.source !== view.source || row.connectionId !== view.connectionId || row.resourceType !== view.resourceType) fail();
  return Object.freeze({ shape: 'fixture-event', externalEventId: identifier(row.externalEventId), revision: string(row.revision),
    kind: oneOf(row.kind, EVENT_KINDS), summary: string(row.summary), sourceSeverity: oneOf(row.sourceSeverity, SEVERITIES), occurredAt: time(row.occurredAt) });
}
/** FIXTURE ticket: id/title/status only; no normalized-event envelope is invented for it. */
function fixtureTicket(raw: unknown): FixtureTicketView {
  const row = object(raw);
  return Object.freeze({ shape: 'fixture-ticket', id: identifier(row.id), title: string(row.title), status: string(row.status) });
}

/**
 * ResourceView. Items are present exactly for OK/STALE/FIXTURE; FIXTURE status belongs to fixture mode only and the other
 * statuses to db mode, so a synthetic resource can never be presented as a database read or the reverse.
 */
export function validateResource(raw: unknown, mode: ContextMode, scope: Scope): StoredRead {
  const row = object(raw);
  const source = oneOf(row.source, CONTEXT_SYSTEMS);
  const resourceType = oneOf(row.resourceType, CONTEXT_RESOURCE_TYPES);
  const connectionId = row.connectionId === null ? null : matching(row.connectionId, SCOPE_ID_PATTERN);
  const status = oneOf(row.status, RESOURCE_STATUSES);
  const asOf = nullableTime(row.asOf); const lastSuccessAt = nullableTime(row.lastSuccessAt);
  nullableString(row.safeErrorCode);
  const truncated = boolean(row.truncated);
  if ((status === 'FIXTURE') !== (mode === 'fixture')) fail();
  const key = { source, resourceType, connectionId };
  let items: StoredItem[] | null = null;
  if (status === 'OK' || status === 'STALE' || status === 'FIXTURE') {
    items = array(row.items, LIMITS.resourceItems).map(item => {
      if (mode === 'db') return snapshotItem(item, key);
      if ((source === 'atera' && resourceType === 'alert') || (source === 'huntress' && resourceType === 'incident')) return fixtureEvent(item, key, scope);
      if (source === 'atera' && resourceType === 'ticket') return fixtureTicket(item);
      return fail();
    });
  } else if (row.items !== null) fail();
  return Object.freeze({ source, resourceType, connectionId, status, asOf, lastSuccessAt, truncated, items: items && Object.freeze(items) });
}

/** The stored ID an item is identified by: DB externalId, fixture normalized externalEventId, fixture ticket id. */
export function storedId(item: StoredItem): string {
  return item.shape === 'snapshot' ? item.externalId : item.shape === 'fixture-event' ? item.externalEventId : item.id;
}
