import { useCallback, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { AlertSeverity } from '../service/types';

/** One open alert, as the urgent list of the Service module returns it; `createdAt` is the source's time. */
export interface UrgentAlert {
  id: string;
  organizationId: string;
  organizationName: string | null;
  system: string;
  kind: 'Monitoring' | 'Security' | 'Backup';
  externalId: string;
  severity: AlertSeverity;
  state: 'Open' | 'Acknowledged' | 'Resolved';
  title: string;
  deviceName: string | null;
  deviceId: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  resolvedAt: string | null;
  url: string | null;
}

/** The latest finished read of one alert source; an incomplete one leaves the alerts of an earlier read in place. */
export interface AlertSourceRead {
  system: string;
  startedAt: string | null;
  complete: boolean;
}

/** The most severe open alerts, oldest first, out of `totalCount` open ones; the counts cover every open alert. */
export interface UrgentAlerts {
  items: UrgentAlert[];
  totalCount: number;
  critical: number;
  warning: number;
  reads: AlertSourceRead[];
}

/** Five rows on My day; the queue holds the rest. */
export const urgentAlertsLimit = 5;

/** The panel owns the request; the key figure above it reads the same answer from the cache (`useCachedQueryData`). */
export const urgentAlertsKey = (employeeId: string, permissionsKey: string) => ['service', 'alerts', 'urgent', employeeId, permissionsKey] as const;

/** One read when My day opens and one per refresh: no polling, and no earlier answer is shown while a new one is read. */
export function useUrgentAlerts(employeeId: string, permissionsKey: string) {
  return useQuery({
    queryKey: urgentAlertsKey(employeeId, permissionsKey),
    queryFn: async ({ signal }) => (await api.get<UrgentAlerts>(`/api/v1/service/alerts/urgent?limit=${urgentAlertsLimit}`, signal)).data,
    retry: false, staleTime: 0, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
}

/**
 * The panel's answer as the key figure may show it, read from the cache without asking again: nothing while the panel reads
 * (also on a refresh) and a failure once it failed, so the tile never shows a figure the panel does not.
 */
export function useUrgentAlertsAnswer(employeeId: string, permissionsKey: string) {
  const client = useQueryClient();
  const key = urgentAlertsKey(employeeId, permissionsKey);
  const hash = JSON.stringify(key);
  const subscribe = useCallback((onChange: () => void) => client.getQueryCache().subscribe(onChange), [client]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the key is compared by its serialised form
  const read = useCallback(() => client.getQueryState<UrgentAlerts>(key), [client, hash]);
  const state = useSyncExternalStore(subscribe, read, read);
  const settled = state !== undefined && state.fetchStatus !== 'fetching';
  return { data: settled && state.status === 'success' ? state.data : undefined, failed: settled && state.status === 'error' };
}

/** Where the list stands: no source read yet, the latest read of some source did not finish, or every source read completely. */
export type AlertsFreshness = 'notRead' | 'incomplete' | 'complete';

export function alertsFreshness(reads: readonly AlertSourceRead[]): AlertsFreshness {
  if (reads.length === 0 || reads.every((read) => read.startedAt === null)) return 'notRead';
  return reads.every((read) => read.complete) ? 'complete' : 'incomplete';
}

const sourceNames: Record<string, string> = { atera: 'Atera' };

/** A source is named by its vendor, as the label of where an alert came from (M38 vocabulary). */
export const alertSourceName = (system: string) => sourceNames[system] ?? system;
