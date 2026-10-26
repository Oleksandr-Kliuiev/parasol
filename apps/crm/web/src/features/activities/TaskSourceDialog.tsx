import {
  Button, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Link, Spinner, Text, makeStyles,
} from '@fluentui/react-components';
import { Open16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { h } from '../../app/hearth';
import { AppLink } from '../../shared/components/AppLink';
import { Dialog } from '../../shared/components/Dialog';
import { ErrorState } from '../../shared/components/ErrorState';
import { DetailList } from '../../shared/components/Panel';
import { formatDateTime } from '../../shared/utils/format';
import { safeHttpUrl } from '../../shared/utils/safeUrl';
import { AlertAge, AlertSeverityBadge } from '../service/alerts/AlertBits';
import { AlertReadLine } from '../service/alerts/AlertReadLine';
import { useAlertReads } from '../service/alerts/alertReads';
import { useTaskSource } from '../service/alerts/alertTasks';
import { alertTitle, sourceName } from '../service/alerts/alertText';

const useStyles = makeStyles({
  content: { display: 'grid', gap: '14px', alignContent: 'start' },
  note: { color: h.muted, fontSize: '13px', lineHeight: '19px' },
  head: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 8px' },
  title: { fontWeight: 600, overflowWrap: 'anywhere' },
  facts: { gridTemplateColumns: 'minmax(0, 120px) minmax(0, 1fr)' },
  external: { display: 'inline-flex', alignItems: 'center', gap: '4px', minHeight: '24px', '& svg': { flexShrink: 0 } },
  source: { display: 'grid', gap: '2px', justifyItems: 'start' },
});

/**
 * A task's alert read again now: its state may have changed since the task was made (resolved in its source, say). How fresh the
 * stored copy is comes with it, apart from when the alert was raised.
 */
export default function TaskSourceDialog({ activityId, onClose }: { activityId: string; onClose: () => void }) {
  const { t } = useTranslation(); const styles = useStyles();
  const source = useTaskSource(activityId, true);
  const reads = useAlertReads(true);
  const view = !source.isFetching ? source.data : undefined;
  const alert = view?.alert;
  const sourceReads = alert && !reads.isFetching ? reads.data?.filter((r) => r.system === alert.system) : undefined;
  const refresh = () => { void source.refetch(); void reads.refetch(); };
  const link = alert?.url ? safeHttpUrl(alert.url) : undefined;
  const code = source.error instanceof ApiError ? source.error.code : undefined;
  return <Dialog open onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
    <DialogSurface><DialogBody>
      <DialogTitle>{t('activities.source.title')}</DialogTitle>
      <DialogContent className={styles.content}>
        <Text block className={styles.note}>{t('activities.source.note')}</Text>
        {source.isFetching && <Spinner size="small" label={t('alerts.detail.loading')} />}
        {!source.isFetching && source.isError && (code === 'ACT_SOURCE_UNSUPPORTED' || code === 'ACT_SOURCE_TASK_NOT_FOUND'
          ? <Text block role="status">{t('activities.source.unsupported')}</Text>
          : <ErrorState error={source.error} onRetry={refresh} />)}
        {view && !alert && <Text block role="status">{t('activities.source.gone')}</Text>}
        {alert && <>
          <span className={styles.head}><AlertSeverityBadge severity={alert.severity} /><Text className={styles.title}>{alertTitle(t, alert)}</Text></span>
          <DetailList className={styles.facts} items={[
            { label: t('alerts.detail.state'), value: t(`alerts.states.${alert.state}`) },
            { label: t('alerts.detail.customer'), value: alert.organizationName ?? t('alerts.detail.unknownCustomer') },
            ...(alert.deviceName ? [{ label: t('alerts.detail.device'), value: alert.deviceName }] : []),
            { label: t('alerts.detail.raised'), value: <>{formatDateTime(alert.createdAt)} · <AlertAge at={alert.createdAt} /></> },
            ...(alert.resolvedAt ? [{ label: t('alerts.detail.resolved'), value: formatDateTime(alert.resolvedAt) }] : []),
            { label: t('alerts.detail.source'), value: <span className={styles.source}>
              {link
                ? <Link href={link} target="_blank" rel="noopener noreferrer" className={styles.external}>
                  {t('alerts.detail.openInSource', { name: sourceName(t, alert.system) })}<Open16Regular aria-hidden /></Link>
                : <span>{sourceName(t, alert.system)}</span>}
              {sourceReads && sourceReads.length > 0 && <AlertReadLine reads={sourceReads} />}
            </span> },
          ]} />
          <AppLink to={`/alerts?alert=${encodeURIComponent(alert.id)}`} onClick={onClose}>{t('activities.source.openInAlerts')}</AppLink>
        </>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('common.close')}</Button>
        <Button disabled={source.isFetching} onClick={refresh}>{t('common.refresh')}</Button>
      </DialogActions>
    </DialogBody></DialogSurface>
  </Dialog>;
}
