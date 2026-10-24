import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Badge, Button, MessageBar, MessageBarBody, Spinner, Text, makeStyles, mergeClasses } from '@fluentui/react-components';
import { Cloud20Regular } from '@fluentui/react-icons';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../../api/client';
import { useCan, useCurrentUser, Permissions } from '../../auth/CurrentUserContext';
import { localeOf } from '../../i18n';
import { h } from '../../app/hearth';
import { FactGrid } from '../../shared/components/Panel';
import { parseM365, type M365Connection } from './m365Contract';
import { resourceTone, useTechnicalStyles } from './technicalStyles';

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
    <h3 id={heading} className={mergeClasses(styles.heading, styles.display)}>{t('parasolM365.title')}</h3>
    <Text block className={styles.note}>{t('parasolM365.savedNote')}</Text>
    <div className={styles.footer}><Button disabled={checking || contextChecking} disabledFocusable={checking || contextChecking} onClick={refresh}>{t('parasolM365.refresh')}</Button></div>
    {checking && <Spinner size="small" label={t('common.loading')} />}
    {status && <MessageBar intent="warning" layout="multiline"><MessageBarBody><Text role="status">
      {t(status === 'ACCESS_DENIED' ? 'parasolM365.accessDenied' : status === 'NOT_SUPPORTED' ? 'parasolM365.notSupported' : `parasol.status.${status}`)}
    </Text></MessageBarBody></MessageBar>}
    {summary && <>
      <Text block className={styles.status}>{t('parasolM365.assessed', { time: date(summary.assessedAt) })}</Text>
      <Text block className={styles.status}>{t('parasolM365.window', { from: date(summary.windowFrom), to: date(summary.windowTo) })}</Text>
      <Text block className={styles.note}>{t('parasolM365.countNote')}</Text>
      {summary.truncated && <MessageBar intent="warning" layout="multiline"><MessageBarBody>
        {t('parasolM365.partial', { shown: summary.connections.length, total: summary.totalConnections })}
      </MessageBarBody></MessageBar>}
      {summary.connections.length === 0 ? <Text block role="status" className={styles.status}>{t('parasolM365.noConnections')}</Text>
        : <div className={styles.list}>{summary.connections.map((connection, i) =>
          <Connection key={connection.connectionId} connection={connection} index={i + 1} date={date} />)}</div>}
      <Text block className={styles.note}>{t('parasolM365.coverageNote')}</Text>
    </>}
  </section>;
}

const useStyles = makeStyles({
  // One Microsoft 365 connection as a card: its directory counts and sign-in coverage as tiles, times as muted lines.
  connection: {
    display: 'grid',
    gap: '12px',
    minWidth: 0,
    paddingTop: '14px',
    paddingBottom: '14px',
    paddingLeft: '16px',
    paddingRight: '16px',
    borderRadius: '16px',
    border: `1px solid ${h.line}`,
    backgroundColor: h.surface,
    overflowWrap: 'anywhere',
  },
  head: { display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 },
  chip: { display: 'grid', placeItems: 'center', flexShrink: 0, width: '32px', height: '32px', borderRadius: '10px',
    backgroundColor: h.irisSoft, color: h.irisT },
  title: { fontFamily: h.display, fontSize: '15px', lineHeight: '20px', fontWeight: 600 },
  resources: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))', gap: '12px', minWidth: 0 },
  resource: { display: 'grid', alignContent: 'start', gap: '6px', minWidth: 0 },
  label: { fontWeight: 600, fontSize: '13px', lineHeight: '18px' },
  // The name over its state badge in every column, so neighbouring columns line up whatever the length of the name.
  labelRow: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '6px', minWidth: 0 },
  // Coverage and freshness are words, not numbers: body size, not the display size of a count.
  words: { '& dd': { fontFamily: 'inherit', fontSize: '14px', lineHeight: '20px' } },
  facts: { gridTemplateColumns: 'repeat(auto-fit, minmax(min(120px, 100%), 1fr))', gap: '8px' },
  meta: { color: h.muted, fontSize: '12.5px', lineHeight: '18px' },
  gaps: { marginTop: '4px', marginBottom: 0, paddingLeft: '20px', color: h.muted, fontSize: '13px', fontVariantNumeric: 'tabular-nums' },
});

function Connection({ connection, index, date }: { connection: M365Connection; index: number; date: (value: string) => string }) {
  const { t } = useTranslation(); const technical = useTechnicalStyles(); const styles = useStyles(); const si = connection.signIns;
  const state = (status: keyof typeof resourceTone) => <Badge appearance="tint" color={resourceTone[status]}>{t(`parasol.resourceStatus.${status}`)}</Badge>;
  return <section className={styles.connection} aria-label={t('parasolM365.connection', { index })}>
    <div className={styles.head}>
      <span className={styles.chip} aria-hidden><Cloud20Regular /></span>
      <Text className={styles.title}>{t('parasolM365.connection', { index })}</Text>
    </div>
    <div className={styles.resources}>
      {connection.directory.map(resource => <div key={resource.resourceType} className={styles.resource}>
        <div className={styles.labelRow}><Text className={styles.label}>{t(`parasolM365.${resource.resourceType}`)}</Text>{state(resource.status)}</div>
        <FactGrid className={styles.facts} items={[
          { label: t('parasolM365.records'), value: resource.count === null ? t('parasolM365.unavailable') : String(resource.count) },
        ]} />
        {resource.asOf && <Text block className={styles.meta}>{t('parasolM365.asOf', { time: date(resource.asOf) })}</Text>}
        {resource.lastSuccessAt && <Text block className={styles.meta}>{t('parasolM365.lastSuccess', { time: date(resource.lastSuccessAt) })}</Text>}
      </div>)}
    </div>
    <div className={styles.resource}>
      <div className={styles.labelRow}><Text className={styles.label}>{t('parasolM365.signIns')}</Text>{state(si.status)}</div>
      <FactGrid className={mergeClasses(styles.facts, styles.words)} items={[
        { label: t('parasolM365.coverage'), value: t(`parasolM365.coverageState.${si.coverage}`) },
        { label: t('parasolM365.freshness'), value: t(`parasolM365.freshnessState.${si.freshness}`) },
      ]} />
      {si.asOf && <Text block className={styles.meta}>{t('parasolM365.oldest', { time: date(si.asOf) })}</Text>}
      {si.lastSuccessAt && <Text block className={styles.meta}>{t('parasolM365.newest', { time: date(si.lastSuccessAt) })}</Text>}
    </div>
    {si.gaps.length > 0 && <details className={technical.details}><summary className={technical.detailsSummary}>{t('parasolM365.gaps', { count: si.gaps.length })}</summary>
      <ul className={styles.gaps}>{si.gaps.map((gap, i) => <li key={i}>{date(gap.fromInclusive)} – {date(gap.toExclusive)} UTC</li>)}</ul>
    </details>}
    <details className={technical.details}><summary className={technical.detailsSummary}>{t('parasolM365.reference')}</summary><Text className={styles.meta}>{connection.connectionId}</Text></details>
  </section>;
}
