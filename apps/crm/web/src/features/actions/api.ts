import { useCallback, useMemo } from 'react';
import { useInfiniteQuery, useQueries, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { api, query } from '../../api/client';
import {
  isWaiting, type ActionKind, type ActionPage, type ActionPreview, type ActionRequest, type ActionTargetFacts, type VendorAction,
} from './types';

const BASE = '/api/v1/actions';

export const actionKeys = {
  all: ['actions'] as const,
  one: (id: string) => ['actions', 'one', id] as const,
  // The page size is part of the key: the filter counts read one row, and that page must never stand in for the list's.
  log: (filters: ActionLogFilters, limit?: number) => ['actions', 'log', filters, limit ?? null] as const,
  kinds: (system: string) => ['actions', 'kinds', system] as const,
  facts: (system: string, targetType: string, ids: readonly string[]) => ['actions', 'facts', system, targetType, ids] as const,
};

/** The targets one lookup carries: a page of a list (the server's limit). */
export const factsLimit = 50;

export interface ActionLogFilters {
  system?: string;
  targetType?: string;
  targetId?: string;
  organizationId?: string;
  state?: 'attention' | 'waiting';
}

/** The preview, made by the server from saved data only: no vendor is asked. */
export async function previewAction(request: ActionRequest): Promise<ActionPreview> {
  return (await api.post<ActionPreview>(`${BASE}/preview`, request)).data;
}

/**
 * The command: the preview's token, and a key of this click so a repeat after a lost answer returns the same action instead of a
 * second one. A destructive action goes to the endpoint that demands a fresh sign-in.
 */
export async function requestAction(
  preview: ActionPreview, request: ActionRequest, commandKey: string, confirmation: { reason?: string; typedName?: string },
): Promise<VendorAction> {
  const url = preview.level === 'Destructive' ? `${BASE}/destructive` : BASE;
  return (await api.post<VendorAction>(url, {
    ...request, previewToken: preview.previewToken, commandKey, reason: confirmation.reason || null, typedName: confirmation.typedName || null,
  })).data;
}

export async function cancelAction(action: VendorAction): Promise<VendorAction> {
  return (await api.post<VendorAction>(`${BASE}/${action.id}/cancel`, undefined, action.etag)).data;
}

export async function settleAction(action: VendorAction, outcome: 'Succeeded' | 'Failed', reason: string): Promise<VendorAction> {
  return (await api.post<VendorAction>(`${BASE}/${action.id}/settle`, { outcome, reason }, action.etag)).data;
}

/**
 * Whether the person may ask for this kind now, so a form offers it only where a preview would let it through. Read only once the form
 * is about to offer it; false while unknown or unreadable.
 */
export function useActionAvailable(system: string, kind: string, enabled = true): boolean {
  const { data } = useQuery({
    queryKey: actionKeys.kinds(system),
    enabled,
    queryFn: async ({ signal }) => (await api.get<ActionKind[]>(`${BASE}/kinds${query({ system })}`, signal)).data,
    staleTime: 60_000,
    retry: false,
  });
  return enabled && Array.isArray(data) && data.some((item) => item.kind === kind);
}

/** One action, read again every two seconds while the worker still has it (UX: a page that waits for the worker polls). */
export function useAction(id: string | null, initial?: VendorAction) {
  return useQuery({
    queryKey: actionKeys.one(id ?? ''),
    enabled: id !== null,
    initialData: initial,
    queryFn: async ({ signal }) => (await api.get<VendorAction>(`${BASE}/${id}`, signal)).data,
    refetchInterval: ({ state }) => (state.data && isWaiting(state.data.status) ? 2_000 : false),
    staleTime: 0,
  });
}

/** The log, newest first, a page at a time; it polls while an action on the loaded pages still waits for the worker. */
export function useActionLog(filters: ActionLogFilters, options: { enabled?: boolean; limit?: number } = {}) {
  const result = useInfiniteQuery<ActionPage, Error, InfiniteData<ActionPage, string | null>, ReturnType<typeof actionKeys.log>, string | null>({
    queryKey: actionKeys.log(filters, options.limit),
    enabled: options.enabled ?? true,
    initialPageParam: null,
    queryFn: async ({ pageParam, signal }) =>
      (await api.get<ActionPage>(`${BASE}${query({ ...filters, limit: options.limit, cursor: pageParam })}`, signal)).data,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: ({ state }) => (state.data?.pages.some((page) => page.items.some((item) => isWaiting(item.status))) ? 5_000 : false),
  });
  const items = useMemo(() => result.data?.pages.flatMap((page) => page.items) ?? [], [result.data]);
  const last = result.data?.pages.at(-1);
  return { ...result, items, total: last?.totalCount ?? null, uncertain: last?.uncertain ?? 0, waiting: last?.waiting ?? 0 };
}

/**
 * The action facts beside a list's rows (M39): one lookup per page of targets (never one per row), merged into one map by target id.
 * A page whose lookup failed leaves its rows without facts; nothing is claimed about them.
 */
export function useActionFacts(system: string, targetType: string, pages: readonly (readonly string[])[], enabled = true) {
  return useQueries({
    queries: pages.filter((ids) => ids.length > 0).flatMap((ids) => chunks(ids, factsLimit)).map((ids) => ({
      queryKey: actionKeys.facts(system, targetType, ids),
      enabled,
      retry: false,
      staleTime: 30_000,
      queryFn: async () => (await api.post<{ items: ActionTargetFacts[] }>(`${BASE}/lookup`, { system, targetType, targetIds: ids })).data,
    })),
    combine: (results) => {
      const facts = new Map<string, ActionTargetFacts>();
      for (const result of results) for (const item of result.data?.items ?? []) facts.set(item.targetId, item);
      return { facts, loading: results.some((r) => r.isPending && r.fetchStatus !== 'idle'), failed: results.some((r) => r.isError) };
    },
  });
}

const chunks = (ids: readonly string[], size: number) =>
  Array.from({ length: Math.ceil(ids.length / size) }, (_, index) => ids.slice(index * size, (index + 1) * size));

/** After an action changed: every log, the facts beside list rows and the action itself are read again. */
export function useRefreshActions() {
  const client = useQueryClient();
  return useCallback((action?: VendorAction) => {
    if (action) client.setQueryData(actionKeys.one(action.id), action);
    void client.invalidateQueries({ queryKey: ['actions', 'log'] });
    void client.invalidateQueries({ queryKey: ['actions', 'facts'] });
  }, [client]);
}
