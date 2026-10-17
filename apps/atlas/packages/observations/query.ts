import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { ObservationStatus, Scope, Severity } from '../core/contracts.ts';
import { AtlasError, activeObservationStatuses, severities } from '../core/contracts.ts';
import type { DbObservationRow, DbObservationStats } from '../graph/context-mapper.ts';

/**
 * Observation selection (task 1.8): status and severity filters, priority order severityRank DESC, createdAt DESC, id —
 * an old CRITICAL is never pushed out by newer MEDIUMs — and keyset pages. The cursor is the sort key of the last item,
 * bound to the filters it was issued for; a cursor reused with other filters or altered is INVALID_CURSOR. Counts and
 * total cover the whole selected set, not the page.
 */
export interface ObservationQuery { statuses: ObservationStatus[]; severities: Severity[]; limit: number; cursor: string | null; deviceId?: string }
export const activeQuery = (limit: number): ObservationQuery => ({ statuses: [...activeObservationStatuses], severities: [...severities], limit, cursor: null });

/** Canonical IDs stay exact: names, case folding and whitespace normalization cannot establish identity. */
export const isObservationDeviceId = (value: unknown): value is string => typeof value === 'string'
  && value.length <= 256 && value.trim().length > 0 && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
  && Buffer.from(value, 'utf8').toString('utf8') === value;

interface CursorKey { r: number; t: string; i: string; f: string }
const filterKey = (q: ObservationQuery): string =>
  createHash('sha256').update(JSON.stringify([[...q.statuses].sort(), [...q.severities].sort(),
    ...(q.deviceId === undefined ? [] : [q.deviceId])])).digest('base64url').slice(0, 16);
const invalidCursor = () => new AtlasError('INVALID_CURSOR', 'VALIDATION');

export function encodeCursor(row: { severityRank: number; createdAt: Date; id: string }, query: ObservationQuery): string {
  return Buffer.from(JSON.stringify({ r: row.severityRank, t: row.createdAt.toISOString(), i: row.id, f: filterKey(query) })).toString('base64url');
}
export function decodeCursor(cursor: string, query: ObservationQuery): { severityRank: number; createdAt: Date; id: string } {
  if (cursor.length > 400 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalidCursor();
  let key: Partial<CursorKey>;
  try { key = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<CursorKey>; } catch { throw invalidCursor(); }
  const valid = !!key && typeof key === 'object' && Object.keys(key).sort().join() === 'f,i,r,t'
    && Number.isInteger(key.r) && key.r! >= 0 && key.r! <= 4 && typeof key.t === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(key.t)
    && Number.isFinite(Date.parse(key.t)) && typeof key.i === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(key.i) && key.f === filterKey(query);
  if (!valid) throw invalidCursor();
  return { severityRank: key.r!, createdAt: new Date(key.t!), id: key.i! };
}

export const observationSelect = {
  id: true, eventId: true, entityId: true, decisionRunId: true, domain: true, severity: true, severityRank: true, priority: true, route: true,
  confidence: true, provider: true, reasonCodes: true, status: true, acknowledgedAt: true, resolvedAt: true, supersededById: true,
  createdAt: true, updatedAt: true,
  event: { select: { eventKey: true, conflictOfEventKey: true, connectionId: true, resourceType: true, externalEventId: true, revision: true,
    occurredAt: true, normalized: true, connection: { select: { system: true } } } }
} as const;

/** One page of the selection inside the caller's scoped transaction, plus the totals of the whole selection. */
export async function readObservationPage(tx: Prisma.TransactionClient, scope: Scope, query: ObservationQuery):
  Promise<{ rows: DbObservationRow[]; stats: DbObservationStats; nextCursor: string | null }> {
  const where: Prisma.ObservationWhereInput = { workspaceId: scope.workspaceId, clientId: scope.clientId,
    status: { in: query.statuses }, severity: { in: query.severities },
    // Keep the stored canonical association even if today's confirmed source link has changed.
    ...(query.deviceId === undefined ? {} : { entityId: query.deviceId, entity: { is: { kind: 'DEVICE', device: { isNot: null } } } }),
  };
  const after = query.cursor === null ? null : decodeCursor(query.cursor, query);
  const page = after === null ? where : { AND: [where, { OR: [
    { severityRank: { lt: after.severityRank } },
    { severityRank: after.severityRank, createdAt: { lt: after.createdAt } },
    { severityRank: after.severityRank, createdAt: after.createdAt, id: { gt: after.id } }] }] };
  const [rows, total, grouped] = await Promise.all([
    tx.observation.findMany({ where: page, orderBy: [{ severityRank: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }], take: query.limit + 1, select: observationSelect }),
    tx.observation.count({ where }),
    tx.observation.groupBy({ by: ['severity'], where, _count: { _all: true } })
  ]);
  const items = rows.slice(0, query.limit);
  const last = items[items.length - 1];
  return { rows: items as unknown as DbObservationRow[], stats: { total, bySeverity: grouped.map(g => ({ severity: g.severity, count: g._count._all })) },
    nextCursor: rows.length > query.limit && last ? encodeCursor(last, query) : null };
}
