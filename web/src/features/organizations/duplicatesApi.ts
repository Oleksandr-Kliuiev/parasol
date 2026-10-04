import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, query } from '../../api/client';
import { usePagedList } from '../../api/paging';
import type { DuplicatePair, MergeListItem, MergeResult, PagedResult } from '../../api/types';

const BASE = '/api/v1/customers/organizations';

/** The strongest pairs first, up to 200, with the number of all pairs (DEV-12). */
export function useDuplicates(organizationId?: string) {
  return useQuery({
    queryKey: ['organizations', 'duplicates', organizationId ?? 'all'],
    queryFn: async ({ signal }) => (await api.get<PagedResult<DuplicatePair>>(`${BASE}/duplicates${query({ organizationId })}`, signal)).data,
  });
}

/** Newest first, a page at a time with the count of all: every merge that can still be undone is reachable. */
export function useMerges() {
  return usePagedList<MergeListItem>(['organizations', 'merges'], `${BASE}/merges`, {}, { limit: 25 });
}

export function useDuplicateActions() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: ['organizations'] });
  return {
    dismiss: useMutation({
      mutationFn: ({ a, b }: { a: string; b: string }) => api.post(`${BASE}/duplicates/dismissals`, { organizationId: a, otherOrganizationId: b }),
      onSuccess: refresh,
    }),
    merge: useMutation({
      mutationFn: async ({ targetId, sourceId }: { targetId: string; sourceId: string }) =>
        (await api.post<MergeResult>(`${BASE}/${targetId}/merge`, { sourceOrganizationId: sourceId })).data,
      onSuccess: refresh,
    }),
    undo: useMutation({
      mutationFn: (mergeId: string) => api.post(`${BASE}/merges/${mergeId}/undo`),
      onSuccess: refresh,
    }),
  };
}
