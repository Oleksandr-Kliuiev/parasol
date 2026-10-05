import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, CSRF_HEADER, MAINTENANCE_EVENT, api, loginUrl, type Problem } from '../../../api/client';

const BASE = '/api/v1/customers/organizations/import';

export type ImportAction = 'Created' | 'Updated' | 'Unchanged' | 'Conflict' | 'Rejected';
export type RunStatus = 'Running' | 'Completed' | 'Partial' | 'Failed';

export interface MigrationRow {
  line: number;
  name: string | null;
  orgNumber: string | null;
  action: ImportAction | 'Failed';
  detail: string | null;
  organizationId: string | null;
  reasonCode: string | null;
  fieldsChanged: string[] | null;
  conflictFields: string[] | null;
  warnings: string[] | null;
  contactAction: string | null;
}

export interface OwnerCoverage {
  columnPresent: boolean;
  resolved: number;
  empty: number;
  unknown: number;
}

/** The answer of an import or a preview and of reading a stored run (DEV-20). `failed` is the older name of `rejected`. */
export interface MigrationResult {
  created: number;
  updated: number;
  unchanged: number;
  contacts: number;
  conflicts: number;
  failed: number;
  rows: MigrationRow[];
  warnings: string[];
  runId: string;
  sourceSha256: string;
  mappingVersion: string;
  repeatKey: string;
  mode: 'DryRun' | 'Real';
  status: RunStatus;
  rowsTotal: number;
  rejected: number;
  lastCommittedLine: number;
  reasonCounts: Record<string, number>;
  warningCounts: Record<string, number>;
  owners: OwnerCoverage;
  validatedNotImported: Record<string, number>;
  failedFromLine: number | null;
  failedToLine: number | null;
  failureCode: string | null;
  repeated: boolean;
}

export interface MigrationRun {
  id: string;
  mode: 'DryRun' | 'Real';
  status: RunStatus;
  sourceSha256: string;
  mappingVersion: string;
  repeatKey: string;
  rowsTotal: number;
  created: number;
  updated: number;
  unchanged: number;
  conflicts: number;
  rejected: number;
  contacts: number;
  lastCommittedLine: number;
  failedFromLine: number | null;
  failedToLine: number | null;
  failureCode: string | null;
  startedAt: string;
  finishedAt: string | null;
  userId: string | null;
}

/** A stored outcome: line, code, ids and field names; never a name, an address or a value. */
export interface MigrationOutcome {
  id: string;
  line: number;
  action: ImportAction;
  reasonCode: string | null;
  organizationId: string | null;
  contactId: string | null;
  contactAction: string | null;
  fieldsChanged: string[];
  conflictFields: string[];
  warnings: string[];
}

export interface BatchEntity {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  fields: string[];
}

export interface ReconciliationLine {
  line: number | null;
  orgNumber: string | null;
  organizationId: string | null;
  period: string;
  currency: string;
  fileRows: number;
  status: 'Matched' | 'Different' | 'Compared' | 'MissingInCrm' | 'MissingCustomer' | 'MissingInFile' | 'Rejected';
  reasonCode: string | null;
  fileAmount?: number | null;
  crmBilled?: number | null;
  crmPending?: number | null;
  crmUnconfirmed?: number | null;
  difference?: number | null;
}

export interface ReconciliationResult {
  sourceSha256: string;
  fileRows: number;
  customers: number;
  amountsVisible: boolean;
  statusCounts: Record<string, number>;
  lines: ReconciliationLine[];
}

export const migrationKeys = {
  all: ['migration'] as const,
  runs: ['migration', 'runs'] as const,
  run: (id: string) => ['migration', 'run', id] as const,
  rows: (id: string, action: string) => ['migration', 'run', id, 'rows', action] as const,
  entities: (id: string) => ['migration', 'run', id, 'entities'] as const,
};

/** The CSV endpoints take the file as the body, so they bypass the JSON client; failures keep their problem code. */
export async function postCsv<T>(url: string, csv: string): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/csv', Accept: 'application/json', [CSRF_HEADER]: '1' },
    credentials: 'same-origin',
    body: csv,
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON body.
  }
  if (!response.ok) {
    const problem: Problem = { status: response.status, ...((body as Problem | null) ?? {}) };
    if (response.status === 401) window.location.assign(loginUrl());
    if (problem.code === 'MAINTENANCE_READ_ONLY') window.dispatchEvent(new Event(MAINTENANCE_EVENT));
    const wait = Number(response.headers.get('Retry-After'));
    throw new ApiError(response.status, problem, Number.isFinite(wait) && wait > 0 ? Math.ceil(wait) : undefined);
  }
  return body as T;
}

/** Previews (dryRun) or imports a file. A real import names the previewed hash, so another text is refused with 409. */
export function useMigrationImport() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ csv, dryRun, expectedSha256 }: { csv: string; dryRun: boolean; expectedSha256?: string }) =>
      postCsv<MigrationResult>(`${BASE}?dryRun=${dryRun}${expectedSha256 ? `&expectedSha256=${encodeURIComponent(expectedSha256)}` : ''}`, csv),
    onSettled: () => client.invalidateQueries({ queryKey: migrationKeys.all }),
  });
}

export function useReconcile() {
  return useMutation({ mutationFn: (csv: string) => postCsv<ReconciliationResult>(`${BASE}/reconcile`, csv) });
}

export function useMigrationRun(id: string | null) {
  return useQuery({
    queryKey: id ? migrationKeys.run(id) : migrationKeys.all,
    enabled: id !== null,
    queryFn: async ({ signal }) => (await api.get<MigrationResult>(`${BASE}/runs/${id}`, signal)).data,
  });
}

export const runsUrl = `${BASE}/runs`;
export const rowsUrl = (id: string) => `${BASE}/runs/${id}/rows`;
export const entitiesUrl = (id: string) => `${BASE}/runs/${id}/entities`;
