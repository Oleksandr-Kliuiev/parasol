import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Actor, Scope } from '../core/contracts.ts';
import { AtlasError } from '../core/contracts.ts';
import { m365Limits } from '../../connectors/microsoft365/contract.ts';
import { clientAuditData } from '../audit/prisma.ts';
import { withScope } from '../graph/scoped-db.ts';
import { assertM365Permissions, lockAndCheck } from './authority.ts';
import { withDenialAudit } from './denial.ts';
import { systemClock } from './io.ts';
import type { Clock } from './io.ts';
import type { DirectoryResource } from './directory.ts';

/**
 * Explicit reset of a directory retry chain (approved corrective policy S2B_RETRY_REPAIR_PLAN_RC2, implementing 03 §6).
 * Operator service only (no CLI/API in S2-B): ACTIVE pinned Connection, current events:ingest + connections:manage, one
 * transaction in the common lock order Connection (SHARE) → state (UPDATE) → latest generation (UPDATE), clock after locks.
 * Refused: a future retryAt (M365_RETRY_NOT_DUE — a reset never bypasses the source's delay), a live STAGING claim of the
 * latest attempt (M365_CLAIM_HELD), a zero budget or a chain that is neither exhausted, failed nor an expired outstanding
 * claim (M365_RESET_NOT_ELIGIBLE). Allowed: started and recorded advance to a common new fence (a delayed old claim can then
 * never record or publish), budget 0, elapsed retryAt cleared; last-good pointer, counts, lastSuccess, the actual failure
 * status/code and all generation history stay. An unrecorded expired chain (PENDING/OK) becomes ERROR/M365_CLAIM_EXPIRED,
 * also when cleanup already removed the expired generation. Audited in the client audit in the same transaction.
 */
export interface DirectoryReset { resourceType: DirectoryResource; attemptSeq: number; previousAttemptsUsed: number; attemptsUsed: 0; status: string; safeErrorCode: string | null }

export function resetM365DirectoryRetry(db: PrismaClient, actor: Actor, scope: Scope, connectionId: string, resourceType: DirectoryResource,
  clock: Clock = systemClock): Promise<DirectoryReset> {
  return withDenialAudit(db, actor, scope, 'm365.directory_reset_denied', async () => {
    assertM365Permissions(actor, scope, 'sync', connectionId);
    if (resourceType !== 'm365_user' && resourceType !== 'm365_device') throw new AtlasError('M365_RESOURCE_UNSUPPORTED', 'VALIDATION');
    const key = { workspaceId: scope.workspaceId, clientId: scope.clientId, connectionId, resourceType };
    return withScope(db, actor, [scope.clientId], async tx => {
      await lockAndCheck(tx, actor, scope, connectionId, 'sync');
      const [state] = await tx.$queryRaw<{ started: number; recorded: number; used: number; retryAt: Date | null; status: string; code: string | null }[]>`
        SELECT "latestStartedSeq" AS started, "latestRecordedSeq" AS recorded, "attemptsUsed" AS used, "retryAt", status, "safeErrorCode" AS code
        FROM "M365ResourceState" WHERE "workspaceId" = ${key.workspaceId} AND "clientId" = ${key.clientId} AND "connectionId" = ${connectionId}
          AND "resourceType" = ${resourceType} FOR UPDATE`;
      const [latest] = state ? await tx.$queryRaw<{ state: string; leaseExpiresAt: Date | null }[]>`SELECT state, "leaseExpiresAt" FROM "M365DirectoryGeneration"
        WHERE "workspaceId" = ${key.workspaceId} AND "clientId" = ${key.clientId} AND "connectionId" = ${connectionId} AND "resourceType" = ${resourceType}
          AND "attemptSeq" = ${state.started} FOR UPDATE` : [];
      const now = clock(); // every lock held
      if (!state || Number(state.used) === 0) throw new AtlasError('M365_RESET_NOT_ELIGIBLE', 'VALIDATION');
      if (state.retryAt && state.retryAt.getTime() > now.getTime()) {
        throw new AtlasError('M365_RETRY_NOT_DUE', 'TRANSIENT', { retryAt: state.retryAt.toISOString() });
      }
      if (latest?.state === 'STAGING' && latest.leaseExpiresAt && latest.leaseExpiresAt.getTime() > now.getTime()) throw new AtlasError('M365_CLAIM_HELD', 'CONFLICT');
      const used = Number(state.used); const started = Number(state.started);
      const eligible = used >= m365Limits.directory.maxAttempts || state.status === 'ERROR' || state.status === 'MISSING' || Number(state.recorded) < started;
      if (!eligible) throw new AtlasError('M365_RESET_NOT_ELIGIBLE', 'VALIDATION');
      const fence = started + 1;
      const unrecorded = state.status === 'PENDING' || state.status === 'OK';
      const status = unrecorded ? 'ERROR' : state.status; const code = unrecorded ? 'M365_CLAIM_EXPIRED' : state.code;
      await tx.$executeRaw`UPDATE "M365ResourceState" SET "latestStartedSeq" = ${fence}, "latestRecordedSeq" = ${fence}, "attemptsUsed" = 0, "retryAt" = NULL,
        status = ${status}, "safeErrorCode" = ${code}, "lastAttemptAt" = GREATEST("lastAttemptAt", ${now})
        WHERE "workspaceId" = ${key.workspaceId} AND "clientId" = ${key.clientId} AND "connectionId" = ${connectionId} AND "resourceType" = ${resourceType}`;
      await tx.auditEvent.create({ data: clientAuditData(scope, actor.id, 'm365.directory_retry_reset', randomUUID(), { connectionId, system: 'microsoft365',
        resourceType, attemptSeq: String(fence), attemptsUsed: String(used) }), select: { id: true } });
      return { resourceType, attemptSeq: fence, previousAttemptsUsed: used, attemptsUsed: 0 as const, status, safeErrorCode: code };
    });
  });
}
