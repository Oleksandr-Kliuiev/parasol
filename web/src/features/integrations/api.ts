import { useRef } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, query } from '../../api/client';
import { usePagedList } from '../../api/paging';
import type {
  BillingDetailsMaster,
  BulkResult,
  ConnectionTestStatus,
  EntityLink,
  IntegrationCapability,
  IntegrationStatus,
  OutboundOperation,
  OutboxOverview,
  RecordPage,
} from '../../api/types';

const BASE = '/api/v1/integrations';

export function useIntegrationStatus(enabled = true) {
  return useQuery({
    queryKey: ['integrations', 'status'],
    enabled,
    queryFn: async ({ signal }) => (await api.get<IntegrationStatus[]>(`${BASE}/status`, signal)).data,
  });
}

/**
 * Asks every two seconds for crm-worker's answer to a queued connection test (only the worker holds the provider
 * credentials) and hands it over once; after a minute without one it hands over null.
 */
export function useConnectionTestAnswer(
  pending: { system: string; id: string } | null,
  onFinished: (result: ConnectionTestStatus | null) => void,
) {
  const polls = useRef(0);
  return useQuery({
    queryKey: ['integrations', 'test', pending?.system, pending?.id],
    enabled: pending !== null,
    refetchInterval: 2_000,
    queryFn: async ({ signal }) => {
      const result = (await api.get<ConnectionTestStatus>(`${BASE}/${pending!.system}/test/${pending!.id}`, signal)).data;
      polls.current += 1;
      if (result.status !== 'Running' || polls.current >= 30) {
        polls.current = 0;
        onFinished(result.status === 'Running' ? null : result);
      }
      return result;
    },
  });
}

export function useCapabilities() {
  return useQuery({
    queryKey: ['integrations', 'capabilities'],
    staleTime: 5 * 60_000,
    queryFn: async ({ signal }) => (await api.get<IntegrationCapability[]>(`${BASE}/capabilities`, signal)).data,
  });
}

export function useCustomerSettings() {
  return useQuery({
    queryKey: ['customers', 'settings'],
    staleTime: 10 * 60_000,
    queryFn: async ({ signal }) => (await api.get<{ billingDetailsMaster: BillingDetailsMaster }>('/api/v1/customers/settings', signal)).data,
  });
}

export interface RecordFilters {
  system: string;
  type: string;
  state: 'All' | 'Unlinked' | 'Linked';
  search: string;
}

export function useRecords(filters: RecordFilters) {
  return useInfiniteQuery({
    queryKey: ['integrations', 'records', filters],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) =>
      (await api.get<RecordPage>(`${BASE}/records${query({ ...filters, search: filters.search || undefined, cursor: pageParam, limit: 50 })}`, signal)).data,
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function useEntityLinks(entityType: string, entityId: string) {
  return useQuery({
    queryKey: ['integrations', 'links', entityType, entityId],
    queryFn: async ({ signal }) => (await api.get<EntityLink[]>(`${BASE}/links${query({ entityType, entityId })}`, signal)).data,
  });
}

/** Newest first, a page at a time with the count of all (DEV-12). */
export function useOutbound(enabled = true) {
  return usePagedList<OutboundOperation>(['integrations', 'outbound'], `${BASE}/outbound`, {}, { enabled, limit: 25, refetchInterval: 15_000 });
}

/** Dead and quarantined domain events of every module, for the delivery panel (DEV-07). */
export function useOutbox(enabled = true) {
  return useQuery({
    queryKey: ['integrations', 'outbox'],
    enabled,
    refetchInterval: 15_000,
    queryFn: async ({ signal }) => (await api.get<OutboxOverview>(`${BASE}/outbox`, signal)).data,
  });
}

export interface ReplayRequest {
  messages: { module: string; id: string }[];
  reason: string;
  /** How many messages the person confirmed; the server refuses when that is no longer what can be replayed. */
  expected: number;
}

export function useIntegrationActions() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: ['integrations'] });
  const onSuccess = () => void refresh();
  return {
    link: useMutation({
      mutationFn: (body: { system: string; externalType: string; externalId: string; entityId: string }) => api.post(`${BASE}/links`, body),
      onSuccess,
    }),
    unlink: useMutation({ mutationFn: (linkId: string) => api.delete(`${BASE}/links/${linkId}`), onSuccess }),
    pause: useMutation({
      mutationFn: (r: { system: string; paused: boolean; reason?: string }) =>
        api.post(`${BASE}/${r.system}/pause`, { paused: r.paused, reason: r.reason ?? null }),
      onSuccess,
    }),
    importOne: useMutation({
      mutationFn: async (r: { system: string; type: string; externalId: string }) =>
        (await api.post<{ entityId: string }>(`${BASE}/records/${r.system}/${r.type}/${encodeURIComponent(r.externalId)}/import`)).data,
      onSuccess,
    }),
    autoLink: useMutation({
      mutationFn: async (r: { system: string; type: string }) => (await api.post<BulkResult>(`${BASE}/records/${r.system}/${r.type}/auto-link`)).data,
      onSuccess,
    }),
    importUnlinked: useMutation({
      mutationFn: async (r: { system: string; type: string; dryRun: boolean }) =>
        (await api.post<BulkResult>(`${BASE}/records/${r.system}/${r.type}/import-unlinked${query({ dryRun: r.dryRun })}`)).data,
      onSuccess: (_, variables) => {
        if (!variables.dryRun) void refresh();
      },
    }),
    exportOrganization: useMutation({
      mutationFn: (r: { system: string; organizationId: string }) => api.post(`${BASE}/${r.system}/organizations/${r.organizationId}/export`),
      onSuccess,
    }),
    test: useMutation({
      mutationFn: async (system: string) => (await api.post<ConnectionTestStatus>(`${BASE}/${system}/test`)).data,
    }),
    retry: useMutation({ mutationFn: (id: string) => api.post(`${BASE}/outbound/${id}/retry`), onSuccess }),
    cancel: useMutation({ mutationFn: (id: string) => api.post(`${BASE}/outbound/${id}/cancel`), onSuccess }),
    replay: useMutation({
      mutationFn: async (request: ReplayRequest) =>
        (await api.post<{ requested: number; modules: string[] }>(`${BASE}/outbox/replay`, request)).data,
      // A refused replay (the list changed meanwhile) also reloads the list, so the person confirms what is there now.
      onSettled: () => void refresh(),
    }),
  };
}
