import { useEffect, useId, useState } from 'react';
import { Button, Field, Input, MessageBar, MessageBarBody, Select, Spinner, Text } from '@fluentui/react-components';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, ApiError, query as queryString } from '../../api/client';
import { useCurrentUser } from '../../auth/CurrentUserContext';
import { DetailList } from '../../shared/components/Panel';
import { formatDateTime } from '../../shared/utils/format';
import { ObservationRows } from './ObservationRows';
import { parseObservationQueue, queueStates, type QueueSeverity, type QueueState } from './observationQueueContract';
import { severities } from './technicalContract';
import { useTechnicalStyles } from './technicalStyles';

export function ObservationQueue({ customerId, onSourceInvalidated }: { customerId: string; onSourceInvalidated: () => void }) {
  const user = useCurrentUser();
  return <EmployeeQueue key={`${user.id}:${customerId}`} customerId={customerId} employeeId={user.id} onSourceInvalidated={onSourceInvalidated} />;
}

function EmployeeQueue({ customerId, employeeId, onSourceInvalidated }: { customerId: string; employeeId: string; onSourceInvalidated: () => void }) {
  const { t } = useTranslation(); const styles = useTechnicalStyles(); const heading = useId();
  const [selection, setSelection] = useState<{ severity: QueueSeverity; status: QueueState; cursors: (string | null)[] }>({
    severity: 'ALL', status: 'ACTIVE', cursors: [null],
  });
  const [search, setSearch] = useState('');
  const { severity, status, cursors } = selection; const cursor = cursors.at(-1) ?? null;
  const query = useQuery({
    queryKey: ['parasol', 'observation-queue', employeeId, customerId, severity, status, cursor],
    queryFn: async ({ signal }) => parseObservationQueue((await api.get<unknown>(
      `/api/v1/parasol/customers/${encodeURIComponent(customerId)}/observations${queryString({ severity, status, cursor })}`, signal)).data,
    customerId, { severity, status, cursor }),
    retry: false, staleTime: 0, gcTime: 0, refetchOnWindowFocus: 'always',
  });
  // Every read replaces the prior page, including re-checks of access and filters. Nothing is shown from a failed read.
  const result = !query.isFetching && !query.isError ? query.data : undefined;
  const queue = result?.status === 'READY' ? result.queue : null;
  const devices = new Map(queue?.devices.map(d => [d.id, d.hostname]) ?? []);
  const term = search.trim().toLocaleLowerCase();
  const matches = queue?.items.filter(o => `${o.summary} ${o.id} ${o.deviceId ? devices.get(o.deviceId) ?? '' : ''}`.toLocaleLowerCase().includes(term)) ?? [];
  const failed = query.isError ? query.error instanceof ApiError && query.error.status === 403 ? 'ACCESS_DENIED' : 'REQUEST_FAILED' : null;
  const sourceInvalid = failed === 'ACCESS_DENIED' || (result && ['ACCESS_DENIED', 'IDENTITY_CHANGED', 'NOT_LINKED', 'SOURCE_NOT_FOUND'].includes(result.status));
  useEffect(() => { if (sourceInvalid) onSourceInvalidated(); }, [sourceInvalid, onSourceInvalidated]);
  const resetPage = () => {
    setSearch('');
    if (cursor === null) void query.refetch();
    else setSelection(s => ({ ...s, cursors: [null] }));
  };
  const setFilter = (change: Partial<Pick<typeof selection, 'severity' | 'status'>>) => {
    setSearch(''); setSelection(s => ({ ...s, ...change, cursors: [null] }));
  };
  return <section className={styles.section} aria-labelledby={heading}>
    <h3 className={styles.heading} id={heading}>{t('parasolQueue.title')}</h3>
    <Text block>{t('parasolQueue.note')}</Text>
    <div className={styles.tools}>
      <Field label={t('parasolQueue.severityFilter')}><Select value={severity} onChange={(_, d) => setFilter({ severity: d.value as QueueSeverity })}>
        <option value="ALL">{t('parasolDetails.allSeverities')}</option>
        <option value="URGENT">{t('parasolDetails.urgent')}</option>
        {[...severities].reverse().map(s => <option key={s} value={s}>{t(`parasolDetails.severity.${s}`)}</option>)}
      </Select></Field>
      <Field label={t('parasolQueue.statusFilter')}><Select value={status} onChange={(_, d) => setFilter({ status: d.value as QueueState })}>
        {queueStates.map(s => <option key={s} value={s}>{t(s === 'ACTIVE' ? 'parasolDetails.allStatuses' : `parasolDetails.status.${s}`)}</option>)}
      </Select></Field>
    </div>
    <div className={styles.footer}>
      <Button disabled={query.isFetching} disabledFocusable={query.isFetching} onClick={resetPage}>{t('parasolQueue.refresh')}</Button>
      <Button disabled={severity === 'ALL' && status === 'ACTIVE' && cursor === null && search === ''}
        onClick={() => setFilter({ severity: 'ALL', status: 'ACTIVE' })}>{t('parasolQueue.reset')}</Button>
    </div>
    {query.isFetching && <Spinner size="small" label={t('common.loading')} />}
    {(failed || (result && result.status !== 'READY')) && <MessageBar intent="warning" layout="multiline"><MessageBarBody>
      <Text role="status">{t(`parasolQueue.status.${failed ?? result!.status}`)}</Text>
      {result && ['INVALID_CURSOR', 'IDENTITY_CHANGED'].includes(result.status)
        && <Button onClick={resetPage}>{t('parasolQueue.first')}</Button>}
    </MessageBarBody></MessageBar>}
    {queue && <>
      <Text block weight="semibold">{t('parasolQueue.total', { total: queue.total })}</Text>
      <Text block>{t('parasolQueue.countNote')}</Text>
      <DetailList items={[...severities].reverse().map(s => ({ label: t(`parasolDetails.severity.${s}`), value: String(queue.severityCounts[s]) }))} />
      <Text block>{t('parasolQueue.retrievedAt', { time: formatDateTime(queue.retrievedAt) })}</Text>
      <Text block>{t('parasol.snapshot', { time: formatDateTime(queue.generatedAt) })}</Text>
      <details>
        <summary>{t('parasolQueue.sources')}</summary>
        <Text block>{t('parasol.coverage')}</Text>
        {queue.resources.length === 0 && <Text>{t('parasol.noSources')}</Text>}
        <ul className={styles.list}>{queue.resources.map((r, i) => <li key={`${r.source}-${r.resourceType}-${i}`} className={styles.row}>
          <Text weight="semibold">{t(`parasol.sources.${r.source}`)} · {t(`parasol.resources.${r.resourceType}`)}</Text>
          <Text block>{t(`parasol.resourceStatus.${r.status}`)}</Text>
          {r.asOf && <Text block>{t('parasol.asOf', { time: formatDateTime(r.asOf) })}</Text>}
          {r.lastSuccessAt && <Text block>{t('parasol.lastSuccess', { time: formatDateTime(r.lastSuccessAt) })}</Text>}
          {r.returnedItems !== null && <Text block>{t(r.truncated ? 'parasol.truncated' : 'parasol.returned', { count: r.returnedItems })}</Text>}
        </li>)}</ul>
      </details>
      {queue.items.length === 0 ? <Text block role="status">{t('parasolQueue.empty')}</Text> : <>
        <Field label={t('parasolQueue.search')}><Input type="search" maxLength={300} value={search} onChange={(_, d) => setSearch(d.value)} /></Field>
        <Text block>{t('parasolQueue.searchNote')}</Text>
        <Text block>{t('parasolDetails.observationMatches', { matched: matches.length, loaded: queue.items.length })}</Text>
        {matches.length === 0 && <Text block>{t('parasolDetails.noMatches')}</Text>}
        <ObservationRows items={matches} devices={queue.devices} customerId={customerId} onSourceInvalidated={onSourceInvalidated} />
      </>}
      <Text block role="status">{t('parasolQueue.page', { page: cursors.length, count: queue.items.length })}</Text>
      <div className={styles.footer}>
        <Button disabled={cursors.length === 1} onClick={resetPage}>{t('parasolQueue.first')}</Button>
        <Button disabled={cursors.length === 1} onClick={() => { setSearch(''); setSelection(s => ({ ...s, cursors: s.cursors.slice(0, -1) })); }}>{t('parasolQueue.previous')}</Button>
        <Button disabled={queue.nextCursor === null} onClick={() => { setSearch(''); setSelection(s => ({ ...s, cursors: [...s.cursors, queue.nextCursor] })); }}>{t('parasolQueue.next')}</Button>
      </div>
    </>}
  </section>;
}
