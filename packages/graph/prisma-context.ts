import type { PrismaClient, Prisma } from '@prisma/client';
import type { Actor, Scope, ClientContextV1, ObservationPage } from '../core/contracts.ts';
import { AtlasError, assertPermission, hasClientPermission } from '../core/contracts.ts';
import { withScope } from './scoped-db.ts';
import { mapClientContext, mapObservationPage } from './context-mapper.ts';
import type { DbClientGraph, DbObservationRow, DbObservationStats } from './context-mapper.ts';

/** Page size of observations in the context and the upper bound of GET /clients/:id/observations. */
export const CONTEXT_OBSERVATION_LIMIT = 100;

function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > CONTEXT_OBSERVATION_LIMIT) throw new AtlasError('INVALID_LIMIT', 'VALIDATION');
}

/**
 * Priority page of OPEN observations: severityRank DESC, createdAt DESC, id (an old CRITICAL is never pushed out by newer
 * MEDIUMs). Total and per-severity counts cover the whole OPEN set, not the returned page. Runs inside the caller's scope.
 */
async function readObservationPage(tx: Prisma.TransactionClient, scope: Scope, limit: number): Promise<{ rows: DbObservationRow[]; stats: DbObservationStats }> {
  const where = { workspaceId: scope.workspaceId, clientId: scope.clientId, status: 'OPEN' };
  const [rows, total, grouped] = await Promise.all([
    tx.observation.findMany({
      where, orderBy: [{ severityRank: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }], take: limit,
      select: { id: true, eventId: true, entityId: true, domain: true, severity: true, priority: true, route: true, confidence: true,
        provider: true, reasonCodes: true, createdAt: true,
        event: { select: { eventKey: true, conflictOfEventKey: true, connectionId: true, resourceType: true, externalEventId: true, revision: true, occurredAt: true, normalized: true,
          connection: { select: { system: true } } } } }
    }),
    tx.observation.count({ where }),
    tx.observation.groupBy({ by: ['severity'], where, _count: { _all: true } })
  ]);
  return { rows: rows as unknown as DbObservationRow[], stats: { total, bySeverity: grouped.map(g => ({ severity: g.severity, count: g._count._all })) } };
}

/**
 * DB-backed getClientContext. Runs inside withScope(): the RLS context is the single requested client, so even a query
 * that forgot `where: scope` could not read another client. Only CONFIRMED links are returned; candidates stay out.
 * Live tickets/alerts/incidents arrive with the snapshot repository in 1.5; until then every resource reports MISSING.
 */
export async function getClientContext(db: PrismaClient, actor: Actor, scope: Scope, limit: number = CONTEXT_OBSERVATION_LIMIT): Promise<ClientContextV1> {
  assertPermission(actor, scope, 'context:read');
  assertLimit(limit);
  return withScope(db, actor, [scope.clientId], async tx => {
    const client = await tx.client.findUnique({
      where: { workspaceId_id: { workspaceId: scope.workspaceId, id: scope.clientId } },
      select: {
        id: true, name: true,
        entities: { select: { id: true, kind: true,
          person: { select: { displayName: true, email: true } },
          device: { select: { hostname: true, personId: true } },
          links: { where: { status: 'CONFIRMED' }, select: { id: true, status: true,
            external: { select: { externalId: true, resourceType: true, connection: { select: { id: true, system: true, status: true } } } } } } } },
        connections: { select: { id: true, system: true, status: true,
          syncStates: { select: { resourceType: true, status: true, lastSyncAt: true, lastSuccessAt: true, safeErrorCode: true } } } }
      }
    });
    if (!client) throw new AtlasError('CLIENT_NOT_FOUND', 'VALIDATION');
    const { rows, stats } = await readObservationPage(tx, scope, limit);
    return mapClientContext(scope, client as unknown as DbClientGraph, rows, stats, limit);
  });
}

/** GET /clients/:id/observations: the context's priority page without the graph. */
export async function getObservationPage(db: PrismaClient, actor: Actor, scope: Scope, limit: number = CONTEXT_OBSERVATION_LIMIT): Promise<ObservationPage> {
  assertPermission(actor, scope, 'context:read');
  assertLimit(limit);
  return withScope(db, actor, [scope.clientId], async tx => {
    const { rows, stats } = await readObservationPage(tx, scope, limit);
    return mapObservationPage(scope, rows, stats, limit);
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
