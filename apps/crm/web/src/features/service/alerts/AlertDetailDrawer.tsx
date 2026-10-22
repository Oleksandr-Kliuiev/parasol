import { useState } from 'react';
import { Button, DrawerBody, DrawerHeader, DrawerHeaderTitle, Link, OverlayDrawer, Spinner, Text, makeStyles, useRestoreFocusTarget } from '@fluentui/react-components';
import { Dismiss24Regular, Open16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../../api/client';
import { h } from '../../../app/hearth';
import { AppLink } from '../../../shared/components/AppLink';
import { ErrorState } from '../../../shared/components/ErrorState';
import { DetailList } from '../../../shared/components/Panel';
import { formatDateTime } from '../../../shared/utils/format';
import { safeHttpUrl } from '../../../shared/utils/safeUrl';
import { AlertSourceSection } from './AlertActions';
import { alertTitle, isBackupGap } from './alertText';
import { CoverageRulesDialog } from './CoverageRulesDialog';
import { AlertAge, AlertSeverityBadge } from './AlertBits';
import { AlertReadLine } from './AlertReadLine';
import { useAlertReads } from './alertReads';
import { AlertTaskSection } from './AlertTaskSection';
import { sourceName } from './alertText';
import { useAlert } from './useAlertQueue';

const useStyles = makeStyles({
  // A side panel beside the list, as the task panel of My day: the person keeps their place in the queue.
  drawer: { width: 'min(480px, 100vw)' },
  body: { display: 'grid', gap: '20px', alignContent: 'start', paddingBottom: '24px' },
  facts: { gridTemplateColumns: 'minmax(0, 120px) minmax(0, 1fr)' },
  muted: { color: h.muted },
  external: { display: 'inline-flex', alignItems: 'center', gap: '4px', minHeight: '24px', '& svg': { flexShrink: 0 } },
  source: { display: 'grid', gap: '2px', justifyItems: 'start' },
});

/**
 * One alert in a side panel (M38): its fields as stored now, the link to its source when one is set up, and how fresh the stored
 * copy is, apart from when the alert was raised. The address holds the alert (`?alert=`), so My day and Back can open and close it.
 */
export function AlertDetailDrawer({ alertId, onClose }: { alertId: string | null; onClose: () => void }) {
  const { t } = useTranslation(); const styles = useStyles();
  const read = useAlert(alertId);
  // Read with the alert: how fresh the stored copy is now, not when the list behind the panel was read. Once read, the panel keeps
  // what it shows while a change reads the alert again (M40): a dialog opened from the panel, and the focus in it, stay put.
  const reads = useAlertReads(alertId !== null);
  const alert = alertId !== null && read.isFetchedAfterMount ? read.data : undefined;
  // M40: a gap's panel leads to the setting of the check that found it.
  const [checks, setChecks] = useState(false); const restore = useRestoreFocusTarget();
  const sourceReads = alert && !reads.isFetching ? reads.data?.filter((r) => r.system === alert.system) : undefined;
  const title = alert ? alertTitle(t, alert) : t('alerts.detail.title');
  const link = alert?.url ? safeHttpUrl(alert.url) : undefined;
  const missing = read.error instanceof ApiError && read.error.status === 404;

  return <OverlayDrawer className={styles.drawer} position="end" open={alertId !== null} onOpenChange={(_, d) => { if (!d.open) onClose(); }}
    aria-label={title}>
    <DrawerHeader>
      <DrawerHeaderTitle action={<Button appearance="subtle" icon={<Dismiss24Regular />} aria-label={t('common.close')} onClick={onClose} />}>
        {title}
      </DrawerHeaderTitle>
    </DrawerHeader>
    <DrawerBody className={styles.body}>
      {read.isFetching && !alert && <Spinner size="small" label={t('alerts.detail.loading')} />}
      {!read.isFetching && read.isError && (missing
        ? <Text block role="status">{t('alerts.detail.notFound')}</Text>
        : <ErrorState error={read.error} onRetry={() => void read.refetch()} />)}
      {alert && <>
        {/* The facts every alert has, then the optional ones only when set: no rows of dashes. */}
        <DetailList className={styles.facts} items={[
          { label: t('alerts.detail.severity'), value: <AlertSeverityBadge severity={alert.severity} /> },
          { label: t('alerts.detail.state'), value: t(`alerts.states.${alert.state}`) },
          { label: t('alerts.detail.customer'), value: <AppLink to={`/organizations/${alert.organizationId}?tab=drift`} onClick={onClose}>
            {alert.organizationName ?? t('alerts.detail.unknownCustomer')}</AppLink> },
          // M40: the device leads to its card in the customer's Drift tab (sources, "Open in Atera", inventory), once matched.
          ...(alert.deviceName ? [{ label: t('alerts.detail.device'), value: alert.machineId
            ? <AppLink to={`/organizations/${alert.organizationId}?tab=drift&device=${encodeURIComponent(alert.machineId)}`} onClick={onClose}>
              {alert.deviceName}</AppLink>
            : alert.deviceName }] : []),
          { label: t('alerts.detail.raised'), value: <>{formatDateTime(alert.createdAt)} · <AlertAge at={alert.createdAt} /></> },
          ...(alert.resolvedAt ? [{ label: t('alerts.detail.resolved'), value: formatDateTime(alert.resolvedAt) }] : []),
          { label: t('alerts.detail.source'), value: <span className={styles.source}>
            <span>{sourceName(t, alert.system)}</span>
            {link
              ? <Link href={link} target="_blank" rel="noopener noreferrer" className={styles.external}>
                {t('alerts.detail.openInSource', { name: sourceName(t, alert.system) })}<Open16Regular aria-hidden /></Link>
              // M40: a gap is found by Parasoll's own check, which also says how it closes.
              : alert.rule ? <>
                <Text size={200} className={styles.muted}>{t('alerts.gaps.found')}</Text>
                {/* M42: a backup gap leads to the customer's backups, where its users and the actions are. */}
                {isBackupGap(alert.rule) && <AppLink to={`/organizations/${alert.organizationId}?tab=backup`} onClick={onClose}>
                  {t('alerts.gaps.openBackup')}</AppLink>}
                <Link {...restore} as="button" className={styles.external} onClick={() => setChecks(true)}>{t('alerts.gaps.changeCheck')}</Link>
              </>
              : <Text size={200} className={styles.muted}>{t('alerts.detail.noLink', { name: sourceName(t, alert.system) })}</Text>}
            {sourceReads && sourceReads.length > 0 && <AlertReadLine reads={sourceReads} />}
          </span> },
        ]} />
        <AlertTaskSection alert={alert} onNavigate={onClose} />
        <AlertSourceSection alert={alert} />
      </>}
      {checks && <CoverageRulesDialog onClose={() => setChecks(false)} />}
    </DrawerBody>
  </OverlayDrawer>;
}
