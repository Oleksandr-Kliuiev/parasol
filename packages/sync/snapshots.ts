import { randomUUID } from 'node:crypto';
import type { PrismaClient, Prisma } from '@prisma/client';
import type { Actor, ErrorKind, ResourceType, Scope, SnapshotItem } from '../core/contracts.ts';
import { AtlasError, assertPermission, errorDetails, errorKind, safeErrorCode, severityRank } from '../core/contracts.ts';
import type { AtlasConnector, ResolvedConnection, SecretResolver } from '../../connectors/contracts.ts';
import type { HttpTransport } from '../../connectors/http.ts';
import { createConnector } from '../../connectors/registry.ts';
import { assertResolvedConnection, resolveCredential } from '../connections/connections.ts';
import { registerExternalEntity, suggestDeviceCandidate } from '../graph/mapping.ts';
import { uniqueViolation } from '../graph/scoped-db.ts';
import { assertEventFromConnection, assertStorableEvent, storeEvent } from '../events/inbox.ts';
import { beginAttempt, commitAttempt, nothing } from './sync-state.ts';

/**
 * SyncModule core (task 1.5): snapshot reads of live resources and identity reads, following the sync order of docs/03.
 * Only the actor's scope is used (events:ingest), every vendor call goes through an issued ResolvedConnection, and the
 * credential is resolved in memory per call. Durable event ingestion (inbox, lease, dedup) is task 1.6.
 */
export const SNAPSHOT_ITEM_LIMIT = 100;
export interface SyncIo { transport: HttpTransport; secrets: SecretResolver }

/** The connector of an issued connection, wired to resolve its credential through ConnectionsModule. */
export function connectorFor(db: PrismaClient, actor: Actor, connection: ResolvedConnection, io: SyncIo): AtlasConnector {
  return createConnector(connection.system, { transport: io.transport, credential: c => resolveCredential(db, actor, c, io.secrets) });
}

const priorityRank: Readonly<Record<string, number>> = { Critical: 4, High: 3, Medium: 2, Low: 1 };
const rank = (item: SnapshotItem): number => item.severity ? severityRank[item.severity] : priorityRank[item.priority ?? ''] ?? 0;
const recency = (item: SnapshotItem): string => item.updatedAt ?? item.occurredAt ?? '';
/** Bounded projection for the context: most severe or urgent first, then newest, then a stable tiebreak. */
export function boundedItems(items: SnapshotItem[]): SnapshotItem[] {
  return [...items].sort((a, b) => rank(b) - rank(a) || recency(b).localeCompare(recency(a)) || a.externalId.localeCompare(b.externalId))
    .slice(0, SNAPSHOT_ITEM_LIMIT);
}

export interface ResourceSyncResult {
  resourceType: ResourceType; status: 'OK' | 'ERROR' | 'UNAVAILABLE'; itemCount: number | null;
  /** Events of this read newly stored in the inbox, and redeliveries recognized as duplicates (durable dedup). */
  eventsStored: number; eventsDuplicate: number;
  /** A read that began later had already been recorded: this outcome changed neither state nor snapshot (its events are stored). */
  superseded: boolean;
  safeErrorCode: string | null; errorKind: ErrorKind | null; retryAfterSeconds: string | null;
}
const scopeOf = (c: ResolvedConnection): Scope => ({ workspaceId: c.workspaceId, clientId: c.clientId });

/**
 * One live resource of one connection: every page is read and validated by the connector, then the snapshot is
 * replaced, the read's events are stored in the durable inbox (task 1.6) and the success is recorded — in ONE
 * transaction, so a read that fails anywhere stores nothing of itself. A failure on any page records ERROR with its code and kind
 * (TRANSIENT: retry later, honouring retryAfterSeconds) and leaves the previous snapshot and lastSuccessAt untouched.
 * A resource the source cannot read with a tenant filter is recorded UNAVAILABLE and never requested.
 * Overlapping reads of one resource (review B3): only the outcome of the read that began later becomes the current state;
 * an earlier read finishing late is `superseded` and only stores its events (packages/sync/sync-state.ts).
 */
export async function syncResource(db: PrismaClient, actor: Actor, connection: ResolvedConnection, connector: AtlasConnector,
  resourceType: ResourceType, now: Date = new Date()): Promise<ResourceSyncResult> {
  assertResolvedConnection(connection);
  const scope = scopeOf(connection);
  assertPermission(actor, scope, 'events:ingest');
  if (connector.system !== connection.system) throw new AtlasError('CONNECTOR_SYSTEM_MISMATCH', 'PERMANENT');
  const key = { ...scope, connectionId: connection.connectionId, resourceType };
  const where = { workspaceId_clientId_connectionId_resourceType: key };
  const attempt = await beginAttempt(db, actor, key, now);
  const recordState = async (status: 'ERROR' | 'UNAVAILABLE', code: string) => (await commitAttempt(db, actor, key, attempt, (tx, recordedSeq) =>
    tx.syncState.upsert({ where, create: { ...key, status, safeErrorCode: code, lastSyncAt: now, attemptSeq: recordedSeq, recordedSeq },
      update: { status, safeErrorCode: code, lastSyncAt: now, recordedSeq } }), nothing)).recorded;
  const unavailable = connector.unavailableResources[resourceType];
  if (unavailable) {
    const recorded = await recordState('UNAVAILABLE', unavailable);
    return { resourceType, status: 'UNAVAILABLE', itemCount: null, eventsStored: 0, eventsDuplicate: 0, superseded: !recorded, safeErrorCode: unavailable, errorKind: null,
      retryAfterSeconds: null };
  }
  try {
    const read = await connector.readSnapshot(connection, resourceType);
    if (read.resourceType !== resourceType || read.itemCount !== read.items.length) throw new AtlasError('CONNECTOR_RESULT_INVALID', 'PERMANENT');
    for (const event of read.events) { assertEventFromConnection(event, connection); assertStorableEvent(event); }
    const correlationId = randomUUID();
    const items = boundedItems(read.items);
    const snapshot = { asOf: now, items: items as unknown as Prisma.InputJsonValue, itemCount: read.itemCount,
      truncated: read.itemCount > items.length, contractVersion: read.contractVersion };
    const success = { status: 'OK', safeErrorCode: null, cursor: null, lastSyncAt: now, lastSuccessAt: now };
    const { recorded, value: counts } = await commitAttempt(db, actor, key, attempt, async (tx, recordedSeq) => {
      await tx.syncState.upsert({ where, create: { ...key, ...success, attemptSeq: recordedSeq, recordedSeq }, update: { ...success, recordedSeq } });
      await tx.resourceSnapshot.upsert({ where, create: { ...key, ...snapshot }, update: snapshot });
    }, async tx => {
      const counted = { stored: 0, duplicate: 0 };
      for (const event of read.events) {
        if ((await storeEvent(tx, scope, actor.id, event, correlationId)).outcome === 'STORED') counted.stored++; else counted.duplicate++;
      }
      return counted;
    });
    return { resourceType, status: 'OK', itemCount: read.itemCount, eventsStored: counts.stored, eventsDuplicate: counts.duplicate, superseded: !recorded,
      safeErrorCode: null, errorKind: null, retryAfterSeconds: null };
  } catch (thrown) {
    // Concurrent syncs that still collide after the one re-decision in commitAttempt: retry later, the winner's rows stand.
    const error = uniqueViolation(thrown) !== null ? new AtlasError('CONCURRENT_SYNC', 'TRANSIENT') : thrown;
    const code = safeErrorCode(error);
    const recorded = await recordState('ERROR', code);
    return { resourceType, status: 'ERROR', itemCount: null, eventsStored: 0, eventsDuplicate: 0, superseded: !recorded, safeErrorCode: code, errorKind: errorKind(error),
      retryAfterSeconds: errorDetails(error).retryAfterSeconds ?? null };
  }
}

export interface IdentitySyncResult { status: 'OK' | 'ERROR'; registered: number; candidates: number; ambiguous: number; superseded: boolean; safeErrorCode: string | null;
  errorKind: ErrorKind | null }

/**
 * Identity objects (agents): each is registered under the connection, then the matcher may propose a CANDIDATE link
 * (exact hostname inside the client); nothing is ever confirmed here. Outcome recorded in SyncState(agent).
 */
export async function syncIdentities(db: PrismaClient, actor: Actor, connection: ResolvedConnection, connector: AtlasConnector,
  now: Date = new Date()): Promise<IdentitySyncResult> {
  assertResolvedConnection(connection);
  const scope = scopeOf(connection);
  assertPermission(actor, scope, 'events:ingest');
  const key = { ...scope, connectionId: connection.connectionId, resourceType: 'agent' };
  const where = { workspaceId_clientId_connectionId_resourceType: key };
  const attempt = await beginAttempt(db, actor, key, now);
  type IdentityState = { status: 'OK' | 'ERROR'; safeErrorCode: string | null; lastSyncAt: Date; lastSuccessAt?: Date };
  const recordState = async (state: IdentityState) => (await commitAttempt(db, actor, key, attempt, (tx, recordedSeq) =>
    tx.syncState.upsert({ where, create: { ...key, ...state, attemptSeq: recordedSeq, recordedSeq }, update: { ...state, recordedSeq } }), nothing)).recorded;
  try {
    const identities = await connector.readIdentities(connection);
    let candidates = 0; let ambiguous = 0;
    for (const identity of identities) {
      const { id } = await registerExternalEntity(db, actor, connection, { resourceType: identity.resourceType, externalId: identity.externalId,
        attributes: identity.attributes, observedAt: new Date(identity.observedAt) });
      if (identity.resourceType !== 'agent') continue;
      const suggestion = await suggestDeviceCandidate(db, actor, connection, id);
      if (suggestion.outcome === 'CANDIDATE') candidates++;
      if (suggestion.outcome === 'AMBIGUOUS') ambiguous++;
    }
    const recorded = await recordState({ status: 'OK', safeErrorCode: null, lastSyncAt: now, lastSuccessAt: now });
    return { status: 'OK', registered: identities.length, candidates, ambiguous, superseded: !recorded, safeErrorCode: null, errorKind: null };
  } catch (error) {
    const code = safeErrorCode(error);
    const recorded = await recordState({ status: 'ERROR', safeErrorCode: code, lastSyncAt: now });
    return { status: 'ERROR', registered: 0, candidates: 0, ambiguous: 0, superseded: !recorded, safeErrorCode: code, errorKind: errorKind(error) };
  }
}

/** One pass over a connection: identities first (so the matcher sees new agents), then every live resource. */
export async function syncConnection(db: PrismaClient, actor: Actor, connection: ResolvedConnection, io: SyncIo,
  now: Date = new Date()): Promise<{ identities: IdentitySyncResult; resources: ResourceSyncResult[] }> {
  const connector = connectorFor(db, actor, connection, io);
  const identities = await syncIdentities(db, actor, connection, connector, now);
  const resources: ResourceSyncResult[] = [];
  for (const resourceType of [...connector.snapshotResources, ...Object.keys(connector.unavailableResources) as ResourceType[]]) {
    resources.push(await syncResource(db, actor, connection, connector, resourceType, now));
  }
  return { identities, resources };
}
