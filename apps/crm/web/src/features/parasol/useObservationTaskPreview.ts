import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { useCurrentUser } from '../../auth/CurrentUserContext';
import { parseTaskPreview, type TaskPreviewScope } from './observationTaskContract';

export function taskRoute(customerId: string, observationId: string) {
  return `/api/v1/parasol/customers/${encodeURIComponent(customerId)}/observations/${encodeURIComponent(observationId)}`;
}

export function taskReadErrorStatus(error: unknown): 'ACCESS_DENIED' | 'IDENTITY_CHANGED' | 'REQUEST_FAILED' {
  if (error instanceof ApiError) {
    if (error.status === 403) return 'ACCESS_DENIED';
    if (error.code === 'PARASOL_CUSTOMER_NOT_FOUND' || error.code === 'PARASOL_IDENTITY_INCONSISTENT') return 'IDENTITY_CHANGED';
  }
  return 'REQUEST_FAILED';
}

export function useObservationTaskPreview(scope: TaskPreviewScope) {
  const user = useCurrentUser();
  const permissionsKey = JSON.stringify([...user.permissions].sort());
  const route = scope.activityId
    ? `/api/v1/parasol/activities/${encodeURIComponent(scope.activityId)}/atlas-observation`
    : `${taskRoute(scope.customerId!, scope.observationId!)}/task-preview`;
  return useQuery({
    queryKey: ['parasol', 'observation-task-preview', user.id, permissionsKey, route],
    queryFn: async ({ signal }) => parseTaskPreview((await api.get<unknown>(route, signal)).data, scope),
    retry: false, staleTime: 0, gcTime: 0, refetchOnWindowFocus: 'always',
  });
}
