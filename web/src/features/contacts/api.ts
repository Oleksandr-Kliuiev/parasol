import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, query } from '../../api/client';
import type {
  AffiliationRequest,
  Contact,
  ContactPersonRequest,
  CreatedContact,
  CreateOrganizationContactRequest,
  OrganizationContactItem,
} from '../../api/types';

const contactKeys = {
  forOrganization: (organizationId: string, includeInactive: boolean) => ['contacts', 'organization', organizationId, includeInactive] as const,
  detail: (id: string) => ['contacts', 'detail', id] as const,
};

export function useOrganizationContacts(organizationId: string, includeInactive: boolean) {
  return useQuery({
    queryKey: contactKeys.forOrganization(organizationId, includeInactive),
    queryFn: async ({ signal }) =>
      (
        await api.get<OrganizationContactItem[]>(
          `/api/v1/customers/organizations/${organizationId}/contacts${query({ includeInactive: includeInactive || undefined })}`,
          signal,
        )
      ).data,
  });
}

export function useContact(id: string) {
  return useQuery({
    queryKey: contactKeys.detail(id),
    queryFn: async ({ signal }) => api.get<Contact>(`/api/v1/customers/contacts/${id}`, signal),
  });
}

export function useCreateContact(organizationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (request: CreateOrganizationContactRequest) =>
      (await api.post<CreatedContact>(`/api/v1/customers/organizations/${organizationId}/contacts`, request)).data,
    onSuccess: () => client.invalidateQueries({ queryKey: ['contacts'] }),
  });
}

export function useUpdateAffiliation(organizationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ contactId, request }: { contactId: string; request: AffiliationRequest }) =>
      api.put(`/api/v1/customers/organizations/${organizationId}/contacts/${contactId}`, request),
    onSuccess: () => client.invalidateQueries({ queryKey: ['contacts'] }),
  });
}

export function useUpdateContactPerson(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ request, etag }: { request: ContactPersonRequest; etag: string | null }) =>
      api.put<Contact>(`/api/v1/customers/contacts/${id}`, request, etag),
    onSuccess: (response) => {
      client.setQueryData(contactKeys.detail(id), response);
      return client.invalidateQueries({ queryKey: ['contacts', 'organization'] });
    },
  });
}
