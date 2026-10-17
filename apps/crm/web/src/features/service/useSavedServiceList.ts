import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, type QueryKey } from '@tanstack/react-query';
import { api, query } from '../../api/client';
import type { PagedResult } from '../../api/types';

export interface SavedServiceScope { owner: string; revision: number }
export const savedServicePolicy = {
  retry: false, gcTime: 0, staleTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false,
} as const;

/** Service mirror reads have a scoped first page; retries discard prior continuations. */
export function useSavedServiceList<T>(key: QueryKey, url: string,
  filters: Record<string, string | number | boolean | undefined>, scope: SavedServiceScope,
  limit: number, pending?: (item: T) => boolean) {
  const [revision, setRevision] = useState(0); const refreshing = useRef(false);
  const read = useInfiniteQuery({
    ...savedServicePolicy, queryKey: [...key, scope.owner, scope.revision, revision], initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const answer = await api.get<PagedResult<T>>(`${url}${query({ ...filters, limit, cursor: pageParam })}`, signal);
      signal.throwIfAborted(); return answer.data;
    },
    getNextPageParam: page => page.nextCursor,
    // A failed poll is visible and waits for explicit recovery. A newly read Pending request resumes polling.
    refetchInterval: pending ? ({ state }) => state.status !== 'error' && state.data?.pages.some(page => page.items.some(pending)) ? 5_000 : false : false,
  });
  useEffect(() => { if (!read.isFetching) refreshing.current = false; }, [read.isFetching, revision, scope.revision]);
  const refresh = () => {
    if (refreshing.current || read.isFetching && !read.isFetchingNextPage) return;
    refreshing.current = true; setRevision(value => value + 1);
  };
  const checking = read.isFetching && !read.isFetchingNextPage;
  const available = read.isSuccess && !checking;
  const items = available ? read.data.pages.flatMap(page => page.items) : [];
  return { ...read, checking, available, refresh, items, total: available ? read.data.pages.at(-1)?.totalCount ?? null : null,
    hasNextPage: available && read.hasNextPage };
}
