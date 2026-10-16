import { Badge, Button, Link, Text, makeStyles, tokens, useRestoreFocusTarget } from '@fluentui/react-components';
import { CalendarLtr16Regular, CheckmarkCircle20Regular, Edit20Regular, Open16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../../shared/utils/format';
import { safeHttpUrl } from '../../shared/utils/safeUrl';
import { AtlasTaskSourceButton } from '../parasol/AtlasTaskSourceButton';
import type { Activity } from './types';

const useStyles = makeStyles({
  item: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: tokens.spacingHorizontalS, overflowWrap: 'anywhere',
    paddingBlock: tokens.spacingVerticalS, borderBottom: `1px solid ${tokens.colorNeutralStroke3}`, ':last-child': { borderBottom: 'none' } },
  head: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: tokens.spacingHorizontalS },
  body: { whiteSpace: 'pre-wrap', color: tokens.colorNeutralForeground2, fontSize: tokens.fontSizeBase200 },
  meta: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  overdue: { color: tokens.colorPaletteRedForeground1, fontSize: tokens.fontSizeBase200 },
  done: { color: tokens.colorNeutralForeground3 },
  high: { color: tokens.colorPaletteDarkOrangeForeground1, fontSize: tokens.fontSizeBase200, fontWeight: tokens.fontWeightSemibold },
  actions: { display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'start' },
});

/** The same record and controls in the timeline and in an exact activity selection. */
export function ActivityTimelineItem({ activity, canWrite, calendar, calendarPending, selected, onEdit, onComplete, onCalendar }: {
  activity: Activity;
  canWrite: boolean;
  calendar: boolean;
  calendarPending: boolean;
  selected?: boolean;
  onEdit: (activity: Activity) => void;
  onComplete: (activity: Activity) => void;
  onCalendar: (activity: Activity) => void;
}) {
  const styles = useStyles(); const { t } = useTranslation(); const restoreFocusTarget = useRestoreFocusTarget();
  return <li className={styles.item}>
    <span>
      <span className={styles.head}>
        <Badge appearance="outline" color="informative">{t(`activities.types.${activity.type}`)}</Badge>
        <Text weight="semibold" className={activity.status === 'Done' ? styles.done : undefined}>{activity.subject}</Text>
        {activity.priority === 'High' && activity.status === 'Open' && <Text className={styles.high}>{t('activities.priorities.High')}</Text>}
        {activity.inCalendar && <Badge appearance="outline" color="informative" icon={<CalendarLtr16Regular />}>{t('activities.inCalendar')}</Badge>}
        {activity.webLink && <Link href={safeHttpUrl(activity.webLink)} target="_blank" rel="noopener noreferrer">
          {t('activities.openInOutlook')}<Open16Regular aria-hidden style={{ marginInlineStart: 4 }} />
        </Link>}
      </span>
      {selected && <div className={styles.meta}>{t('activities.selectedStatus', { state: t(`parasolWork.taskStatus.${activity.status}`) })}</div>}
      {activity.body && <div className={styles.body}>{activity.body}</div>}
      {activity.fromAddress && <div className={styles.meta}>{activity.fromAddress}</div>}
      <div className={activity.isOverdue ? styles.overdue : styles.meta}>
        {activity.dueAt ? t(activity.isOverdue ? 'activities.overdueAt' : 'activities.dueAt', { at: formatDateTime(activity.dueAt) })
          : t('activities.loggedAt', { at: formatDateTime(activity.createdAt) })}
        {activity.assignee ? ` · ${activity.assignee.name}` : ''}
        {activity.status === 'Done' && activity.completedAt ? ` · ${t('activities.doneAt', { at: formatDateTime(activity.completedAt) })}` : ''}
      </div>
      {activity.hasTechnicalSource && <AtlasTaskSourceButton activityId={activity.id} />}
    </span>
    {canWrite && activity.type !== 'Email' && <span className={styles.actions}>
      {activity.type === 'Meeting' && calendar && <Button size="small" appearance="subtle" icon={<CalendarLtr16Regular />}
        aria-label={t(activity.inCalendar ? 'activities.removeFromCalendarNamed' : 'activities.addToCalendarNamed', { subject: activity.subject })}
        disabled={calendarPending} onClick={() => onCalendar(activity)} />}
      {activity.status === 'Open' && <Button size="small" appearance="subtle" icon={<CheckmarkCircle20Regular />}
        aria-label={t('activities.completeNamed', { subject: activity.subject })} onClick={() => onComplete(activity)} />}
      <Button {...restoreFocusTarget} size="small" appearance="subtle" icon={<Edit20Regular />}
        aria-label={t('activities.editNamed', { subject: activity.subject })} onClick={() => onEdit(activity)} />
    </span>}
  </li>;
}
