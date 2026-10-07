import type { PrismaClient } from '@prisma/client';
import type { Actor, Scope, ClientContextV1 } from '../core/contracts.ts';
import { AtlasError, assertPermission } from '../core/contracts.ts';
import { withScope } from './scoped-db.ts';
import { mapClientContext } from './context-mapper.ts';
import type { DbClientGraph, DbObservationRow } from './context-mapper.ts';

export const CONTEXT_OBSERVATION_LIMIT = 100;

/**
 * DB-backed getClientContext (task 1.3 wires it into the API). Runs inside withScope(): the RLS context is the single
 * requested client, so even a query that forgot `where: scope` could not read another client. Observations are ordered
 * by priority (severityRank DESC, createdAt DESC, id) and the counts cover the whole OPEN set, not the returned page.
 * Live tickets/alerts/incidents arrive with the snapshot repository in 1.5; until then every resource reports MISSING.
 */
export async function getClientContext(db: PrismaClient, actor: Actor, scope: Scope, limit: number = CONTEXT_OBSERVATION_LIMIT): Promise<ClientContextV1> {
  assertPermission(actor, scope, 'context:read');
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
    const stats = { total, bySeverity: grouped.map(g => ({ severity: g.severity, count: g._count._all })) };
    return mapClientContext(scope, client as unknown as DbClientGraph, rows as unknown as DbObservationRow[], stats, limit);
  });
}
