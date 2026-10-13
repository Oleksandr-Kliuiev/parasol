import { createHash } from 'node:crypto';
import type { PrismaClient, Prisma } from '@prisma/client';
import type { Actor, Scope } from '../core/contracts.ts';
import type { M365DeviceV1, M365UserV1 } from '../../connectors/microsoft365/directory-dto.ts';
import { assessCoverage } from '../correlation/coverage.ts';
import { checkCursor, cursorExpired, cursorExpiry, digestOf, issueCursor, requireCursorKey } from '../correlation/cursor.ts';
import type { CursorClaims, CursorKey } from '../correlation/cursor.ts';
import { conflictedSources, signInDto } from '../correlation/items.ts';
import { parseDirectoryListInput, parseSignInListInput } from '../correlation/parameters.ts';
import type { SignInListInput } from '../correlation/parameters.ts';
import type { DbClock } from '../correlation/time.ts';
import { conflictContributors, contributorFingerprint, loadCapability, loadRoots, positionOf, selectionPage, selectionStats } from '../correlation/query.ts';
import type { SelectionSpec } from '../correlation/query.ts';
import { assertInterval, assertUnexpired, auditRead, pageClaims, signInTransitions } from '../correlation/read.ts';
import type { ReadDeps } from '../correlation/read.ts';
import { directoryFingerprint, directoryResource, directoryTransitions, directoryUsability, loadDirectory } from '../correlation/resolve.ts';
import { assertReadable, guardedRead, READ_PERMISSIONS, readSelectedConnection, withReadSnapshot } from '../correlation/snapshot.ts';
import type { DirectoryListV1, SignInListV1 } from './read-contracts.ts';
import { DIRECTORY_LIST_CONTRACT_VERSION, SIGNIN_LIST_CONTRACT_VERSION } from './read-contracts.ts';

/**
 * Permission-gated stored-data reads of the M365 evidence (brief RC3): context:read + m365:read on one membership, the
 * selected connection ACTIVE/bound/microsoft365 and not FIXTURE, one RepeatableRead snapshot with current authority and
 * the database clock (correlation/snapshot.ts), query-time expiry, approved DTO projections only and the shared
 * authenticated cursor. No credential, token or upstream I/O. Denials: one workspace denial per read.
 */
export const SIGNINS_DENIED_EVENT = 'm365.signins_read_denied';
export const DIRECTORY_DENIED_EVENT = 'm365.directory_read_denied';

/** microsoft365.signin.list: every eligible published sign-in of the interval with the correlation resource/coverage envelope. */
export function readSignIns(db: PrismaClient, actor: Actor, scope: Scope, raw: unknown, deps: ReadDeps): Promise<SignInListV1> {
  const auth = { actor, scope, permissions: READ_PERMISSIONS, deniedEvent: SIGNINS_DENIED_EVENT };
  return guardedRead(db, auth, async () => {
    const input = parseSignInListInput(raw);
    const key = requireCursorKey(deps.cursorKey);
    const claims = pageClaims(key, input.cursor);
    return withReadSnapshot(db, auth, (tx, clock) => signInsPage(tx, actor, scope, input, key, claims, deps, clock));
  });
}

/** One sign-in list page inside the caller's snapshot (authority established there); exported for deterministic clock tests. */
export async function signInsPage(tx: Prisma.TransactionClient, actor: Actor, scope: Scope, input: SignInListInput, key: CursorKey,
  claims: CursorClaims | null, deps: ReadDeps, clock: DbClock): Promise<SignInListV1> {
  assertUnexpired(claims, clock);
  assertInterval(input, clock);
  const connection = await readSelectedConnection(tx, scope, input.connectionId);
  assertReadable(connection);
  const assessed = assessCoverage(await loadRoots(tx, scope, connection.id, input.from, input.to), await loadCapability(tx, scope, connection.id),
    input.from, input.to, clock);
  const spec: SelectionSpec = { scope, connectionId: connection.id, from: input.from, to: input.to, clock, published: assessed.published };
  const available = assessed.coverage.status !== 'UNAVAILABLE';
  const stats = available ? await selectionStats(tx, spec) : { total: 0, earliestExpiryMs: null };
  const contributors = available ? await conflictContributors(tx, spec) : [];
  const binding = digestOf({ op: SIGNIN_LIST_CONTRACT_VERSION, workspaceId: scope.workspaceId, clientId: scope.clientId, actorId: actor.id,
    permissions: [...READ_PERMISSIONS].sort(), connectionId: connection.id, from: input.from, to: input.to, limit: input.limit });
  const fingerprint = digestOf({ connection: [connection.status, connection.lifecycleVersion], coverage: assessed.fingerprint,
    conflicts: contributorFingerprint(contributors) });
  if (claims) checkCursor(claims, clock.now.getTime(), binding, fingerprint);
  const after = claims ? await positionOf(tx, spec, claims.p) : null;
  if (claims && !after) throw cursorExpired();
  const rows = available ? await selectionPage(tx, spec, after, input.limit) : [];
  const pageRows = rows.slice(0, input.limit); const more = rows.length > input.limit;
  const conflicted = conflictedSources(contributors);
  const transitions = signInTransitions(input, assessed.transitions, stats.earliestExpiryMs, contributors);
  const nextCursor = more ? issueCursor(key, { b: binding, f: fingerprint, p: pageRows.at(-1)!.id, e: cursorExpiry(clock, transitions) }) : null;
  const items = available ? pageRows.map(r => {
    const dto = signInDto(r.dto);
    return { evidenceRef: { sourceId: r.sourceId, contentHash: r.contentHash }, occurredAt: dto.createdDateTime, dto,
      evidenceState: conflicted.has(r.sourceId) ? 'CONFLICTED' as const : 'CURRENT' as const };
  }) : null;
  await auditRead(tx, scope, actor, deps.correlationId, { connectionId: connection.id, itemCount: String(items?.length ?? 0), total: String(stats.total),
    coverageStatus: assessed.coverage.status }, 'm365.signins_read');
  return { contractVersion: SIGNIN_LIST_CONTRACT_VERSION, mode: 'db', workspaceId: scope.workspaceId, clientId: scope.clientId, m365ConnectionId: connection.id,
    window: { fromInclusive: input.from, toExclusive: input.to }, resources: [assessed.resource], coverage: assessed.coverage, items, total: stats.total,
    truncated: more, nextCursor };
}

/** SHA-256 hex of a directory source-object key: the cursor position, looked up only inside the current generation. */
export const directoryPosition = (sourceObjectId: string): string => createHash('sha256').update(sourceObjectId, 'utf8').digest('hex');

/** Explicit approved DTO projection (02 §2) of a stored directory object. */
function directoryDto(resourceType: 'm365_user' | 'm365_device', dto: unknown): M365UserV1 | M365DeviceV1 {
  const d = dto as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' ? v : null); const bool = (v: unknown) => (typeof v === 'boolean' ? v : null);
  if (resourceType === 'm365_user') {
    const type = d.userType === 'MEMBER' || d.userType === 'GUEST' || d.userType === 'UNKNOWN' ? d.userType : null;
    return { id: String(d.id), displayName: text(d.displayName), userPrincipalName: text(d.userPrincipalName), userType: type, accountEnabled: bool(d.accountEnabled) };
  }
  return { id: String(d.id), deviceId: text(d.deviceId), displayName: text(d.displayName), accountEnabled: bool(d.accountEnabled), operatingSystem: text(d.operatingSystem) };
}

async function directoryPage(tx: Prisma.TransactionClient, scope: Scope, connectionId: string, resourceType: string, generationId: string,
  after: string | null, limit: number): Promise<{ sourceObjectId: string; dto: unknown }[]> {
  return after === null
    ? tx.$queryRaw`SELECT "sourceObjectId", dto FROM "M365DirectoryObject" WHERE "workspaceId" = ${scope.workspaceId} AND "clientId" = ${scope.clientId}
        AND "connectionId" = ${connectionId} AND "resourceType" = ${resourceType} AND "generationId" = ${generationId}
        ORDER BY "sourceObjectId" COLLATE "C" LIMIT ${limit + 1}`
    : tx.$queryRaw`SELECT "sourceObjectId", dto FROM "M365DirectoryObject" WHERE "workspaceId" = ${scope.workspaceId} AND "clientId" = ${scope.clientId}
        AND "connectionId" = ${connectionId} AND "resourceType" = ${resourceType} AND "generationId" = ${generationId}
        AND "sourceObjectId" COLLATE "C" > ${after} COLLATE "C" ORDER BY "sourceObjectId" COLLATE "C" LIMIT ${limit + 1}`;
}

/** m365-directory: approved DTOs of the usable (unexpired, possibly STALE) active generation, generation-bound paging. */
export function readDirectory(db: PrismaClient, actor: Actor, scope: Scope, raw: unknown, deps: ReadDeps): Promise<DirectoryListV1> {
  const auth = { actor, scope, permissions: READ_PERMISSIONS, deniedEvent: DIRECTORY_DENIED_EVENT };
  return guardedRead(db, auth, async () => {
    const input = parseDirectoryListInput(raw);
    const key = requireCursorKey(deps.cursorKey);
    const claims = pageClaims(key, input.cursor);
    return withReadSnapshot(db, auth, async (tx, clock) => {
      assertUnexpired(claims, clock);
      const connection = await readSelectedConnection(tx, scope, input.connectionId);
      assertReadable(connection);
      const state = (await loadDirectory(tx, scope, connection.id))[input.resourceType];
      const resource = directoryResource(input.resourceType, state, clock);
      const usability = directoryUsability(state, clock);
      const generationId = usability === 'FRESH' || usability === 'STALE' ? state!.activeGenerationId! : null;
      const binding = digestOf({ op: DIRECTORY_LIST_CONTRACT_VERSION, workspaceId: scope.workspaceId, clientId: scope.clientId, actorId: actor.id,
        permissions: [...READ_PERMISSIONS].sort(), connectionId: connection.id, resourceType: input.resourceType, limit: input.limit });
      const fingerprint = digestOf({ connection: [connection.status, connection.lifecycleVersion], directory: directoryFingerprint(state) });
      if (claims) checkCursor(claims, clock.now.getTime(), binding, fingerprint);
      let after: string | null = null;
      if (claims) {
        const [row] = generationId ? await tx.$queryRaw<{ sourceObjectId: string }[]>`SELECT "sourceObjectId" FROM "M365DirectoryObject"
          WHERE "workspaceId" = ${scope.workspaceId} AND "clientId" = ${scope.clientId} AND "connectionId" = ${connection.id}
            AND "resourceType" = ${input.resourceType} AND "generationId" = ${generationId}
            AND encode(sha256(convert_to("sourceObjectId", 'UTF8')), 'hex') = ${claims.p}` : [];
        if (!row) throw cursorExpired();
        after = row.sourceObjectId;
      }
      const total = generationId ? await tx.m365DirectoryObject.count({ where: { ...scope, connectionId: connection.id, resourceType: input.resourceType, generationId } }) : 0;
      const rows = generationId ? await directoryPage(tx, scope, connection.id, input.resourceType, generationId, after, input.limit) : [];
      const pageRows = rows.slice(0, input.limit); const more = rows.length > input.limit;
      const nextCursor = more ? issueCursor(key, { b: binding, f: fingerprint, p: directoryPosition(pageRows.at(-1)!.sourceObjectId),
        e: cursorExpiry(clock, directoryTransitions(state, clock)) }) : null;
      const items = generationId ? pageRows.map(r => directoryDto(input.resourceType, r.dto)) : null;
      await auditRead(tx, scope, actor, deps.correlationId, { connectionId: connection.id, resourceType: input.resourceType, itemCount: String(items?.length ?? 0),
        total: String(total) }, 'm365.directory_read');
      return { contractVersion: DIRECTORY_LIST_CONTRACT_VERSION, mode: 'db', workspaceId: scope.workspaceId, clientId: scope.clientId, m365ConnectionId: connection.id,
        resourceType: input.resourceType, resource, items: items as M365UserV1[] | M365DeviceV1[] | null, total, truncated: more, nextCursor };
    });
  });
}
