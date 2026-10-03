import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, query } from '../../api/client';
import { postCsv } from '../licensing/api';
import type {
  CustomerCategory,
  PriceItemRequest,
  PriceList,
  PriceListItem,
  PriceListRequest,
  PriceListSummary,
  Product,
  ProductPage,
  ProductRequest,
  ProductType,
} from './types';
import type { PriceSheetImportResult } from './types';

const BASE = '/api/v1/catalog';

export const catalogKeys = {
  all: ['catalog'] as const,
  products: (filters: ProductFilters) => ['catalog', 'products', filters] as const,
  product: (id: string) => ['catalog', 'product', id] as const,
  categories: ['catalog', 'categories'] as const,
  priceLists: ['catalog', 'price-lists'] as const,
  priceList: (id: string) => ['catalog', 'price-list', id] as const,
};

export interface ProductFilters {
  search?: string;
  type?: ProductType | null;
  active?: boolean | null;
  limit?: number;
}

export function useProducts(filters: ProductFilters) {
  return useInfiniteQuery({
    queryKey: catalogKeys.products(filters),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) =>
      (await api.get<ProductPage>(`${BASE}/products${query({ search: filters.search, type: filters.type, active: filters.active, limit: filters.limit, cursor: pageParam })}`, signal)).data,
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function useProduct(id: string | undefined) {
  return useQuery({
    queryKey: catalogKeys.product(id ?? ''),
    enabled: Boolean(id),
    queryFn: async ({ signal }) => api.get<Product>(`${BASE}/products/${id}`, signal),
  });
}

export function useSaveProduct(id?: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ request, etag }: { request: ProductRequest; etag?: string | null }) =>
      id ? api.put<Product>(`${BASE}/products/${id}`, request, etag) : api.post<Product>(`${BASE}/products`, request),
    onSuccess: async (response) => {
      client.setQueryData(catalogKeys.product(response.data.id), response);
      await client.invalidateQueries({ queryKey: catalogKeys.all, refetchType: 'none' });
    },
  });
}

export function useProductActions(id: string) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: catalogKeys.all });
  return {
    setActive: useMutation({
      mutationFn: (active: boolean) => api.post(`${BASE}/products/${id}/${active ? 'activate' : 'deactivate'}`),
      onSuccess: refresh,
    }),
    remove: useMutation({ mutationFn: () => api.delete(`${BASE}/products/${id}`), onSuccess: refresh }),
  };
}

export function useCategories() {
  return useQuery({
    queryKey: catalogKeys.categories,
    queryFn: async ({ signal }) => (await api.get<CustomerCategory[]>(`${BASE}/categories`, signal)).data,
    staleTime: 60_000,
  });
}

export function useSaveCategory() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, etag, ...body }: { id?: string; etag?: string; code: string; name: string; licenseMarkupPct: number; isDefault: boolean }) =>
      id ? api.put<CustomerCategory>(`${BASE}/categories/${id}`, body, etag) : api.post<CustomerCategory>(`${BASE}/categories`, body),
    onSuccess: () => client.invalidateQueries({ queryKey: catalogKeys.categories }),
  });
}

export function usePriceLists() {
  return useQuery({
    queryKey: catalogKeys.priceLists,
    queryFn: async ({ signal }) => (await api.get<PriceListSummary[]>(`${BASE}/price-lists`, signal)).data,
  });
}

export function usePriceList(id: string) {
  return useQuery({
    queryKey: catalogKeys.priceList(id),
    queryFn: async ({ signal }) => api.get<PriceList>(`${BASE}/price-lists/${id}`, signal),
  });
}

export function usePriceListActions(id?: string) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: catalogKeys.all });
  return {
    save: useMutation({
      mutationFn: ({ request, etag }: { request: PriceListRequest; etag?: string | null }) =>
        id ? api.put<PriceList>(`${BASE}/price-lists/${id}`, request, etag) : api.post<PriceList>(`${BASE}/price-lists`, request),
      onSuccess: refresh,
    }),
    setActive: useMutation({
      mutationFn: (active: boolean) => api.post(`${BASE}/price-lists/${id}/${active ? 'activate' : 'deactivate'}`),
      onSuccess: refresh,
    }),
    copy: useMutation({
      mutationFn: (body: { name: string; validFrom: string; validTo: string | null; adjustPct: number | null }) =>
        api.post<PriceList>(`${BASE}/price-lists/${id}/copy`, body),
      onSuccess: refresh,
    }),
    remove: useMutation({ mutationFn: () => api.delete(`${BASE}/price-lists/${id}`), onSuccess: refresh }),
    setItem: useMutation({
      mutationFn: ({ productId, request }: { productId: string; request: PriceItemRequest }) =>
        api.put<PriceListItem>(`${BASE}/price-lists/${id}/items/${productId}`, request),
      onSuccess: refresh,
    }),
    removeItem: useMutation({ mutationFn: (productId: string) => api.delete(`${BASE}/price-lists/${id}/items/${productId}`), onSuccess: refresh }),
    importPriceSheet: useMutation({
      mutationFn: ({ csv, exchangeRate, markupPct, dryRun }: { csv: string; exchangeRate: number; markupPct: number | null; dryRun: boolean }) =>
        postCsv<PriceSheetImportResult>(
          `${BASE}/price-lists/${id}/price-sheet${query({ exchangeRate, markupPct, dryRun })}`,
          csv,
        ),
      onSuccess: (_, variables) => (variables.dryRun ? undefined : refresh()),
    }),
  };
}
