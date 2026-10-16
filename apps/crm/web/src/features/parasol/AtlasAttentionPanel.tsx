import { useCallback, useId, useRef, useState } from 'react';
import { Button, MessageBar, MessageBarBody, Spinner, Text } from '@fluentui/react-components';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../../api/client';
import { Permissions, useCan, useCurrentUser } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { DetailList, Panel } from '../../shared/components/Panel';
import { formatDateTime } from '../../shared/utils/format';
import { parseAtlasAttention, type AtlasAttentionCustomer } from './atlasAttentionContract';
import { ObservationRows } from './ObservationRows';
import { useTechnicalStyles } from './technicalStyles';

export function AtlasAttentionPanel() {
  const user = useCurrentUser(); const canCustomers = useCan(Permissions.customersRead); const canAtlas = useCan(Permissions.parasolAtlasRead);
  if (!canCustomers || !canAtlas) return null;
  const permissionsKey = JSON.stringify([...user.permissions].sort());
  return <PersonalAttention key={`${user.id}:${permissionsKey}`} employeeId={user.id} permissionsKey={permissionsKey} />;
}

function PersonalAttention({ employeeId, permissionsKey }: { employeeId: string; permissionsKey: string }) {
  const { t } = useTranslation(); const styles = useTechnicalStyles();
  const [check, setCheck] = useState({ pending: false, revision: 0 });
  const refreshing = useRef(false);
  const query = useQuery({
    queryKey: ['parasol', 'atlas-attention', employeeId, permissionsKey],
    queryFn: async ({ signal }) => parseAtlasAttention((await api.get<unknown>('/api/v1/parasol/my-day/atlas-attention', signal)).data),
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
  return <Panel title={t('parasolAttention.title')} actions={<Button size="small" disabled={checking} disabledFocusable={checking} onClick={refresh}>{t('parasolAttention.refresh')}</Button>}>
    <Text block>{t('parasolAttention.note')}</Text>
    {checking && <Spinner size="small" label={t('common.loading')} />}
    {error && <MessageBar intent="warning" layout="multiline"><MessageBarBody><Text role="status">{t(`parasolAttention.status.${error}`)}</Text></MessageBarBody></MessageBar>}
    {data && data.coverage && data.totals && data.customers && <div key={check.revision}>
      <Text block>{t('parasolAttention.checkedAt', { time: formatDateTime(data.checkedAt) })}</Text>
      <Text block weight="semibold">{t('parasolAttention.coverage', { ready: data.coverage.readyCustomers, selected: data.coverage.selectedCustomers })}</Text>
      <DetailList items={[
        { label: t('parasolAttention.visible'), value: String(data.coverage.visibleClients) },
        { label: t('parasolAttention.matched'), value: String(data.coverage.matchedCustomers) },
        { label: t('parasolAttention.attempted'), value: String(data.coverage.attemptedCustomers) },
        { label: t('parasolAttention.unmapped'), value: String(data.coverage.unmappedClients) },
        { label: t('parasolAttention.mappingIssues'), value: String(data.coverage.mappingIssues) },
        { label: t('parasolAttention.failed'), value: String(data.coverage.failedCustomers) },
        { label: t('parasolAttention.omitted'), value: String(data.coverage.omittedCustomers) },
      ]} />
      {data.status === 'PARTIAL' && <MessageBar intent="warning" layout="multiline"><MessageBarBody>{t('parasolAttention.partial')}</MessageBarBody></MessageBar>}
      {data.coverage.timedOut && <Text block>{t('parasolAttention.timedOut')}</Text>}
      {data.coverage.limitReached && <Text block>{t('parasolAttention.limit')}</Text>}
      <Text block>{t('parasolAttention.totals', { active: data.totals.activeObservations, high: data.totals.high, critical: data.totals.critical })}</Text>
      <Text block>{t('parasolAttention.previewNote')}</Text>
      {data.customers.length === 0 && <Text block role="status">{t('parasolAttention.empty')}</Text>}
      <div className={styles.list}>{data.customers.map(customer => <AttentionCustomer key={customer.customerId} customer={customer} onSourceInvalidated={refresh} />)}</div>
    </div>}
  </Panel>;
}

function AttentionCustomer({ customer: c, onSourceInvalidated }: { customer: AtlasAttentionCustomer; onSourceInvalidated: () => void }) {
  const { t } = useTranslation(); const styles = useTechnicalStyles(); const heading = useId();
  return <section className={styles.row} aria-labelledby={heading}>
    <h3 id={heading} className={styles.heading}><AppLink to={`/organizations/${c.customerId}`}>{c.customerName}</AppLink></h3>
    {c.status !== 'READY' ? <Text role="status">{t(`parasolAttention.customerStatus.${c.status}`)}</Text> : <>
      {c.mode === 'fixture' && <MessageBar intent="warning"><MessageBarBody>{t('parasol.fixture')}</MessageBarBody></MessageBar>}
      <Text block weight="semibold">{t('parasolAttention.customerCounts', { high: c.high, critical: c.critical })}</Text>
      <Text block>{t('parasolAttention.retrievedAt', { time: formatDateTime(c.retrievedAt!) })}</Text>
      <Text block>{t('parasol.snapshot', { time: formatDateTime(c.generatedAt!) })}</Text>
      {c.completeness !== 'COMPLETE' && <Text block>{t('parasolAttention.sourcePartial')}</Text>}
      <details>
        <summary>{t('parasolAttention.sources')}</summary>
        <Text block>{t('parasol.coverage')}</Text>
        {c.resources?.length === 0 && <Text block>{t('parasol.noSources')}</Text>}
        <div className={styles.list}>{c.resources?.map((r, i) => <div className={styles.row} key={`${r.source}-${r.resourceType}-${i}`}>
          <Text weight="semibold">{t(`parasol.sources.${r.source}`)} · {t(`parasol.resources.${r.resourceType}`)}</Text>
          <Text block>{t(`parasol.resourceStatus.${r.status}`)}</Text>
          {r.asOf && <Text block>{t('parasol.asOf', { time: formatDateTime(r.asOf) })}</Text>}
          {r.lastSuccessAt && <Text block>{t('parasol.lastSuccess', { time: formatDateTime(r.lastSuccessAt) })}</Text>}
          {r.returnedItems !== null && <Text block>{t(r.truncated ? 'parasol.truncated' : 'parasol.returned', { count: r.returnedItems })}</Text>}
        </div>)}</div>
      </details>
      <Text block>{t('parasolAttention.previewCount', { shown: c.preview.length, total: c.high! + c.critical! })}</Text>
      {c.preview.length === 0 ? <Text block>{t('parasolAttention.noUrgent')}</Text>
        : <ObservationRows items={c.preview} devices={c.devices} customerId={c.customerId} onSourceInvalidated={onSourceInvalidated} />}
      <AppLink to={`/organizations/${c.customerId}`}>{t('parasolAttention.openCustomer')}</AppLink>
    </>}
  </section>;
}
