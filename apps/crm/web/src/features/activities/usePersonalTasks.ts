import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, query as queryString } from '../../api/client';
import type { PagedResult } from '../../api/types';
import type { Activity } from './types';

type Page = PagedResult<Activity>;
interface Read { page: Page; generation: number }
interface Continuation { basis: Read | null; pages: Page[]; loading: boolean; error: unknown }
const empty = (): Continuation => ({ basis: null, pages: [], loading: false, error: null });
const route = (cursor: string | null = null) => `/api/v1/activities/${queryString({ mine: true, open: true, limit: 10, cursor })}`;

/** One scoped first-page query; subsequent pages are read only on explicit request. */
export function usePersonalTasks(employeeId: string, permissionsKey: string) {
  const sequence = useRef(0);
  const first = useQuery({
    queryKey: ['activities', 'personal', employeeId, permissionsKey],
    queryFn: async ({ signal }) => ({ page: (await api.get<Page>(route(), signal)).data, generation: ++sequence.current }),
    retry: false, staleTime: 0, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  const [continuation, setContinuation] = useState<Continuation>(empty);
  const [refreshing, setRefreshing] = useState(false);
  const [revision, setRevision] = useState(0);
  const active = useRef(false); const pageRequest = useRef<AbortController | null>(null); const refreshingRef = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; pageRequest.current?.abort(); }; }, []);
  const clearPages = useCallback(() => { pageRequest.current?.abort(); pageRequest.current = null; setContinuation(empty()); }, []);
  useEffect(() => {
    if (first.isFetching) { pageRequest.current?.abort(); pageRequest.current = null; }
  }, [first.isFetching]);
  const { refetch } = first;
  const refresh = useCallback(() => {
    if (refreshingRef.current) return;
    refreshingRef.current = true; clearPages(); setRefreshing(true); setRevision(value => value + 1);
    void refetch().finally(() => { refreshingRef.current = false; if (active.current) setRefreshing(false); });
  }, [refetch, clearPages]);
  const extra = continuation.basis === first.data ? continuation : null;
  const checking = refreshing || first.isFetching;
  const error = !checking ? first.error ?? extra?.error : null;
  const pages = first.data ? [first.data.page, ...(extra?.pages ?? [])] : [];
  const latest = pages.at(-1);
  const nextCursor = latest?.nextCursor ?? null;
  // Due dates can move a task between reads; keep one row with its newest received value.
  const unique = new Map<string, Activity>();
  if (!checking && !error) for (const page of pages) for (const activity of page.items) unique.set(activity.id, activity);
  const items = [...unique.values()];

  const loadMore = async () => {
    const basis = first.data;
    if (!basis || !nextCursor || checking || error || pageRequest.current) return;
    const request = new AbortController(); pageRequest.current = request;
    setContinuation(state => ({ basis, pages: state.basis === basis ? state.pages : [], loading: true, error: null }));
    try {
      const page = (await api.get<Page>(route(nextCursor), request.signal)).data;
      if (!active.current || request.signal.aborted || pageRequest.current !== request) return;
      setContinuation(state => ({ basis, pages: [...(state.basis === basis ? state.pages : []), page], loading: false, error: null }));
    } catch (failure) {
      if (!active.current || request.signal.aborted || pageRequest.current !== request) return;
      setContinuation(state => ({ ...state, basis, loading: false, error: failure }));
    } finally { if (pageRequest.current === request) pageRequest.current = null; }
  };
  return { items, error, checking, revision, refresh, loadMore, loadingMore: extra?.loading ?? false,
    total: !checking && !error ? latest?.totalCount ?? null : null, hasMore: !checking && !error && nextCursor !== null };
}
