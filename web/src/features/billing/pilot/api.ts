import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, query } from '../../../api/client';
import { usePagedList } from '../../../api/paging';
import { postCsv } from '../../admin/migration/api';
import type { BasisStatus, BillingGroup, InvoiceStatus, Ref } from '../types';

const BASE = '/api/v1/billing';

// ---------- Readiness ----------

export interface ReadinessCheck {
  check: string;
  state: string;
  /** True: does not endanger the run. False: does. Null: crm-web cannot know. */
  ok: boolean | null;
  code: string;
  decisive: boolean;
}

export interface Readiness {
  safeForParallelRun: boolean;
  targetPeriod: string | null;
  source: string;
  checks: ReadinessCheck[];
  caveats: string[];
}

// ---------- Trace ----------

export interface TraceRow {
  lineId: string;
  basisId: string;
  runId: string;
  payer: Ref;
  payerOrgNumber: string | null;
  sourceOrganization: Ref | null;
  group: BillingGroup;
  productCode: string | null;
  description: string;
  sourceKey: string | null;
  periodStart: string;
  periodEnd: string;
  quantity: number;
  /** Money is removed server-side for callers without finance.read. */
  unitPrice?: number | null;
  discountPct?: number | null;
  vatRate: number;
  lineTotal?: number | null;
  origin: 'Collected' | 'Manual';
  decision: 'None' | 'Override' | 'Exclusion';
  manuallyAdjusted: boolean;
  changeReason: string | null;
  conflict: 'None' | 'SourceChanged' | 'SourceRemoved';
  anomalyCodes: string[];
  basisStatus: BasisStatus;
  orderNo: string | null;
  invoiceNo: string | null;
  invoiceStatus: InvoiceStatus | null;
}

export interface TraceFilters {
  [key: string]: string | number | boolean | null | undefined;
  payerId?: string;
  group?: string;
  anomaly?: string;
  anomaliesOnly?: boolean;
}

export const pilotKeys = {
  readiness: (period: string) => ['billing', 'pilot', 'readiness', period] as const,
  trace: (runId: string, filters: object) => ['billing', 'pilot', 'trace', runId, filters] as const,
  overview: (runId: string) => ['billing', 'pilot', 'overview', runId] as const,
  kpi: (range: object) => ['billing', 'pilot', 'kpi', range] as const,
};

export function useReadiness(period: string | undefined) {
  return useQuery({
    queryKey: pilotKeys.readiness(period ?? ''),
    enabled: Boolean(period),
    queryFn: async ({ signal }) => (await api.get<Readiness>(`${BASE}/pilot-readiness${query({ period })}`, signal)).data,
  });
}

export function useTrace(runId: string, filters: TraceFilters) {
  return usePagedList<TraceRow>(pilotKeys.trace(runId, filters), `${BASE}/runs/${runId}/trace`, filters, { limit: 100 });
}

export const traceExportUrl = (runId: string, filters: TraceFilters, lang: string) => `${BASE}/runs/${runId}/trace.xlsx${query({ ...filters, lang })}`;

// ---------- Comparison ----------

export type CompareStatus = 'Matched' | 'Different' | 'MissingInCrm' | 'MissingInFile' | 'MissingCustomer' | 'Rejected';
export const compareStatuses: CompareStatus[] = ['Matched', 'Different', 'MissingInCrm', 'MissingInFile', 'MissingCustomer', 'Rejected'];

/** Amounts are removed server-side for callers without finance.read. */
export interface CompareItem {
  key: string;
  status: CompareStatus;
  reasonCode: string | null;
  line: number | null;
  orgNumber: string | null;
  payerId: string | null;
  currency: string;
  group: string | null;
  productCode: string | null;
  fileRows: number;
  fileAmount?: number | null;
  crmAmount?: number | null;
  difference?: number | null;
  fileQuantity: number | null;
  crmQuantity: number | null;
  crmLines: number;
  externalRefs: string[];
}

export interface PayerSummary {
  payerKey: string;
  orgNumber: string | null;
  payerId: string | null;
  currency: string;
  keys: number;
  exceptions: number;
  fileAmount?: number | null;
  crmAmount?: number | null;
  difference?: number | null;
  status: string;
}

export interface CompareTotals {
  currency: string;
  keys: number;
  exceptions: number;
  fileAmount?: number | null;
  crmAmount?: number | null;
  difference?: number | null;
}

export interface ComparisonDocument {
  schemaVersion: string;
  comparisonId: string;
  runId: string;
  periodStart: string;
  runStatus: string;
  runContentRevision: number;
  contentDigest: string;
  fileSha256: string;
  fileRows: number;
  unknownColumns: string[];
  at: string;
  exceptionCount: number;
  statusCounts: Record<string, number>;
  totals: CompareTotals[];
  payers: PayerSummary[];
  items: CompareItem[];
}

export interface ComparisonResult {
  documentSha256: string;
  documentKey: string;
  comparison: ComparisonDocument;
}

export function useCompare(runId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (csv: string) => postCsv<ComparisonResult>(`${BASE}/runs/${runId}/pilot/compare`, csv),
    onSettled: () => client.invalidateQueries({ queryKey: pilotKeys.overview(runId) }),
  });
}

// ---------- Sign-off ----------

export interface PilotExplanation {
  key: string;
  text: string;
  ownerRole: string;
}

export interface SignoffRequest {
  comparisonId: string;
  comparisonSha256: string;
  explanations: PilotExplanation[];
  fallbackProcess: string;
  statement: string;
}

export interface SignoffResult {
  signoffId: string;
  documentSha256: string;
  documentKey: string;
  signedAt: string;
  exceptionCount: number;
}

export interface ComparisonInfo {
  id: string;
  documentSha256: string;
  fileSha256: string;
  fileRows: number;
  at: string;
  createdBy: Ref;
  runContentRevision: number;
  stale: boolean;
  exceptionCount: number;
  statusCounts: Record<string, number>;
  signoffs: number;
}

export interface SignoffInfo {
  id: string;
  comparisonId: string;
  documentSha256: string;
  comparisonSha256: string;
  signedAt: string;
  signedBy: Ref;
  exceptionCount: number;
  runContentRevision: number;
  stale: boolean;
}

export interface PilotOverview {
  runId: string;
  contentRevision: number;
  /** The exact sentence a sign-off must confirm. */
  statement: string;
  comparisons: ComparisonInfo[];
  signoffs: SignoffInfo[];
}

export function useOverview(runId: string) {
  return useQuery({
    queryKey: pilotKeys.overview(runId),
    queryFn: async ({ signal }) => (await api.get<PilotOverview>(`${BASE}/runs/${runId}/pilot`, signal)).data,
  });
}

export function useSignoff(runId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ request, etag }: { request: SignoffRequest; etag: string }) =>
      api.post<SignoffResult>(`${BASE}/runs/${runId}/pilot/signoff`, request, etag),
    onSettled: () => client.invalidateQueries({ queryKey: pilotKeys.overview(runId) }),
  });
}

// ---------- KPI ----------

export interface RunKpi {
  runId: string;
  periodStart: string;
  kind: 'Regular' | 'Supplementary';
  status: string;
  hoursCollectedToClosed: number | null;
  hoursCollectedToExported: number | null;
  bases: number;
  basesCancelled: number;
  basesFailed: number;
  basesReconciliationRequired: number;
  basesWithAnomalies: number;
  anomalyEntries: number;
  lines: number;
  manualLines: number;
  manualShare: number | null;
  unresolvedConflicts: number;
}

export interface KpiTotals {
  runs: number;
  closedRuns: number;
  averageHoursCollectedToClosed: number | null;
  lines: number;
  manualLines: number;
  manualShare: number | null;
  anomalyEntries: number;
  unresolvedConflicts: number;
  basesFailed: number;
  basesReconciliationRequired: number;
}

export interface KpiReport {
  from: string;
  to: string;
  asOf: string;
  runs: RunKpi[];
  totals: KpiTotals;
  overdueUnacknowledgedReminders: number;
  notMeasured: Array<{ kpi: string; reason: string }>;
}

export function useKpi(range: { from?: string; to?: string }, enabled: boolean) {
  return useQuery({
    queryKey: pilotKeys.kpi(range),
    enabled,
    queryFn: async ({ signal }) => (await api.get<KpiReport>(`${BASE}/pilot/kpi${query(range)}`, signal)).data,
  });
}
