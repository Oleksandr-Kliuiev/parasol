import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, query } from '../../api/client';
import type { NotificationList, NotificationPreferences } from './types';

const BASE = '/api/v1/notifications';

export const notificationKeys = {
  all: ['notifications'] as const,
  list: (filters: object) => ['notifications', 'list', filters] as const,
  preferences: ['notifications', 'preferences'] as const,
};

export function useNotifications(unreadOnly = false, limit = 50) {
  return useQuery({
    queryKey: notificationKeys.list({ unreadOnly, limit }),
    queryFn: async ({ signal }) => (await api.get<NotificationList>(`${BASE}${query({ unreadOnly, limit })}`, signal)).data,
    // The bell should not go stale while the user works; the worker adds notices in the background.
    refetchInterval: 120_000,
  });
}

/** The notices page by page, with how many there are in all (DEV-12). */
export function useNotificationPages(unreadOnly: boolean) {
  const result = useInfiniteQuery({
    queryKey: [...notificationKeys.list({ unreadOnly }), 'pages'],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => (await api.get<NotificationList>(`${BASE}${query({ unreadOnly, limit: 50, cursor: pageParam })}`, signal)).data,
    getNextPageParam: (last) => last.nextCursor,
  });
  return { ...result, latest: result.data?.pages.at(-1), items: result.data?.pages.flatMap((page) => page.items) ?? [] };
}

export function useNotificationActions() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: notificationKeys.all });
  return {
    markRead: useMutation({ mutationFn: (id: string) => api.post(`${BASE}/${id}/read`), onSuccess: refresh }),
    markAllRead: useMutation({ mutationFn: () => api.post<{ read: number }>(`${BASE}/read-all`), onSuccess: refresh }),
  };
}

export function useNotificationPreferences() {
  return useQuery({
    queryKey: notificationKeys.preferences,
    queryFn: async ({ signal }) => (await api.get<NotificationPreferences>(`${BASE}/preferences`, signal)).data,
  });
}

export function useSaveNotificationPreferences() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: Pick<NotificationPreferences, 'emailEnabled' | 'digestHour' | 'mutedKinds'>) =>
      api.put<NotificationPreferences>(`${BASE}/preferences`, request),
    onSuccess: (response) => {
      client.setQueryData(notificationKeys.preferences, response.data);
      return client.invalidateQueries({ queryKey: notificationKeys.all });
    },
  });
}
