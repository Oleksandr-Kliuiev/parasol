import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, query } from '../../api/client';
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

export function useOrganizations(filters: OrganizationFilters) {
  return useInfiniteQuery({
    queryKey: organizationKeys.list(filters),
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
