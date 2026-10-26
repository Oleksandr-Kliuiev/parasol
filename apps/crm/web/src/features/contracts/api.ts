import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, query } from '../../api/client';
import { usePagedList } from '../../api/paging';
import type { PagedResult } from '../../api/types';
import type {
  Contract,
  ContractListItem,
  ContractRequest,
  ContractStatus,
  HourBank,
  HourBankEntryKind,
  IndexationPreview,
  IndexationResult,
  LineRequest,
  Reminder,
  SlaPolicy,
  SlaPolicyRequest,
} from './types';

const BASE = '/api/v1/contracts';

export const contractKeys = {
  all: ['contracts'] as const,
  list: (filters: ContractFilters) => ['contracts', 'list', filters] as const,
  detail: (id: string) => ['contracts', 'detail', id] as const,
  sla: ['contracts', 'sla'] as const,
  hourBanks: (filters: object) => ['contracts', 'hour-banks', filters] as const,
  hourBank: (id: string) => ['contracts', 'hour-bank', id] as const,
  reminders: (filters: object) => ['contracts', 'reminders', filters] as const,
  indexation: (percent: number, effectiveFrom: string) => ['contracts', 'indexation', percent, effectiveFrom] as const,
};

export interface ContractFilters {
  search?: string;
  organizationId?: string;
  status?: ContractStatus | null;
  ownerId?: string | null;
  endingWithinDays?: number | null;
  limit?: number;
}

/**
 * Contracts page by page. `keepPrevious`: the list searched as people type keeps the rows of the previous search or filter until
 * the new answer is there, so a row someone is clicking does not vanish; a customer's own tab starts empty and never shows another
 * customer's rows.
 */
export function useContracts(filters: ContractFilters, enabled = true, options: { keepPrevious?: boolean } = {}) {
  return useInfiniteQuery({
    queryKey: contractKeys.list(filters),
    enabled,
    placeholderData: options.keepPrevious ? keepPreviousData : undefined,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) =>
      (await api.get<PagedResult<ContractListItem>>(`${BASE}${query({ ...filters, cursor: pageParam })}`, signal)).data,
    getNextPageParam: (last) => last.nextCursor,
  });
}

/** One contract with its lines and ETag; shared by the contract page and the lists that need several contracts' lines. */
export const contractQuery = (id: string) => ({
  queryKey: contractKeys.detail(id),
  queryFn: async ({ signal }: { signal: AbortSignal }) => api.get<Contract>(`${BASE}/${id}`, signal),
});

export function useContract(id: string | undefined) {
  return useQuery({ ...contractQuery(id ?? ''), enabled: Boolean(id) });
}

export function useSaveContract(id?: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ request, etag }: { request: ContractRequest; etag?: string | null }) =>
      id ? api.put<Contract>(`${BASE}/${id}`, request, etag) : api.post<Contract>(BASE, request),
    onSuccess: async (response) => {
      client.setQueryData(contractKeys.detail(response.data.id), response);
      await client.invalidateQueries({ queryKey: contractKeys.all, refetchType: 'none' });
    },
  });
}

/** Status changes and line changes return the whole contract; the cache is updated from the response. */
export function useContractActions(id: string) {
  const client = useQueryClient();
  const onSuccess = async (response: Awaited<ReturnType<typeof api.post<Contract>>>) => {
    client.setQueryData(contractKeys.detail(id), response);
    await client.invalidateQueries({ queryKey: contractKeys.all, refetchType: 'none' });
  };
  const post = (path: string, body?: unknown) => api.post<Contract>(`${BASE}/${id}/${path}`, body);
  return {
    transition: useMutation({
      mutationFn: ({ action, body }: { action: 'activate' | 'suspend' | 'notice' | 'withdraw-notice' | 'end'; body?: unknown }) => post(action, body ?? {}),
      onSuccess,
    }),
    addLine: useMutation({ mutationFn: (request: LineRequest) => post('lines', request), onSuccess }),
    reviseLine: useMutation({
      mutationFn: ({ lineId, ...body }: { lineId: string; quantity: number; unitPrice: number | null; discountPct: number | null; description: string | null; effectiveFrom: string }) =>
        post(`lines/${lineId}/revise`, body),
      onSuccess,
    }),
    endLine: useMutation({ mutationFn: ({ lineId, endDate }: { lineId: string; endDate: string }) => post(`lines/${lineId}/end`, { endDate }), onSuccess }),
    removeLine: useMutation({ mutationFn: (lineId: string) => api.delete<Contract>(`${BASE}/${id}/lines/${lineId}`), onSuccess }),
    remove: useMutation({
      mutationFn: () => api.delete(`${BASE}/${id}`),
      onSuccess: () => client.invalidateQueries({ queryKey: contractKeys.all }),
    }),
  };
}

export function useSlaPolicies(includeInactive = false) {
  return useQuery({
    queryKey: [...contractKeys.sla, includeInactive],
    queryFn: async ({ signal }) => (await api.get<SlaPolicy[]>(`${BASE}/sla-policies${query({ includeInactive })}`, signal)).data,
    staleTime: 60_000,
  });
}

export function useSaveSlaPolicy() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, etag, request }: { id?: string; etag?: string; request: SlaPolicyRequest }) =>
      id ? api.put<SlaPolicy>(`${BASE}/sla-policies/${id}`, request, etag) : api.post<SlaPolicy>(`${BASE}/sla-policies`, request),
    onSuccess: () => client.invalidateQueries({ queryKey: contractKeys.sla }),
  });
}

/** Newest first, a page at a time with the count of all (DEV-12). */
export function useHourBanks(filters: { organizationId?: string; contractId?: string; includeClosed?: boolean }, enabled = true) {
  return usePagedList<HourBank>(contractKeys.hourBanks(filters), `${BASE}/hour-banks`, filters, { limit: 25, enabled });
}

export function useHourBank(id: string) {
  return useQuery({
    queryKey: contractKeys.hourBank(id),
    queryFn: async ({ signal }) => (await api.get<HourBank>(`${BASE}/hour-banks/${id}`, signal)).data,
  });
}

export function useHourBankActions() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: contractKeys.all });
  return {
    create: useMutation({
      mutationFn: (body: { organizationId: string; contractId: string | null; name: string; hours: number; validFrom: string; validTo: string | null; overageRate: number | null }) =>
        api.post<HourBank>(`${BASE}/hour-banks`, body),
      onSuccess: refresh,
    }),
    addEntry: useMutation({
      mutationFn: ({ id, ...body }: { id: string; kind: HourBankEntryKind; hours: number; date: string; description: string | null }) =>
        api.post<HourBank>(`${BASE}/hour-banks/${id}/entries`, body),
      onSuccess: refresh,
    }),
    close: useMutation({ mutationFn: (id: string) => api.post(`${BASE}/hour-banks/${id}/close`), onSuccess: refresh }),
  };
}

/** Soonest first, a page at a time with the count of all (DEV-12). */
export function useReminders(filters: { mine?: boolean; organizationId?: string }, enabled = true) {
  return usePagedList<Reminder>(contractKeys.reminders(filters), `${BASE}/reminders`, filters, { enabled, limit: 20 });
}

export function useAcknowledgeReminder() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`${BASE}/reminders/${id}/acknowledge`),
    onSuccess: () => client.invalidateQueries({ queryKey: ['contracts', 'reminders'] }),
  });
}

/** FR-CON-05: what the contracts would cost after the yearly indexation; nothing is written until it is applied. */
export function useIndexationPreview(percent: number, effectiveFrom: string, enabled: boolean) {
  return useQuery({
    queryKey: contractKeys.indexation(percent, effectiveFrom),
    enabled: enabled && percent !== 0 && Boolean(effectiveFrom),
    queryFn: async ({ signal }) =>
      (await api.get<IndexationPreview>(`${BASE}/indexation/preview${query({ percent, effectiveFrom })}`, signal)).data,
  });
}

export function useApplyIndexation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (request: { percent: number; effectiveFrom: string; contractIds: string[] }) =>
      (await api.post<IndexationResult>(`${BASE}/indexation`, request)).data,
    onSuccess: () => client.invalidateQueries({ queryKey: contractKeys.all }),
  });
}
