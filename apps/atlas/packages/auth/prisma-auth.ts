import type { PrismaClient, Prisma } from '@prisma/client';
import type { Actor } from '../core/contracts.ts';
import { hashToken } from './token.ts';

/**
 * Resolves a bearer token to the verified Actor. Memberships with per-client permissions and workspace permissions come
 * from the database, never from the request, a model or an AI output. Runs as the confined runtime role in one
 * transaction along the lookup policies of migration 202610071600: first only the token row with this digest is
 * visible, then only the actor it names and that actor's memberships. Unknown, revoked or expired tokens and disabled
 * actors all return null (HTTP 401, no detail). Every setting is transaction-local and ends with the transaction.
 */
export async function authenticateToken(db: PrismaClient, token: string, now: Date = new Date()): Promise<Actor | null> {
  const tokenHash = hashToken(token);
  return db.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT set_config('app.token_hash', ${tokenHash}, true), set_config('app.workspace_id', '', true),
      set_config('app.client_ids', '', true), set_config('app.actor_id', '', true)`;
    const credential = await tx.apiToken.findFirst({
      where: { tokenHash, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      select: { workspaceId: true, actorId: true } });
    if (!credential) return null;
    await tx.$queryRaw`SELECT set_config('app.token_hash', '', true), set_config('app.workspace_id', ${credential.workspaceId}, true),
      set_config('app.actor_id', ${credential.actorId}, true)`;
    const actor = await tx.actor.findUnique({
      where: { workspaceId_id: { workspaceId: credential.workspaceId, id: credential.actorId } },
      select: { id: true, workspaceId: true, status: true, workspacePermissions: true,
        memberships: { select: { clientId: true, permissions: true }, orderBy: { clientId: 'asc' } } } });
    if (!actor || actor.status !== 'ACTIVE') return null;
    return { id: actor.id, workspaceId: actor.workspaceId, workspacePermissions: [...actor.workspacePermissions],
      memberships: actor.memberships.map(m => ({ clientId: m.clientId, permissions: [...m.permissions] })) };
  });
}
