import type { PrismaClient } from '@prisma/client';
import type { Actor, Scope } from '../core/contracts.ts';
import { AtlasError } from '../core/contracts.ts';
import { assessCoverage } from '../correlation/coverage.ts';
import { loadCapability, loadRoots } from '../correlation/query.ts';
import { auditRead } from '../correlation/read.ts';
import { assertReadable, guardedRead, READ_PERMISSIONS, readSelectedConnection, withReadSnapshot } from '../correlation/snapshot.ts';
import { hourFloorMs, keyOfDate, keyPlusMs } from '../correlation/time.ts';
import { directoryView } from './status.ts';
import type { DirectoryStateRow } from './status.ts';
import { M365_OVERVIEW_CONNECTION_LIMIT, M365_OVERVIEW_VERSION } from './overview-contract.ts';
import type { M365OverviewDirectory, M365OverviewV1, OverviewResourceStatus } from './overview-contract.ts';

export const M365_OVERVIEW_DENIED_EVENT = 'm365.overview_read_denied';
const HOUR = 3_600_000;

export function validateOverviewQuery(raw: unknown): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 0)
    throw new AtlasError('M365_OVERVIEW_INPUT_INVALID', 'VALIDATION');
}

export interface OverviewDirectoryState extends DirectoryStateRow {
  lastSuccessAt: Date | null;
  activeGeneration: { completedAt: Date | null; expiresAt: Date; rowCount: number } | null;
}

/** Use the established expiry/freshness semantics; an expired count is null, never zero. */
export function overviewDirectory(resourceType: M365OverviewDirectory['resourceType'], state: OverviewDirectoryState | null, now: Date): M365OverviewDirectory {
  const generation = state?.activeGeneration?.completedAt ? { completedAt: state.activeGeneration.completedAt, expiresAt: state.activeGeneration.expiresAt } : null;
  const view = directoryView(state, generation, now);
  const usable = view.status === 'OK' || view.status === 'STALE';
  return { resourceType, status: view.status, count: usable ? state!.activeGeneration!.rowCount : null,
    asOf: usable ? generation!.completedAt.toISOString() : null, lastSuccessAt: state?.lastSuccessAt?.toISOString() ?? null };
}

/** Ordinary evidence read, NOT the connections:manage status command. One current all-of authority,
 * one RepeatableRead snapshot/DB clock, active bound connections only, no Graph/token/secret I/O.
 * Only metadata and scoped coverage are loaded; directory DTOs and sign-in evidence are not queried.
 */
export function readM365Overview(db: PrismaClient, actor: Actor, scope: Scope, raw: unknown = {}, correlationId?: string): Promise<M365OverviewV1> {
  const auth = { actor, scope, permissions: READ_PERMISSIONS, deniedEvent: M365_OVERVIEW_DENIED_EVENT };
  return guardedRead(db, auth, async () => {
    validateOverviewQuery(raw);
    return withReadSnapshot(db, auth, async (tx, clock) => {
      const where = { ...scope, system: 'microsoft365', status: 'ACTIVE' };
      const totalConnections = await tx.connection.count({ where });
      const selected = await tx.connection.findMany({ where, orderBy: { id: 'asc' },
        select: { id: true }, take: M365_OVERVIEW_CONNECTION_LIMIT });
      const to = keyOfDate(new Date(hourFloorMs(clock.key)));
      const from = keyPlusMs(to, -24 * HOUR);
      const connections: M365OverviewV1['connections'] = [];
      for (const row of selected) {
        const connection = await readSelectedConnection(tx, scope, row.id);
        assertReadable(connection);
        const states = await tx.m365ResourceState.findMany({ where: { ...scope, connectionId: row.id,
          resourceType: { in: ['m365_user', 'm365_device'] } },
          select: { resourceType: true, status: true, safeErrorCode: true, activeGenerationId: true,
            latestStartedSeq: true, latestPublishedSeq: true, lastSuccessAt: true,
            activeGeneration: { select: { completedAt: true, expiresAt: true, rowCount: true } } } });
        const directory = (['m365_user', 'm365_device'] as const).map(type => {
          const state = states.find(s => s.resourceType === type);
          return overviewDirectory(type, state ? { ...state, latestStartedSeq: Number(state.latestStartedSeq),
            latestPublishedSeq: Number(state.latestPublishedSeq) } : null, clock.now);
        });
        const assessed = assessCoverage(await loadRoots(tx, scope, row.id, from, to), await loadCapability(tx, scope, row.id), from, to, clock);
        connections.push({ connectionId: row.id, directory, signIns: { status: assessed.resource.status as OverviewResourceStatus,
          coverage: assessed.coverage.status, freshness: assessed.coverage.freshness,
          asOf: assessed.resource.asOf, lastSuccessAt: assessed.resource.lastSuccessAt,
          gaps: assessed.coverage.gaps.map(g => ({ fromInclusive: g.fromInclusive, toExclusive: g.toExclusive })) } });
      }
      await auditRead(tx, scope, actor, correlationId, { itemCount: String(connections.length), total: String(totalConnections) }, 'm365.overview_read');
      return { contractVersion: M365_OVERVIEW_VERSION, mode: 'db', workspaceId: scope.workspaceId, clientId: scope.clientId,
        assessedAt: clock.now.toISOString(), window: { fromInclusive: from, toExclusive: to }, totalConnections,
        truncated: totalConnections > connections.length, connections };
    });
  });
}
