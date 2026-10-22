import { useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, query } from '../../api/client';
import { organizationStatuses } from '../../api/types';
import type {
  Organization,
  OrganizationListItem,
  OrganizationRequest,
  OrganizationStatus,
  PagedResult,
  RegistryLookup,
  RegistryOrganization,
  SetParentRequest,
} from '../../api/types';

const BASE = '/api/v1/customers/organizations';

export const organizationKeys = {
  all: ['organizations'] as const,
  list: (filters: OrganizationFilters) => ['organizations', 'list', filters] as const,
  detail: (id: string) => ['organizations', 'detail', id] as const,
};

export interface OrganizationFilters {
  search?: string;
  status?: OrganizationStatus | null;
  accountManagerId?: string | null;
  limit?: number;
}

/**
 * Organizations page by page. `keepPrevious`: the list searched as people type keeps the rows of the previous search or filter until
 * the new answer is there (isPlaceholderData), so a row someone is clicking does not vanish; other lists of organizations start empty.
 */
export function useOrganizations(filters: OrganizationFilters, options: { keepPrevious?: boolean } = {}) {
  return useInfiniteQuery({
    queryKey: organizationKeys.list(filters),
    placeholderData: options.keepPrevious ? keepPreviousData : undefined,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) =>
      (
        await api.get<PagedResult<OrganizationListItem>>(
          `${BASE}${query({ search: filters.search, status: filters.status, accountManagerId: filters.accountManagerId, limit: filters.limit, cursor: pageParam })}`,
          signal,
        )
      ).data,
    getNextPageParam: (last) => last.nextCursor,
  });
}

/**
 * How many organizations of each status match the search, for the counts on the status filters: one read per status
 * that asks for a single row and keeps only the list's total. Null until every count is known. While another search is
 * counted, the counts of the previous one are returned as `pending`: the filters keep their size without showing them.
 */
export function useOrganizationCounts(search: string): { counts: Record<OrganizationStatus, number>; pending: boolean } | null {
  const reads = useQueries({
    queries: organizationStatuses.map((status) => ({
      queryKey: [...organizationKeys.all, 'count', { search, status }] as const,
      queryFn: async ({ signal }: { signal: AbortSignal }) =>
        (await api.get<PagedResult<OrganizationListItem>>(`${BASE}${query({ search, status, limit: 1 })}`, signal)).data.totalCount ?? null,
      staleTime: 30_000,
    })),
  });
  const values = reads.map((read) => read.data);
  const counts = values.every((value) => typeof value === 'number')
    ? Object.fromEntries(organizationStatuses.map((status, i) => [status, values[i]])) as Record<OrganizationStatus, number>
    : null;
  // A new search is counted by new reads, which start empty (useQueries keeps no previous data): the last full set stands in, unless
  // a read failed and no count will come.
  const [last, setLast] = useState(counts);
  if (counts && organizationStatuses.some((status) => counts[status] !== last?.[status])) setLast(counts);
  return counts ? { counts, pending: false } : last && !reads.some((read) => read.isError) ? { counts: last, pending: true } : null;
}

export function useOrganization(id: string | undefined) {
  return useQuery({
    queryKey: organizationKeys.detail(id ?? ''),
    enabled: Boolean(id),
    queryFn: async ({ signal }) => api.get<Organization>(`${BASE}/${id}`, signal),
  });
}

export function useSaveOrganization(id?: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ request, etag }: { request: OrganizationRequest; etag?: string | null }) =>
      id ? api.put<Organization>(`${BASE}/${id}`, request, etag) : api.post<Organization>(BASE, request),
    onSuccess: async (response) => {
      client.setQueryData(organizationKeys.detail(response.data.id), response);
      await client.invalidateQueries({ queryKey: organizationKeys.all, refetchType: 'none' });
    },
  });
}

/** Places the organization in a group and says whether the parent is the one invoiced (FR-CUS-07). */
export function useSetOrganizationParent(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ request, etag }: { request: SetParentRequest; etag?: string | null }) =>
      api.put<Organization>(`${BASE}/${id}/parent`, request, etag),
    onSuccess: async (response) => {
      client.setQueryData(organizationKeys.detail(response.data.id), response);
      await client.invalidateQueries({ queryKey: organizationKeys.all, refetchType: 'none' });
    },
  });
}

export function useDeleteOrganization() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`${BASE}/${id}`),
    onSuccess: async (_, id) => {
      client.removeQueries({ queryKey: organizationKeys.detail(id) });
      await client.invalidateQueries({ queryKey: organizationKeys.all });
    },
  });
}

export async function lookupRegistry(orgNumber: string, signal?: AbortSignal): Promise<RegistryLookup> {
  return (await api.get<RegistryLookup>(`/api/v1/integrations/brreg/organizations/${encodeURIComponent(orgNumber)}`, signal)).data;
}

export async function searchRegistry(name: string, signal?: AbortSignal): Promise<RegistryOrganization[]> {
  return (await api.get<RegistryOrganization[]>(`/api/v1/integrations/brreg/organizations${query({ name, size: 8 })}`, signal)).data;
}
