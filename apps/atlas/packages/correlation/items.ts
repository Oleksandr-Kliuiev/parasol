import { Prisma } from '@prisma/client';
import type { Scope } from '../core/contracts.ts';
import type { M365SignInV1 } from '../../connectors/microsoft365/signin-dto.ts';
import type { CorrelationItem, CorrelationProof, CorrelationRelationCode } from './contracts.ts';
import { CORRELATION_RULE_VERSION } from './contracts.ts';
import type { ConflictContributor, EvidenceRow } from './query.ts';
import type { PathProof, Resolution } from './resolve.ts';

/**
 * Items of one correlation page (02 §4–5, brief RC3). Selection is exactly route (a) ∪ route (b) (query.ts); this module
 * only labels: DEVICE_REFERENCE when the sign-in's deviceDetail.deviceId equals the resolved registration deviceId,
 * ASSIGNED_PERSON_ACTIVITY when its userId equals the assigned person's directory user ID — both on one item when both
 * match — and SIGNIN_USER_REFERENCE + canonicalPersonId as an ANNOTATION when the sign-in userId is a current directory
 * user (usable generation) with exactly one confirmed PERSON link. An annotation never selects an item. A CONFLICTED item
 * (another unexpired published version of its source ID exists) keeps its selected relations and proofs but gets no
 * canonicalPersonId and no SIGNIN_USER_REFERENCE: no identity is chosen from contradictory evidence.
 */
export interface SignInUser { personId: string; linkId: string; linkStatus: string }

/** Current user objects of the generation with exactly one confirmed PERSON link, for the page's user IDs. */
export async function loadSignInUsers(tx: Prisma.TransactionClient, scope: Scope, connectionId: string, generationId: string | null,
  userIds: readonly string[]): Promise<Map<string, SignInUser>> {
  const ids = [...new Set(userIds)];
  if (!generationId || ids.length === 0) return new Map();
  const rows = await tx.$queryRaw<{ userId: string; linkId: string; linkStatus: string; personId: string }[]>`
    SELECT o."sourceObjectId" AS "userId", l.id AS "linkId", l.status AS "linkStatus", l."entityId" AS "personId"
    FROM "M365DirectoryObject" o JOIN "EntityLink" l ON l."workspaceId" = o."workspaceId" AND l."clientId" = o."clientId"
      AND l."externalEntityId" = o."externalEntityId" AND l."resourceType" = 'm365_user' AND l."entityKind" = 'PERSON' AND l.status = 'CONFIRMED'
    WHERE o."workspaceId" = ${scope.workspaceId} AND o."clientId" = ${scope.clientId} AND o."connectionId" = ${connectionId}
      AND o."resourceType" = 'm365_user' AND o."generationId" = ${generationId} AND o."sourceObjectId" IN (${Prisma.join(ids)})`;
  const out = new Map<string, SignInUser>(); const seen = new Map<string, number>();
  for (const r of rows) seen.set(r.userId, (seen.get(r.userId) ?? 0) + 1);
  for (const r of rows) if (seen.get(r.userId) === 1) out.set(r.userId, { personId: r.personId, linkId: r.linkId, linkStatus: r.linkStatus });
  return out;
}
/**
 * Digest of every confirmed m365_user link of the connection: the annotation input of all pages (a confirmation,
 * rejection or reassignment of any user link changes it). Computed in SQL; no ID leaves the database here.
 */
export async function userLinkDigest(tx: Prisma.TransactionClient, scope: Scope, connectionId: string): Promise<string> {
  const [row] = await tx.$queryRaw<{ digest: string }[]>`SELECT encode(sha256(convert_to(coalesce(string_agg(l.id || ':' || l."entityId" || ':' || l."externalEntityId",
      ',' ORDER BY l.id COLLATE "C"), ''), 'UTF8')), 'hex') AS digest
    FROM "EntityLink" l JOIN "ExternalEntity" x ON x."workspaceId" = l."workspaceId" AND x."clientId" = l."clientId" AND x.id = l."externalEntityId"
    WHERE l."workspaceId" = ${scope.workspaceId} AND l."clientId" = ${scope.clientId} AND l."resourceType" = 'm365_user' AND l.status = 'CONFIRMED'
      AND x."connectionId" = ${connectionId}`;
  return row!.digest;
}

/** Source IDs with at least two unexpired published versions. */
export const conflictedSources = (contributors: readonly ConflictContributor[]): Set<string> => new Set(contributors.map(c => c.sourceId));

/** Explicit projection of the stored allowlisted DTO: nothing beyond M365SignInV1 is ever returned. */
export function signInDto(dto: unknown): M365SignInV1 {
  const d = dto as Record<string, unknown>;
  return { id: String(d.id), createdDateTime: String(d.createdDateTime), userId: (d.userId as string | null) ?? null, deviceId: (d.deviceId as string | null) ?? null,
    appId: (d.appId as string | null) ?? null, errorCode: typeof d.errorCode === 'number' ? d.errorCode : null,
    isInteractive: typeof d.isInteractive === 'boolean' ? d.isInteractive : null };
}

const proof = (relation: CorrelationRelationCode, vendorField: string, row: EvidenceRow, path: PathProof): CorrelationProof => ({
  relation, vendorField, evidence: { sourceId: row.sourceId, contentHash: row.contentHash }, linkIds: [...path.linkIds], linkStatuses: [...path.linkStatuses],
  directoryGenerationIds: [...path.directoryGenerationIds], ruleVersion: CORRELATION_RULE_VERSION });

export function correlationItem(row: EvidenceRow, resolution: Resolution, conflicted: Set<string>, users: Map<string, SignInUser>,
  userGenerationId: string | null): CorrelationItem {
  const dto = signInDto(row.dto);
  const proofs: CorrelationProof[] = [];
  if (resolution.userRef && row.userId === resolution.userRef) proofs.push(proof('ASSIGNED_PERSON_ACTIVITY', 'userId', row, resolution.personProof!));
  if (resolution.deviceRef && row.deviceId === resolution.deviceRef) proofs.push(proof('DEVICE_REFERENCE', 'deviceDetail.deviceId', row, resolution.deviceProof!));
  const state = conflicted.has(row.sourceId) ? 'CONFLICTED' : 'CURRENT';
  const user = state === 'CURRENT' && row.userId && userGenerationId ? users.get(row.userId) : undefined;
  if (user) proofs.push(proof('SIGNIN_USER_REFERENCE', 'userId', row, { linkIds: [user.linkId], linkStatuses: [user.linkStatus], directoryGenerationIds: [userGenerationId!] }));
  return { evidenceRef: { sourceId: row.sourceId, contentHash: row.contentHash }, occurredAt: dto.createdDateTime,
    ...(dto.errorCode !== null ? { statusCode: dto.errorCode } : {}), ...(user ? { canonicalPersonId: user.personId } : {}),
    relationCodes: proofs.map(p => p.relation), proof: proofs, evidenceState: state };
}
