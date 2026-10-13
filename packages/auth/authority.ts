import type { Prisma } from '@prisma/client';
import type { Actor } from '../core/contracts.ts';

/**
 * Current authority inside a transaction (docs/stage2/02_CONTRACTS.md §1). The Actor object was resolved when the request
 * or command authenticated; a lifecycle change that commits later — under a row lock it may have waited for — rechecks
 * that the actor is still ACTIVE and that one membership of the client still holds every permission. Reads through the
 * authentication lookup policy of migration 202610071600 (app.actor_id within the transaction's workspace), as the
 * confined runtime role; nothing is taken from the caller.
 */
export async function hasCurrentClientPermissions(tx: Prisma.TransactionClient, actor: Actor, clientId: string,
  permissions: readonly string[]): Promise<boolean> {
  await tx.$queryRaw`SELECT set_config('app.actor_id', ${actor.id}, true)`;
  const row = await tx.actor.findUnique({ where: { workspaceId_id: { workspaceId: actor.workspaceId, id: actor.id } },
    select: { status: true, memberships: { where: { clientId }, select: { permissions: true } } } });
  return permissions.length > 0 && row?.status === 'ACTIVE' && row.memberships.some(m => permissions.every(p => m.permissions.includes(p)));
}
