import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button, MessageBar, MessageBarBody, Spinner, Text } from '@fluentui/react-components';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../../api/client';
import { useCan, useCurrentUser, Permissions } from '../../auth/CurrentUserContext';
import { localeOf } from '../../i18n';
import { DetailList } from '../../shared/components/Panel';
import { parseM365, type M365Connection } from './m365Contract';
import { useTechnicalStyles } from './technicalStyles';

export function AtlasM365Panel({ customerId, onSourceInvalidated, onAccessDenied, contextChecking = false }: {
  customerId: string; onSourceInvalidated: () => void; onAccessDenied?: () => void; contextChecking?: boolean;
}) {
  const user = useCurrentUser(); const { t } = useTranslation();
  const canAtlas = useCan(Permissions.parasolAtlasRead); const canCustomers = useCan(Permissions.customersRead);
  const permissionsKey = JSON.stringify([...user.permissions].sort());
  const allowed = canAtlas && canCustomers;
  if (!allowed) return <Text>{t('parasolM365.noPermission')}</Text>;
  return <PersonalM365 key={`${user.id}:${customerId}:${permissionsKey}`}
    employeeId={user.id} permissionsKey={permissionsKey} customerId={customerId} onSourceInvalidated={onSourceInvalidated}
    onAccessDenied={onAccessDenied} contextChecking={contextChecking} />;
}

function PersonalM365({ customerId, employeeId, permissionsKey, onSourceInvalidated, onAccessDenied, contextChecking }: {
  customerId: string; employeeId: string; permissionsKey: string; onSourceInvalidated: () => void;
  onAccessDenied?: () => void; contextChecking: boolean;
}) {
  const { t, i18n } = useTranslation(); const styles = useTechnicalStyles(); const heading = useId();
  const [pending, setPending] = useState(false); const refreshing = useRef(false); const invalidated = useRef(-1);
  const denied = useRef<string | null>(null);
  const query = useQuery({
    queryKey: ['parasol', 'm365', employeeId, permissionsKey, customerId],
    queryFn: async ({ signal }) => parseM365((await api.get<unknown>(`/api/v1/parasol/customers/${encodeURIComponent(customerId)}/m365`, signal)).data, customerId),
    retry: false, staleTime: 0, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  const { refetch } = query;
  const refresh = useCallback(() => {
    if (refreshing.current) return;
    refreshing.current = true; setPending(true);
    void refetch().finally(() => { refreshing.current = false; setPending(false); });
  }, [refetch]);
  const checking = pending || query.isFetching;
  const result = !checking && !query.isError ? query.data : undefined;
  const failed = query.error instanceof ApiError && query.error.status === 403 ? 'ACCESS_DENIED' : query.isError ? 'UNAVAILABLE' : undefined;
  useEffect(() => {
    if (result && ['NOT_LINKED', 'IDENTITY_CHANGED'].includes(result.status) && invalidated.current !== query.dataUpdatedAt) {
      invalidated.current = query.dataUpdatedAt; onSourceInvalidated();
    }
  }, [result, query.dataUpdatedAt, onSourceInvalidated]);
  const denialVersion = !checking && failed === 'ACCESS_DENIED' ? `error:${query.errorUpdatedAt}`
    : result?.status === 'ACCESS_DENIED' ? `data:${query.dataUpdatedAt}` : null;
  useEffect(() => {
    if (denialVersion && denied.current !== denialVersion) {
      denied.current = denialVersion; onAccessDenied?.();
    }
  }, [denialVersion, onAccessDenied]);
  const summary = !contextChecking && result?.status === 'READY' ? result.summary : null;
  const date = (value: string) => new Intl.DateTimeFormat(localeOf(i18n.language), {
    timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(value));
  const status = failed ?? (result?.status !== 'READY' ? result?.status : undefined);
  return <section className={styles.section} aria-labelledby={heading}>
    <h3 id={heading} className={styles.heading}>{t('parasolM365.title')}</h3>
    <Text block>{t('parasolM365.savedNote')}</Text>
    <div className={styles.footer}><Button disabled={checking || contextChecking} disabledFocusable={checking || contextChecking} onClick={refresh}>{t('parasolM365.refresh')}</Button></div>
    {checking && <Spinner size="small" label={t('common.loading')} />}
    {status && <MessageBar intent="warning" layout="multiline"><MessageBarBody><Text role="status">
      {t(status === 'ACCESS_DENIED' ? 'parasolM365.accessDenied' : status === 'NOT_SUPPORTED' ? 'parasolM365.notSupported' : `parasol.status.${status}`)}
    </Text></MessageBarBody></MessageBar>}
    {summary && <>
      <Text block>{t('parasolM365.assessed', { time: date(summary.assessedAt) })}</Text>
      <Text block>{t('parasolM365.window', { from: date(summary.windowFrom), to: date(summary.windowTo) })}</Text>
      <Text block>{t('parasolM365.countNote')}</Text>
      {summary.truncated && <MessageBar intent="warning" layout="multiline"><MessageBarBody>
        {t('parasolM365.partial', { shown: summary.connections.length, total: summary.totalConnections })}
      </MessageBarBody></MessageBar>}
      {summary.connections.length === 0 ? <Text block role="status">{t('parasolM365.noConnections')}</Text>
        : <div className={styles.list}>{summary.connections.map((connection, i) =>
          <Connection key={connection.connectionId} connection={connection} index={i + 1} date={date} />)}</div>}
      <Text block>{t('parasolM365.coverageNote')}</Text>
    </>}
  </section>;
}

function Connection({ connection, index, date }: { connection: M365Connection; index: number; date: (value: string) => string }) {
  const { t } = useTranslation(); const styles = useTechnicalStyles(); const si = connection.signIns;
  return <section className={styles.row} aria-label={t('parasolM365.connection', { index })}>
    <Text weight="semibold">{t('parasolM365.connection', { index })}</Text>
    {connection.directory.map(resource => <div key={resource.resourceType}>
      <Text block weight="semibold">{t(`parasolM365.${resource.resourceType}`)}</Text>
      <DetailList items={[
        { label: t('parasolM365.records'), value: resource.count === null ? t('parasolM365.unavailable') : String(resource.count) },
        { label: t('parasolM365.state'), value: t(`parasol.resourceStatus.${resource.status}`) },
      ]} />
      {resource.asOf && <Text block>{t('parasolM365.asOf', { time: date(resource.asOf) })}</Text>}
      {resource.lastSuccessAt && <Text block>{t('parasolM365.lastSuccess', { time: date(resource.lastSuccessAt) })}</Text>}
    </div>)}
    <Text block weight="semibold">{t('parasolM365.signIns')}</Text>
    <DetailList items={[
      { label: t('parasolM365.state'), value: t(`parasol.resourceStatus.${si.status}`) },
      { label: t('parasolM365.coverage'), value: t(`parasolM365.coverageState.${si.coverage}`) },
      { label: t('parasolM365.freshness'), value: t(`parasolM365.freshnessState.${si.freshness}`) },
    ]} />
    {si.asOf && <Text block>{t('parasolM365.oldest', { time: date(si.asOf) })}</Text>}
    {si.lastSuccessAt && <Text block>{t('parasolM365.newest', { time: date(si.lastSuccessAt) })}</Text>}
    {si.gaps.length > 0 && <details><summary>{t('parasolM365.gaps', { count: si.gaps.length })}</summary>
      <ul>{si.gaps.map((gap, i) => <li key={i}>{date(gap.fromInclusive)} – {date(gap.toExclusive)} UTC</li>)}</ul>
    </details>}
    <details><summary>{t('parasolM365.reference')}</summary><Text>{connection.connectionId}</Text></details>
  </section>;
}
