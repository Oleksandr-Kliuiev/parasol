import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, ApiError, query } from '../../api/client';
import type { InvoiceDocuments, InvoiceHistory, LedgerPage } from './customerFinanceTypes';

const BASE = '/api/v1/billing';
export const customerFinanceKey = (organizationId: string) => ['billing', 'customer-finance', organizationId] as const;
export const invoiceDocumentUrl = (organizationId: string, invoiceId: string, documentId: string) =>
  `${BASE}/invoices/${encodeURIComponent(invoiceId)}/documents/${encodeURIComponent(documentId)}/download${query({ organizationId })}`;

export function useInvoiceHistory(organizationId: string, invoiceId: string) {
  return useQuery({
    queryKey: [...customerFinanceKey(organizationId), invoiceId, 'history'], gcTime: 0,
    queryFn: async ({ signal }) => {
      const result = (await api.get<InvoiceHistory>(`${BASE}/invoices/${encodeURIComponent(invoiceId)}/history${query({ organizationId })}`, signal)).data;
      if (result.invoice.id !== invoiceId || result.invoice.organization?.id !== organizationId) throw new ApiError(409, { code: 'BIL_CUSTOMER_CONTEXT_CHANGED' });
      return result;
    },
  });
}
export function useInvoiceDocuments(organizationId: string, invoiceId: string) {
  return useQuery({
    queryKey: [...customerFinanceKey(organizationId), invoiceId, 'documents'], gcTime: 0,
    queryFn: async ({ signal }) => {
      const result = (await api.get<InvoiceDocuments>(`${BASE}/invoices/${encodeURIComponent(invoiceId)}/documents${query({ organizationId })}`, signal)).data;
      if (result.invoiceId !== invoiceId) throw new ApiError(409, { code: 'BIL_CUSTOMER_CONTEXT_CHANGED' });
      return result;
    },
  });
}
export function useCustomerLedger(organizationId: string, invoiceId: string | undefined, paymentsOnly: boolean) {
  return useInfiniteQuery({
    queryKey: [...customerFinanceKey(organizationId), 'ledger', invoiceId ?? null, paymentsOnly], gcTime: 0,
    initialPageParam: 0,
    queryFn: async ({ signal, pageParam }) => {
      const page = (await api.get<LedgerPage>(`${BASE}/customer-ledger${query({ organizationId, invoiceId, kind: paymentsOnly ? 'Payment' : undefined, offset: pageParam, limit: 25 })}`, signal)).data;
      if (page.entries.some(e => e.organizationId !== organizationId) || page.offset !== pageParam)
        throw new ApiError(409, { code: 'BIL_CUSTOMER_CONTEXT_CHANGED' });
      return page;
    },
    getNextPageParam: last => last.offset + last.entries.length < last.total && last.entries.length > 0
      ? last.offset + last.entries.length : undefined,
  });
}
