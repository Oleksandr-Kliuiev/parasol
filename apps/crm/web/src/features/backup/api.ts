import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { savedServicePolicy, useSavedServiceList, type SavedServiceScope } from '../service/useSavedServiceList';
import type { BackupEntity, BackupOverview, BackupService } from './types';

const BASE = '/api/v1/backup/organizations';

export const backupKeys = {
  all: ['backup'] as const,
  overview: (organizationId: string) => ['backup', 'overview', organizationId] as const,
  entities: (organizationId: string, filters: object) => ['backup', 'entities', organizationId, filters] as const,
};

/** The customer's backups as Parasoll saved them from CloudAlly (M42): read when the tab opens and on its refresh, never kept. */
export function useBackupOverview(organizationId: string, scope: SavedServiceScope) {
  return useQuery({
    ...savedServicePolicy, queryKey: [...backupKeys.overview(organizationId), scope.owner, scope.revision],
    queryFn: async ({ signal }) => {
      const answer = await api.get<BackupOverview>(`${BASE}/${organizationId}`, signal);
      signal.throwIfAborted(); return answer.data;
    },
  });
}

/**
 * Whether the customer has a CloudAlly account linked: with a link and nothing stored yet, the tab says the backups come with the
 * next read instead of saying no account is linked.
 */
export function useCloudAllyLinked(organizationId: string, scope: SavedServiceScope) {
  return useQuery({
    ...savedServicePolicy, queryKey: ['backup', 'linked', organizationId, scope.owner, scope.revision],
    queryFn: async ({ signal }) => {
      const answer = await api.get<Array<{ system: string }>>(
        `/api/v1/integrations/links?entityType=Organization&entityId=${encodeURIComponent(organizationId)}`, signal);
      signal.throwIfAborted(); return answer.data.some((link) => link.system === 'cloudally');
    },
  });
}

export interface BackupEntityFilters {
  service?: BackupService;
  /** `problems` keeps failed, late, paused and not backed up; a state's name keeps that state. */
  state?: string;
  q?: string;
}

/** The mailboxes, OneDrives, sites and teams, the ones that need someone first; a page at a time with the count of all (DEV-12). */
export function useBackupEntities(organizationId: string, filters: BackupEntityFilters, scope: SavedServiceScope) {
  return useSavedServiceList<BackupEntity>(backupKeys.entities(organizationId, filters), `${BASE}/${organizationId}/entities`,
    { service: filters.service, state: filters.state, q: filters.q }, scope, 25);
}
