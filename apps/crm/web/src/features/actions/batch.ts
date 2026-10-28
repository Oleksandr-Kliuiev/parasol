import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { ActionBatchPreview, ActionBatchRequest, ActionBatchResult, ActionBatchState } from './types';

const BASE = '/api/v1/actions';

/** The preview of a batch (M45), made by the server from saved data only: no vendor is asked. */
export async function previewBatch(request: ActionBatchRequest): Promise<ActionBatchPreview> {
  return (await api.post<ActionBatchPreview>(`${BASE}/batch/preview`, request)).data;
}

/** The targets of a preview that will each get an action: exactly those the command sends back with the token. */
export const readyTargets = (preview: ActionBatchPreview) => preview.targets.filter((target) => target.block === null).map((target) => target.targetId);

/**
 * The confirmation of a batch: the preview's token, its ready targets and a key of this confirmation, so a repeat after a lost answer
 * returns the actions already saved instead of asking again.
 */
export async function requestBatch(
  preview: ActionBatchPreview, request: ActionBatchRequest, batchKey: string, reason?: string,
): Promise<ActionBatchResult> {
  return (await api.post<ActionBatchResult>(`${BASE}/batch`, {
    ...request, targetIds: readyTargets(preview), previewToken: preview.previewToken, batchKey, reason: reason || null,
  })).data;
}

/**
 * A batch followed while the worker sends it: its counts every three seconds while any action waits, then once more with every action
 * of it, so a dialog says what happened to each target without reading all of them on every poll.
 */
export function useActionBatch(batchId: string | null) {
  const counts = useQuery({
    queryKey: ['actions', 'batch', batchId, 'counts'],
    enabled: batchId !== null,
    queryFn: async ({ signal }) => (await api.get<ActionBatchState>(`${BASE}/batches/${batchId}`, signal)).data,
    refetchInterval: ({ state }) => (state.data && state.data.waiting === 0 ? false : 3_000),
    staleTime: 0,
  });
  const finished = counts.data !== undefined && counts.data.waiting === 0;
  const items = useQuery({
    queryKey: ['actions', 'batch', batchId, 'items'],
    enabled: batchId !== null && finished,
    queryFn: async ({ signal }) => (await api.get<ActionBatchState>(`${BASE}/batches/${batchId}?items=true`, signal)).data,
    staleTime: 0,
  });
  return { state: items.data ?? counts.data ?? null, finished, error: counts.error ?? items.error ?? null };
}
