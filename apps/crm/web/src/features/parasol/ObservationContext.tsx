import type { ReactNode } from 'react';
import { Badge, Text, makeStyles, mergeClasses } from '@fluentui/react-components';
import { HardDrive20Regular, ShieldError20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { formatDateTime, formatRelative } from '../../shared/utils/format';
import type { AtlasDevice, AtlasObservation } from './technicalContract';
import type { ObservationTaskLink } from './observationTaskContract';
import { useTechnicalStyles } from './technicalStyles';

const useStyles = makeStyles({
  // The attention row of the reference: an icon chip, the title with its severity over two quiet lines, the action at the
  // end. The state leads the first line, so the end column stays narrow and the text keeps its width.
  // Below 560 px (and in a narrow card, see technicalStyles.row) the end column moves under the text.
  root: {
    display: 'grid',
    gridTemplateColumns: '36px minmax(0, 1fr) auto',
    alignItems: 'start',
    columnGap: '12px',
    rowGap: '10px',
    minWidth: 0,
    '@media (max-width: 560px)': { gridTemplateColumns: '36px minmax(0, 1fr)' },
  },
  // A read-only row has no end column, so no gap is kept for one.
  noAction: { gridTemplateColumns: '36px minmax(0, 1fr)' },
  flag: { display: 'grid', placeItems: 'center', width: '36px', height: '36px', borderRadius: '11px', backgroundColor: h.well, color: h.muted },
  hot: { backgroundColor: h.emberSoft, color: h.emberT },
  body: { display: 'grid', gap: '3px', minWidth: 0 },
  // The title with its severity at the end of the line: the one severity cue stays beside the title at every width,
  // also where the action moves under five lines of facts (a phone, a narrow card).
  titleLine: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px', minWidth: 0 },
  title: { fontSize: '14px', lineHeight: '20px', minWidth: 0 },
  badge: { flexShrink: 0 },
  // Facts sit apart by a gap, not by "·" separators: a separator would start a line when the facts wrap.
  meta: {
    display: 'flex',
    flexWrap: 'wrap',
    columnGap: '12px',
    rowGap: '2px',
    color: h.muted,
    fontSize: '12.5px',
    lineHeight: '18px',
  },
  facts: { color: h.faint },
  state: { color: h.text, fontWeight: 600 },
  // Work that already exists for the observation: said in the row, so nobody opens the dialog to find out.
  task: { color: h.spruceT, fontWeight: 600 },
  taskClosed: { color: h.muted, fontWeight: 600 },
  aside: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: '10px',
    '@media (max-width: 560px)': { gridColumn: '2', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  },
});

/**
 * One observation as an attention row. The severity is said once, by the badge (urgent means HIGH or CRITICAL, which the
 * contract enforces); lists give the event's age, the record's own views (`exact`, the assignment dialog) the exact moments.
 */
export function ObservationContext({ observation: o, devices, action, exact = false, task }: {
  observation: AtlasObservation; devices: AtlasDevice[]; action?: ReactNode; exact?: boolean; task?: ObservationTaskLink;
}) {
  const { t } = useTranslation(); const technical = useTechnicalStyles(); const styles = useStyles();
  const hostname = devices.find(d => d.id === o.deviceId)?.hostname;
  const urgent = o.priority === 'URGENT';
  const moment = (key: 'occurred' | 'updated', iso: string) => exact
    ? <span>{t(key === 'occurred' ? 'parasolDetails.occurredAt' : 'parasolDetails.updatedAt', { time: formatDateTime(iso) })}</span>
    : <span>{t(`parasolDetails.${key}`)}{' '}
      <time dateTime={iso} title={formatDateTime(iso)}>{formatRelative(iso)}</time></span>;
  return <div className={mergeClasses(styles.root, !action && styles.noAction)}>
    <span className={mergeClasses(styles.flag, urgent && styles.hot)} aria-hidden>
      {o.kind === 'SECURITY_INCIDENT' ? <ShieldError20Regular /> : <HardDrive20Regular />}
    </span>
    <div className={styles.body}>
      <div className={styles.titleLine}>
        <Text weight="semibold" className={styles.title}>{o.summary || t('parasolDetails.noSummary')}</Text>
        <Badge className={styles.badge} appearance={o.severity === 'CRITICAL' ? 'filled' : 'tint'} color={urgent ? 'danger' : 'informative'}>
          {t(`parasolDetails.severity.${o.severity}`)}
        </Badge>
      </div>
      <div className={styles.meta}>
        <span className={styles.state}>{t(`parasolDetails.status.${o.status}`)}</span>
        {task && <span className={task.task.isAvailable && task.task.status === 'Open' ? styles.task : styles.taskClosed}>
          {[t(`parasolWork.rowTask.${task.task.isAvailable ? task.task.status : 'Unavailable'}`), task.assigneeName,
            task.task.dueAt && t('parasolWork.rowTaskDue', { due: formatDateTime(task.task.dueAt) })].filter(Boolean).join(' · ')}
        </span>}
        <span>{t(`parasol.sources.${o.source}`)} · {t(`parasolDetails.kind.${o.kind}`)}</span>
        <span>{o.deviceId
          ? <code className={technical.identifier}>{t('parasolDetails.confirmedDevice', { name: hostname, id: o.deviceId })}</code>
          : t(`parasolDetails.deviceStatus.${o.deviceStatus}`)}</span>
      </div>
      <div className={mergeClasses(styles.meta, styles.facts)}>
        <span>{t('parasolDetails.route')}: {t(`parasolDetails.routes.${o.route}`)}</span>
        {moment('occurred', o.occurredAt)}
        {/* An update in the same minute as the event says nothing new in a list; the record's own view keeps both. */}
        {(exact || Math.abs(new Date(o.updatedAt).getTime() - new Date(o.occurredAt).getTime()) >= 60_000) && moment('updated', o.updatedAt)}
      </div>
    </div>
    {action && <div className={styles.aside}>{action}</div>}
  </div>;
}
