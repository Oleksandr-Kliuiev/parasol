import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { savedServicePolicy } from '../service/useSavedServiceList';
import type { Alert } from '../service/types';
import type { Incident, Notice, SecurityOverview, SecurityRecord } from './types';

const BASE = '/api/v1/security';

export const securityKeys = {
  all: ['security'] as const,
  record: (system: string, record: SecurityRecord) => ['security', system, record.kind, record.id] as const,
  overview: (organizationId: string) => ['security', 'overview', organizationId] as const,
};

/** The Huntress record an alert stands for, read from its id; null for an alert of another kind. */
export function securityRecord(alert: Pick<Alert, 'system' | 'externalId'>): SecurityRecord | null {
  if (alert.system !== 'huntress') return null;
  const match = /^(incident|escalation|platform-action):(\d+)$/.exec(alert.externalId);
  return match ? { kind: match[1] as SecurityRecord['kind'], id: Number(match[2]) } : null;
}

const path = (system: string, record: SecurityRecord) =>
  `${BASE}/${encodeURIComponent(system)}/${record.kind === 'incident' ? 'incidents' : record.kind === 'escalation' ? 'escalations' : 'platform-actions'}/${record.id}`;

/** The incident behind an alert (M41), read when its panel opens and never kept for later. */
export function useIncident(system: string, record: SecurityRecord | null) {
  return useQuery({
    ...savedServicePolicy, queryKey: record ? securityKeys.record(system, record) : ['security', 'none'], enabled: record?.kind === 'incident',
    queryFn: async ({ signal }) => {
      const answer = await api.get<Incident>(path(system, record!), signal);
      signal.throwIfAborted(); return answer.data;
    },
  });
}

/** The escalation or platform action behind an alert (M41). */
export function useNotice(system: string, record: SecurityRecord | null) {
  return useQuery({
    ...savedServicePolicy, queryKey: record ? securityKeys.record(system, record) : ['security', 'none'],
    enabled: record !== null && record.kind !== 'incident',
    queryFn: async ({ signal }) => {
      const answer = await api.get<Notice>(path(system, record!), signal);
      signal.throwIfAborted(); return answer.data;
    },
  });
}

/** A customer's security overview (M41): Huntress's counts and reports, read with the Drift tab. */
export function useSecurityOverview(organizationId: string, scope: { owner: string; revision: number }) {
  return useQuery({
    ...savedServicePolicy, queryKey: [...securityKeys.overview(organizationId), scope.owner, scope.revision],
    queryFn: async ({ signal }) => {
      const answer = await api.get<SecurityOverview>(`${BASE}/organizations/${organizationId}/overview`, signal);
      signal.throwIfAborted(); return answer.data;
    },
  });
}

/**
 * Confirms the closing of an urgent alert its source closed (M41): it is read first, so the change goes with the ETag of the alert as
 * it is now. Answers with the alert as it is then.
 */
export async function confirmClosed(alert: Pick<Alert, 'id'>) {
  const current = await api.get<Alert>(`/api/v1/service/alerts/${encodeURIComponent(alert.id)}`);
  return api.post<Alert>(`/api/v1/service/alerts/${encodeURIComponent(alert.id)}/confirm-closed`, {}, current.data.etag ?? null);
}
