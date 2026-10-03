import { useQuery } from '@tanstack/react-query';
import { api, query } from '../../api/client';
import type { Dashboard, MarginReport } from './types';

export const reportKeys = {
  dashboard: (months: number) => ['reports', 'dashboard', months] as const,
  margins: (period: string, months: number) => ['reports', 'margins', period, months] as const,
  martDatasets: ['reports', 'mart'] as const,
};

/** FR-RPT-02: billed against what it cost us, per customer. */
export function useMargins(period: string, months: number) {
  const [year, month] = period.split('-');
  return useQuery({
    queryKey: reportKeys.margins(period, months),
    enabled: Boolean(year && month),
    queryFn: async ({ signal }) => (await api.get<MarginReport>(`/api/v1/reports/margins${query({ year, month, months })}`, signal)).data,
  });
}

/** FR-RPT-03: the tables Power BI can read with the Web connector. */
export function useMartDatasets(enabled: boolean) {
  return useQuery({
    queryKey: reportKeys.martDatasets,
    enabled,
    staleTime: 300_000,
    queryFn: async ({ signal }) => (await api.get<{ datasets: string[] }>('/api/v1/reports/mart', signal)).data.datasets,
  });
}

export function useDashboard(months = 6) {
  return useQuery({
    queryKey: reportKeys.dashboard(months),
    staleTime: 60_000,
    queryFn: async ({ signal }) => (await api.get<Dashboard>(`/api/v1/reports/dashboard${query({ months })}`, signal)).data,
  });
}
