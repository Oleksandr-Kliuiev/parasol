import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { OrganizationDocuments } from './types';

const BASE = '/api/v1/customers/organizations';

export const documentKeys = {
  all: ['documents'] as const,
  forOrganization: (organizationId: string) => ['documents', organizationId] as const,
};

export function useOrganizationDocuments(organizationId: string) {
  return useQuery({
    queryKey: documentKeys.forOrganization(organizationId),
    queryFn: async ({ signal }) => (await api.get<OrganizationDocuments>(`${BASE}/${organizationId}/documents`, signal)).data,
  });
}

export function useCreateDocumentFolder(organizationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<OrganizationDocuments>(`${BASE}/${organizationId}/documents/folder`),
    onSuccess: () => client.invalidateQueries({ queryKey: documentKeys.forOrganization(organizationId) }),
  });
}
