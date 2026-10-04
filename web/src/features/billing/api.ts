import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, query } from '../../api/client';
import type {
  AdjustLineRequest,
  BasisListItem,
  BasisStatus,
  Basis,
  BillingSettings,
  CorrectionRequest,
  Invoice,
  InvoiceSummary,
  LegacyChargeReport,
  ManualLineRequest,
  ReconcileRequest,
  Run,
  RunListItem,
  RunStatus,
} from './types';

const BASE = '/api/v1/billing';

export const billingKeys = {
  all: ['billing'] as const,
  runs: (filters: object) => ['billing', 'runs', filters] as const,
  run: (id: string) => ['billing', 'run', id] as const,
  bases: (runId: string, filters: object) => ['billing', 'bases', runId, filters] as const,
  basis: (id: string) => ['billing', 'basis', id] as const,
  invoices: (filters: object) => ['billing', 'invoices', filters] as const,
  settings: ['billing', 'settings'] as const,
  legacy: ['billing', 'legacy'] as const,
};

export interface RunFilters {
  [key: string]: string | number | boolean | null | undefined;
  status?: RunStatus | null;
  year?: number | null;
  limit?: number;
}

export function useRuns(filters: RunFilters = {}) {
  return useQuery({
    queryKey: billingKeys.runs(filters),
    queryFn: async ({ signal }) => (await api.get<RunListItem[]>(`${BASE}/runs${query(filters)}`, signal)).data,
  });
}

/** While the export is in flight the worker changes the run behind our back, so the page follows it. */
export function useRun(id: string | undefined) {
  return useQuery({
    queryKey: billingKeys.run(id ?? ''),
    enabled: Boolean(id),
    queryFn: async ({ signal }) => (await api.get<Run>(`${BASE}/runs/${id}`, signal)).data,
    refetchInterval: (query) => (query.state.data?.status === 'Approved' || query.state.data?.status === 'Exporting' ? 5_000 : false),
  });
}

export function useBillingSettings() {
  return useQuery({
    queryKey: billingKeys.settings,
    staleTime: 600_000,
    queryFn: async ({ signal }) => (await api.get<BillingSettings>(`${BASE}/settings`, signal)).data,
  });
}

export interface BasisFilters {
  [key: string]: string | number | boolean | null | undefined;
  anomaliesOnly?: boolean;
  status?: BasisStatus | null;
  search?: string;
}

export function useBases(runId: string | undefined, filters: BasisFilters) {
  return useQuery({
    queryKey: billingKeys.bases(runId ?? '', filters),
    enabled: Boolean(runId),
    queryFn: async ({ signal }) => (await api.get<BasisListItem[]>(`${BASE}/runs/${runId}/bases${query(filters)}`, signal)).data,
    // An approved basis is waiting for the worker to send it; the list keeps up until every one has left.
    refetchInterval: (query) => (query.state.data?.some((basis) => basis.status === 'Approved') ? 5_000 : false),
  });
}

export function useBasis(id: string | undefined) {
  return useQuery({
    queryKey: billingKeys.basis(id ?? ''),
    enabled: Boolean(id),
    queryFn: async ({ signal }) => (await api.get<Basis>(`${BASE}/bases/${id}`, signal)).data,
    refetchInterval: (query) => (query.state.data?.status === 'Approved' ? 5_000 : false),
  });
}

/**
 * Every run action returns the whole run, so one invalidation keeps the page in step. Collect and both approvals carry the
 * ETag of the run on screen: an approval is about the revision the user saw, and a run that changed meanwhile answers 412.
 */
export function useRunActions(id?: string) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: billingKeys.all });
  const post = (path: string, etag?: string) => api.post<Run>(`${BASE}/runs/${id}/${path}`, etag ? {} : undefined, etag);
  return {
    create: useMutation({
      mutationFn: (request: { year: number; month: number; notes: string | null; supplementary: boolean }) => api.post<Run>(`${BASE}/runs`, request),
      onSuccess: refresh,
    }),
    collect: useMutation({ mutationFn: (etag: string) => post('collect', etag), onSuccess: refresh, onError: refresh }),
    review: useMutation({ mutationFn: () => post('review'), onSuccess: refresh }),
    approve: useMutation({ mutationFn: (etag: string) => post('approve', etag), onSuccess: refresh, onError: refresh }),
    secondApprove: useMutation({ mutationFn: (etag: string) => post('second-approve', etag), onSuccess: refresh, onError: refresh }),
    exportRun: useMutation({ mutationFn: () => post('export'), onSuccess: refresh }),
    close: useMutation({ mutationFn: () => post('close'), onSuccess: refresh }),
    discard: useMutation({
      mutationFn: (etag: string) => api.delete(`${BASE}/runs/${id}`, etag),
      onSuccess: refresh,
    }),
  };
}

export function useBasisActions(basisId: string) {
  const client = useQueryClient();
  const onSuccess = async (response: { data: Basis }) => {
    client.setQueryData(billingKeys.basis(basisId), response.data);
    await client.invalidateQueries({ queryKey: billingKeys.all, refetchType: 'none' });
  };
  return {
    addLine: useMutation({
      mutationFn: ({ request, etag }: { request: ManualLineRequest; etag: string }) =>
        api.post<Basis>(`${BASE}/bases/${basisId}/lines`, request, etag),
      onSuccess,
    }),
    adjustLine: useMutation({
      mutationFn: ({ lineId, request, etag }: { lineId: string; request: AdjustLineRequest; etag: string }) =>
        api.put<Basis>(`${BASE}/bases/${basisId}/lines/${lineId}`, request, etag),
      onSuccess,
    }),
    removeLine: useMutation({
      mutationFn: ({ lineId, etag }: { lineId: string; etag: string }) => api.delete<Basis>(`${BASE}/bases/${basisId}/lines/${lineId}`, etag),
      onSuccess,
    }),
    /** A collected line is left out with a reason instead of being deleted, so the next collect cannot bring it back. */
    excludeLine: useMutation({
      mutationFn: ({ lineId, reason, etag }: { lineId: string; reason: string; etag: string }) =>
        api.post<Basis>(`${BASE}/bases/${basisId}/lines/${lineId}/exclude`, { reason }, etag),
      onSuccess,
    }),
    /** Undoes Finance's decision: the line follows its source again. */
    revertLine: useMutation({
      mutationFn: ({ lineId, etag }: { lineId: string; etag: string }) => api.post<Basis>(`${BASE}/bases/${basisId}/lines/${lineId}/revert`, {}, etag),
      onSuccess,
    }),
    /** Confirms Finance's decision against what the source says now. */
    keepLine: useMutation({
      mutationFn: ({ lineId, reason, etag }: { lineId: string; reason: string; etag: string }) =>
        api.post<Basis>(`${BASE}/bases/${basisId}/lines/${lineId}/keep`, { reason }, etag),
      onSuccess,
    }),
    retry: useMutation({ mutationFn: () => api.post<Basis>(`${BASE}/bases/${basisId}/retry`), onSuccess }),
    /** Cancelling a basis of an open run changes what the run invoices, so it needs the basis on screen. */
    cancel: useMutation({
      mutationFn: ({ reason, etag }: { reason: string; etag: string }) => api.post<Basis>(`${BASE}/bases/${basisId}/cancel`, { reason }, etag),
      onSuccess,
    }),
    /** What Finance found in PowerOffice for a send that got no answer (ADR-013). */
    reconcile: useMutation({
      mutationFn: ({ request, etag }: { request: ReconcileRequest; etag: string }) => api.post<Basis>(`${BASE}/bases/${basisId}/reconcile`, request, etag),
      onSuccess,
    }),
    /** An addition to an exported line, billed by the next run; the exported order itself never changes. */
    addCorrection: useMutation({
      mutationFn: ({ lineId, request }: { lineId: string; request: CorrectionRequest }) =>
        api.post<{ id: string }>(`${BASE}/bases/${basisId}/lines/${lineId}/corrections`, request),
      onSuccess: () => client.invalidateQueries({ queryKey: billingKeys.all, refetchType: 'none' }),
    }),
  };
}

export interface InvoiceFilters {
  [key: string]: string | number | boolean | null | undefined;
  organizationId?: string;
  openOnly?: boolean;
  overdueOnly?: boolean;
  limit?: number;
}

export function useInvoices(filters: InvoiceFilters, enabled = true) {
  return useQuery({
    queryKey: billingKeys.invoices(filters),
    enabled,
    queryFn: async ({ signal }) => (await api.get<InvoiceSummary>(`${BASE}/invoices${query(filters)}`, signal)).data,
  });
}

export type { Invoice };

/** Lines billed before the charge register that hold what they cover until Finance decides (ADR-013, EXT-01). */
export function useLegacyCharges(enabled: boolean) {
  return useQuery({
    queryKey: billingKeys.legacy,
    enabled,
    queryFn: async ({ signal }) => (await api.get<LegacyChargeReport>(`${BASE}/charges/legacy`, signal)).data,
  });
}

export function useLegacyDecision() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, billed, reason, etag }: { id: string; billed: boolean; reason: string; etag: string }) =>
      api.post(`${BASE}/charges/${id}/legacy-decision`, { billed, reason }, etag),
    onSuccess: () => client.invalidateQueries({ queryKey: billingKeys.all }),
  });
}
