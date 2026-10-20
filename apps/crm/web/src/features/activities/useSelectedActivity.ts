import { useId, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, query } from '../../api/client';
import type { PagedResult } from '../../api/types';
import type { ActivityFilters } from './api';
import type { ActivitySelection } from './activityNavigation';
import type { Activity } from './types';

/** An exact organization-scoped read: never walk or fall back to a customer timeline. */
export function useSelectedActivity(filters: ActivityFilters, selection: ActivitySelection, scopeKey: string) {
  const instance = useId();
  const missingRevision = useRef(0);
  const activityId = selection.kind === 'selected' ? selection.activityId : null;
  return useQuery({
    queryKey: ['activities', 'selected', scopeKey, instance, filters, activityId],
    enabled: activityId !== null,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({ signal }): Promise<{ activity: Activity | null; missingRevision: number }> => {
      const page = (await api.get<PagedResult<Activity>>(`/api/v1/activities/${query({ ...filters, activityId, limit: 1 })}`, signal)).data;
      signal.throwIfAborted();
      if (!Array.isArray(page.items) || page.items.length > 1 || page.nextCursor !== null || page.totalCount !== page.items.length)
        throw new Error('The selected activity could not be read.');
      const item = page.items[0];
      if (!item) return { activity: null, missingRevision: ++missingRevision.current };
      if (item.id.toLowerCase() !== activityId || item.organizationId.toLowerCase() !== filters.organizationId?.toLowerCase()
        || (filters.opportunityId && item.opportunityId !== filters.opportunityId) || (filters.contractId && item.contractId !== filters.contractId))
        throw new Error('The selected activity could not be read.');
      return { activity: item, missingRevision: missingRevision.current };
    },
  });
}
