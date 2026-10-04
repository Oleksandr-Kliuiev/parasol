import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, query } from '../../api/client';
import { usePagedList } from '../../api/paging';
import type { PagedResult } from '../../api/types';
import type { Lead, LeadRequest, LeadStatus, Opportunity, OpportunityRequest, PipelineView, Stage } from './types';

const BASE = '/api/v1/sales';

export const salesKeys = {
  all: ['sales'] as const,
  stages: ['sales', 'stages'] as const,
  leads: (filters: object) => ['sales', 'leads', filters] as const,
  opportunities: (filters: object) => ['sales', 'opportunities', filters] as const,
  opportunity: (id: string) => ['sales', 'opportunity', id] as const,
  pipeline: (filters: object) => ['sales', 'pipeline', filters] as const,
};

export function useStages(includeInactive = false) {
  return useQuery({
    queryKey: [...salesKeys.stages, includeInactive],
    staleTime: 300_000,
    queryFn: async ({ signal }) => (await api.get<Stage[]>(`${BASE}/stages${query({ includeInactive })}`, signal)).data,
  });
}

export function useSaveStage() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, etag, ...body }: { id?: string; etag?: string; name: string; probability: number; order: number; isActive: boolean }) =>
      id ? api.put<Stage>(`${BASE}/stages/${id}`, body, etag) : api.post<Stage>(`${BASE}/stages`, body),
    onSuccess: () => client.invalidateQueries({ queryKey: salesKeys.all }),
  });
}

/** Leads page by page, newest first, with how many the filter matches (DEV-12). */
export function useLeads(filters: { status?: LeadStatus | null; mine?: boolean; search?: string }) {
  return usePagedList<Lead>(salesKeys.leads(filters), `${BASE}/leads`, filters);
}

export function useLeadActions() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: salesKeys.all });
  return {
    create: useMutation({ mutationFn: (request: LeadRequest) => api.post<Lead>(`${BASE}/leads`, request), onSuccess: refresh }),
    update: useMutation({
      mutationFn: ({ id, request, etag }: { id: string; request: LeadRequest; etag: string }) => api.put<Lead>(`${BASE}/leads/${id}`, request, etag),
      onSuccess: refresh,
    }),
    qualify: useMutation({ mutationFn: (id: string) => api.post<Lead>(`${BASE}/leads/${id}/qualify`), onSuccess: refresh }),
    disqualify: useMutation({
      mutationFn: ({ id, reason }: { id: string; reason: string }) => api.post<Lead>(`${BASE}/leads/${id}/disqualify`, { reason }),
      onSuccess: refresh,
    }),
    convert: useMutation({
      mutationFn: ({ id, ...body }: { id: string; createOpportunity: boolean; opportunityName: string | null; stageId: string | null; expectedCloseDate: string | null; oneOffAmount: number | null; mrr: number | null; termMonths: number | null }) =>
        api.post<Lead>(`${BASE}/leads/${id}/convert`, body),
      onSuccess: async () => {
        await client.invalidateQueries({ queryKey: salesKeys.all });
        await client.invalidateQueries({ queryKey: ['organizations'] });
      },
    }),
  };
}

export interface OpportunityFilters {
  [key: string]: string | number | boolean | null | undefined;
  search?: string;
  organizationId?: string;
  ownerId?: string;
  stageId?: string;
  status?: string | null;
  mine?: boolean;
  stale?: boolean;
}

/** Deals page by page, soonest expected close first, with how many the filter matches (DEV-12). */
export function useOpportunities(filters: OpportunityFilters, enabled = true, limit?: number) {
  return usePagedList<Opportunity>([...salesKeys.opportunities(filters), limit], `${BASE}/opportunities`, filters, { enabled, limit });
}

/** The next cards of one board column: the deals list with the board's filters, the stage and the column's cursor. */
export async function fetchOpportunityPage(filters: OpportunityFilters, cursor: string) {
  return (await api.get<PagedResult<Opportunity>>(`${BASE}/opportunities${query({ ...filters, limit: 50, cursor })}`)).data;
}

export function usePipeline(filters: OpportunityFilters) {
  return useQuery({
    queryKey: salesKeys.pipeline(filters),
    queryFn: async ({ signal }) => (await api.get<PipelineView>(`${BASE}/pipeline${query(filters)}`, signal)).data,
  });
}

export function useOpportunity(id: string | undefined) {
  return useQuery({
    queryKey: salesKeys.opportunity(id ?? ''),
    enabled: Boolean(id),
    queryFn: async ({ signal }) => (await api.get<Opportunity>(`${BASE}/opportunities/${id}`, signal)).data,
  });
}

export function useOpportunityActions() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: salesKeys.all });
  return {
    create: useMutation({ mutationFn: (request: OpportunityRequest) => api.post<Opportunity>(`${BASE}/opportunities`, request), onSuccess: refresh }),
    update: useMutation({
      mutationFn: ({ id, request, etag }: { id: string; request: OpportunityRequest; etag: string }) =>
        api.put<Opportunity>(`${BASE}/opportunities/${id}`, request, etag),
      onSuccess: refresh,
    }),
    move: useMutation({
      mutationFn: ({ id, stageId, lostReason }: { id: string; stageId: string; lostReason?: string | null }) =>
        api.post<Opportunity>(`${BASE}/opportunities/${id}/stage`, { stageId, lostReason: lostReason ?? null }),
      onSuccess: refresh,
    }),
    reopen: useMutation({ mutationFn: (id: string) => api.post<Opportunity>(`${BASE}/opportunities/${id}/reopen`), onSuccess: refresh }),
  };
}
