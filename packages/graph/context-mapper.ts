import type { Scope, ClientContextV1, ObservationPage, ObservationStatus, ObservationSummary, ResourceView, Person, Device, ExternalLink, Severity, System, ResourceType, EventKind, Domain, Priority, Route, Provider, EntityKind, LinkStatus } from '../core/contracts.ts';
import { emptyCounts, isM365ResourceType, severities, severityRank } from '../core/contracts.ts';

// Row shapes as selected by packages/graph/prisma-context.ts. Kept free of Prisma imports so the mapping is unit-tested
// without a generated client and so the API contract never depends on the storage shape.
export interface DbLinkRow { id: string; status: string; external: { externalId: string; resourceType: string; connection: { id: string; system: string; status: string } } }
export interface DbEntityRow {
  id: string; kind: string;
  person: { displayName: string; email: string | null } | null;
  device: { hostname: string; personId: string | null } | null;
  links: DbLinkRow[];
}
export interface DbSnapshotRow { asOf: Date | string; items: unknown; itemCount: number; truncated: boolean }
export interface DbSyncStateRow {
  resourceType: string; status: string; lastSyncAt: Date | string | null; lastSuccessAt: Date | string | null; safeErrorCode: string | null;
  snapshot?: DbSnapshotRow | null;
}
export interface DbConnectionRow { id: string; system: string; status: string; syncStates: DbSyncStateRow[] }
export interface DbClientGraph { id: string; name: string; entities: DbEntityRow[]; connections: DbConnectionRow[] }
export interface DbObservationRow {
  id: string; eventId: string; entityId: string | null; decisionRunId: string | null; domain: string; severity: string; priority: string; route: string;
  confidence: number; provider: string; reasonCodes: string[]; createdAt: Date | string; updatedAt: Date | string;
  status: string; acknowledgedAt: Date | string | null; resolvedAt: Date | string | null; supersededById: string | null;
  event: { eventKey: string; conflictOfEventKey: string | null; connectionId: string; resourceType: string; externalEventId: string; revision: string; occurredAt: Date | string;
    normalized: unknown; connection: { system: string } };
}
export interface DbObservationStats { total: number; bySeverity: { severity: string; count: number }[] }

/**
 * Freshness window per live resource — Atlas configuration, versioned with the code. A snapshot older than this, or one
 * whose latest refresh failed, is STALE: shown with its asOf, never presented as the current state.
 */
export const RESOURCE_MAX_AGE_MS: Readonly<Partial<Record<ResourceType, number>>> = Object.freeze({ alert: 15 * 60_000, incident: 15 * 60_000, ticket: 30 * 60_000 });

/** Resource types Stage 1 expects per system. A connection without a sync state for one of them reports MISSING. */
export const expectedResources: Record<System, ResourceType[]> = {
  atera: ['alert', 'ticket'], huntress: ['incident'], microsoft365: [], poweroffice: []
};

const iso = (v: Date | string | null | undefined): string | null => v == null ? null : (v instanceof Date ? v.toISOString() : String(v));
const asSystem = (s: string): System => (['atera', 'huntress', 'microsoft365', 'poweroffice'].includes(s) ? s : 'atera') as System;

export function mapObservationRow(scope: Scope, row: DbObservationRow): ObservationSummary {
  const normalized = (row.event.normalized && typeof row.event.normalized === 'object' ? row.event.normalized : {}) as Record<string, unknown>;
  const kind: EventKind = normalized.kind === 'SECURITY_INCIDENT' ? 'SECURITY_INCIDENT' : 'DISK_CAPACITY';
  return { workspaceId: scope.workspaceId, clientId: scope.clientId, id: row.id, eventKey: row.event.eventKey,
    source: asSystem(row.event.connection.system), connectionId: row.event.connectionId, resourceType: row.event.resourceType as ResourceType,
    externalEventId: row.event.externalEventId, revision: row.event.revision, entityId: row.entityId, decisionRunId: row.decisionRunId, kind,
    domain: row.domain as Domain, severity: row.severity as Severity, priority: row.priority as Priority, route: row.route as Route,
    confidence: row.confidence, provider: row.provider as Provider, reasonCodes: [...row.reasonCodes], conflictOfEventKey: row.event.conflictOfEventKey ?? null,
    status: row.status as ObservationStatus, acknowledgedAt: iso(row.acknowledgedAt), resolvedAt: iso(row.resolvedAt), supersededById: row.supersededById,
    summary: typeof normalized.summary === 'string' ? normalized.summary.slice(0, 300) : '',
    occurredAt: iso(row.event.occurredAt) ?? '', createdAt: iso(row.createdAt) ?? '', updatedAt: iso(row.updatedAt) ?? '' };
}

/**
 * One ResourceView per connection × expected resource (task 1.5 snapshot repository):
 *   no sync state → MISSING (SYNC_NOT_CONFIGURED); UNAVAILABLE → MISSING with the source's reason (no tenant-scoped read);
 *   PENDING (a first read began, no outcome recorded yet) → MISSING (SYNC_NOT_COMPLETED);
 *   no complete read yet → ERROR with the failure code; fresh snapshot after a successful refresh → OK;
 *   snapshot older than the freshness window, or latest refresh failed → STALE with the last snapshot and its asOf.
 * Items are present only for OK and STALE; a resource is never reported as an empty list it did not read.
 */
export function mapResources(connections: DbConnectionRow[], now: Date = new Date()): ResourceView[] {
  const views: ResourceView[] = [];
  for (const connection of connections) {
    const system = asSystem(connection.system);
    for (const resourceType of expectedResources[system]) {
      const sync = connection.syncStates.find(s => s.resourceType === resourceType);
      const view = (status: ResourceView['status'], safeErrorCode: string | null, snapshot: DbSnapshotRow | null = null): ResourceView => ({
        source: system, resourceType, connectionId: connection.id, status, asOf: snapshot ? iso(snapshot.asOf) : null,
        lastSuccessAt: iso(sync?.lastSuccessAt), safeErrorCode, items: snapshot && Array.isArray(snapshot.items) ? snapshot.items : null,
        truncated: snapshot ? snapshot.truncated : false });
      const snapshot = sync?.snapshot ?? null;
      if (!sync) views.push(view('MISSING', 'SYNC_NOT_CONFIGURED'));
      else if (sync.status === 'UNAVAILABLE') views.push(view('MISSING', sync.safeErrorCode ?? 'SOURCE_UNAVAILABLE'));
      else if (sync.status === 'PENDING') views.push(view('MISSING', 'SYNC_NOT_COMPLETED'));
      else if (!snapshot) views.push(sync.status === 'ERROR' ? view('ERROR', sync.safeErrorCode ?? 'SYNC_ERROR') : view('MISSING', 'SNAPSHOT_MISSING'));
      else if (!Array.isArray(snapshot.items)) views.push(view('ERROR', 'SNAPSHOT_INVALID'));
      else {
        const age = now.getTime() - new Date(snapshot.asOf).getTime();
        const fresh = age <= (RESOURCE_MAX_AGE_MS[resourceType] ?? 0);
        if (sync.status === 'OK' && fresh) views.push(view('OK', null, snapshot));
        else views.push(view('STALE', sync.status === 'ERROR' ? sync.safeErrorCode ?? 'SYNC_ERROR' : 'SNAPSHOT_STALE', snapshot));
      }
    }
  }
  return views;
}

/** Items in priority order (severityRank DESC, createdAt DESC, id); counts and total cover the whole selected set. */
export function mapObservationPage(scope: Scope, observations: DbObservationRow[], stats: DbObservationStats, nextCursor: string | null): ObservationPage {
  const counts = emptyCounts();
  for (const { severity, count } of stats.bySeverity) if ((severities as readonly string[]).includes(severity)) counts[severity as Severity] = count;
  const items = observations.map(row => mapObservationRow(scope, row))
    .sort((a, b) => severityRank[b.severity] - severityRank[a.severity] || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  return { items, counts, total: stats.total, truncated: nextCursor !== null, nextCursor };
}

export function mapClientContext(scope: Scope, graph: DbClientGraph, observations: DbObservationRow[], stats: DbObservationStats, nextCursor: string | null,
  now: Date = new Date()): ClientContextV1 {
  const people: Person[] = []; const devices: Device[] = []; const links: ExternalLink[] = [];
  for (const entity of graph.entities) {
    if (entity.kind === 'PERSON' && entity.person) people.push({ ...scope, id: entity.id, displayName: entity.person.displayName, email: entity.person.email });
    if (entity.kind === 'DEVICE' && entity.device) devices.push({ ...scope, id: entity.id, hostname: entity.device.hostname, personId: entity.device.personId });
    for (const link of entity.links) {
      // Second guard behind the query filter (prisma-context.ts): no M365 link ever reaches the V1 projection.
      if (isM365ResourceType(link.external.resourceType) || link.external.connection.system === 'microsoft365') continue;
      links.push({ ...scope, connectionId: link.external.connection.id, system: asSystem(link.external.connection.system),
        resourceType: link.external.resourceType as ResourceType, externalId: link.external.externalId, entityId: entity.id,
        entityKind: entity.kind as EntityKind, status: link.status as LinkStatus });
    }
  }
  const resources = mapResources(graph.connections, now);
  return { ...scope, contractVersion: 'ClientContextV1', mode: 'db', clientName: graph.name, people, devices, links,
    observations: mapObservationPage(scope, observations, stats, nextCursor), resources, generatedAt: now.toISOString(),
    completeness: resources.length > 0 && resources.every(r => r.status === 'OK') ? 'COMPLETE' : 'PARTIAL' };
}
