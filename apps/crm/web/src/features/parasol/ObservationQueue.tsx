import { useEffect, useId, useRef, useState } from 'react';
import { Button, Field, Input, MessageBar, MessageBarBody, Select, Spinner, Text, mergeClasses } from '@fluentui/react-components';
import { useQuery } from '@tanstack/react-query';
import { Search16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { api, ApiError, query as queryString } from '../../api/client';
import { useCurrentUser } from '../../auth/CurrentUserContext';
import { ObservationRows } from './ObservationRows';
import { ObservationQueueHelp, ObservationQueueInfo } from './ObservationQueueInfo';
import { parseObservationQueue, queueStates, type QueueSeverity, type QueueState } from './observationQueueContract';
import { severities } from './technicalContract';
import { useTechnicalStyles } from './technicalStyles';

type DeviceScope = { deviceId?: string | null; onClearDevice?: () => void; onReturnToDevice?: () => void };

export function ObservationQueue({ customerId, onSourceInvalidated, deviceId = null, onClearDevice, onReturnToDevice }: {
  customerId: string; onSourceInvalidated: () => void;
} & DeviceScope) {
  const user = useCurrentUser();
  return <EmployeeQueue key={`${user.id}:${customerId}`} customerId={customerId} employeeId={user.id} onSourceInvalidated={onSourceInvalidated}
    deviceId={deviceId} onClearDevice={onClearDevice} onReturnToDevice={onReturnToDevice} />;
}

function EmployeeQueue({ customerId, employeeId, onSourceInvalidated, deviceId = null, onClearDevice, onReturnToDevice }: {
  customerId: string; employeeId: string; onSourceInvalidated: () => void;
} & DeviceScope) {
  const { t } = useTranslation(); const styles = useTechnicalStyles(); const heading = useId();
  const title = useRef<HTMLHeadingElement>(null); const clearRequested = useRef(false);
  const [selection, setSelection] = useState<{ deviceId: string | null; severity: QueueSeverity; status: QueueState; cursors: (string | null)[] }>({
    deviceId, severity: 'ALL', status: 'ACTIVE', cursors: [null],
  });
  const [search, setSearch] = useState('');
  // Derive the first page immediately; effects must never send another device's continuation.
  const { severity, status, cursors } = selection.deviceId === deviceId ? selection : { ...selection, cursors: [null] };
  const cursor = cursors.at(-1) ?? null;
  if (selection.deviceId !== deviceId) {
    setSelection({ ...selection, deviceId, cursors: [null] });
    setSearch('');
  }
  useEffect(() => {
    if (deviceId === null && clearRequested.current) {
      clearRequested.current = false; title.current?.focus({ preventScroll: true }); title.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [deviceId]);
  const query = useQuery({
    queryKey: ['parasol', 'observation-queue', employeeId, customerId, severity, status, deviceId, cursor],
    queryFn: async ({ signal }) => parseObservationQueue((await api.get<unknown>(
      `/api/v1/parasol/customers/${encodeURIComponent(customerId)}/observations${queryString({ severity, status, cursor, deviceId })}`, signal)).data,
    customerId, { severity, status, cursor, deviceId }),
    retry: false, staleTime: 0, gcTime: 0, refetchOnWindowFocus: 'always',
  });
  // Every read replaces the prior page, including re-checks of access and filters. Nothing is shown from a failed read.
  const result = !query.isFetching && !query.isError ? query.data : undefined;
  const queue = result?.status === 'READY' ? result.queue : null;
  const devices = new Map(queue?.devices.map(d => [d.id, d.hostname]) ?? []);
  const term = search.trim().toLocaleLowerCase();
  const matches = queue?.items.filter(o => `${o.summary} ${o.id} ${o.deviceId ? devices.get(o.deviceId) ?? '' : ''}`.toLocaleLowerCase().includes(term)) ?? [];
  const failed = query.isError ? query.error instanceof ApiError && query.error.status === 403 ? 'ACCESS_DENIED' : 'REQUEST_FAILED' : null;
  const sourceInvalid = failed === 'ACCESS_DENIED' || (result && ['ACCESS_DENIED', 'IDENTITY_CHANGED', 'NOT_LINKED', 'SOURCE_NOT_FOUND', 'DEVICE_NOT_AVAILABLE'].includes(result.status));
  useEffect(() => { if (sourceInvalid) onSourceInvalidated(); }, [sourceInvalid, onSourceInvalidated]);
  const resetPage = () => {
    setSearch('');
    if (cursor === null) void query.refetch();
    else setSelection(s => ({ ...s, deviceId, cursors: [null] }));
  };
  const setFilter = (change: Partial<Pick<typeof selection, 'severity' | 'status'>>) => {
    setSearch(''); setSelection(s => ({ ...s, ...change, deviceId, cursors: [null] }));
  };
  const clearDevice = () => { clearRequested.current = true; onClearDevice?.(); };
  const selectedDevice = queue?.devices.find(d => d.id === deviceId);
  return <section className={mergeClasses(styles.section, styles.queueSection)} aria-labelledby={heading}>
    <h3 ref={title} tabIndex={-1} className={mergeClasses(styles.heading, styles.display)} id={heading}>{t('parasolQueue.title')}</h3>
    <Text block className={styles.note}>{t('parasolQueue.savedNote')}</Text>
    {deviceId !== null && <div className={styles.row}>
      <Text block weight="semibold" role="status">{selectedDevice
        ? <code className={styles.identifier}>{t('parasolQueue.selectedDevice', { name: selectedDevice.hostname })}</code>
        : t('parasolQueue.selectingDevice')}</Text>
      <div className={mergeClasses(styles.footer, styles.queueFooter)}>
        {onClearDevice && <Button tabIndex={0} className={styles.deviceAction} onClick={clearDevice}>{t('parasolQueue.allDevices')}</Button>}
        {onReturnToDevice && <Button tabIndex={0} className={styles.deviceAction} onClick={onReturnToDevice}>{t('parasolQueue.backToDevice')}</Button>}
      </div>
    </div>}
    <div className={styles.toolbar}>
      <Field label={{ children: t('parasolQueue.severityFilter'), className: styles.hiddenLabel }}><Select value={severity} onChange={(_, d) => setFilter({ severity: d.value as QueueSeverity })}>
        <option value="ALL">{t('parasolDetails.allSeverities')}</option>
        <option value="URGENT">{t('parasolDetails.urgent')}</option>
        {[...severities].reverse().map(s => <option key={s} value={s}>{t(`parasolDetails.severity.${s}`)}</option>)}
      </Select></Field>
      <Field label={{ children: t('parasolQueue.statusFilter'), className: styles.hiddenLabel }}><Select value={status} onChange={(_, d) => setFilter({ status: d.value as QueueState })}>
        {queueStates.map(s => <option key={s} value={s}>{t(s === 'ACTIVE' ? 'parasolDetails.allStatuses' : `parasolDetails.status.${s}`)}</option>)}
      </Select></Field>
      <Button disabled={query.isFetching} disabledFocusable={query.isFetching} onClick={resetPage}>{t('parasolQueue.refresh')}</Button>
      <Button disabled={deviceId === null && severity === 'ALL' && status === 'ACTIVE' && cursor === null && search === ''}
        onClick={() => { setFilter({ severity: 'ALL', status: 'ACTIVE' }); if (deviceId !== null) clearDevice(); }}>{t('parasolQueue.reset')}</Button>
    </div>
    {query.isFetching && <Spinner size="small" label={t('common.loading')} />}
    {(failed || (result && result.status !== 'READY')) && <MessageBar intent="warning" layout="multiline"><MessageBarBody>
      <Text role="status">{t(`parasolQueue.status.${failed ?? result!.status}`)}</Text>
      {result && ['INVALID_CURSOR', 'IDENTITY_CHANGED'].includes(result.status)
        && <Button onClick={resetPage}>{t('parasolQueue.first')}</Button>}
    </MessageBarBody></MessageBar>}
    {queue && <>
      <ObservationQueueInfo queue={queue} />
      {queue.items.length === 0 ? <Text block role="status" className={styles.status}>{t('parasolQueue.empty')}</Text> : <>
        <Field className={styles.search} label={{ children: t('parasolQueue.search'), className: styles.hiddenLabel }}><Input type="search" maxLength={300} value={search}
          contentBefore={<Search16Regular />} placeholder={t('parasolQueue.search')} onChange={(_, d) => setSearch(d.value)} /></Field>
        <Text block className={styles.status}>{t('parasolQueue.pageMatches', { matched: matches.length, loaded: queue.items.length })}</Text>
        {matches.length === 0 && <Text block className={styles.status}>{t('parasolDetails.noMatches')}</Text>}
        <ObservationRows key={term} items={matches} devices={queue.devices} customerId={customerId}
          onSourceInvalidated={onSourceInvalidated} scrollLabel={t('parasolQueue.title')} scrollHint={t('parasolQueue.scrollList')} />
      </>}
      <Text block role="status" className={styles.status}>{t('parasolQueue.page', { page: cursors.length, count: queue.items.length })}</Text>
      <div className={mergeClasses(styles.footer, styles.queueFooter)}>
        <Button disabled={cursors.length === 1} onClick={resetPage}>{t('parasolQueue.first')}</Button>
        <Button disabled={cursors.length === 1} onClick={() => { setSearch(''); setSelection(s => ({ ...s, deviceId, cursors: cursors.slice(0, -1) })); }}>{t('parasolQueue.previous')}</Button>
        <Button disabled={queue.nextCursor === null} onClick={() => { setSearch(''); setSelection(s => ({ ...s, deviceId, cursors: [...cursors, queue.nextCursor] })); }}>{t('parasolQueue.next')}</Button>
      </div>
      <ObservationQueueHelp deviceSelected={deviceId !== null} />
    </>}
  </section>;
}
