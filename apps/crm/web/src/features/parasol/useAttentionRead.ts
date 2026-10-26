import { useCallback, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../../api/client';
import { parseAtlasAttention } from './atlasAttentionContract';

/**
 * One personal Atlas read (M14): the bounded directory, mapping and customer reads behind My day's attention panel and the
 * observation queue. It is read when the page opens and when the person asks (M17: no polling); while it runs, and after
 * it fails, nothing of an earlier read is shown.
 */
export function useAttentionRead(path: string, limit: number, key: readonly unknown[]) {
  const { t } = useTranslation();
  const [check, setCheck] = useState({ pending: false, revision: 0 });
  const refreshing = useRef(false);
  const query = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => parseAtlasAttention((await api.get<unknown>(path, signal)).data, limit),
    retry: false, staleTime: 0, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  const { refetch } = query;
  const refresh = useCallback(() => {
    if (refreshing.current) return;
    refreshing.current = true;
    setCheck(s => ({ pending: true, revision: s.revision + 1 }));
    void refetch().finally(() => { refreshing.current = false; setCheck(s => ({ ...s, pending: false })); });
  }, [refetch]);
  const checking = check.pending || query.isFetching;
  const view = !checking && !query.isError ? query.data : undefined;
  const data = view && ['READY', 'PARTIAL'].includes(view.status) ? view : null;
  const error = query.isError ? query.error instanceof ApiError && query.error.status === 403 ? 'ACCESS_DENIED'
    : query.error instanceof ApiError && query.error.status === 429 ? 'RATE_LIMITED' : 'REQUEST_FAILED'
    : view && !data ? view.status : null;
  const coverage = data?.coverage;
  // A read customer whose sources are incomplete or synthetic also makes the read PARTIAL (the contract's rule): count it, so
  // a partial read always names its reason.
  const incompleteSources = (data?.customers ?? []).filter(c => c.status === 'READY' && c.completeness !== 'COMPLETE').length;
  // The figures that ask for a look stay in sight when the coverage details are closed (as in the queue, M36).
  const gaps = coverage ? ([
    ['unmapped', coverage.unmappedClients], ['mappingIssues', coverage.mappingIssues],
    ['failed', coverage.failedCustomers], ['omitted', coverage.omittedCustomers], ['incompleteSources', incompleteSources],
  ] as const).filter(([, count]) => count > 0) : [];
  // Green only for a read without any gap: a partial read never looks like a healthy one.
  const complete = data?.status === 'READY' && gaps.length === 0 && !coverage?.timedOut && !coverage?.limitReached;
  const warnings = data ? [
    data.status === 'PARTIAL' && t('parasolAttention.partial'),
    gaps.length > 0 && t('parasolAttention.issues', { list: gaps.map(([key, count]) => `${t(`parasolAttention.${key}`)}: ${count}`).join(' · ') }),
    coverage?.timedOut && t('parasolAttention.timedOut'),
    coverage?.limitReached && t('parasolAttention.limit'),
  ].filter((line): line is string => Boolean(line)) : [];
  return { refresh, checking, revision: check.revision, data, error, complete, warnings, incompleteSources };
}

export type AttentionRead = ReturnType<typeof useAttentionRead>;
export type AttentionData = NonNullable<AttentionRead['data']>;
