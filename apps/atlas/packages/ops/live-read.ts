import type { PrismaClient } from '@prisma/client';
import type { Actor, Scope } from '../core/contracts.ts';
import { resolveConnection } from '../connections/connections.ts';
import { activateConnection } from '../sync/activation.ts';
import { connectorFor, syncConnection } from '../sync/snapshots.ts';
import type { SyncIo } from '../sync/snapshots.ts';

/**
 * Live read-only check of one bound connection (task 1.10, docs/06 "Live-read onboarding gate"): activation if the binding
 * is still DISABLED (a health check against the bound tenant), an explicit health check, then one bounded sync of the
 * identities and every live resource. Only GET requests reach the vendor and nothing changes there; Atlas stores the
 * snapshots and events as any sync does. The summary carries statuses, counts and safe codes — never record content or a
 * credential. With a mock transport it is the same code path the tests run.
 */
export interface LiveReadSummary {
  /** null while the connection is not active: nothing about it was resolved for a sync */
  connectionId: string; system: string | null;
  activation: { status: 'ACTIVE' } | { status: 'DISABLED'; safeErrorCode: string };
  health: { status: string; safeErrorCode: string | null } | null;
  identities: { status: string; registered: number; candidates: number; ambiguous: number; safeErrorCode: string | null } | null;
  resources: { resourceType: string; status: string; itemCount: number | null; eventsStored: number; safeErrorCode: string | null; retryAfterSeconds: string | null }[];
}

export async function liveReadCheck(db: PrismaClient, actor: Actor, scope: Scope, connectionId: string, io: SyncIo, now: Date = new Date()): Promise<LiveReadSummary> {
  const activation = await activateConnection(db, actor, scope, connectionId, io);
  if (activation.status !== 'ACTIVE') return { connectionId, system: null, activation, health: null, identities: null, resources: [] };
  const connection = await resolveConnection(db, actor, scope, connectionId, 'sync');
  const health = await connectorFor(db, actor, connection, io).healthCheck(connection);
  const summary: LiveReadSummary = { connectionId, system: connection.system, activation,
    health: { status: health.status, safeErrorCode: health.status === 'OK' ? null : health.safeErrorCode ?? 'HEALTH_CHECK_FAILED' }, identities: null, resources: [] };
  if (health.status !== 'OK') return summary;
  const sync = await syncConnection(db, actor, connection, io, now);
  summary.identities = { status: sync.identities.status, registered: sync.identities.registered, candidates: sync.identities.candidates,
    ambiguous: sync.identities.ambiguous, safeErrorCode: sync.identities.safeErrorCode };
  summary.resources = sync.resources.map(r => ({ resourceType: r.resourceType, status: r.status, itemCount: r.itemCount, eventsStored: r.eventsStored,
    safeErrorCode: r.safeErrorCode, retryAfterSeconds: r.retryAfterSeconds }));
  return summary;
}
