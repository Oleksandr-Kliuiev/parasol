import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { usePagedList } from '../../api/paging';
import type { ActionRequest } from '../actions/types';
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

/** The customer's folder as the signed-in person sees it in SharePoint, read live (M47). */
export function useOrganizationDocuments(organizationId: string) {
  return useQuery({
    queryKey: documentKeys.forOrganization(organizationId),
    queryFn: async ({ signal }) => (await api.get<OrganizationDocuments>(`${BASE}/${organizationId}/documents`, signal)).data,
  });
}

/**
 * Takes a stale folder link off (the folder is gone from SharePoint): nothing is deleted there, and the customer can get a new folder
 * or be linked to another one. The mapping screen's own unlink, so it needs the same right (integrations.manage).
 */
export function useRemoveFolderLink(organizationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (linkId: string) => api.delete(`/api/v1/integrations/links/${linkId}`),
    onSuccess: () => client.invalidateQueries({ queryKey: documentKeys.forOrganization(organizationId) }),
  });
}

/** The company forms a person leaves out when naming a customer's folder ("Kviknes Hotel" for "Kviknes Hotel AS"), as the server does. */
const companyForms = new Set(['as', 'asa', 'enk', 'da', 'ans', 'sa', 'ba', 'nuf', 'ks', 'iks']);

/** The customer's name as a person would have named its folder: without a trailing company form. */
export function plainName(name: string): string {
  const words = name.trim().split(/\s+/);
  return words.length > 1 && companyForms.has(words[words.length - 1]!.toLowerCase()) ? words.slice(0, -1).join(' ') : name.trim();
}

/**
 * The SharePoint folders on the mapping screen, where a customer is linked to a folder that already exists, searched for the customer's
 * name the way a person would have named the folder, so the old folder is in front of them.
 */
export function folderMappingsPath(organizationName?: string): string {
  const search = organizationName ? plainName(organizationName) : '';
  return `/admin/mappings?system=graph&type=Folder${search ? `&search=${encodeURIComponent(search)}` : ''}`;
}

/** The vendor action that creates the customer's folder in SharePoint's root folder and links it (M47, the M43 path). */
export const createFolderRequest = (organizationId: string): ActionRequest => ({
  system: 'graph', kind: 'folder.create', targetType: 'organization', targetId: organizationId, parameters: {},
});
