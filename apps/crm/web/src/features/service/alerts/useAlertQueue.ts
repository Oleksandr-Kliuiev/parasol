import { useQuery } from '@tanstack/react-query';
import { api, query } from '../../../api/client';
import { usePagedList } from '../../../api/paging';
import type { Alert, AlertPage, AlertSeverity } from '../types';

export interface AlertQueueFilters {
  /** Open (not hidden), hidden in Parasoll (M40), or resolved. */
  state: 'Open' | 'Hidden' | 'Resolved';
  severity: AlertSeverity | null;
  organizationId: string | null;
  search: string;
}

/** One page of the queue holds what one task lookup may carry. */
export const queuePageSize = 25;

/**
 * Alerts across customers (M38): open ones critical first and the longest waiting first, resolved ones newest resolved first,
 * both in the server's order. The counts are of the whole filter, and the reads say how fresh the stored alerts are, both from the
 * newest answer (DEV-12). A new search or filter is read with the previous rows kept in place, so a row someone is clicking does not
 * vanish while the answer is on its way.
 */
export function useAlertQueue(filters: AlertQueueFilters) {
  const list = usePagedList<Alert>(['service', 'alerts', 'queue', filters], '/api/v1/service/alerts', {
    state: filters.state === 'Resolved' ? filters.state : undefined,
    hidden: filters.state === 'Hidden' ? true : undefined,
    severity: filters.severity ?? undefined,
    organizationId: filters.organizationId ?? undefined,
    q: filters.search || undefined,
  }, { limit: queuePageSize, keepPrevious: true });
  // The queue's answer is a page with its severity counts; the generic list reader types only the paging part of it.
  const pages = list.data?.pages as AlertPage[] | undefined;
  const latest = pages?.at(-1);
  // Reading another search or filter with the previous rows on screen is not a read of those rows again (isFetching): their read
  // line stays above the queue and Refresh stays usable, as in the ticket queue.
  return { ...list, isFetching: list.isFetching && !list.isPlaceholderData, pages, critical: latest?.critical ?? null, warning: latest?.warning ?? null,
    reads: latest?.reads ?? null };
}

/** One alert as stored now, in any state (the side panel; a link from My day names it by id). Never served from a cache. */
export function useAlert(alertId: string | null) {
  return useQuery({
    queryKey: ['service', 'alerts', 'one', alertId],
    enabled: alertId !== null,
    retry: false, staleTime: 0, gcTime: 0, refetchOnWindowFocus: false,
    queryFn: async ({ signal }) => (await api.get<Alert>(`/api/v1/service/alerts/${encodeURIComponent(alertId ?? '')}`, signal)).data,
  });
}

/** How many alerts of one customer are open, and how many of them critical: one read of the list's counts, no rows. */
export function useCustomerAlertCounts(organizationId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['service', 'alerts', 'counts', organizationId],
    enabled,
    queryFn: async ({ signal }) => {
      const page = (await api.get<AlertPage>(`/api/v1/service/alerts${query({ organizationId, limit: 1 })}`, signal)).data;
      return { total: page.totalCount, critical: page.critical };
    },
  });
}
