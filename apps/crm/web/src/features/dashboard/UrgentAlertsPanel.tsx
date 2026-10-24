import { useRef, useState } from 'react';
import { Badge, Button, MessageBar, MessageBarBody, Spinner, Text, makeStyles, mergeClasses } from '@fluentui/react-components';
import { Alert16Regular, AlertOn24Regular, AlertUrgent16Regular, ArrowClockwise16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { alertTitle } from '../service/alerts/alertText';
import { h } from '../../app/hearth';
import { Permissions, useCurrentUser } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { Panel } from '../../shared/components/Panel';
import { formatDateTime, formatRelative } from '../../shared/utils/format';
import { useFlushStyles } from '../billing/flushStyles';
import { RecordRow, RowMeta } from '../billing/RecordRow';
import { AlertReadLine } from '../service/alerts/AlertReadLine';
import { AlertTaskCell } from '../service/alerts/AlertTaskCell';
import { AlertTaskDialogHost } from '../service/alerts/AlertTaskDialogHost';
import { alertsFreshness } from '../service/alerts/alertReads';
import { useAlertTaskLinks, type AlertTask } from '../service/alerts/alertTasks';
import { useUrgentAlerts, type UrgentAlerts } from './urgentAlerts';

const useStyles = makeStyles({
  // A read state or an empty line inside the flush panel keeps the panel's side padding and a bottom edge.
  pad: { paddingLeft: '20px', paddingRight: '20px', paddingBottom: '16px', '@media (max-width: 600px)': { paddingLeft: '16px', paddingRight: '16px' } },
  caption: { display: 'block', color: h.muted, fontSize: '12.5px', lineHeight: '18px' },
  foot: { paddingTop: '12px', paddingBottom: '16px', borderTop: `1px solid ${h.line}` },
  context: { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap' },
});

/**
 * The open alerts to look at first, across customers (M38): the most severe, and among them the oldest. Each row opens the
 * alert in the queue and says who has its task, or hands it over here with Assign (M40), in the dialog the queue uses; the
 * header says how fresh the CRM's copy is, never more than the read proved.
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
  // The rows' tasks in one lookup for the panel, never one per row.
  const tasks = useAlertTaskLinks(read.data ? [read.data.items.map((alert) => alert.id)] : []);

  // The assign dialog is held outside the rows, which a new read hides: the dialog stays with its answer while the panel reads.
  return (<AlertTaskDialogHost>
    <Panel title={t('myDay.alerts.title')} icon={<AlertUrgent16Regular />} flush className={flush.panel} actions={<>
      {data && <AlertReadLine reads={data.reads} />}
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
        <ul className={mergeClasses(flush.list, 'h-stagger')}>{data.items.map((alert) =>
          <AlertRow key={alert.id} alert={alert} task={tasks.links.get(alert.id)} />)}</ul>
        <div className={mergeClasses(flush.foot, styles.foot)}>
          <AppLink to="/alerts">{t('myDay.alerts.all', { count: data.totalCount })}</AppLink>
        </div>
      </>}
    </Panel>
  </AlertTaskDialogHost>);
}

function AlertRow({ alert, task }: { alert: UrgentAlerts['items'][number]; task: AlertTask | undefined }) {
  const { t } = useTranslation();
  const styles = useStyles();
  const critical = alert.severity === 'Critical';
  const where = [alert.organizationName, alert.deviceName].filter(Boolean).join(' · ');
  return (
    <RecordRow
      icon={<Alert16Regular />}
      tone={critical ? 'ember' : 'saffron'}
      title={<AppLink to={`/alerts?alert=${encodeURIComponent(alert.id)}`}>
        {alertTitle(t, alert)}
        {/* Alerts of the same kind share a title; the customer tells the links apart for a screen reader. */}
        {alert.organizationName && <span className={styles.context}>{` · ${alert.organizationName}`}</span>}
      </AppLink>}
      meta={<RowMeta>
        {where && `${where} · `}
        <time dateTime={alert.createdAt} title={formatDateTime(alert.createdAt)}>{formatRelative(alert.createdAt)}</time>
      </RowMeta>}
      end={<>
        <Badge appearance="tint" color={critical ? 'danger' : 'warning'}>{t(`service.severities.${alert.severity}`)}</Badge>
        <AlertTaskCell alert={alert} task={task} />
      </>}
    />
  );
}
