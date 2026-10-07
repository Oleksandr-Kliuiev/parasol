import type { Scope, ClientContextV1, ObservationSummary, ResourceView, Person, Device, ExternalLink, Severity, System, ResourceType, EventKind, Domain, Priority, Route, Provider, EntityKind, LinkStatus } from '../core/contracts.ts';
import { emptyCounts, severities, severityRank } from '../core/contracts.ts';

// Row shapes as selected by packages/graph/prisma-context.ts. Kept free of Prisma imports so the mapping is unit-tested
// without a generated client and so the API contract never depends on the storage shape.
export interface DbLinkRow { id: string; status: string; external: { externalId: string; resourceType: string; connection: { id: string; system: string; status: string } } }
export interface DbEntityRow {
  id: string; kind: string;
  person: { displayName: string; email: string | null } | null;
  device: { hostname: string; personId: string | null } | null;
  links: DbLinkRow[];
}
export interface DbSyncStateRow { resourceType: string; status: string; lastSyncAt: Date | string | null; lastSuccessAt: Date | string | null; safeErrorCode: string | null }
export interface DbConnectionRow { id: string; system: string; status: string; syncStates: DbSyncStateRow[] }
export interface DbClientGraph { id: string; name: string; entities: DbEntityRow[]; connections: DbConnectionRow[] }
export interface DbObservationRow {
  id: string; eventId: string; entityId: string | null; domain: string; severity: string; priority: string; route: string;
  confidence: number; provider: string; reasonCodes: string[]; createdAt: Date | string;
  event: { eventKey: string; conflictOfEventKey: string | null; connectionId: string; resourceType: string; externalEventId: string; revision: string; occurredAt: Date | string;
    normalized: unknown; connection: { system: string } };
}
export interface DbObservationStats { total: number; bySeverity: { severity: string; count: number }[] }

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
    source: asSystem(row.event.connection.system), resourceType: row.event.resourceType as ResourceType,
    externalEventId: row.event.externalEventId, revision: row.event.revision, entityId: row.entityId, kind,
    domain: row.domain as Domain, severity: row.severity as Severity, priority: row.priority as Priority, route: row.route as Route,
    confidence: row.confidence, provider: row.provider as Provider, reasonCodes: [...row.reasonCodes], conflictOfEventKey: row.event.conflictOfEventKey ?? null,
    summary: typeof normalized.summary === 'string' ? normalized.summary.slice(0, 300) : '',
    occurredAt: iso(row.event.occurredAt) ?? '', createdAt: iso(row.createdAt) ?? '' };
}

export function mapResources(connections: DbConnectionRow[]): ResourceView[] {
  const views: ResourceView[] = [];
  for (const connection of connections) {
    const system = asSystem(connection.system);
    for (const resourceType of expectedResources[system]) {
      const sync = connection.syncStates.find(s => s.resourceType === resourceType);
      if (!sync) {
        views.push({ source: system, resourceType, connectionId: connection.id, status: 'MISSING', asOf: null, lastSuccessAt: null, safeErrorCode: 'SYNC_NOT_CONFIGURED', items: null, truncated: false });
      } else if (sync.status === 'ERROR') {
        views.push({ source: system, resourceType, connectionId: connection.id, status: 'ERROR', asOf: iso(sync.lastSuccessAt), lastSuccessAt: iso(sync.lastSuccessAt), safeErrorCode: sync.safeErrorCode ?? 'SYNC_ERROR', items: null, truncated: false });
      } else {
        // Sync metadata exists but no snapshot repository yet (task 1.5): say so instead of returning an empty list.
        views.push({ source: system, resourceType, connectionId: connection.id, status: 'MISSING', asOf: iso(sync.lastSuccessAt), lastSuccessAt: iso(sync.lastSuccessAt), safeErrorCode: 'SNAPSHOT_REPOSITORY_PENDING', items: null, truncated: false });
      }
    }
  }
  return views;
}

export function mapClientContext(scope: Scope, graph: DbClientGraph, observations: DbObservationRow[], stats: DbObservationStats, limit: number, now: Date = new Date()): ClientContextV1 {
  const people: Person[] = []; const devices: Device[] = []; const links: ExternalLink[] = [];
  for (const entity of graph.entities) {
    if (entity.kind === 'PERSON' && entity.person) people.push({ ...scope, id: entity.id, displayName: entity.person.displayName, email: entity.person.email });
    if (entity.kind === 'DEVICE' && entity.device) devices.push({ ...scope, id: entity.id, hostname: entity.device.hostname, personId: entity.device.personId });
    for (const link of entity.links) {
      links.push({ ...scope, connectionId: link.external.connection.id, system: asSystem(link.external.connection.system),
        resourceType: link.external.resourceType as ResourceType, externalId: link.external.externalId, entityId: entity.id,
        entityKind: entity.kind as EntityKind, status: link.status as LinkStatus });
    }
  }
  const counts = emptyCounts();
  for (const { severity, count } of stats.bySeverity) if ((severities as readonly string[]).includes(severity)) counts[severity as Severity] = count;
  const items = observations.map(row => mapObservationRow(scope, row))
    .sort((a, b) => severityRank[b.severity] - severityRank[a.severity] || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  return { ...scope, contractVersion: 'ClientContextV1', mode: 'db', clientName: graph.name, people, devices, links,
    observations: { items, counts, total: stats.total, truncated: stats.total > limit },
    resources: mapResources(graph.connections), generatedAt: now.toISOString(), completeness: 'PARTIAL' };
}
