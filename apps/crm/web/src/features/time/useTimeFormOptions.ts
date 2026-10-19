import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { fetchAllPages } from '../../api/paging';
import type { ProjectListItem } from '../projects/types';
import { savedServicePolicy } from '../service/useSavedServiceList';

/** Form options belong to this employee/form/customer; cancelled answers cannot populate a replacement form. */
export function useTimeFormOptions(scope: string, organizationId: string | undefined) {
  const workTypes = useQuery({
    ...savedServicePolicy, queryKey: ['time-form', scope, 'work-types'],
    queryFn: async ({ signal }) => {
      const answer = await api.get<string[]>('/api/v1/time/work-types', signal);
      signal.throwIfAborted(); return answer.data;
    },
  });
  const projects = useQuery({
    ...savedServicePolicy, queryKey: ['time-form', scope, 'projects', organizationId], enabled: Boolean(organizationId),
    queryFn: async ({ signal }) => {
      const answer = await fetchAllPages<ProjectListItem>('/api/v1/projects', { organizationId, openOnly: true }, signal);
      signal.throwIfAborted(); return answer;
    },
  });
  return { workTypes, projects };
}
