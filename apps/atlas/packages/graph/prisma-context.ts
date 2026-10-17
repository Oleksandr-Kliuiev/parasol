import type { PrismaClient } from '@prisma/client';
import type { Actor, Scope, ClientContextV1, ObservationPage, ObservationSummary } from '../core/contracts.ts';
import { AtlasError, M365_RESOURCE_TYPES, assertPermission, hasClientPermission, observationStatuses, severities } from '../core/contracts.ts';
import { withScope } from './scoped-db.ts';
import { mapClientContext, mapObservationPage, mapObservationRow } from './context-mapper.ts';
import type { DbClientGraph, DbObservationRow } from './context-mapper.ts';
import { activeQuery, isObservationDeviceId, observationSelect, readObservationPage } from '../observations/query.ts';
import type { ObservationQuery } from '../observations/query.ts';

/** Page size of observations in the context and the upper bound of GET /clients/:id/observations. */
export const CONTEXT_OBSERVATION_LIMIT = 100;

function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > CONTEXT_OBSERVATION_LIMIT) throw new AtlasError('INVALID_LIMIT', 'VALIDATION');
}
const subset = <T>(values: readonly T[], allowed: readonly T[]) => values.length > 0 && new Set(values).size === values.length && values.every(v => allowed.includes(v));
function assertQuery(query: ObservationQuery): void {
  assertLimit(query.limit);
  if (!subset(query.statuses, observationStatuses) || !subset(query.severities, severities)
    || (query.deviceId !== undefined && !isObservationDeviceId(query.deviceId))) throw new AtlasError('INVALID_OBSERVATION_QUERY', 'VALIDATION');
}

/**
 * DB-backed getClientContext. Runs inside withScope(): the RLS context is the single requested client, so even a query
 * that forgot `where: scope` could not read another client. Only CONFIRMED links are returned; candidates stay out.
 * ClientContextV1 is the Stage 1 contract: m365_* links and Microsoft 365 connections are excluded in the query itself,
 * whatever the caller's permissions (M365 data has its own versioned read, docs/stage2/02_CONTRACTS.md §5).
 * Live alerts/tickets/incidents come from the snapshot repository (task 1.5) with an explicit status per resource.
 * Observations: the active ones (OPEN and ACKNOWLEDGED) in priority order; an old CRITICAL is never pushed out by newer MEDIUMs.
 * Entities, links and connections come in ID order, so the same data gives the same context (no physical row order).
 */
export async function getClientContext(db: PrismaClient, actor: Actor, scope: Scope, limit: number = CONTEXT_OBSERVATION_LIMIT): Promise<ClientContextV1> {
  assertPermission(actor, scope, 'context:read');
  assertLimit(limit);
  return withScope(db, actor, [scope.clientId], async tx => {
    const client = await tx.client.findUnique({
      where: { workspaceId_id: { workspaceId: scope.workspaceId, id: scope.clientId } },
      select: {
        id: true, name: true,
        entities: { orderBy: { id: 'asc' }, select: { id: true, kind: true,
          person: { select: { displayName: true, email: true } },
          device: { select: { hostname: true, personId: true } },
          links: { where: { status: 'CONFIRMED', resourceType: { notIn: [...M365_RESOURCE_TYPES] } }, orderBy: { id: 'asc' }, select: { id: true, status: true,
            external: { select: { externalId: true, resourceType: true, connection: { select: { id: true, system: true, status: true } } } } } } } },
        connections: { where: { system: { not: 'microsoft365' } }, orderBy: { id: 'asc' }, select: { id: true, system: true, status: true,
          syncStates: { select: { resourceType: true, status: true, lastSyncAt: true, lastSuccessAt: true, safeErrorCode: true,
            snapshot: { select: { asOf: true, items: true, itemCount: true, truncated: true } } } } } }
      }
    });
    if (!client) throw new AtlasError('CLIENT_NOT_FOUND', 'VALIDATION');
    const { rows, stats, nextCursor } = await readObservationPage(tx, scope, activeQuery(limit));
    return mapClientContext(scope, client as unknown as DbClientGraph, rows, stats, nextCursor);
  });
}

/**
 * GET /clients/:id/observations (task 1.8): the selected statuses (default: the active ones, as in the context) and
 * severities in priority order, page by page through the keyset cursor; counts and total cover the whole selection.
 */
export async function getObservationPage(db: PrismaClient, actor: Actor, scope: Scope,
  query: ObservationQuery = activeQuery(CONTEXT_OBSERVATION_LIMIT)): Promise<ObservationPage> {
  assertPermission(actor, scope, 'context:read');
  assertQuery(query);
  return withScope(db, actor, [scope.clientId], async tx => {
    const { rows, stats, nextCursor } = await readObservationPage(tx, scope, query);
    return mapObservationPage(scope, rows, stats, nextCursor);
  });
}

/** Stored observation identifiers use the same bounded vocabulary as lifecycle commands and page cursors. */
export function assertObservationId(id: string): void {
  if (typeof id !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(id)) throw new AtlasError('INVALID_OBSERVATION_ID', 'VALIDATION');
}

/** Exact stored read, including resolved/suppressed history. Never searches another client or invokes a provider. */
export async function getObservationSummary(db: PrismaClient, actor: Actor, scope: Scope, id: string): Promise<ObservationSummary | null> {
  assertPermission(actor, scope, 'context:read');
  assertObservationId(id);
  return withScope(db, actor, [scope.clientId], async tx => {
    const row = await tx.observation.findUnique({ where: { workspaceId_clientId_id: { ...scope, id } }, select: observationSelect });
    return row ? mapObservationRow(scope, row as unknown as DbObservationRow) : null;
  });
}

export interface ClientSummary { id: string; name: string }
/** GET /clients: only clients whose context the actor may read. No membership with context:read → no query at all. */
export async function listClients(db: PrismaClient, actor: Actor): Promise<ClientSummary[]> {
  const ids = actor.memberships.map(m => m.clientId).filter(id => hasClientPermission(actor, id, 'context:read'));
  if (ids.length === 0) return [];
  return withScope(db, actor, ids, tx => tx.client.findMany({ where: { workspaceId: actor.workspaceId, id: { in: ids } },
    select: { id: true, name: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] }));
}
