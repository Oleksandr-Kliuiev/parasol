import { useRef, useState } from 'react';
import { Badge, Button, MessageBar, MessageBarBody, Spinner, Text, makeStyles, mergeClasses } from '@fluentui/react-components';
import { Alert16Regular, AlertOn24Regular, AlertUrgent16Regular, ArrowClockwise16Regular, Warning16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { Permissions, useCurrentUser } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { Panel } from '../../shared/components/Panel';
import { formatDateTime, formatReadAt, formatRelative } from '../../shared/utils/format';
import { useFlushStyles } from '../billing/flushStyles';
import { RecordRow, RowMeta } from '../billing/RecordRow';
import { alertSourceName, alertsFreshness, useUrgentAlerts, type AlertSourceRead, type UrgentAlerts } from './urgentAlerts';

const useStyles = makeStyles({
  // A read state or an empty line inside the flush panel keeps the panel's side padding and a bottom edge.
  pad: { paddingLeft: '20px', paddingRight: '20px', paddingBottom: '16px', '@media (max-width: 600px)': { paddingLeft: '16px', paddingRight: '16px' } },
  caption: { display: 'block', color: h.muted, fontSize: '12.5px', lineHeight: '18px' },
  read: { display: 'inline-flex', alignItems: 'center', gap: '4px', color: h.muted, fontSize: '12.5px', lineHeight: '18px', fontVariantNumeric: 'tabular-nums' },
  // A read that did not finish is said in the warning tone, with its mark: the list may be older than the time beside it.
  partial: { color: h.saffronT, '& svg': { flexShrink: 0 } },
  foot: { paddingTop: '12px', paddingBottom: '16px', borderTop: `1px solid ${h.line}` },
  context: { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap' },
});

/**
 * The open alerts to look at first, across customers (M38): the most severe, and among them the oldest. Each row opens the
 * alert in the queue, where it is assigned; the header says how fresh the CRM's copy is, never more than the read proved.
 */
export function UrgentAlertsPanel() {
  const user = useCurrentUser();
  if (!user.permissions.includes(Permissions.serviceRead)) return null;
  const permissionsKey = JSON.stringify([...user.permissions].sort());
  return <UrgentAlertsList key={`${user.id}:${permissionsKey}`} employeeId={user.id} permissionsKey={permissionsKey} />;
}

function UrgentAlertsList({ employeeId, permissionsKey }: { employeeId: string; permissionsKey: string }) {
  const { t } = useTranslation();
  const styles = useStyles();
  const flush = useFlushStyles();
  const read = useUrgentAlerts(employeeId, permissionsKey);
  const [refreshing, setRefreshing] = useState(false);
  const pending = useRef(false);
  const { refetch } = read;
  const refresh = () => {
    if (pending.current) return;
    pending.current = true; setRefreshing(true);
    void refetch().finally(() => { pending.current = false; setRefreshing(false); });
  };
  const checking = refreshing || read.isFetching;
  // A new read hides the rows of the last one: a failed or pending read never leaves older alerts standing as current.
  const data = !checking && !read.isError ? read.data : undefined;
  const freshness = data ? alertsFreshness(data.reads) : null;

  return (
    <Panel title={t('myDay.alerts.title')} icon={<AlertUrgent16Regular />} flush className={flush.panel} actions={<>
      {data && <SourceReads reads={data.reads} />}
      <Button size="small" icon={<ArrowClockwise16Regular />} aria-label={t('myDay.alerts.refresh')}
        disabled={checking} disabledFocusable={checking} onClick={refresh}>{t('common.refresh')}</Button>
    </>}>
      <div className={styles.pad}>
        {checking && <Spinner size="small" label={t('common.loading')} />}
        {!checking && read.isError && <MessageBar intent="error"><MessageBarBody>
          <Text role="status">{t('myDay.alerts.readFailed')}</Text>
        </MessageBarBody></MessageBar>}
        {data && data.items.length === 0 && <EmptyState compact icon={<AlertOn24Regular />}
          message={t(freshness === 'notRead' ? 'myDay.alerts.emptyNotRead' : 'myDay.alerts.empty')} />}
        {data && data.items.length > 0 && <Text className={styles.caption}>{data.totalCount > data.items.length
          ? t('myDay.alerts.shownSome', { shown: data.items.length, total: data.totalCount })
          : t('myDay.alerts.shownAll', { count: data.totalCount })}</Text>}
      </div>
      {data && data.items.length > 0 && <>
        <ul className={mergeClasses(flush.list, 'h-stagger')}>{data.items.map((alert) => <AlertRow key={alert.id} alert={alert} />)}</ul>
        <div className={mergeClasses(flush.foot, styles.foot)}>
          <AppLink to="/alerts">{t('myDay.alerts.all', { count: data.totalCount })}</AppLink>
        </div>
      </>}
    </Panel>
  );
}

/** "Atera read 08:30" per source: a read that did not finish, or none yet, is said as such. */
function SourceReads({ reads }: { reads: UrgentAlerts['reads'] }) {
  const { t } = useTranslation();
  const styles = useStyles();
  const said = (read: AlertSourceRead) => {
    const source = alertSourceName(read.system);
    if (read.startedAt === null) return t('myDay.alerts.notRead', { source });
    const time = formatReadAt(read.startedAt);
    return t(read.complete ? 'myDay.alerts.readAt' : 'myDay.alerts.readIncomplete', { source, time });
  };
  const partial = alertsFreshness(reads) === 'incomplete';
  return (
    <Text className={mergeClasses(styles.read, partial && styles.partial)}>
      {partial && <Warning16Regular aria-hidden />}
      {reads.map(said).join(' · ')}
    </Text>
  );
}

function AlertRow({ alert }: { alert: UrgentAlerts['items'][number] }) {
  const { t } = useTranslation();
  const styles = useStyles();
  const critical = alert.severity === 'Critical';
  const where = [alert.organizationName, alert.deviceName].filter(Boolean).join(' · ');
  return (
    <RecordRow
      icon={<Alert16Regular />}
      tone={critical ? 'ember' : 'saffron'}
      title={<AppLink to={`/alerts?alert=${encodeURIComponent(alert.id)}`}>
        {alert.title}
        {/* Alerts of the same kind share a title; the customer tells the links apart for a screen reader. */}
        {alert.organizationName && <span className={styles.context}>{` · ${alert.organizationName}`}</span>}
      </AppLink>}
      meta={<RowMeta>
        {where && `${where} · `}
        <time dateTime={alert.createdAt} title={formatDateTime(alert.createdAt)}>{formatRelative(alert.createdAt)}</time>
      </RowMeta>}
      end={<Badge appearance="tint" color={critical ? 'danger' : 'warning'}>{t(`service.severities.${alert.severity}`)}</Badge>}
    />
  );
}
