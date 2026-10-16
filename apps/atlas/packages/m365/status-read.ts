import type { PrismaClient } from '@prisma/client';
import type { Actor, Scope } from '../core/contracts.ts';
import { AtlasError } from '../core/contracts.ts';
import { SCOPE_ID_PATTERN } from '../graph/scope-context.ts';
import { guardedRead, readSelectedConnection, STATUS_PERMISSIONS, withReadSnapshot } from '../correlation/snapshot.ts';
import { directoryView } from './status.ts';

/**
 * m365-status (02 §1, brief RC3): connections:manage, bound ACTIVE or DISABLED connection (FIXTURE refused), local
 * metadata only — statuses, sequences, budgets, retry times, local Atlas IDs, counts and safe codes. No DTO, secret,
 * tenant or vendor ID. Root outcomes are derived from the CURRENT root jobs (M365SyncRequest.state stays OPEN by design).
 * The same snapshot discipline as every read: current authority and the database clock; no activation, sync or I/O.
 */
export const STATUS_DENIED_EVENT = 'm365.status_denied';
export type RequestOutcome = 'COMPLETE' | 'FAILED' | 'PARTIAL' | 'IN_PROGRESS';
export function requestOutcome(states: readonly string[]): RequestOutcome {
  if (states.length > 0 && states.every(s => s === 'COMPLETE')) return 'COMPLETE';
  if (states.length > 0 && states.every(s => s === 'FAILED')) return 'FAILED';
  return states.every(s => s === 'COMPLETE' || s === 'FAILED') && states.length > 0 ? 'PARTIAL' : 'IN_PROGRESS';
}
const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

export function readM365Status(db: PrismaClient, actor: Actor, scope: Scope, connectionId: string, requestId: string | null = null) {
  const auth = { actor, scope, permissions: STATUS_PERMISSIONS, deniedEvent: STATUS_DENIED_EVENT };
  return guardedRead(db, auth, async () => {
    if (!SCOPE_ID_PATTERN.test(connectionId)) throw new AtlasError('CONNECTION_NOT_FOUND', 'VALIDATION');
    if (requestId !== null && !SCOPE_ID_PATTERN.test(requestId)) throw new AtlasError('M365_JOB_NOT_FOUND', 'VALIDATION');
    return withReadSnapshot(db, auth, async (tx, clock) => {
      const connection = await readSelectedConnection(tx, scope, connectionId);
      const key = { ...scope, connectionId };
      const states = await tx.m365ResourceState.findMany({ where: key, orderBy: { resourceType: 'asc' }, select: { resourceType: true, status: true,
        safeErrorCode: true, activeGenerationId: true, latestStartedSeq: true, latestPublishedSeq: true, attemptsUsed: true, retryAt: true, lastSuccessAt: true,
        lastAttemptAt: true, activeGeneration: { select: { completedAt: true, expiresAt: true, rowCount: true } } } });
      const directory = (['m365_user', 'm365_device'] as const).map(resourceType => {
        const s = states.find(r => r.resourceType === resourceType) ?? null;
        const g = s?.activeGeneration?.completedAt ? { completedAt: s.activeGeneration.completedAt, expiresAt: s.activeGeneration.expiresAt } : null;
        const view = directoryView(s ? { ...s, latestStartedSeq: Number(s.latestStartedSeq), latestPublishedSeq: Number(s.latestPublishedSeq) } : null, g, clock.now);
        return { resourceType, status: view.status, reasonCodes: view.reasonCodes, attemptsUsed: view.attemptsUsed, maxAttempts: view.maxAttempts,
          retryAt: iso(s?.retryAt), lastAttemptAt: iso(s?.lastAttemptAt), lastSuccessAt: iso(s?.lastSuccessAt),
          activeGenerationId: view.status === 'OK' || view.status === 'STALE' ? s!.activeGenerationId : null,
          rowCount: view.status === 'OK' || view.status === 'STALE' ? s!.activeGeneration!.rowCount : null };
      });
      const capability = states.find(r => r.resourceType === 'm365_signin') ?? null;
      const windows = await tx.m365SignInWindow.groupBy({ by: ['status'], where: key, _count: { _all: true } });
      const count = (status: string) => windows.find(w => w.status === status)?._count._all ?? 0;
      let request = null;
      if (requestId !== null) {
        const r = await tx.m365SyncRequest.findUnique({ where: { workspaceId_clientId_connectionId_id: { ...key, id: requestId } },
          select: { id: true, rootCount: true, createdAt: true, requestedFrom: true, requestedTo: true, retrievalFrom: true, retrievalTo: true, configVersion: true,
            totalLeaves: true, totalStagedRows: true, rootJobs: { select: { windowId: true, state: true, attemptsUsed: true, maxAttempts: true, retryAt: true,
              safeErrorCode: true, window: { select: { rootFrom: true } } }, orderBy: { window: { rootFrom: 'asc' } } } } });
        if (!r) throw new AtlasError('M365_JOB_NOT_FOUND', 'VALIDATION');
        request = { requestId: r.id, outcome: requestOutcome(r.rootJobs.map(j => j.state)), rootCount: r.rootCount, createdAt: iso(r.createdAt),
          requestedFrom: iso(r.requestedFrom), requestedTo: iso(r.requestedTo), retrievalFrom: iso(r.retrievalFrom), retrievalTo: iso(r.retrievalTo),
          configVersion: r.configVersion, totalLeaves: r.totalLeaves, totalStagedRows: r.totalStagedRows,
          roots: r.rootJobs.map(j => ({ windowId: j.windowId, rootFrom: iso(j.window.rootFrom), state: j.state, attemptsUsed: j.attemptsUsed,
            maxAttempts: j.maxAttempts, retryAt: iso(j.retryAt), safeErrorCode: j.safeErrorCode })) };
      }
      return { connectionId: connection.id, connectionStatus: connection.status, lifecycleVersion: connection.lifecycleVersion, assessedAt: clock.now.toISOString(),
        directory, signIns: { capability: capability?.status ?? null, safeErrorCode: capability?.safeErrorCode ?? null,
          windows: { total: windows.reduce((n, w) => n + w._count._all, 0), ok: count('OK'), error: count('ERROR'), pending: count('PENDING'), missing: count('MISSING') } },
        request };
    });
  });
}
