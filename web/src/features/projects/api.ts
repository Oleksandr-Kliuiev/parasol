import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, query } from '../../api/client';
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

export function useProjects(filters: ProjectFilters, enabled = true) {
  return useQuery({
    queryKey: projectKeys.list(filters),
    enabled,
    queryFn: async ({ signal }) => (await api.get<ProjectListItem[]>(`${BASE}${query(filters)}`, signal)).data,
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
  };
}
