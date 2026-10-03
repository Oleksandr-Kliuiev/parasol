import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, query } from '../../api/client';
import type { DuplicatePair, MergeListItem, MergeResult } from '../../api/types';

const BASE = '/api/v1/customers/organizations';

export function useDuplicates(organizationId?: string) {
  return useQuery({
    queryKey: ['organizations', 'duplicates', organizationId ?? 'all'],
    queryFn: async ({ signal }) => (await api.get<DuplicatePair[]>(`${BASE}/duplicates${query({ organizationId })}`, signal)).data,
  });
}

export function useMerges() {
  return useQuery({
    queryKey: ['organizations', 'merges'],
    queryFn: async ({ signal }) => (await api.get<MergeListItem[]>(`${BASE}/merges`, signal)).data,
  });
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
