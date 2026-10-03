import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, query } from '../../api/client';
import type { ApprovalSummary, Period, TechnicianMapping, TimeEntryPage, TimeEntryRequest, TimeEntryStatus, TimeSource } from './types';

const BASE = '/api/v1/time';

export interface TimeFilters {
  year?: number;
  month?: number;
  from?: string;
  to?: string;
  organizationId?: string;
  technicianId?: string;
  status?: TimeEntryStatus | null;
  source?: TimeSource | null;
  mine?: boolean;
}

export const timeKeys = {
  all: ['time'] as const,
  entries: (filters: TimeFilters) => ['time', 'entries', filters] as const,
  periods: (year: number) => ['time', 'periods', year] as const,
  workTypes: ['time', 'work-types'] as const,
  technicians: ['identity', 'technicians'] as const,
};

export function useTimeEntries(filters: TimeFilters, enabled = true) {
  return useQuery({
    queryKey: timeKeys.entries(filters),
    enabled,
    queryFn: async ({ signal }) => (await api.get<TimeEntryPage>(`${BASE}/entries${query({ ...filters })}`, signal)).data,
  });
}

export function useWorkTypes() {
  return useQuery({
    queryKey: timeKeys.workTypes,
    staleTime: 600_000,
    queryFn: async ({ signal }) => (await api.get<string[]>(`${BASE}/work-types`, signal)).data,
  });
}

export function useTimeActions() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: timeKeys.all });
  return {
    create: useMutation({ mutationFn: (request: TimeEntryRequest) => api.post(`${BASE}/entries`, request), onSuccess: refresh }),
    update: useMutation({
      mutationFn: ({ id, request, etag }: { id: string; request: TimeEntryRequest; etag: string }) => api.put(`${BASE}/entries/${id}`, request, etag),
      onSuccess: refresh,
    }),
    remove: useMutation({ mutationFn: (id: string) => api.delete(`${BASE}/entries/${id}`), onSuccess: refresh }),
    adjust: useMutation({
      mutationFn: ({ id, ...body }: { id: string; billable: boolean; workType: string | null; afterHours: boolean }) =>
        api.post(`${BASE}/entries/${id}/adjust`, body),
      onSuccess: refresh,
    }),
    approve: useMutation({
      mutationFn: (entryIds: string[]) => api.post<ApprovalSummary>(`${BASE}/approve`, { entryIds }),
      onSuccess: async () => {
        await client.invalidateQueries({ queryKey: timeKeys.all });
        await client.invalidateQueries({ queryKey: ['contracts'] });
      },
    }),
    withdraw: useMutation({
      mutationFn: (entryIds: string[]) => api.post<{ withdrawn: number }>(`${BASE}/withdraw`, { entryIds }),
      onSuccess: async () => {
        await client.invalidateQueries({ queryKey: timeKeys.all });
        await client.invalidateQueries({ queryKey: ['contracts'] });
      },
    }),
  };
}

export function usePeriods(year: number, enabled = true) {
  return useQuery({
    queryKey: timeKeys.periods(year),
    enabled,
    queryFn: async ({ signal }) => (await api.get<Period[]>(`${BASE}/periods${query({ year })}`, signal)).data,
  });
}

export function usePeriodActions() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: timeKeys.all });
  return {
    close: useMutation({ mutationFn: ({ year, month }: { year: number; month: number }) => api.post<Period>(`${BASE}/periods/${year}/${month}/close`), onSuccess: refresh }),
    reopen: useMutation({
      mutationFn: ({ year, month, reason }: { year: number; month: number; reason: string }) => api.post<Period>(`${BASE}/periods/${year}/${month}/reopen`, { reason }),
      onSuccess: refresh,
    }),
  };
}

export function useTechnicianMappings(unmappedOnly = false) {
  return useQuery({
    queryKey: [...timeKeys.technicians, unmappedOnly],
    queryFn: async ({ signal }) => (await api.get<TechnicianMapping[]>(`/api/v1/identity/technicians${query({ unmappedOnly })}`, signal)).data,
  });
}

export function useMapTechnician() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, userId }: { id: string; userId: string | null }) => api.put(`/api/v1/identity/technicians/${id}`, { userId }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: timeKeys.technicians });
      await client.invalidateQueries({ queryKey: timeKeys.all });
    },
  });
}
