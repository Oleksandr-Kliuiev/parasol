import { randomUUID } from 'node:crypto';
import type { PrismaClient, Prisma } from '@prisma/client';
import type { Actor, InboxStatus, NormalizedEvent, Scope } from '../core/contracts.ts';
import { AtlasError, assertPermission, severities } from '../core/contracts.ts';
import type { ResolvedConnection } from '../../connectors/contracts.ts';
import { assertResolvedConnection } from '../connections/connections.ts';
import { clientAuditData } from '../audit/prisma.ts';
import { withScope, uniqueViolation } from '../graph/scoped-db.ts';
import { SCOPE_ID_PATTERN } from '../graph/scope-context.ts';
import { EXTERNAL_ID_PATTERN } from '../graph/mapping.ts';
import { eventKey, conflictEventKey, payloadHash } from './identity.ts';

/**
 * Durable inbox (task 1.6). An event is stored before anything else happens to it; from then on every outcome is a status
 * with a reason (docs/03). Identity is eventKey v2 (resource type included). Same identity and content: a duplicate.
 * Same identity, different content: a separate conflict row linked to the canonical one, which is never overwritten.
 */
export interface StoreResult { outcome: 'STORED' | 'DUPLICATE'; eventKey: string; conflictOfEventKey: string | null }

const SYSTEMS = ['atera', 'huntress', 'microsoft365', 'poweroffice'];
const KINDS = ['DISK_CAPACITY', 'SECURITY_INCIDENT'];
const EVENT_RESOURCES = ['alert', 'ticket', 'incident'];
const storable = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !/[\u0000]/.test(v) && !/\p{Cs}/u.test(v);
const isoTime = (v: unknown): boolean => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));

/** Shape check of a normalized event, on the way in and when a stored payload is read back by the worker. */
export function assertStorableEvent(value: unknown): asserts value is NormalizedEvent {
  const e = value as Partial<NormalizedEvent> | null;
  const device = e?.externalDevice;
  const facts = e?.facts as Record<string, unknown> | undefined;
  const valid = !!e && typeof e === 'object'
    && [e.workspaceId, e.clientId, e.connectionId].every(id => typeof id === 'string' && SCOPE_ID_PATTERN.test(id))
    && SYSTEMS.includes(e.source as string) && EVENT_RESOURCES.includes(e.resourceType as string) && KINDS.includes(e.kind as string)
    && (severities as readonly string[]).includes(e.sourceSeverity as string)
    && typeof e.externalEventId === 'string' && EXTERNAL_ID_PATTERN.test(e.externalEventId)
    && typeof e.revision === 'string' && e.revision.length > 0 && storable(e.revision, 64)
    && isoTime(e.occurredAt) && isoTime(e.receivedAt) && storable(e.summary, 300)
    && (device === null || (!!device && ['agent', 'contact'].includes(device.resourceType) && EXTERNAL_ID_PATTERN.test(device.externalId)))
    && !!facts && typeof facts === 'object' && !Array.isArray(facts)
    && (facts.diskPercent === undefined || (typeof facts.diskPercent === 'number' && facts.diskPercent >= 0 && facts.diskPercent <= 100))
    && (facts.signal === undefined || storable(facts.signal, 300));
  if (!valid) throw new AtlasError('INVALID_EVENT', 'VALIDATION');
}

/** An event is accepted only for the issued connection it came through: client and connection IDs in a body prove nothing. */
export function assertEventFromConnection(event: NormalizedEvent, connection: ResolvedConnection): void {
  if (event.workspaceId !== connection.workspaceId || event.clientId !== connection.clientId || event.connectionId !== connection.connectionId
    || event.source !== connection.system) throw new AtlasError('EVENT_SCOPE_MISMATCH', 'SCOPE');
}

/** Stores one event inside the caller's scoped transaction (the snapshot sync stores a complete read atomically). */
export async function storeEvent(tx: Prisma.TransactionClient, scope: Scope, actorId: string, event: NormalizedEvent, correlationId: string): Promise<StoreResult> {
  const canonicalKey = eventKey(event);
  const hash = payloadHash(event);
  const identity = { workspaceId: scope.workspaceId, clientId: scope.clientId, connectionId: event.connectionId, resourceType: event.resourceType,
    externalEventId: event.externalEventId, revision: event.revision };
  const insert = (key: string, conflictOfEventKey: string | null) => tx.rawEvent.create({ data: { ...identity, id: randomUUID(), eventKey: key,
    eventKeyVersion: 'v2', normalized: event as unknown as Prisma.InputJsonValue, payloadHash: hash, occurredAt: new Date(event.occurredAt),
    status: 'RECEIVED', conflictOfEventKey }, select: { id: true } });
  const canonical = await tx.rawEvent.findFirst({ where: { ...identity, conflictOfEventKey: null }, select: { payloadHash: true } });
  if (!canonical) { await insert(canonicalKey, null); return { outcome: 'STORED', eventKey: canonicalKey, conflictOfEventKey: null }; }
  if (canonical.payloadHash === hash) return { outcome: 'DUPLICATE', eventKey: canonicalKey, conflictOfEventKey: null };
  const key = conflictEventKey(canonicalKey, hash);
  if (await tx.rawEvent.findFirst({ where: { workspaceId: scope.workspaceId, clientId: scope.clientId, eventKey: key }, select: { id: true } })) {
    return { outcome: 'DUPLICATE', eventKey: key, conflictOfEventKey: canonicalKey };
  }
  await insert(key, canonicalKey);
  await tx.auditEvent.create({ data: clientAuditData(scope, actorId, 'event.revision_conflict', correlationId,
    { eventKey: key, conflictOfEventKey: canonicalKey, safeErrorCode: 'REVISION_PAYLOAD_CONFLICT' }), select: { id: true } });
  return { outcome: 'STORED', eventKey: key, conflictOfEventKey: canonicalKey };
}

/** Single-event ingestion (events:ingest). A lost race on the identity is retried once and then decided like any delivery. */
export async function ingestEvent(db: PrismaClient, actor: Actor, connection: ResolvedConnection, event: NormalizedEvent,
  correlationId: string = randomUUID()): Promise<StoreResult> {
  assertResolvedConnection(connection);
  const scope = { workspaceId: connection.workspaceId, clientId: connection.clientId };
  assertPermission(actor, scope, 'events:ingest');
  assertEventFromConnection(event, connection);
  assertStorableEvent(event);
  const store = () => withScope(db, actor, [scope.clientId], tx => storeEvent(tx, scope, actor.id, event, correlationId));
  try { return await store(); }
  catch (error) { if (uniqueViolation(error) === null) throw error; return store(); }
}

export interface InboxView {
  eventKey: string; conflictOfEventKey: string | null; source: string; resourceType: string; externalEventId: string; revision: string;
  status: InboxStatus; attempts: number; lastErrorCode: string | null; receivedAt: string; nextAttemptAt: string;
}
/** Operator view (context:read): pending, retrying and dead-lettered events by default, newest first, at most 100. */
export async function listInbox(db: PrismaClient, actor: Actor, scope: Scope,
  statuses: InboxStatus[] = ['RECEIVED', 'RETRY', 'DEAD_LETTER']): Promise<InboxView[]> {
  assertPermission(actor, scope, 'context:read');
  const rows = await withScope(db, actor, [scope.clientId], tx => tx.rawEvent.findMany({
    where: { workspaceId: scope.workspaceId, clientId: scope.clientId, status: { in: statuses } }, orderBy: [{ receivedAt: 'desc' }, { id: 'asc' }], take: 100,
    select: { eventKey: true, conflictOfEventKey: true, resourceType: true, externalEventId: true, revision: true, status: true, attempts: true,
      lastErrorCode: true, receivedAt: true, nextAttemptAt: true, connection: { select: { system: true } } } }));
  return rows.map(r => ({ eventKey: r.eventKey, conflictOfEventKey: r.conflictOfEventKey, source: r.connection.system, resourceType: r.resourceType,
    externalEventId: r.externalEventId, revision: r.revision, status: r.status as InboxStatus, attempts: r.attempts, lastErrorCode: r.lastErrorCode,
    receivedAt: r.receivedAt.toISOString(), nextAttemptAt: r.nextAttemptAt.toISOString() }));
}

/** A dead letter is never reprocessed implicitly (docs/03): requeueing is an explicit, audited operator action. */
export async function requeueDeadLetter(db: PrismaClient, actor: Actor, scope: Scope, key: string, now: Date = new Date()): Promise<void> {
  assertPermission(actor, scope, 'events:ingest');
  await withScope(db, actor, [scope.clientId], async tx => {
    const row = await tx.rawEvent.findFirst({ where: { workspaceId: scope.workspaceId, clientId: scope.clientId, eventKey: key }, select: { id: true, status: true, attempts: true } });
    if (!row) throw new AtlasError('EVENT_NOT_FOUND', 'VALIDATION');
    if (row.status !== 'DEAD_LETTER') throw new AtlasError('EVENT_NOT_DEAD_LETTERED', 'VALIDATION');
    await tx.rawEvent.update({ where: { workspaceId_clientId_id: { workspaceId: scope.workspaceId, clientId: scope.clientId, id: row.id } },
      data: { status: 'RECEIVED', attempts: 0, nextAttemptAt: now }, select: { id: true } });
    await tx.auditEvent.create({ data: clientAuditData(scope, actor.id, 'event.requeued', randomUUID(),
      { eventKey: key, attempts: String(row.attempts), inboxStatus: 'RECEIVED' }), select: { id: true } });
  });
}
