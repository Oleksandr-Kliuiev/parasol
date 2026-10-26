import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, query } from '../../api/client';
import { usePagedList } from '../../api/paging';
import type { ImportResult, LicenseUsageRow, LicensingAttention, ReconciliationReport, Subscription, SubscriptionSource } from './types';

const BASE = '/api/v1/licensing';

export interface SubscriptionFilters {
  [key: string]: string | number | boolean | null | undefined;
  search?: string;
  organizationId?: string;
  source?: SubscriptionSource | null;
  renewingSoon?: boolean;
  cancellationWindowOpen?: boolean;
  notBilled?: boolean;
  withoutOrganization?: boolean;
}

export const licensingKeys = {
  all: ['licensing'] as const,
  subscriptions: (filters: SubscriptionFilters) => ['licensing', 'subscriptions', filters] as const,
  attention: ['licensing', 'attention'] as const,
  usage: (organizationId: string | undefined, unusedOnly: boolean) => ['licensing', 'usage', organizationId ?? null, unusedOnly] as const,
  reconciliation: (period: string) => ['licensing', 'reconciliation', period] as const,
  periods: ['licensing', 'reconciliation', 'periods'] as const,
};

/**
 * Subscriptions page by page, with how many the filter matches (DEV-12). `keepPrevious`: the list searched as people type keeps
 * the rows of the previous search or filter until the new answer is there, so a row someone is clicking does not vanish; a
 * customer's own tab starts empty and never shows another customer's rows.
 */
export function useSubscriptions(filters: SubscriptionFilters, enabled = true, options: { keepPrevious?: boolean } = {}) {
  return usePagedList<Subscription>(licensingKeys.subscriptions(filters), `${BASE}/subscriptions`, filters,
    { enabled, keepPrevious: options.keepPrevious });
}

export function useLicensingAttention(enabled = true) {
  return useQuery({
    queryKey: licensingKeys.attention,
    enabled,
    queryFn: async ({ signal }) => (await api.get<LicensingAttention>(`${BASE}/attention`, signal)).data,
  });
}

/** Uploads a distributor export; the preview reports what the file would change without writing it (BR-LIC-05). */
export function useImportSubscriptions() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ csv, dryRun }: { csv: string; dryRun: boolean }) => postCsv<ImportResult>(`${BASE}/import?dryRun=${dryRun}`, csv),
    onSuccess: (_, variables) => (variables.dryRun ? undefined : client.invalidateQueries({ queryKey: licensingKeys.all })),
  });
}

/** Licences bought against licences handed out; unusedOnly is the list someone can act on (BR-LIC-04). */
export function useLicenseUsage(organizationId: string | undefined, unusedOnly: boolean, enabled = true) {
  return useQuery({
    queryKey: licensingKeys.usage(organizationId, unusedOnly),
    enabled,
    queryFn: async ({ signal }) =>
      (await api.get<LicenseUsageRow[]>(`${BASE}/usage${query({ organizationId, unusedOnly })}`, signal)).data,
  });
}

export function useReconciliation(period: string, enabled = true) {
  const [year, month] = period.split('-');
  return useQuery({
    queryKey: licensingKeys.reconciliation(period),
    enabled: enabled && Boolean(year && month),
    queryFn: async ({ signal }) =>
      (await api.get<ReconciliationReport>(`${BASE}/reconciliation${query({ year, month })}`, signal)).data,
  });
}

/** Months that have Microsoft cost lines; the newest is what the report opens on. */
export function useReconciliationPeriods(enabled = true) {
  return useQuery({
    queryKey: licensingKeys.periods,
    enabled,
    queryFn: async ({ signal }) => (await api.get<string[]>(`${BASE}/reconciliation/periods`, signal)).data,
  });
}

/** Imports the distributor's invoice file; the preview reports what it would change without writing it (FR-LIC-04). */
export function useImportMsBilling() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ csv, dryRun }: { csv: string; dryRun: boolean }) => postCsv<ImportResult>(`${BASE}/ms-billing/import?dryRun=${dryRun}`, csv),
    onSuccess: (_, variables) => (variables.dryRun ? undefined : client.invalidateQueries({ queryKey: licensingKeys.all })),
  });
}

/** The CSV endpoints take the file as the body, so they bypass the JSON client. */
export async function postCsv<T>(url: string, csv: string): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/csv', 'X-CSRF': '1' },
    credentials: 'same-origin',
    body: csv,
  });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as T & { detail?: string; errors?: string[] }) : null;
  if (!response.ok) {
    throw new Error(body?.errors?.join(' ') ?? body?.detail ?? `Import failed with status ${response.status}`);
  }

  return body!;
}
