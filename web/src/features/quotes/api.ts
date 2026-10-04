import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, query } from '../../api/client';
import type { OrganizationContact, Quote, QuoteListItem, QuoteRequest, QuoteStatus, QuoteTemplate, SendQuoteRequest } from './types';

const BASE = '/api/v1/sales';

export const quoteKeys = {
  all: ['quotes'] as const,
  list: (filters: object) => ['quotes', 'list', filters] as const,
  one: (id: string) => ['quotes', 'one', id] as const,
  templates: ['quotes', 'templates'] as const,
};

export interface QuoteFilters {
  [key: string]: string | number | boolean | null | undefined;
  search?: string;
  organizationId?: string;
  opportunityId?: string;
  status?: QuoteStatus | null;
  mine?: boolean;
  awaitingApproval?: boolean;
}

export function useQuotes(filters: QuoteFilters, enabled = true) {
  return useQuery({
    queryKey: quoteKeys.list(filters),
    enabled,
    queryFn: async ({ signal }) => (await api.get<QuoteListItem[]>(`${BASE}/quotes${query(filters)}`, signal)).data,
  });
}

export function useQuote(id: string | undefined) {
  return useQuery({
    queryKey: quoteKeys.one(id ?? ''),
    enabled: Boolean(id),
    queryFn: async ({ signal }) => (await api.get<Quote>(`${BASE}/quotes/${id}`, signal)).data,
    // While the worker stores the document (DEV-08), the page asks again until it is ready.
    refetchInterval: (q) => (q.state.data?.documents.at(-1)?.status === 'Preparing' ? 3_000 : false),
  });
}

export function useQuoteTemplates(includeInactive = false) {
  return useQuery({
    queryKey: [...quoteKeys.templates, includeInactive],
    staleTime: 300_000,
    queryFn: async ({ signal }) => (await api.get<QuoteTemplate[]>(`${BASE}/quote-templates${query({ includeInactive })}`, signal)).data,
  });
}

export function useOrganizationContacts(organizationId: string | undefined) {
  return useQuery({
    queryKey: ['organizations', organizationId ?? '', 'contacts'],
    enabled: Boolean(organizationId),
    queryFn: async ({ signal }) =>
      (await api.get<OrganizationContact[]>(`/api/v1/customers/organizations/${organizationId}/contacts`, signal)).data,
  });
}

/** The stored document (DEV-08); a revision picks an earlier one of the same version. Opened in a new tab. */
export function quotePdfUrl(id: string, revision?: number): string {
  return `${BASE}/quotes/${id}/pdf${revision ? `?revision=${revision}` : ''}`;
}

export function useQuoteActions(id?: string) {
  const client = useQueryClient();
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: quoteKeys.all });
    await client.invalidateQueries({ queryKey: ['sales'] });
  };
  const act = (action: string) => ({
    mutationFn: () => api.post<Quote>(`${BASE}/quotes/${id}/${action}`),
    onSuccess: refresh,
  });

  return {
    create: useMutation({ mutationFn: (request: QuoteRequest) => api.post<Quote>(`${BASE}/quotes`, request), onSuccess: refresh }),
    update: useMutation({
      mutationFn: ({ request, etag }: { request: QuoteRequest; etag: string }) => api.put<Quote>(`${BASE}/quotes/${id}`, request, etag),
      onSuccess: refresh,
    }),
    submit: useMutation(act('submit')),
    withdraw: useMutation(act('withdraw')),
    approve: useMutation(act('approve')),
    reject: useMutation({
      mutationFn: (reason: string) => api.post<Quote>(`${BASE}/quotes/${id}/reject`, { reason }),
      onSuccess: refresh,
    }),
    send: useMutation({
      mutationFn: (request: SendQuoteRequest) => api.post<Quote>(`${BASE}/quotes/${id}/send`, request),
      onSuccess: refresh,
    }),
    accept: useMutation({
      mutationFn: () => api.post<Quote>(`${BASE}/quotes/${id}/accept`),
      onSuccess: async () => {
        await refresh();
        await client.invalidateQueries({ queryKey: ['contracts'] });
      },
    }),
    decline: useMutation({
      mutationFn: (reason: string | null) => api.post<Quote>(`${BASE}/quotes/${id}/decline`, { reason }),
      onSuccess: refresh,
    }),
    cancel: useMutation(act('cancel')),
    revise: useMutation(act('revise')),
  };
}

export function useSaveQuoteTemplate() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, etag, ...body }: { id?: string; etag?: string } & Omit<QuoteTemplate, 'id' | 'etag'>) =>
      id ? api.put<QuoteTemplate>(`${BASE}/quote-templates/${id}`, body, etag) : api.post<QuoteTemplate>(`${BASE}/quote-templates`, body),
    onSuccess: () => client.invalidateQueries({ queryKey: quoteKeys.templates }),
  });
}
