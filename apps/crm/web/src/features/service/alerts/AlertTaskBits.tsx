import { Text, makeStyles, mergeClasses } from '@fluentui/react-components';
import { TaskListSquareLtr16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../../api/client';
import { h } from '../../../app/hearth';
import { AppLink } from '../../../shared/components/AppLink';
import { ErrorState } from '../../../shared/components/ErrorState';
import { formatDateTime } from '../../../shared/utils/format';
import { activityUrl } from '../../activities/activityNavigation';
import type { AlertTask } from './alertTasks';

const useStyles = makeStyles({
  // The task an alert has, said in one line in a row: who, when, and a way to it.
  task: { display: 'inline-flex', alignItems: 'center', gap: '6px', minWidth: 0, minHeight: '24px', fontSize: '13px', lineHeight: '18px' },
  taskIcon: { display: 'inline-flex', flexShrink: 0, color: h.muted },
  taskText: { minWidth: 0, overflowWrap: 'anywhere' },
  muted: { color: h.muted },
  // In a dialog or a side panel the task gets its subject on a line of its own.
  block: { display: 'grid', gap: '2px', fontSize: '13.5px', lineHeight: '20px' },
  subject: { fontWeight: 600, overflowWrap: 'anywhere' },
});

/** Who has the task and until when; `compact` is the one-line form of a list row. */
export function AlertTaskSummary({ task, compact = false, onNavigate }: { task: AlertTask; compact?: boolean; onNavigate?: () => void }) {
  const { t } = useTranslation(); const styles = useStyles();
  const who = task.assignee ? task.assignee.name || t('alerts.task.assigned') : t('alerts.task.unassigned');
  const when = task.dueAt ? t('alerts.task.due', { due: formatDateTime(task.dueAt) }) : t('alerts.task.noDue');
  const state = task.status === 'Open' ? null : t(`alerts.task.status.${task.status}`);
  if (!task.isAvailable) return <Text className={mergeClasses(styles.task, styles.muted)}>{t('alerts.task.deleted')}</Text>;
  const facts = [state, who, when].filter(Boolean).join(' · ');
  if (compact) {
    return <span className={styles.task}>
      <span className={styles.taskIcon} aria-hidden><TaskListSquareLtr16Regular /></span>
      {/* The visible words start the accessible name (WCAG 2.5.3); the subject tells one row's task from another's. */}
      <AppLink className={styles.taskText} to={activityUrl(task.organizationId, task.id)} onClick={onNavigate}
        ariaLabel={t('alerts.task.openNamed', { subject: task.subject ?? '', facts })}>{facts}</AppLink>
    </span>;
  }
  return <div className={styles.block}>
    <Text className={styles.subject}>{task.subject}</Text>
    <Text className={styles.muted}>{facts}</Text>
    <AppLink to={activityUrl(task.organizationId, task.id)} onClick={onNavigate}>{t('alerts.task.open')}</AppLink>
  </div>;
}

/**
 * Why an alert could not be read for a task, in words: one that is no longer stored or one of a source no task is made from is
 * said as such (no retry would change it); a refusal and anything else go through the app's own read error.
 */
export function AlertReadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useTranslation();
  const code = error instanceof ApiError ? error.code : undefined;
  if (code === 'ACT_SOURCE_ALERT_NOT_FOUND') return <Text block role="status">{t('alerts.detail.notFound')}</Text>;
  if (code === 'ACT_SOURCE_UNSUPPORTED') return <Text block role="status">{t('alerts.detail.unsupported')}</Text>;
  return <ErrorState error={error} onRetry={onRetry} />;
}
