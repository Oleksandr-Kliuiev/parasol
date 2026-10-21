import { useQueries, useQuery } from '@tanstack/react-query';
import { api, query } from '../../../api/client';
import { Permissions, useCurrentUser } from '../../../auth/CurrentUserContext';
import { activityKeys } from '../../activities/api';
import type { ActivityPriority, ActivityRef, ActivityStatus } from '../../activities/types';
import type { AlertKind, AlertSeverity, AlertState } from '../types';

const BASE = '/api/v1/activities';

/** The alert as the CRM stores it at the moment of the read. */
export interface AlertTaskSource {
  id: string;
  organizationId: string;
  organizationName: string | null;
  system: string;
  kind: AlertKind;
  title: string;
  severity: AlertSeverity;
  state: AlertState;
  deviceName: string | null;
  deviceId: string | null;
  createdAt: string;
  url: string | null;
  resolvedAt: string | null;
}

/** The task an alert has; subject, assignee and due date are empty once the task was deleted. */
export interface AlertTask {
  id: string;
  organizationId: string;
  subject: string | null;
  status: ActivityStatus;
  assignee: ActivityRef | null;
  dueAt: string | null;
  isAvailable: boolean;
}

export interface AlertTaskPreview {
  alert: AlertTaskSource;
  fingerprint: string;
  subject: string;
  priority: Extract<ActivityPriority, 'Normal' | 'High'>;
  task: AlertTask | null;
  canCreate: boolean;
}

export interface AlertTaskOutcome {
  status: 'CREATED' | 'EXISTING';
  task: AlertTask;
}

export interface TaskSource {
  task: AlertTask;
  alert: AlertTaskSource | null;
}

/** The ids one lookup may carry: a page of the queue or of a customer's alerts. */
export const lookupLimit = 50;

/** Tasks made from alerts need both reads; assigning one needs activities.write too (the server checks the same). */
export function useAlertTaskAccess() {
  const user = useCurrentUser();
  const read = user.permissions.includes(Permissions.activitiesRead) && user.permissions.includes(Permissions.serviceRead);
  return { read, write: read && user.permissions.includes(Permissions.activitiesWrite), user };
}

export const alertTaskKeys = {
  /** Under the activities key: a task saved anywhere refreshes the rows that show tasks. */
  all: [...activityKeys.all, 'alert-tasks'] as const,
  preview: (alertId: string, scope: string) => [...activityKeys.all, 'alert-tasks', 'preview', alertId, scope] as const,
  lookup: (ids: readonly string[], scope: string) => [...activityKeys.all, 'alert-tasks', 'lookup', ids, scope] as const,
  source: (activityId: string, scope: string) => [...activityKeys.all, 'alert-tasks', 'source', activityId, scope] as const,
};

const fresh = { retry: false, staleTime: 0, gcTime: 0, refetchOnWindowFocus: false } as const;

/** The alert as stored now, with the task it has and what assigning it would make. */
export function useAlertTaskPreview(alertId: string, enabled = true) {
  const { read, user } = useAlertTaskAccess();
  const scope = JSON.stringify([user.id, [...user.permissions].sort()]);
  return useQuery({
    ...fresh,
    queryKey: alertTaskKeys.preview(alertId, scope),
    enabled: enabled && read && alertId !== '',
    queryFn: async ({ signal }) =>
      (await api.get<AlertTaskPreview>(`${BASE}/source-tasks/preview${query({ alertId })}`, signal)).data,
  });
}

export async function createAlertTask(body: {
  alertId: string; assigneeId: string; dueAt: string | null; subject: string; expectedFingerprint: string;
}): Promise<AlertTaskOutcome> {
  return (await api.post<AlertTaskOutcome>(`${BASE}/source-tasks`, body)).data;
}

/**
 * The tasks the shown alerts already have: one lookup per page of rows (never one per row), merged into one map. A page whose
 * lookup failed leaves its rows without task facts; the rows then offer the dialog, which reads the alert's task itself.
 */
export function useAlertTaskLinks(pages: readonly (readonly string[])[], enabled = true) {
  const { read, user } = useAlertTaskAccess();
  const scope = JSON.stringify([user.id, [...user.permissions].sort()]);
  return useQueries({
    queries: pages.filter((ids) => ids.length > 0).map((ids) => ({
      queryKey: alertTaskKeys.lookup(ids, scope),
      enabled: enabled && read,
      retry: false,
      staleTime: 30_000,
      queryFn: async () =>
        (await api.post<{ items: { alertId: string; task: AlertTask }[] }>(`${BASE}/source-tasks/lookup`, { alertIds: ids.slice(0, lookupLimit) })).data,
    })),
    combine: (results) => {
      const links = new Map<string, AlertTask>();
      for (const result of results) for (const item of result.data?.items ?? []) links.set(item.alertId, item.task);
      return { links, loading: results.some((r) => r.isPending && r.fetchStatus !== 'idle'), failed: results.some((r) => r.isError) };
    },
  });
}

/** A task's alert read again now (the task's Source button). */
export function useTaskSource(activityId: string, enabled: boolean) {
  const { read, user } = useAlertTaskAccess();
  const scope = JSON.stringify([user.id, [...user.permissions].sort()]);
  return useQuery({
    ...fresh,
    queryKey: alertTaskKeys.source(activityId, scope),
    enabled: enabled && read,
    queryFn: async ({ signal }) => (await api.get<TaskSource>(`${BASE}/${encodeURIComponent(activityId)}/source`, signal)).data,
  });
}

/** Splits loaded rows into the pages they were read in, so each page asks for its own tasks once. */
export function pageIds<T extends { id: string }>(pages: readonly { items: readonly T[] }[] | undefined): string[][] {
  return (pages ?? []).map((page) => page.items.map((item) => item.id));
}
