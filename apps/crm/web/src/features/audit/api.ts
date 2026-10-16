import { useInfiniteQuery } from '@tanstack/react-query';
import { api, query } from '../../api/client';
import type { AuditPage } from '../../api/types';

export interface AuditFilters {
  module?: string;
  entityType?: string;
  entityId?: string;
  action?: string;
  from?: string;
  to?: string;
}

export function useAuditLog(filters: AuditFilters) {
  return useInfiniteQuery({
    queryKey: ['audit', 'log', filters],
    initialPageParam: null as number | null,
    queryFn: async ({ pageParam, signal }) =>
      (await api.get<AuditPage>(`/api/v1/audit/${query({ ...filters, cursor: pageParam, limit: 50 })}`, signal)).data,
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function useEntityHistory(module: string, entityType: string, entityId: string) {
  return useInfiniteQuery({
    queryKey: ['audit', 'entity', module, entityType, entityId],
    initialPageParam: null as number | null,
    queryFn: async ({ pageParam, signal }) =>
      (
        await api.get<AuditPage>(
          `/api/v1/audit/entities/${module}/${entityType}/${entityId}${query({ cursor: pageParam, limit: 25 })}`,
          signal,
        )
      ).data,
    getNextPageParam: (last) => last.nextCursor,
  });
}
