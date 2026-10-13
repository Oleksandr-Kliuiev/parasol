import type { Prisma } from '@prisma/client';
import type { Actor, Scope } from '../core/contracts.ts';
import { AtlasError, M365_READ, hasClientPermissions, isM365ResourceType } from '../core/contracts.ts';

/**
 * Microsoft 365 rules of the generic mapping workflow (docs/stage2/02_CONTRACTS.md §1, §3). A link on an m365_* type is a
 * decision about an M365 identity: it needs m365:read together with mapping:review on the same client membership, and a
 * NEW confirmation needs fresh directory evidence — the object is a member of the active published generation, that
 * generation completed less than 60 minutes ago and no newer directory attempt has started since. Stale retained
 * membership keeps existing confirmations usable for reads but never accepts a new one. Names are never evidence.
 */
export const M365_DIRECTORY_FRESH_MS = 60 * 60_000;
const REVIEW_PERMISSIONS = ['mapping:review', M365_READ] as const;

/** Whether the actor may see or decide M365 links of this client (both permissions on one membership). */
export const mayReviewM365 = (actor: Actor, clientId: string): boolean => hasClientPermissions(actor, clientId, REVIEW_PERMISSIONS);

export interface LinkTarget { resourceType: string; connectionId: string }
/** The link's typed resource and its connection, read inside the decision's transaction before any lock is taken. */
export async function linkTarget(tx: Prisma.TransactionClient, scope: Scope, linkId: string): Promise<LinkTarget> {
  const row = await tx.entityLink.findUnique({ where: { workspaceId_clientId_id: { ...scope, id: linkId } },
    select: { resourceType: true, external: { select: { connectionId: true } } } });
  if (!row) throw new AtlasError('LINK_NOT_FOUND', 'VALIDATION');
  return { resourceType: row.resourceType, connectionId: row.external.connectionId };
}

/**
 * Lock order shared with directory publication: Connection, then the resource state, then (in mapping.ts) the external
 * object. FOR SHARE lets confirmations run side by side while publication, disable and cleanup — which take the
 * Connection FOR NO KEY UPDATE — wait, so the freshness checked below cannot change before this transaction commits.
 */
export async function lockM365Directory(tx: Prisma.TransactionClient, scope: Scope, target: LinkTarget): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Connection" WHERE "workspaceId" = ${scope.workspaceId} AND "clientId" = ${scope.clientId}
    AND id = ${target.connectionId} FOR SHARE`;
  await tx.$queryRaw`SELECT "resourceType" FROM "M365ResourceState" WHERE "workspaceId" = ${scope.workspaceId} AND "clientId" = ${scope.clientId}
    AND "connectionId" = ${target.connectionId} AND "resourceType" = ${target.resourceType} FOR SHARE`;
}

/** New confirmation of an M365 link: the typed object is current in a fresh published generation of its connection. */
export async function assertFreshM365Membership(tx: Prisma.TransactionClient, scope: Scope, externalEntityId: string, target: LinkTarget,
  now: Date): Promise<void> {
  const external = await tx.externalEntity.findUnique({ where: { workspaceId_clientId_id: { ...scope, id: externalEntityId } },
    select: { connectionId: true, resourceType: true, connection: { select: { system: true } } } });
  if (!external || external.connectionId !== target.connectionId || external.resourceType !== target.resourceType || !isM365ResourceType(external.resourceType)
    || external.connection.system !== 'microsoft365') {
    throw new AtlasError('LINK_NOT_FOUND', 'VALIDATION');
  }
  const state = await tx.m365ResourceState.findUnique({
    where: { workspaceId_clientId_connectionId_resourceType: { ...scope, connectionId: target.connectionId, resourceType: target.resourceType } },
    select: { activeGenerationId: true, latestStartedSeq: true, latestPublishedSeq: true,
      activeGeneration: { select: { completedAt: true, expiresAt: true } } } });
  const completedAt = state?.activeGeneration?.completedAt ?? null;
  if (!state?.activeGenerationId || !completedAt) throw new AtlasError('M365_DIRECTORY_MISSING', 'CONFLICT');
  const fresh = now.getTime() - completedAt.getTime() < M365_DIRECTORY_FRESH_MS && now < state.activeGeneration!.expiresAt
    && state.latestStartedSeq === state.latestPublishedSeq;
  if (!fresh) throw new AtlasError('M365_DIRECTORY_NOT_FRESH', 'CONFLICT');
  const member = await tx.m365DirectoryObject.findFirst({ where: { ...scope, connectionId: target.connectionId, resourceType: target.resourceType,
    generationId: state.activeGenerationId, externalEntityId }, select: { sourceObjectId: true } });
  if (!member) throw new AtlasError('DIRECTORY_OBJECT_NOT_CURRENT', 'CONFLICT');
}
