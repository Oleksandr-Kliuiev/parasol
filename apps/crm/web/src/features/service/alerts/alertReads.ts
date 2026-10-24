import { useQuery } from '@tanstack/react-query';
import { api } from '../../../api/client';
import type { AlertPage, AlertSourceRead } from '../types';

/**
 * Where the stored alerts stand: no source read yet, the latest read of a source did not finish, a source's next read is
 * overdue, or every source was read completely and on time.
 */
export type AlertsFreshness = 'notRead' | 'incomplete' | 'late' | 'complete';

export function alertsFreshness(reads: readonly AlertSourceRead[]): AlertsFreshness {
  if (reads.length === 0 || reads.every((read) => read.startedAt === null)) return 'notRead';
  if (!reads.every((read) => read.complete)) return 'incomplete';
  return reads.some((read) => read.late) ? 'late' : 'complete';
}

/**
 * The reads alone, for a view of one alert (its side panel, a task's alert): the alert list carries them, so one row is asked
 * for. Read when the view opens and on its refresh, never kept from an earlier view.
 */
export function useAlertReads(enabled: boolean) {
  return useQuery({
    queryKey: ['service', 'alerts', 'reads'],
    enabled,
    retry: false, staleTime: 0, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false,
    queryFn: async ({ signal }) => (await api.get<AlertPage>('/api/v1/service/alerts?limit=1', signal)).data.reads,
  });
}
