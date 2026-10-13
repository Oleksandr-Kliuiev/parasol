import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Actor, Scope } from '../core/contracts.ts';
import { AtlasError, assertPermission } from '../core/contracts.ts';
import { resolveConnectionForActivation } from '../connections/connections.ts';
import { clientAuditData } from '../audit/prisma.ts';
import { withScope } from '../graph/scoped-db.ts';
import { mapFenceError } from '../graph/fence-errors.ts';
import { connectorFor } from './snapshots.ts';
import type { SyncIo } from './snapshots.ts';

/**
 * Activation of an explicitly bound connection (connections:manage): a health check against the bound tenant with the
 * resolved credential. OK → ACTIVE, recorded with the audit row in one transaction; anything else keeps it DISABLED and
 * records the reason. Only ACTIVE connections are synced from a vendor. Re-activating an ACTIVE connection is a no-op.
 * Microsoft 365 is refused here: it activates only through a versioned one-use capability (packages/m365/activation.ts).
 */
export async function activateConnection(db: PrismaClient, actor: Actor, scope: Scope, connectionId: string, io: SyncIo):
  Promise<{ status: 'ACTIVE' } | { status: 'DISABLED'; safeErrorCode: string }> {
  assertPermission(actor, scope, 'connections:manage');
  const current = await withScope(db, actor, [scope.clientId], tx => tx.connection.findUnique({
    where: { workspaceId_clientId_id: { workspaceId: scope.workspaceId, clientId: scope.clientId, id: connectionId } }, select: { status: true, system: true } }));
  if (current?.system === 'microsoft365') throw new AtlasError('M365_ACTIVATION_CAPABILITY_REQUIRED', 'VALIDATION');
  if (current?.status === 'ACTIVE') return { status: 'ACTIVE' };
  const connection = await resolveConnectionForActivation(db, actor, scope, connectionId);
  if (connection.system === 'microsoft365') throw new AtlasError('M365_ACTIVATION_CAPABILITY_REQUIRED', 'VALIDATION');
  const health = await connectorFor(db, actor, connection, io).healthCheck(connection);
  const ids = { workspaceId: scope.workspaceId, clientId: scope.clientId };
  const metadata = { connectionId, system: connection.system };
  const correlationId = randomUUID();
  if (health.status !== 'OK') {
    const code = health.safeErrorCode ?? 'HEALTH_CHECK_FAILED';
    await withScope(db, actor, [scope.clientId], tx => tx.auditEvent.create({
      data: clientAuditData(ids, actor.id, 'connection.activation_failed', correlationId, { ...metadata, safeErrorCode: code }), select: { id: true } }));
    return { status: 'DISABLED', safeErrorCode: code };
  }
  await withScope(db, actor, [scope.clientId], async tx => {
    // Shared lifecycle fence (Stage 2): every activation increments lifecycleVersion; the public result is unchanged.
    // Stage 3: the update also increments the workspace authority fence (ACTION_FENCE_NOT_READY when it is missing).
    await tx.connection.update({ where: { workspaceId_clientId_id: { ...ids, id: connectionId } },
      data: { status: 'ACTIVE', lifecycleVersion: { increment: 1 } }, select: { id: true } });
    await tx.auditEvent.create({ data: clientAuditData(ids, actor.id, 'connection.activated', correlationId, metadata), select: { id: true } });
  }).catch(error => { throw mapFenceError(error); });
  return { status: 'ACTIVE' };
}
