import { useMemo } from 'react';
import { useInfiniteQuery, type InfiniteData, type QueryKey } from '@tanstack/react-query';
import { api, query } from './client';
import type { PagedResult } from './types';

type Filters = Record<string, string | number | boolean | null | undefined>;

/**
 * A list read page by page (DEV-12): the rows loaded so far, how many the filter matches according to the newest answer, and
 * the means to load the next page. Nothing is truncated without saying so.
 */
export function usePagedList<T>(
  key: QueryKey,
  url: string,
  filters: Filters,
  options: { enabled?: boolean; limit?: number; refetchInterval?: number; refetchWhile?: (item: T) => boolean } = {},
) {
  const { refetchWhile } = options;
  const result = useInfiniteQuery<PagedResult<T>, Error, InfiniteData<PagedResult<T>, string | null>, QueryKey, string | null>({
    queryKey: key,
    enabled: options.enabled ?? true,
    // A page that waits for the worker polls every loaded page while any row is still in that state.
    refetchInterval: refetchWhile
      ? ({ state }) => (state.data?.pages.some((page) => page.items.some(refetchWhile)) ? 5_000 : false)
      : options.refetchInterval,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) =>
      (await api.get<PagedResult<T>>(`${url}${query({ ...filters, limit: options.limit, cursor: pageParam })}`, signal)).data,
    getNextPageParam: (last) => last.nextCursor,
  });
  const items = useMemo(() => result.data?.pages.flatMap((page) => page.items) ?? [], [result.data]);
  return { ...result, items, total: result.data?.pages.at(-1)?.totalCount ?? null };
}

/**
 * Every page of a small list, for a picker that has to offer all choices (an organization's open projects). Stops at
 * `maxPages`, which no real list reaches; a picker that would need more should search instead.
 */
export async function fetchAllPages<T>(url: string, filters: Filters, signal?: AbortSignal, maxPages = 20): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const answer: PagedResult<T> = (await api.get<PagedResult<T>>(`${url}${query({ ...filters, limit: 200, cursor })}`, signal)).data;
    items.push(...answer.items);
    if (!answer.nextCursor) break;
    cursor = answer.nextCursor;
  }
  return items;
}
