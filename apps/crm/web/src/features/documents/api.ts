import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { usePagedList } from '../../api/paging';
import type { OrganizationDocuments, StoredDocument } from './types';

const BASE = '/api/v1/customers/organizations';

export const documentKeys = {
  all: ['documents'] as const,
  forOrganization: (organizationId: string) => ['documents', organizationId] as const,
  stored: (organizationId: string, limit?: number) => ['documents', organizationId, 'stored', limit ?? null] as const,
};

/** The monthly reports the CRM filed for the customer (M43), newest month first, a page at a time. */
export function useStoredDocuments(organizationId: string, { enabled = true, limit }: { enabled?: boolean; limit?: number } = {}) {
  return usePagedList<StoredDocument>(documentKeys.stored(organizationId, limit), `${BASE}/${organizationId}/stored-documents`, {}, { enabled, limit });
}

/** The download of one stored report; the server checks the file against the fingerprint it was filed with. */
export const storedDocumentUrl = (organizationId: string, documentId: string) =>
  `${BASE}/${organizationId}/stored-documents/${documentId}/download`;

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
