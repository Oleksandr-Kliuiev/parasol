import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { fetchAllPages, usePagedList } from '../../api/paging';
import type { PhaseRequest, Project, ProjectListItem, ProjectPhaseStatus, ProjectRequest, ProjectStatus, TaskRequest } from './types';

const BASE = '/api/v1/projects';

export interface ProjectFilters {
  [key: string]: string | number | boolean | null | undefined;
  search?: string;
  organizationId?: string;
  status?: ProjectStatus | null;
  managerId?: string;
  openOnly?: boolean;
}

export const projectKeys = {
  all: ['projects'] as const,
  list: (filters: ProjectFilters) => ['projects', 'list', filters] as const,
  detail: (id: string) => ['projects', 'detail', id] as const,
};

/**
 * Projects page by page, with how many the filter matches (DEV-12). `keepPrevious`: the list searched as people type keeps the
 * rows of the previous search or filter until the new answer is there, so a row someone is clicking does not vanish; a customer's
 * own tab starts empty and never shows another customer's rows.
 */
export function useProjects(filters: ProjectFilters, enabled = true, options: { keepPrevious?: boolean } = {}) {
  return usePagedList<ProjectListItem>(projectKeys.list(filters), BASE, filters, { enabled, keepPrevious: options.keepPrevious });
}

/** Every project of a filter, for a picker that must offer all of them (an organization's open projects). */
export function useAllProjects(filters: ProjectFilters, enabled = true) {
  return useQuery({
    queryKey: [...projectKeys.list(filters), 'all'],
    enabled,
    queryFn: ({ signal }) => fetchAllPages<ProjectListItem>(BASE, filters, signal),
  });
}

export function useProject(id: string | undefined) {
  return useQuery({
    queryKey: projectKeys.detail(id ?? ''),
    enabled: Boolean(id),
    queryFn: async ({ signal }) => (await api.get<Project>(`${BASE}/${id}`, signal)).data,
  });
}

/** Every phase and task action returns the whole project, so one invalidation keeps the screen honest. */
export function useProjectActions(id?: string) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: projectKeys.all });
  return {
    save: useMutation({
      mutationFn: ({ request, etag }: { request: ProjectRequest; etag?: string }) =>
        id ? api.put<Project>(`${BASE}/${id}`, request, etag) : api.post<Project>(BASE, request),
      onSuccess: refresh,
    }),
    setStatus: useMutation({
      mutationFn: (status: ProjectStatus) => api.post<Project>(`${BASE}/${id}/status`, { status }),
      onSuccess: refresh,
    }),
    remove: useMutation({ mutationFn: () => api.delete(`${BASE}/${id}`), onSuccess: refresh }),
    addPhase: useMutation({
      mutationFn: (request: PhaseRequest) => api.post<Project>(`${BASE}/${id}/phases`, request),
      onSuccess: refresh,
    }),
    updatePhase: useMutation({
      mutationFn: ({ phaseId, request }: { phaseId: string; request: PhaseRequest }) =>
        api.put<Project>(`${BASE}/${id}/phases/${phaseId}`, request),
      onSuccess: refresh,
    }),
    setPhaseStatus: useMutation({
      mutationFn: ({ phaseId, status }: { phaseId: string; status: ProjectPhaseStatus }) =>
        api.post<Project>(`${BASE}/${id}/phases/${phaseId}/status`, { status }),
      onSuccess: refresh,
    }),
    removePhase: useMutation({
      mutationFn: (phaseId: string) => api.delete(`${BASE}/${id}/phases/${phaseId}`),
      onSuccess: refresh,
    }),
    addTask: useMutation({
      mutationFn: ({ phaseId, request }: { phaseId: string; request: TaskRequest }) =>
        api.post<Project>(`${BASE}/${id}/phases/${phaseId}/tasks`, request),
      onSuccess: refresh,
    }),
    updateTask: useMutation({
      mutationFn: ({ taskId, request }: { taskId: string; request: TaskRequest }) =>
        api.put<Project>(`${BASE}/${id}/tasks/${taskId}`, request),
      onSuccess: refresh,
    }),
    removeTask: useMutation({
      mutationFn: (taskId: string) => api.delete(`${BASE}/${id}/tasks/${taskId}`),
      onSuccess: refresh,
    }),
    addMember: useMutation({
      mutationFn: (userId: string) => api.post<Project>(`${BASE}/${id}/members`, { userId }),
      onSuccess: refresh,
    }),
    removeMember: useMutation({
      mutationFn: (userId: string) => api.delete<Project>(`${BASE}/${id}/members/${userId}`),
      onSuccess: refresh,
    }),
  };
}
