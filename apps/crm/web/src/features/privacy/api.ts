import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, download } from '../../api/client';
import { usePagedList } from '../../api/paging';

export type PrivacyCaseKind = 'Access' | 'Erasure';
export type DataSubjectKind = 'Contact' | 'Lead';
export type PrivacyCaseStatus = 'Received' | 'Verified' | 'Previewed' | 'Executing' | 'Completed' | 'Rejected';
export type RequestChannel = 'Email' | 'Letter' | 'Phone' | 'InPerson' | 'Other';
export type VerificationMethod = 'KnownEmail' | 'InPerson' | 'SignedLetter' | 'Other';
export type ErasureAction = 'Pseudonymize' | 'Delete' | 'Retain' | 'OperatorErasure';
export type RetentionBasis = 'Bookkeeping' | 'LegalHold';
export type LegalHoldReason = 'Bookkeeping' | 'LegalClaim' | 'AuthorityRequest' | 'Other';

export interface PrivacyCaseSummary {
  id: string;
  number: string;
  kind: PrivacyCaseKind;
  subjectKind: DataSubjectKind;
  subjectId: string;
  status: PrivacyCaseStatus;
  receivedAt: string;
  dueOn: string;
  overdue: boolean;
}

export interface RecordRef {
  module: string;
  entityType: string;
  entityId: string;
}

export interface Receipt {
  case: string;
  manifest: string;
  manifestSha256: string;
  modules: { module: string; actions: { action: ErasureAction; records: number }[] }[];
  retained: { module: string; entityType: string; entityId: string; basis: RetentionBasis | null; until: string | null; note: string | null }[];
  operatorErasure: { module: string; entityType: string; records: number }[];
  suppressions: { kind: 'Email' | 'ExternalReference'; count: number }[];
  externalSystems: string[];
}

export interface PrivacyCase extends PrivacyCaseSummary {
  channel: RequestChannel;
  note: string | null;
  verifiedAt: string | null;
  verificationMethod: VerificationMethod | null;
  verificationNote: string | null;
  planDigest: string | null;
  previewedAt: string | null;
  completedAt: string | null;
  rejectionReason: string | null;
  exportSha256: string | null;
  receipt: Receipt | null;
  etag: string;
}

export interface PlannedErasure {
  record: RecordRef;
  action: ErasureAction;
  dataClass: string;
  basis: RetentionBasis | null;
  retainUntil: string | null;
  note: string | null;
}

export interface Plan {
  digest: string;
  records: PlannedErasure[];
  counts: { module: string; action: ErasureAction; records: number }[];
  etag: string;
}

export interface LegalHold {
  id: string;
  module: string;
  entityType: string;
  entityId: string;
  reason: LegalHoldReason;
  explanation: string;
  until: string;
  active: boolean;
  placedAt: string;
  releasedAt: string | null;
  releaseReason: string | null;
  etag: string;
}

export interface Suppression {
  id: string;
  kind: 'Email' | 'ExternalReference';
  caseId: string;
  caseNumber: string | null;
  createdAt: string;
  liftedAt: string | null;
  liftReason: string | null;
  etag: string;
}

export interface RetentionClass {
  dataClass: string;
  approved: boolean;
  reference: string | null;
  days: number | null;
  proposal: boolean;
  due: number;
  removed: number;
  error: string | null;
}

export interface RetentionOverview {
  mode: 'DryRun' | 'Apply';
  policies: { dataClass: string; retainDays: number; approvedBy: string; approvedAt: string; reference: string }[];
  proposals: Record<string, number>;
  lastRun: { runId: string; mode: 'DryRun' | 'Apply'; startedAt: string; finishedAt: string | null; failed: boolean; classes: RetentionClass[] } | null;
}

const base = '/api/v1/privacy';

const keys = {
  cases: (includeClosed: boolean) => ['privacy', 'cases', includeClosed] as const,
  case: (id: string) => ['privacy', 'case', id] as const,
  plan: (id: string) => ['privacy', 'plan', id] as const,
  holds: (includeEnded: boolean) => ['privacy', 'holds', includeEnded] as const,
  suppressions: ['privacy', 'suppressions'] as const,
  retention: ['privacy', 'retention'] as const,
};

/** Newest first, a page at a time with the count of all (DEV-12). */
export function usePrivacyCases(includeClosed: boolean) {
  return usePagedList<PrivacyCaseSummary>(keys.cases(includeClosed), `${base}/cases`, { includeClosed: includeClosed || undefined }, { limit: 25 });
}

export function usePrivacyCase(id: string) {
  return useQuery({
    queryKey: keys.case(id),
    queryFn: async ({ signal }) => (await api.get<PrivacyCase>(`${base}/cases/${id}`, signal)).data,
  });
}

/** The recorded plan of a case that was previewed; none (404/409) before the first preview. */
export function usePrivacyPlan(id: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.plan(id),
    enabled,
    retry: false,
    queryFn: async ({ signal }) => (await api.get<Plan>(`${base}/cases/${id}/plan`, signal)).data,
  });
}

export function useLegalHolds(includeEnded: boolean) {
  return usePagedList<LegalHold>(keys.holds(includeEnded), `${base}/holds`, { includeEnded: includeEnded || undefined }, { limit: 25 });
}

export function useSuppressions() {
  return usePagedList<Suppression>(keys.suppressions, `${base}/suppressions`, {}, { limit: 25 });
}

export function useRetention() {
  return useQuery({
    queryKey: keys.retention,
    queryFn: async ({ signal }) => (await api.get<RetentionOverview>(`${base}/retention`, signal)).data,
  });
}

export interface OpenCaseRequest {
  kind: PrivacyCaseKind;
  subjectKind: DataSubjectKind;
  subjectId: string;
  channel: RequestChannel;
  receivedAt: string | null;
  note: string | null;
}

export function useOpenCase() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (request: OpenCaseRequest) => (await api.post<PrivacyCase>(`${base}/cases`, request)).data,
    onSuccess: () => client.invalidateQueries({ queryKey: ['privacy', 'cases'] }),
  });
}

/** The steps of one case: each sends the version it read (If-Match) and refreshes the case. */
export function useCaseActions(id: string) {
  const client = useQueryClient();
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: keys.case(id) });
    await client.invalidateQueries({ queryKey: ['privacy', 'cases'] });
  };
  return {
    verify: useMutation({
      mutationFn: ({ etag, method, note }: { etag: string; method: VerificationMethod; note: string | null }) =>
        api.post<PrivacyCase>(`${base}/cases/${id}/verify`, { method, note }, etag),
      onSuccess: refresh,
    }),
    reject: useMutation({
      mutationFn: ({ etag, reason }: { etag: string; reason: string }) => api.post<PrivacyCase>(`${base}/cases/${id}/reject`, { reason }, etag),
      onSuccess: refresh,
    }),
    preview: useMutation({
      mutationFn: async ({ etag }: { etag: string }) => (await api.post<Plan>(`${base}/cases/${id}/preview`, {}, etag)).data,
      onSuccess: async (plan) => {
        client.setQueryData(keys.plan(id), plan);
        await refresh();
      },
    }),
    execute: useMutation({
      mutationFn: ({ etag, planDigest, confirmation }: { etag: string; planDigest: string; confirmation: string }) =>
        api.post<PrivacyCase>(`${base}/cases/${id}/execute`, { planDigest, confirmation }, etag),
      onSettled: refresh,
    }),
    export: useMutation({
      mutationFn: () => download(`${base}/cases/${id}/export`),
      onSuccess: refresh,
    }),
  };
}

export interface PlaceHoldRequest {
  module: string;
  entityType: string;
  entityId: string;
  reason: LegalHoldReason;
  explanation: string;
  until: string;
}

export function useHoldActions() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: ['privacy'] });
  return {
    place: useMutation({ mutationFn: (request: PlaceHoldRequest) => api.post<LegalHold>(`${base}/holds`, request), onSuccess: refresh }),
    release: useMutation({
      mutationFn: ({ hold, reason }: { hold: LegalHold; reason: string }) => api.post(`${base}/holds/${hold.id}/release`, { reason }, hold.etag),
      onSuccess: refresh,
    }),
    lift: useMutation({
      mutationFn: ({ suppression, reason }: { suppression: Suppression; reason: string }) =>
        api.post(`${base}/suppressions/${suppression.id}/lift`, { reason }, suppression.etag),
      onSuccess: refresh,
    }),
  };
}
