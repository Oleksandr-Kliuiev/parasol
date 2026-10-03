import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, query } from '../../api/client';
import type { CustomFieldDefinition, CustomFieldEntity, CustomFieldRequest, CustomFieldValue } from './types';

const BASE = '/api/v1/custom-fields';

export const customFieldKeys = {
  all: ['custom-fields'] as const,
  definitions: (entity: CustomFieldEntity | undefined, includeInactive: boolean) =>
    ['custom-fields', 'definitions', entity ?? null, includeInactive] as const,
  values: (entity: CustomFieldEntity, entityId: string) => ['custom-fields', 'values', entity, entityId] as const,
};

export function useCustomFieldDefinitions(entity?: CustomFieldEntity, includeInactive = false) {
  return useQuery({
    queryKey: customFieldKeys.definitions(entity, includeInactive),
    queryFn: async ({ signal }) =>
      (await api.get<CustomFieldDefinition[]>(`${BASE}/definitions${query({ entity, includeInactive })}`, signal)).data,
  });
}

export function useCustomFieldActions() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: customFieldKeys.all });
  return {
    save: useMutation({
      mutationFn: ({ id, request }: { id?: string; request: CustomFieldRequest }) =>
        id ? api.put<CustomFieldDefinition>(`${BASE}/definitions/${id}`, request) : api.post<CustomFieldDefinition>(`${BASE}/definitions`, request),
      onSuccess: refresh,
    }),
    setActive: useMutation({
      mutationFn: ({ id, active }: { id: string; active: boolean }) => api.post(`${BASE}/definitions/${id}/active`, { active }),
      onSuccess: refresh,
    }),
    remove: useMutation({ mutationFn: (id: string) => api.delete(`${BASE}/definitions/${id}`), onSuccess: refresh }),
  };
}

/** The fields and answers of one record; an empty list means nobody defined fields for this record type. */
export function useCustomFieldValues(entity: CustomFieldEntity, entityId: string, enabled = true) {
  return useQuery({
    queryKey: customFieldKeys.values(entity, entityId),
    enabled: enabled && Boolean(entityId),
    queryFn: async ({ signal }) => (await api.get<CustomFieldValue[]>(`${BASE}/${entity}/${entityId}`, signal)).data,
  });
}

export function useSaveCustomFieldValues(entity: CustomFieldEntity, entityId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (values: Record<string, string | null>) => api.put<CustomFieldValue[]>(`${BASE}/${entity}/${entityId}`, { values }),
    onSuccess: (response) => client.setQueryData(customFieldKeys.values(entity, entityId), response.data),
  });
}
