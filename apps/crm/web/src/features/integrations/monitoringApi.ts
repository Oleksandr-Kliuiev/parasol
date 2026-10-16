import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';

export type TriageStatus = 'Open' | 'InProgress' | 'Resolved';
export interface ExceptionTriage {
  ownerId: string | null;
  ownerName: string | null;
  status: TriageStatus;
  comment: string | null;
  etag: string;
}
export interface MonitoringException {
  active: boolean;
  key: string;
  category: 'Integration' | 'Financial' | 'Pause';
  source: string;
  kind: string;
  detectedAt: string | null;
  lastSucceededAt: string | null;
  ageMinutes: number | null;
  thresholdMinutes: number | null;
  count: number;
  impact: string;
  runbook: string;
  triage: ExceptionTriage;
}
export interface MonitoringSystem {
  system: string;
  job: string;
  enabled: boolean;
  paused: boolean;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastSucceededAt: string | null;
  ageMinutes: number | null;
  freshness: 'Fresh' | 'Stale' | 'Never' | 'Paused' | 'Disabled';
  thresholdMinutes: number;
  failedOutbound: number;
  unmapped: number;
}
export interface MonitoringOverview {
  recoveredTotalCount: number;
  checkedAt: string;
  systems: MonitoringSystem[];
  exceptions: MonitoringException[];
}
export interface OperationResult {
  id: string;
  module?: string;
  status: 'Requested' | 'Unavailable' | 'Available' | 'Stale' | 'Unknown' | 'NotRequested';
}

const BASE = '/api/v1/integrations/monitoring';

export function useMonitoring(enabled: boolean) {
  return useQuery({
    queryKey: ['integrations', 'monitoring'],
    enabled,
    refetchInterval: 15_000,
    queryFn: async ({ signal }) => (await api.get<MonitoringOverview>(BASE, signal)).data,
  });
}

export function useTriage() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ key, ownerId, status, comment, etag }: ExceptionTriage & { key: string }) =>
      (await api.put<ExceptionTriage>(`${BASE}/triage`, { key, ownerId, status, comment }, etag)).data,
    onSettled: () => void client.invalidateQueries({ queryKey: ['integrations', 'monitoring'] }),
  });
}

export function useBulkOutboundRetry() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (request: { messages: { id: string; etag: string }[]; expected: number; reason: string }) =>
      (await api.post<{ items: OperationResult[] }>(`${BASE}/outbound/retry`, request)).data,
    onSettled: () => void client.invalidateQueries({ queryKey: ['integrations'] }),
  });
}
