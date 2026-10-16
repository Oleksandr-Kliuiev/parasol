import { randomUUID } from 'node:crypto';
import type { PrismaClient, Prisma } from '@prisma/client';
import type { Actor, Scope, EntityKind, ResourceType, LinkStatus } from '../core/contracts.ts';
import { AtlasError, M365_RESOURCE_TYPES, assertPermission, isM365ResourceType } from '../core/contracts.ts';
import type { ResolvedConnection } from '../../connectors/contracts.ts';
import { assertResolvedConnection } from '../connections/connections.ts';
import { clientAuditData } from '../audit/prisma.ts';
import { withScope, uniqueViolation } from './scoped-db.ts';
import { SCOPE_ID_PATTERN } from './scope-context.ts';
import { assertFreshM365Membership, linkTarget, lockM365Directory, mayReviewM365 } from './m365-mapping.ts';

/**
 * Mapping workflow (task 1.4, docs/02 "Entity matching"). Identity objects read from a source (agents, contacts) are
 * recorded per connection. A link to a canonical entity starts as CANDIDATE — proposed by a reviewer or by an exact
 * hostname match inside one client — and becomes CONFIRMED only by an explicit decision with mapping:review; a name or
 * hostname never confirms by itself. A confirmation that conflicts with the confirmed link of the same external object is
 * kept as QUARANTINED with a pointer to that link: visible for review, never lost, never used for resolution. Every
 * decision commits together with its client audit row. Rows of another client are invisible (RLS) and could not be
 * linked anyway (composite keys), so a cross-client link ends as "not found".
 */

/**
 * The only identity pairs a link may join (also a CHECK). Events, tenants and sign-ins are never linked to entities.
 * M365 pairs follow the extra rules of m365-mapping.ts (m365:read, fresh directory evidence, manual decisions only).
 */
const LINKABLE: Readonly<Record<string, EntityKind>> = Object.freeze({ agent: 'DEVICE', contact: 'PERSON', m365_user: 'PERSON', m365_device: 'DEVICE' });
export function linkableKind(resourceType: string): EntityKind | null { return LINKABLE[resourceType] ?? null; }
/** Returned from a decision's transaction when the target is an M365 link and the actor lacks m365:read. */
const M365_DENIED = Symbol('M365_DENIED');
/** Safe audited denial on an authorized client (02 §1): the permission code only, no link or M365 identifier. */
async function deniedM365(db: PrismaClient, actor: Actor, scope: Scope): Promise<never> {
  await withScope(db, actor, [scope.clientId], tx => tx.auditEvent.create({
    data: clientAuditData(scope, actor.id, 'mapping.denied', randomUUID(), { safeErrorCode: 'PERMISSION_DENIED' }), select: { id: true } }));
  throw new AtlasError('PERMISSION_DENIED', 'SCOPE');
}
const settle = <T>(db: PrismaClient, actor: Actor, scope: Scope) => (result: T | typeof M365_DENIED): Promise<T> =>
  result === M365_DENIED ? deniedM365(db, actor, scope) : Promise.resolve(result);

export const EXTERNAL_ID_PATTERN = /^[\x21-\x7e]{1,128}$/;
const ATTRIBUTE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const REVIEW_PAGE_LIMIT = 100;

/** Source attributes are untrusted: at most 16 string values of 256 characters, storable as PostgreSQL text. */
export function assertStorableAttributes(attributes: Record<string, string>): void {
  const entries = attributes && typeof attributes === 'object' && !Array.isArray(attributes) ? Object.entries(attributes) : null;
  if (!entries || entries.length > 16 || entries.some(([key, value]) => !ATTRIBUTE_KEY_PATTERN.test(key) || typeof value !== 'string'
    || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value) || /\p{Cs}/u.test(value))) {
    throw new AtlasError('INVALID_EXTERNAL_ATTRIBUTES', 'VALIDATION');
  }
}
function assertRowId(id: unknown, code: string): void {
  if (typeof id !== 'string' || !SCOPE_ID_PATTERN.test(id)) throw new AtlasError(code, 'VALIDATION');
}
/** One retry after a lost race on a unique key: the second attempt sees the winner's committed row and decides from it. */
async function retryOnce<T>(attempt: () => Promise<T>): Promise<T> {
  try { return await attempt(); }
  catch (error) { if (uniqueViolation(error) === null) throw error; return attempt(); }
}
const scopeOf = (s: Scope): Scope => ({ workspaceId: s.workspaceId, clientId: s.clientId });

export interface ExternalEntityInput { resourceType: ResourceType; externalId: string; attributes: Record<string, string>; observedAt: Date }

/**
 * Sync order step 4 (docs/03): record an identity object read under a ResolvedConnection. Idempotent per connection +
 * resourceType + externalId; a newer observation replaces the attributes, an older one never overwrites them.
 */
export async function registerExternalEntity(db: PrismaClient, actor: Actor, connection: ResolvedConnection,
  input: ExternalEntityInput): Promise<{ id: string; created: boolean }> {
  assertResolvedConnection(connection);
  const scope = scopeOf(connection);
  assertPermission(actor, scope, 'events:ingest');
  // M365 mirrors are created only inside directory publication (task 2.5), never through this generic path.
  if (isM365ResourceType(input.resourceType)) throw new AtlasError('M365_MIRROR_PUBLICATION_ONLY', 'VALIDATION');
  if (!linkableKind(input.resourceType)) throw new AtlasError('NOT_AN_IDENTITY_RESOURCE', 'VALIDATION');
  if (!EXTERNAL_ID_PATTERN.test(input.externalId)) throw new AtlasError('INVALID_EXTERNAL_ID', 'VALIDATION');
  assertStorableAttributes(input.attributes);
  if (!(input.observedAt instanceof Date) || Number.isNaN(input.observedAt.getTime())) throw new AtlasError('INVALID_OBSERVED_AT', 'VALIDATION');
  const key = { ...scope, connectionId: connection.connectionId, resourceType: input.resourceType, externalId: input.externalId };
  return retryOnce(() => withScope(db, actor, [scope.clientId], async tx => {
    const where = { workspaceId_clientId_connectionId_resourceType_externalId: key };
    const existing = await tx.externalEntity.findUnique({ where, select: { id: true, observedAt: true } });
    if (existing) {
      if (input.observedAt > existing.observedAt) {
        await tx.externalEntity.update({ where, data: { attributes: input.attributes, observedAt: input.observedAt }, select: { id: true } });
      }
      return { id: existing.id, created: false };
    }
    const id = randomUUID();
    await tx.externalEntity.create({ data: { ...key, id, attributes: input.attributes, observedAt: input.observedAt }, select: { id: true } });
    return { id, created: true };
  }));
}

export interface LinkDecision { linkId: string; status: LinkStatus; conflictsWithLinkId: string | null }

async function createCandidate(tx: Prisma.TransactionClient, scope: Scope, actorId: string,
  input: { externalEntityId: string; entityId: string; method: 'MANUAL' | 'HOSTNAME_EXACT'; correlationId: string }): Promise<LinkDecision> {
  const external = await tx.externalEntity.findUnique({ where: { workspaceId_clientId_id: { ...scope, id: input.externalEntityId } }, select: { id: true, resourceType: true } });
  if (!external) throw new AtlasError('EXTERNAL_ENTITY_NOT_FOUND', 'VALIDATION');
  const entity = await tx.entity.findUnique({ where: { workspaceId_clientId_id: { ...scope, id: input.entityId } }, select: { id: true, kind: true } });
  if (!entity) throw new AtlasError('ENTITY_NOT_FOUND', 'VALIDATION');
  if (linkableKind(external.resourceType) !== entity.kind) throw new AtlasError('INCOMPATIBLE_LINK', 'VALIDATION');
  const pair = { ...scope, externalEntityId: external.id, entityId: entity.id };
  const existing = await tx.entityLink.findUnique({ where: { workspaceId_clientId_externalEntityId_entityId: pair },
    select: { id: true, status: true, conflictsWithLinkId: true } });
  if (existing) return { linkId: existing.id, status: existing.status as LinkStatus, conflictsWithLinkId: existing.conflictsWithLinkId };
  const id = randomUUID();
  await tx.entityLink.create({ data: { ...pair, id, resourceType: external.resourceType, entityKind: entity.kind, status: 'CANDIDATE',
    method: input.method, createdBy: actorId }, select: { id: true } });
  await tx.auditEvent.create({ data: clientAuditData(scope, actorId, 'mapping.link_proposed', input.correlationId,
    { linkId: id, linkStatus: 'CANDIDATE', method: input.method }), select: { id: true } });
  return { linkId: id, status: 'CANDIDATE', conflictsWithLinkId: null };
}

/**
 * Manual proposal (mapping:review; m365:read too for an M365 object). Idempotent per (external object, entity): an
 * existing link is returned unchanged.
 */
export async function proposeLink(db: PrismaClient, actor: Actor, scope: Scope, link: { externalEntityId: string; entityId: string }): Promise<LinkDecision> {
  assertPermission(actor, scope, 'mapping:review');
  assertRowId(link.externalEntityId, 'EXTERNAL_ENTITY_NOT_FOUND'); assertRowId(link.entityId, 'ENTITY_NOT_FOUND');
  const ids = scopeOf(scope);
  return retryOnce(() => withScope(db, actor, [ids.clientId], async tx => {
    const external = await tx.externalEntity.findUnique({ where: { workspaceId_clientId_id: { ...ids, id: link.externalEntityId } }, select: { resourceType: true } });
    if (external && isM365ResourceType(external.resourceType) && !mayReviewM365(actor, ids.clientId)) return M365_DENIED;
    return createCandidate(tx, ids, actor.id, { externalEntityId: link.externalEntityId, entityId: link.entityId, method: 'MANUAL', correlationId: randomUUID() });
  })).then(settle<LinkDecision>(db, actor, ids));
}

export type Suggestion =
  | { outcome: 'CANDIDATE'; linkId: string }
  | { outcome: 'AMBIGUOUS'; reasonCode: 'MULTIPLE_DEVICES' | 'DEVICE_ALREADY_CLAIMED' }
  | { outcome: 'ALREADY_LINKED' | 'NO_EVIDENCE' | 'NO_MATCH' };

/**
 * Matcher after a sync page (docs/02, rule 2): exact case-insensitive hostname match inside the connection's client only.
 * One device → CANDIDATE (HOSTNAME_EXACT), never CONFIRMED. Several devices with that hostname, or a device already
 * confirmed for another agent of this connection, is ambiguous: no link is created and the refusal is audited for review.
 */
export async function suggestDeviceCandidate(db: PrismaClient, actor: Actor, connection: ResolvedConnection, externalEntityId: string): Promise<Suggestion> {
  assertResolvedConnection(connection);
  const scope = scopeOf(connection);
  assertPermission(actor, scope, 'events:ingest');
  assertRowId(externalEntityId, 'EXTERNAL_ENTITY_NOT_FOUND');
  return retryOnce(() => withScope(db, actor, [scope.clientId], async (tx): Promise<Suggestion> => {
    const external = await tx.externalEntity.findUnique({ where: { workspaceId_clientId_id: { ...scope, id: externalEntityId } },
      select: { id: true, connectionId: true, resourceType: true, attributes: true } });
    if (!external || external.connectionId !== connection.connectionId) throw new AtlasError('EXTERNAL_ENTITY_NOT_FOUND', 'VALIDATION');
    if (external.resourceType !== 'agent') throw new AtlasError('INCOMPATIBLE_LINK', 'VALIDATION');
    if (await tx.entityLink.findFirst({ where: { ...scope, externalEntityId: external.id, status: 'CONFIRMED' }, select: { id: true } })) return { outcome: 'ALREADY_LINKED' };
    const hostname = (external.attributes as Record<string, unknown> | null)?.hostname;
    if (typeof hostname !== 'string' || hostname.trim() === '') return { outcome: 'NO_EVIDENCE' };
    // Equality on lower(), not LIKE: '_' or '%' in a hostname is never a wildcard.
    const devices = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Device" WHERE "workspaceId" = ${scope.workspaceId}
      AND "clientId" = ${scope.clientId} AND lower(hostname) = lower(${hostname.trim()}) ORDER BY id LIMIT 2`;
    if (devices.length === 0) return { outcome: 'NO_MATCH' };
    const device = devices[0]!.id;
    const reasonCode = devices.length > 1 ? 'MULTIPLE_DEVICES' as const
      : await tx.entityLink.findFirst({ where: { ...scope, entityId: device, status: 'CONFIRMED', resourceType: 'agent', external: { connectionId: connection.connectionId } },
          select: { id: true } }) ? 'DEVICE_ALREADY_CLAIMED' as const : null;
    const correlationId = randomUUID();
    if (reasonCode) {
      await tx.auditEvent.create({ data: clientAuditData(scope, actor.id, 'mapping.suggestion_ambiguous', correlationId,
        { externalEntityId: external.id, safeErrorCode: reasonCode }), select: { id: true } });
      return { outcome: 'AMBIGUOUS', reasonCode };
    }
    const decision = await createCandidate(tx, scope, actor.id, { externalEntityId: external.id, entityId: device, method: 'HOSTNAME_EXACT', correlationId });
    return { outcome: 'CANDIDATE', linkId: decision.linkId };
  }));
}

/** Decisions about one external object are serialized: concurrent decisions queue here and see each other's commits. */
async function lockedLink(tx: Prisma.TransactionClient, scope: Scope, linkId: string) {
  const target = await tx.entityLink.findUnique({ where: { workspaceId_clientId_id: { ...scope, id: linkId } }, select: { externalEntityId: true } });
  if (!target) throw new AtlasError('LINK_NOT_FOUND', 'VALIDATION');
  await tx.$queryRaw`SELECT id FROM "ExternalEntity" WHERE "workspaceId" = ${scope.workspaceId} AND "clientId" = ${scope.clientId}
    AND id = ${target.externalEntityId} FOR UPDATE`;
  return tx.entityLink.findUniqueOrThrow({ where: { workspaceId_clientId_id: { ...scope, id: linkId } },
    select: { id: true, externalEntityId: true, status: true, conflictsWithLinkId: true } });
}

/**
 * Explicit confirmation (mapping:review). The first confirmation of an external object wins; a later conflicting one is
 * QUARANTINED with a pointer to the confirmed link (the partial unique index stays the last guard: a lost race is retried
 * once and then decided the same way). Re-confirming a CONFIRMED link is a no-op; a REJECTED or QUARANTINED link can be
 * confirmed by a new explicit decision and is checked for conflicts exactly like a candidate.
 * The decision time comes from `clock` AFTER every lock of the attempt was acquired (each retry reads it again), so a lock
 * wait can never carry a stale "now" past the M365 freshness or payload-expiry boundary; it is also the persisted
 * confirmedAt/reviewedAt (the audit row keeps the database's recordedAt, as for every Stage 1 audit row).
 */
export async function confirmLink(db: PrismaClient, actor: Actor, scope: Scope, linkId: string,
  clock: () => Date = () => new Date()): Promise<LinkDecision> {
  assertPermission(actor, scope, 'mapping:review');
  assertRowId(linkId, 'LINK_NOT_FOUND');
  const ids = scopeOf(scope);
  return retryOnce(() => withScope(db, actor, [ids.clientId], async (tx): Promise<LinkDecision | typeof M365_DENIED> => {
    const target = await linkTarget(tx, ids, linkId);
    const m365 = isM365ResourceType(target.resourceType);
    if (m365 && !mayReviewM365(actor, ids.clientId)) return M365_DENIED;
    if (m365) await lockM365Directory(tx, ids, target);
    const link = await lockedLink(tx, ids, linkId);
    const now = clock(); // all locks held: the decision clock is read here, never before a wait
    if (link.status === 'CONFIRMED') return { linkId, status: 'CONFIRMED', conflictsWithLinkId: null };
    const confirmed = await tx.entityLink.findFirst({ where: { ...ids, externalEntityId: link.externalEntityId, status: 'CONFIRMED' }, select: { id: true } });
    const where = { workspaceId_clientId_id: { ...ids, id: linkId } };
    const correlationId = randomUUID();
    if (confirmed) {
      await tx.entityLink.update({ where, select: { id: true }, data: { status: 'QUARANTINED', reviewedBy: actor.id, reviewedAt: now,
        reasonCode: 'CONFLICTS_WITH_CONFIRMED', conflictsWithLinkId: confirmed.id } });
      await tx.auditEvent.create({ data: clientAuditData(ids, actor.id, 'mapping.link_quarantined', correlationId,
        { linkId, conflictsWithLinkId: confirmed.id, linkStatus: 'QUARANTINED', safeErrorCode: 'CONFLICTS_WITH_CONFIRMED' }), select: { id: true } });
      return { linkId, status: 'QUARANTINED', conflictsWithLinkId: confirmed.id };
    }
    if (m365) await assertFreshM365Membership(tx, ids, link.externalEntityId, target, now);
    await tx.entityLink.update({ where, select: { id: true }, data: { status: 'CONFIRMED', confirmedBy: actor.id, confirmedAt: now,
      reviewedBy: actor.id, reviewedAt: now, reasonCode: null, conflictsWithLinkId: null } });
    await tx.auditEvent.create({ data: clientAuditData(ids, actor.id, 'mapping.link_confirmed', correlationId, { linkId, linkStatus: 'CONFIRMED' }), select: { id: true } });
    return { linkId, status: 'CONFIRMED', conflictsWithLinkId: null };
  })).then(settle<LinkDecision>(db, actor, ids));
}

/** Explicit rejection (mapping:review); for a CONFIRMED link this is a revocation. The reason is a code, never free text. */
export async function rejectLink(db: PrismaClient, actor: Actor, scope: Scope, linkId: string, reasonCode = 'MANUAL_REJECT',
  now: Date = new Date()): Promise<LinkDecision> {
  assertPermission(actor, scope, 'mapping:review');
  assertRowId(linkId, 'LINK_NOT_FOUND');
  if (!REASON_CODE_PATTERN.test(reasonCode)) throw new AtlasError('INVALID_REASON_CODE', 'VALIDATION');
  const ids = scopeOf(scope);
  return withScope(db, actor, [ids.clientId], async (tx): Promise<LinkDecision | typeof M365_DENIED> => {
    if (isM365ResourceType((await linkTarget(tx, ids, linkId)).resourceType) && !mayReviewM365(actor, ids.clientId)) return M365_DENIED;
    const link = await lockedLink(tx, ids, linkId);
    if (link.status === 'REJECTED') return { linkId, status: 'REJECTED', conflictsWithLinkId: link.conflictsWithLinkId };
    await tx.entityLink.update({ where: { workspaceId_clientId_id: { ...ids, id: linkId } }, select: { id: true },
      data: { status: 'REJECTED', reviewedBy: actor.id, reviewedAt: now, reasonCode } });
    await tx.auditEvent.create({ data: clientAuditData(ids, actor.id, link.status === 'CONFIRMED' ? 'mapping.link_revoked' : 'mapping.link_rejected',
      randomUUID(), { linkId, linkStatus: 'REJECTED', safeErrorCode: reasonCode }), select: { id: true } });
    return { linkId, status: 'REJECTED', conflictsWithLinkId: link.conflictsWithLinkId };
  }).then(settle<LinkDecision>(db, actor, ids));
}

export interface MappingReviewItem {
  linkId: string; status: LinkStatus; resourceType: string; entityKind: string; entityId: string; externalEntityId: string;
  connectionId: string; system: string; externalId: string; method: string; createdBy: string | null; createdAt: string;
  reviewedBy: string | null; reviewedAt: string | null; reasonCode: string | null; conflictsWithLinkId: string | null;
}

/**
 * Review queue (mapping:review): QUARANTINED conflicts first, then CANDIDATE links, oldest first; at most 100. M365 links
 * are part of it only for a reviewer who also holds m365:read on this client; otherwise the query itself excludes them.
 */
export async function listMappingReview(db: PrismaClient, actor: Actor, scope: Scope): Promise<MappingReviewItem[]> {
  assertPermission(actor, scope, 'mapping:review');
  const ids = scopeOf(scope);
  const types = mayReviewM365(actor, ids.clientId) ? {} : { resourceType: { notIn: [...M365_RESOURCE_TYPES] } };
  const rows = await withScope(db, actor, [ids.clientId], tx => tx.entityLink.findMany({
    where: { ...ids, ...types, status: { in: ['QUARANTINED', 'CANDIDATE'] } },
    // 'QUARANTINED' sorts after 'CANDIDATE', so descending status puts conflicts first.
    orderBy: [{ status: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }], take: REVIEW_PAGE_LIMIT,
    select: { id: true, status: true, resourceType: true, entityKind: true, entityId: true, externalEntityId: true, method: true,
      createdBy: true, createdAt: true, reviewedBy: true, reviewedAt: true, reasonCode: true, conflictsWithLinkId: true,
      external: { select: { externalId: true, connection: { select: { id: true, system: true } } } } } }));
  return rows.map(r => ({ linkId: r.id, status: r.status as LinkStatus, resourceType: r.resourceType, entityKind: r.entityKind, entityId: r.entityId,
    externalEntityId: r.externalEntityId, connectionId: r.external.connection.id, system: r.external.connection.system, externalId: r.external.externalId,
    method: r.method, createdBy: r.createdBy, createdAt: r.createdAt.toISOString(), reviewedBy: r.reviewedBy,
    reviewedAt: r.reviewedAt?.toISOString() ?? null, reasonCode: r.reasonCode, conflictsWithLinkId: r.conflictsWithLinkId }));
}
