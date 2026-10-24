import { useQueries } from '@tanstack/react-query';
import { api } from '../../api/client';
import { Permissions, useCan, useCurrentUser } from '../../auth/CurrentUserContext';
import { activityKeys } from '../activities/api';
import { parseTaskLookup, type ObservationTaskLink } from './observationTaskContract';

/** The server answers for one page of ids at a time (AtlasObservationTaskService.LookupPage). */
const pageSize = 50;

/**
 * The tasks the shown observations already have, so a row says "task open · Ingrid" without opening the dialog (UX 2026,
 * В3). One request per 50 shown rows, never one per row; no Atlas read; under the activities key, so creating or completing
 * a task reads it again. Without both read permissions, or when a read fails, rows simply show no task line: the dialog
 * still reads the exact, current state before anything is offered.
 */
export function useObservationTaskLinks(customerId: string | undefined, observationIds: readonly string[]): Map<string, ObservationTaskLink> {
  const user = useCurrentUser();
  const canRead = useCan(Permissions.activitiesRead); const canAtlas = useCan(Permissions.parasolAtlasRead);
  const ids = [...new Set(observationIds)].sort();
  const pages = Array.from({ length: Math.ceil(ids.length / pageSize) }, (_, index) => ids.slice(index * pageSize, (index + 1) * pageSize));
  const results = useQueries({
    queries: pages.map((page) => ({
      queryKey: [...activityKeys.all, 'observation-tasks', user.id, customerId, page],
      enabled: Boolean(customerId) && canRead && canAtlas,
      retry: false,
      staleTime: 30_000,
      queryFn: async ({ signal }: { signal: AbortSignal }) => parseTaskLookup((await api.get<unknown>(
        `/api/v1/parasol/customers/${customerId}/observation-tasks?ids=${page.map(encodeURIComponent).join(',')}`, signal)).data, customerId!, page),
    })),
  });
  const links = new Map<string, ObservationTaskLink>();
  for (const result of results) for (const [id, link] of result.data ?? []) links.set(id, link);
  return links;
}
