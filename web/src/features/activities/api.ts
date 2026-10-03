import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, query } from '../../api/client';
import type {
  Activity,
  ActivityRequest,
  ActivityType,
  CalendarSyncResult,
  MailMessage,
  OutlookStatus,
  SaveMailRequest,
} from './types';

const BASE = '/api/v1/activities';

export interface ActivityFilters {
  [key: string]: string | number | boolean | null | undefined;
  organizationId?: string;
  opportunityId?: string;
  contractId?: string;
  type?: ActivityType | null;
  mine?: boolean;
  open?: boolean;
}

export const activityKeys = {
  all: ['activities'] as const,
  list: (filters: ActivityFilters) => ['activities', 'list', filters] as const,
  outlook: ['activities', 'outlook'] as const,
  mail: (organizationId: string) => ['activities', 'mail', organizationId] as const,
};

/** What Outlook can do for this session; the dialogs and tabs explain themselves from it (FR-ACT-02, FR-ACT-03). */
export function useOutlookStatus() {
  return useQuery({
    queryKey: activityKeys.outlook,
    staleTime: 300_000,
    queryFn: async ({ signal }) => (await api.get<OutlookStatus>(`${BASE}/outlook/status`, signal)).data,
  });
}

export function useCustomerMail(organizationId: string, enabled: boolean) {
  return useQuery({
    queryKey: activityKeys.mail(organizationId),
    enabled,
    // Mail is read live from Exchange and never stored, so it is not cached for long either.
    staleTime: 30_000,
    queryFn: async ({ signal }) => (await api.get<MailMessage[]>(`${BASE}/mail${query({ organizationId })}`, signal)).data,
  });
}

export function useActivities(filters: ActivityFilters, enabled = true) {
  return useQuery({
    queryKey: activityKeys.list(filters),
    enabled,
    queryFn: async ({ signal }) => (await api.get<Activity[]>(`${BASE}/${query(filters)}`, signal)).data,
  });
}

export function useActivityActions() {
  const client = useQueryClient();
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: activityKeys.all });
    // A logged activity moves the deal's "last activity", so the stale marker changes too.
    await client.invalidateQueries({ queryKey: ['sales'] });
  };
  return {
    create: useMutation({ mutationFn: (request: ActivityRequest) => api.post<Activity>(`${BASE}/`, request), onSuccess: refresh }),
    update: useMutation({
      mutationFn: ({ id, request, etag }: { id: string; request: ActivityRequest; etag: string }) => api.put<Activity>(`${BASE}/${id}`, request, etag),
      onSuccess: refresh,
    }),
    complete: useMutation({ mutationFn: (id: string) => api.post<Activity>(`${BASE}/${id}/complete`), onSuccess: refresh }),
    reopen: useMutation({ mutationFn: (id: string) => api.post<Activity>(`${BASE}/${id}/reopen`), onSuccess: refresh }),
    remove: useMutation({ mutationFn: (id: string) => api.delete(`${BASE}/${id}`), onSuccess: refresh }),
    addToCalendar: useMutation({ mutationFn: (id: string) => api.post<Activity>(`${BASE}/${id}/calendar`), onSuccess: refresh }),
    removeFromCalendar: useMutation({ mutationFn: (id: string) => api.delete(`${BASE}/${id}/calendar`), onSuccess: refresh }),
    syncCalendar: useMutation({ mutationFn: () => api.post<CalendarSyncResult>(`${BASE}/calendar/sync`), onSuccess: refresh }),
    saveMail: useMutation({
      mutationFn: (request: SaveMailRequest) => api.post<Activity>(`${BASE}/mail/save`, request),
      onSuccess: refresh,
    }),
  };
}
