import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Actor, Scope } from '../core/contracts.ts';
import { AtlasError, assertPermission, safeErrorCode } from '../core/contracts.ts';
import { withScope } from '../graph/scoped-db.ts';
import { SCOPE_ID_PATTERN } from '../graph/scope-context.ts';
import { clientAuditData, PrismaSecurityAudit } from '../audit/prisma.ts';
import { hasCurrentClientPermissions } from '../auth/authority.ts';
import { mapFenceError } from '../graph/fence-errors.ts';
import { m365TokenCache } from '../../connectors/microsoft365/auth.ts';

/**
 * Local disable ("revoke") of a Microsoft 365 connection (docs/stage2/02_CONTRACTS.md §1, CLI `m365-disable`). One
 * transaction: lock the Connection row (FOR NO KEY UPDATE — the fence that publication and cleanup take in the same
 * order), recheck the actor's CURRENT connections:manage on the client, require system microsoft365 and status ACTIVE or
 * DISABLED (FIXTURE is refused), then set DISABLED, increment lifecycleVersion — even when already DISABLED, so every
 * pending activation capability and token-cache entry of the old version stops working — and write the allowlisted
 * `connection.disabled` audit row. Output: local connection ID, status and version only. No upstream call, no credential
 * deletion, no new status. A publisher that loses the lock race finds the new version and cannot publish.
 */
export interface M365DisableResult { connectionId: string; status: 'DISABLED'; lifecycleVersion: number }

export async function disableM365Connection(db: PrismaClient, actor: Actor, scope: Scope, connectionId: string): Promise<M365DisableResult> {
  assertPermission(actor, scope, 'connections:manage');
  if (!SCOPE_ID_PATTERN.test(connectionId)) throw new AtlasError('CONNECTION_NOT_FOUND', 'VALIDATION');
  const ids = { workspaceId: scope.workspaceId, clientId: scope.clientId };
  const correlationId = randomUUID();
  try {
    const result = await withScope(db, actor, [ids.clientId], async tx => {
      const [row] = await tx.$queryRaw<{ system: string; status: string }[]>`SELECT system, status FROM "Connection"
        WHERE "workspaceId" = ${ids.workspaceId} AND "clientId" = ${ids.clientId} AND id = ${connectionId} FOR NO KEY UPDATE`;
      if (!row) throw new AtlasError('CONNECTION_NOT_FOUND', 'VALIDATION');
      if (!await hasCurrentClientPermissions(tx, actor, ids.clientId, ['connections:manage'])) throw new AtlasError('PERMISSION_DENIED', 'SCOPE');
      if (row.system !== 'microsoft365') throw new AtlasError('CONNECTION_NOT_M365', 'VALIDATION');
      if (row.status === 'FIXTURE') throw new AtlasError('FIXTURE_CONNECTION_NOT_SUPPORTED', 'VALIDATION');
      if (row.status !== 'ACTIVE' && row.status !== 'DISABLED') throw new AtlasError('CONNECTION_STATUS_UNSUPPORTED', 'VALIDATION');
      const updated = await tx.connection.update({ where: { workspaceId_clientId_id: { ...ids, id: connectionId } },
        data: { status: 'DISABLED', lifecycleVersion: { increment: 1 } }, select: { lifecycleVersion: true } });
      await tx.auditEvent.create({ data: clientAuditData(ids, actor.id, 'connection.disabled', correlationId, { connectionId, system: 'microsoft365',
        previousStatus: row.status, connectionStatus: 'DISABLED', lifecycleVersion: String(updated.lifecycleVersion) }), select: { id: true } });
      return { connectionId, status: 'DISABLED' as const, lifecycleVersion: updated.lifecycleVersion };
    });
    // Local eviction after the commit; other processes find the new version at their authority recheck (version-keyed cache).
    m365TokenCache.evictConnection(ids.workspaceId, ids.clientId, connectionId);
    return result;
  } catch (caught) {
    // Stage 3: emergency disable also increments the workspace authority fence and fails closed (ACTION_FENCE_NOT_READY)
    // when that fence is missing or corrupt — docs/RUNBOOK.md: offline, separately reviewed repair only.
    const error = mapFenceError(caught);
    const code = safeErrorCode(error);
    if (code === 'PERMISSION_DENIED') {
      // Authority withdrawn since authentication: a workspace denial, never a write into a client the actor may have lost.
      await new PrismaSecurityAudit(db, actor).append({ workspaceId: actor.workspaceId, actorId: actor.id, eventType: 'connection.disable_denied',
        outcome: 'DENIED', requestedClientId: ids.clientId, reasonCode: code, correlationId, metadata: {} });
    } else if (error instanceof AtlasError && error.kind === 'VALIDATION') {
      await withScope(db, actor, [ids.clientId], tx => tx.auditEvent.create({
        data: clientAuditData(ids, actor.id, 'connection.disable_rejected', correlationId, { connectionId, safeErrorCode: code }), select: { id: true } }));
    }
    throw error;
  }
}
