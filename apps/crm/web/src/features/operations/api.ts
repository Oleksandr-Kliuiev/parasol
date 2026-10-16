import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, MAINTENANCE_EVENT } from '../../api/client';

// DEV-13 (ADR-021, runbook 03): read-only maintenance and the restore reconciliation.

export type MaintenanceMode = 'Normal' | 'ReadOnly';

/** What everyone may know, signed in or not; the reason only once signed in. */
export interface PublicMaintenance {
  mode: MaintenanceMode;
  since: string | null;
  reason: string | null;
}

export interface InFlightCount {
  area: string;
  count: number;
}

export interface MaintenanceStatus {
  mode: MaintenanceMode;
  reason: string | null;
  reference: string | null;
  setBy: string | null;
  since: string | null;
  /** The stored decision; a change names it, so two operators cannot overwrite each other unnoticed. */
  key: string | null;
  /** Read-only by configuration (Maintenance:ForceReadOnly): only a new revision lifts it. */
  forced: boolean;
  inFlight: InFlightCount[];
}

export interface RestoreLine {
  area: string;
  subject: string;
  finding: string;
  action: string | null;
  needsPerson: boolean;
}

export interface RestoreReport {
  id: string;
  at: string;
  restorePoint: string;
  applied: boolean;
  by: string;
  maintenanceKey: string | null;
  effects: number;
  checks: RestoreLine[];
  reconciliation: RestoreLine[];
}

export interface RestoreReportSummary {
  id: string;
  at: string;
  restorePoint: string;
  applied: boolean;
  by: string;
  effects: number;
  needsPerson: number;
}

export const publicMaintenanceKey = ['bff', 'maintenance'] as const;
const statusKey = ['operations', 'maintenance'] as const;
const reportsKey = ['operations', 'restore', 'reports'] as const;

export async function fetchPublicMaintenance(signal?: AbortSignal): Promise<PublicMaintenance> {
  return (await api.get<PublicMaintenance>('/bff/maintenance', signal)).data;
}

/** The public state: asked now and then, and again at once when the server refused a change for maintenance. */
export function usePublicMaintenance(enabled = true) {
  const queryClient = useQueryClient();
  useEffect(() => {
    const refresh = () => void queryClient.invalidateQueries({ queryKey: publicMaintenanceKey });
    window.addEventListener(MAINTENANCE_EVENT, refresh);
    return () => window.removeEventListener(MAINTENANCE_EVENT, refresh);
  }, [queryClient]);
  return useQuery({
    queryKey: publicMaintenanceKey,
    queryFn: ({ signal }) => fetchPublicMaintenance(signal),
    enabled,
    retry: false,
    staleTime: 10_000,
    refetchInterval: (query) => (query.state.data?.mode === 'ReadOnly' ? 15_000 : 60_000),
  });
}

/** The operator's view; while read-only it is asked every few seconds, so the sends under way are seen draining. */
export function useMaintenanceStatus() {
  return useQuery({
    queryKey: statusKey,
    queryFn: async ({ signal }) => (await api.get<MaintenanceStatus>('/api/v1/operations/maintenance', signal)).data,
    refetchInterval: (query) => (query.state.data?.mode === 'ReadOnly' ? 5_000 : false),
  });
}

export interface MaintenanceDecision {
  mode: MaintenanceMode;
  reason: string;
  reference: string | null;
  expectedKey: string | null;
}

export function useSetMaintenance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (decision: MaintenanceDecision) =>
      (await api.put<MaintenanceStatus>('/api/v1/operations/maintenance', decision)).data,
    onSuccess: (status) => {
      queryClient.setQueryData(statusKey, status);
      void queryClient.invalidateQueries({ queryKey: publicMaintenanceKey });
    },
    // Another decision may have been taken meanwhile: show the one that stands.
    onError: () => void queryClient.invalidateQueries({ queryKey: statusKey }),
  });
}

export function useReconcile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (request: { restorePoint: string; apply: boolean }) =>
      (await api.post<RestoreReport>('/api/v1/operations/restore/reconcile', request)).data,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: reportsKey }),
  });
}

export function useRestoreReports() {
  return useQuery({
    queryKey: reportsKey,
    queryFn: async ({ signal }) => (await api.get<RestoreReportSummary[]>('/api/v1/operations/restore/reports', signal)).data,
  });
}

export function useRestoreReport(id: string | null) {
  return useQuery({
    queryKey: [...reportsKey, id],
    queryFn: async ({ signal }) => (await api.get<RestoreReport>(`/api/v1/operations/restore/reports/${encodeURIComponent(id!)}`, signal)).data,
    enabled: id !== null,
  });
}
