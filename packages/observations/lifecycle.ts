import { randomUUID } from 'node:crypto';
import type { PrismaClient, Prisma } from '@prisma/client';
import type { Actor, ObservationStatus, Priority, Scope } from '../core/contracts.ts';
import { AtlasError, activeObservationStatuses, assertPermission } from '../core/contracts.ts';
import { clientAuditData } from '../audit/prisma.ts';
import { withScope } from '../graph/scoped-db.ts';

/**
 * Observation lifecycle (task 1.8, docs/02): OPEN → ACKNOWLEDGED → RESOLVED | SUPPRESSED, and reopen back to OPEN. Every
 * change records its author and time and writes its client audit row in the same transaction; the database trigger
 * `Observation_lifecycle` allows no other change and keeps the evidence (event, decision, entity, severity, priority,
 * route, reasons) immutable, so the source link survives every status.
 *
 * Revisions of one source object (connection, resource type, external ID) are ordered by their ISO 8601 revision time
 * (Huntress: updated_at). A newer revision supersedes the active observations of older revisions; a revision that arrives
 * late is superseded by the newest one at once. The system never closes urgent evidence in favour of a non-urgent
 * revision: an URGENT observation stays active until a person closes it. Content conflicts stay in review, and revisions
 * without an order are never superseded.
 */
export type TriageAction = 'acknowledge' | 'resolve' | 'suppress' | 'reopen';
const TRANSITIONS: Readonly<Record<TriageAction, { from: readonly ObservationStatus[]; to: ObservationStatus; audit: string }>> = {
  acknowledge: { from: ['OPEN'], to: 'ACKNOWLEDGED', audit: 'observation.acknowledged' },
  resolve: { from: ['OPEN', 'ACKNOWLEDGED'], to: 'RESOLVED', audit: 'observation.resolved' },
  suppress: { from: ['OPEN', 'ACKNOWLEDGED'], to: 'SUPPRESSED', audit: 'observation.suppressed' },
  reopen: { from: ['RESOLVED', 'SUPPRESSED'], to: 'OPEN', audit: 'observation.reopened' },
};
const OBSERVATION_ID = /^[A-Za-z0-9._:-]{1,100}$/;
const ids = (scope: Scope) => ({ workspaceId: scope.workspaceId, clientId: scope.clientId });

export interface TriageResult { id: string; previousStatus: ObservationStatus; status: ObservationStatus; updatedAt: string }

/**
 * A person's lifecycle change (observations:triage). `expectedStatus` makes it conditional: a change made meanwhile by
 * someone else is OBSERVATION_STATUS_CHANGED (CONFLICT) instead of being overwritten.
 */
export async function triageObservation(db: PrismaClient, actor: Actor, scope: Scope, observationId: string, action: TriageAction,
  options: { expectedStatus?: ObservationStatus; now?: Date; correlationId?: string } = {}): Promise<TriageResult> {
  assertPermission(actor, scope, 'observations:triage');
  if (typeof observationId !== 'string' || !OBSERVATION_ID.test(observationId)) throw new AtlasError('INVALID_OBSERVATION_ID', 'VALIDATION');
  // Own keys only: an inherited name such as `toString` is not an action
  const transition = typeof action === 'string' && Object.hasOwn(TRANSITIONS, action) ? TRANSITIONS[action] : null;
  if (!transition) throw new AtlasError('INVALID_TRIAGE_ACTION', 'VALIDATION');
  const now = options.now ?? new Date();
  return withScope(db, actor, [scope.clientId], async tx => {
    const [row] = await tx.$queryRaw<{ status: ObservationStatus }[]>`SELECT status FROM "Observation"
      WHERE "workspaceId" = ${scope.workspaceId} AND "clientId" = ${scope.clientId} AND id = ${observationId} FOR UPDATE`;
    if (!row) throw new AtlasError('OBSERVATION_NOT_FOUND', 'VALIDATION');
    if (options.expectedStatus && options.expectedStatus !== row.status) throw new AtlasError('OBSERVATION_STATUS_CHANGED', 'CONFLICT');
    if (!transition.from.includes(row.status)) throw new AtlasError('TRANSITION_NOT_ALLOWED', 'VALIDATION');
    const data = action === 'acknowledge' ? { status: transition.to, acknowledgedAt: now, acknowledgedBy: actor.id }
      : action === 'reopen' ? { status: transition.to, resolvedAt: null, resolvedBy: null, acknowledgedAt: null, acknowledgedBy: null, supersededById: null, legacyClosure: false }
      : { status: transition.to, resolvedAt: now, resolvedBy: actor.id };
    await tx.observation.update({ where: { workspaceId_clientId_id: { ...ids(scope), id: observationId } }, data: { ...data, updatedAt: now }, select: { id: true } });
    await tx.auditEvent.create({ data: clientAuditData(scope, actor.id, transition.audit, options.correlationId ?? randomUUID(),
      { observationId, previousStatus: row.status, observationStatus: transition.to }), select: { id: true } });
    return { id: observationId, previousStatus: row.status, status: transition.to, updatedAt: now.toISOString() };
  });
}

const ISO_REVISION = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
/** Order of a revision: its ISO 8601 time; any other revision has none (and is never superseded). */
export function revisionTime(revision: string): number | null {
  if (!ISO_REVISION.test(revision)) return null;
  const time = Date.parse(revision);
  return Number.isFinite(time) ? time : null;
}

export interface CreatedObservation {
  id: string; connectionId: string; resourceType: string; externalEventId: string; revision: string; priority: Priority; conflictOfEventKey: string | null;
}

/**
 * Revision lifecycle inside the final transaction that created `created`. Serialized per source object by a transaction
 * advisory lock, so two revisions committed at the same time still see each other.
 *
 * A person's triage does not take that lock: between the read below and the UPDATE, an older observation may have been
 * resolved or suppressed. The UPDATE is therefore conditional on the row being still active; it waits for the triage
 * transaction and re-checks the committed row (review C1). A closed observation stays as the person left it, only a
 * transition that happened is audited, and the new revision commits normally — never a dead letter from a lifecycle race.
 */
export async function applyRevisionLifecycle(tx: Prisma.TransactionClient, scope: Scope, actorId: string, created: CreatedObservation,
  correlationId: string, now: Date): Promise<void> {
  const time = revisionTime(created.revision);
  if (created.conflictOfEventKey !== null || time === null) return;
  const objectKey = JSON.stringify([scope.workspaceId, scope.clientId, created.connectionId, created.resourceType, created.externalEventId]);
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${objectKey}, 0))`;
  const others = await tx.$queryRaw<{ id: string; status: ObservationStatus; priority: Priority; revision: string }[]>`
    SELECT o.id, o.status, o.priority, r.revision FROM "Observation" o
    JOIN "RawEvent" r ON r."workspaceId" = o."workspaceId" AND r."clientId" = o."clientId" AND r.id = o."eventId"
    WHERE o."workspaceId" = ${scope.workspaceId} AND o."clientId" = ${scope.clientId} AND o.id <> ${created.id} AND r."conflictOfEventKey" IS NULL
      AND r."connectionId" = ${created.connectionId} AND r."resourceType" = ${created.resourceType} AND r."externalEventId" = ${created.externalEventId}`;
  const ordered = others.map(o => ({ ...o, time: revisionTime(o.revision) })).filter((o): o is typeof o & { time: number } => o.time !== null);
  const keepsUrgency = (older: { priority: Priority }, newer: { priority: Priority }) => older.priority === 'URGENT' && newer.priority !== 'URGENT';
  const supersede = async (id: string, byId: string): Promise<void> => {
    const { count } = await tx.observation.updateMany({ where: { ...ids(scope), id, status: { in: [...activeObservationStatuses] } },
      data: { status: 'SUPPRESSED', resolvedAt: now, resolvedBy: actorId, supersededById: byId, updatedAt: now } });
    if (count === 0) return; // closed by a person meanwhile: it stays as they left it
    await tx.auditEvent.create({ data: clientAuditData(scope, actorId, 'observation.superseded', correlationId,
      { observationId: id, supersededById: byId, observationStatus: 'SUPPRESSED' }), select: { id: true } });
  };
  const newest = ordered.filter(o => o.time > time).sort((a, b) => b.time - a.time || a.id.localeCompare(b.id))[0];
  if (newest) {
    if (keepsUrgency(created, newest)) return; // a late urgent revision stays for a person to close
    await supersede(created.id, newest.id); // created in this transaction: nobody else can have closed it
    return;
  }
  const older = ordered.filter(o => o.time < time && activeObservationStatuses.includes(o.status) && !keepsUrgency(o, created))
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const o of older) await supersede(o.id, created.id);
}
