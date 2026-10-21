import { Badge, Button, Link, Text, makeStyles, tokens, useRestoreFocusTarget } from '@fluentui/react-components';
import type { ReactElement } from 'react';
import { ArrowUndo20Regular, CalendarLtr16Regular, Call20Regular, CheckmarkCircle20Regular, Edit20Regular, Mail20Regular, Note20Regular, Open16Regular,
  People20Regular, TaskListSquareLtr20Regular } from '@fluentui/react-icons';
import { h, tone as tones, type Tone } from '../../app/hearth';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../../shared/utils/format';
import { safeHttpUrl } from '../../shared/utils/safeUrl';
import { AtlasTaskSourceButton } from '../parasol/AtlasTaskSourceButton';
import type { Activity, ActivityType } from './types';
import { ActivityStatusFeedback } from './ActivityStatusFeedback';
import type { StatusFocusRequest } from './useActivityStatusCommands';
import { TaskTicketButton } from './TaskTicketButton';

const useStyles = makeStyles({
  // A row of the reference task list: the type as a tinted icon, subject and muted meta, quiet actions on the right.
  item: {
    display: 'grid',
    gridTemplateColumns: '32px minmax(0, 1fr) auto',
    alignItems: 'start',
    columnGap: '12px',
    rowGap: '4px',
    overflowWrap: 'anywhere',
    paddingTop: '12px',
    paddingBottom: '12px',
    borderBottom: `1px solid ${h.line}`,
    ':last-child': { borderBottom: 'none' },
  },
  chip: { display: 'grid', placeItems: 'center', width: '32px', height: '32px', borderRadius: '10px', '& svg': { width: '16px', height: '16px' } },
  content: { display: 'grid', gap: '2px', minWidth: 0, justifyItems: 'start' },
  head: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px' },
  body: { whiteSpace: 'pre-wrap', color: tokens.colorNeutralForeground2, fontSize: '13px', lineHeight: '20px' },
  meta: { color: h.muted, fontSize: '12.5px', lineHeight: '18px' },
  overdue: { color: h.emberT, fontSize: '12.5px', lineHeight: '18px', fontWeight: tokens.fontWeightSemibold },
  done: { color: h.muted, textDecorationLine: 'line-through' },
  high: { color: h.emberT, fontSize: '12px', fontWeight: tokens.fontWeightSemibold },
  actions: { display: 'flex', gap: '2px', alignItems: 'start' },
});

const typeLook: Record<ActivityType, { icon: ReactElement; tone: Tone }> = {
  Task: { icon: <TaskListSquareLtr20Regular />, tone: 'iris' },
  Call: { icon: <Call20Regular />, tone: 'spruce' },
  Meeting: { icon: <People20Regular />, tone: 'iris' },
  Email: { icon: <Mail20Regular />, tone: 'saffron' },
  Note: { icon: <Note20Regular />, tone: 'neutral' },
};

/** The same record and controls in the timeline and in an exact activity selection. */
export function ActivityTimelineItem({ activity, canWrite, calendar, calendarPending, selected, statusPending, statusStale,
  focusRequest, onFocusReady, onEdit, onComplete, onReopen, onCalendar, onTicketChanged }: {
  activity: Activity;
  canWrite: boolean;
  calendar: boolean;
  calendarPending: boolean;
  selected?: boolean;
  statusPending: boolean;
  statusStale: boolean;
  focusRequest: StatusFocusRequest | null;
  onFocusReady: (request: StatusFocusRequest, button: HTMLButtonElement) => void;
  onEdit: (activity: Activity) => void;
  onComplete: (activity: Activity, trigger: HTMLButtonElement) => void;
  onReopen: (activity: Activity, trigger: HTMLButtonElement) => void;
  onCalendar: (activity: Activity) => void;
  onTicketChanged: () => void;
}) {
  const styles = useStyles(); const { t } = useTranslation(); const restoreFocusTarget = useRestoreFocusTarget();
  const statusButton = useRef<HTMLButtonElement>(null);
  const canReopen = activity.status === 'Done' && ['Task', 'Call', 'Meeting'].includes(activity.type);
  useEffect(() => {
    if (!statusPending && focusRequest?.id === activity.id && focusRequest.status === activity.status && statusButton.current)
      onFocusReady(focusRequest, statusButton.current);
  }, [focusRequest, activity.id, activity.status, statusPending, onFocusReady]);
  const look = typeLook[activity.type] ?? typeLook.Note;
  return <li className={styles.item}>
    <span className={styles.chip} style={{ backgroundColor: tones[look.tone].soft, color: tones[look.tone].text }} aria-hidden>{look.icon}</span>
    <span className={styles.content}>
      <span className={styles.head}>
        <Badge appearance="outline">{t(`activities.types.${activity.type}`)}</Badge>
        <Text weight="semibold" className={activity.status === 'Done' ? styles.done : undefined}>{activity.subject}</Text>
        {activity.priority === 'High' && activity.status === 'Open' && <Badge appearance="tint" color="danger" className={styles.high}>{t('activities.priorities.High')}</Badge>}
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
      <TaskTicketButton activity={activity} onCloseAfterChange={onTicketChanged} />
      {statusStale && <ActivityStatusFeedback activity={activity} />}
    </span>
    {canWrite && activity.type !== 'Email' && <span className={styles.actions}>
      {activity.type === 'Meeting' && calendar && <Button size="small" appearance="subtle" icon={<CalendarLtr16Regular />}
        aria-label={t(activity.inCalendar ? 'activities.removeFromCalendarNamed' : 'activities.addToCalendarNamed', { subject: activity.subject })}
        disabled={calendarPending || statusPending} disabledFocusable={statusPending} onClick={() => onCalendar(activity)} />}
      {(activity.status === 'Open' || canReopen) && <Button ref={statusButton} size="small" appearance="subtle"
        disabled={statusPending || statusStale} disabledFocusable={statusPending || statusStale}
        icon={canReopen ? <ArrowUndo20Regular /> : <CheckmarkCircle20Regular />}
        aria-label={t(canReopen ? 'activities.reopenNamed' : 'activities.completeNamed', { subject: activity.subject })}
        onClick={event => (canReopen ? onReopen : onComplete)(activity, event.currentTarget)} />}
      <Button {...restoreFocusTarget} size="small" appearance="subtle" icon={<Edit20Regular />}
        disabled={statusPending} disabledFocusable={statusPending}
        aria-label={t('activities.editNamed', { subject: activity.subject })} onClick={() => onEdit(activity)} />
    </span>}
  </li>;
}
