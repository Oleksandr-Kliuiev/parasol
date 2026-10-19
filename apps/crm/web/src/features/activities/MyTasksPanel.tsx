import { Button, MessageBar, MessageBarBody, Spinner, Text, makeStyles, tokens } from '@fluentui/react-components';
import { CheckmarkCircle20Regular } from '@fluentui/react-icons';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { AppLink } from '../../shared/components/AppLink';
import { Panel } from '../../shared/components/Panel';
import { ListFooter } from '../../shared/components/ListFooter';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDateTime } from '../../shared/utils/format';
import { useActivityActions } from './api';
import { AtlasTaskSourceButton } from '../parasol/AtlasTaskSourceButton';
import { Permissions, useCurrentUser } from '../../auth/CurrentUserContext';
import { usePersonalTasks } from './usePersonalTasks';
import { activityUrl } from './activityNavigation';
import type { Activity } from './types';
import { useActivityStatusCommands } from './useActivityStatusCommands';
import { ActivityStatusFeedback } from './ActivityStatusFeedback';
import { TaskTicketButton } from './TaskTicketButton';

const useStyles = makeStyles({
  list: { listStyle: 'none', margin: 0, padding: 0 },
  row: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingBlock: tokens.spacingVerticalS,
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
    ':last-child': { borderBottom: 'none' },
  },
  text: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: '1 1 240px' },
  actions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: tokens.spacingHorizontalS, maxWidth: '100%', marginInlineStart: 'auto' },
  muted: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  overdue: { color: tokens.colorPaletteRedForeground1, fontSize: tokens.fontSizeBase200 },
  context: { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap' },
});

/** Open tasks and meetings assigned to the signed-in user (FR-ACT-01, "My day"). */
export function MyTasksPanel() {
  const user = useCurrentUser();
  if (!user.permissions.includes(Permissions.activitiesRead)) return null;
  const permissionsKey = JSON.stringify([...user.permissions].sort());
  return <PersonalTasks key={`${user.id}:${permissionsKey}`} employeeId={user.id} permissionsKey={permissionsKey}
    canWrite={user.permissions.includes(Permissions.activitiesWrite)} />;
}

function PersonalTasks({ employeeId, permissionsKey, canWrite }: { employeeId: string; permissionsKey: string; canWrite: boolean }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const actions = useActivityActions();
  const status = useActivityStatusCommands(actions);
  // The ten due first, and the rest on request: the panel says how many open tasks there are (DEV-12).
  const tasks = usePersonalTasks(employeeId, permissionsKey);
  const data = tasks.items;
  const active = useRef(false);
  const refreshButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const refreshAfterTicket = () => {
    status.clearConflicts(); tasks.refresh();
    queueMicrotask(() => { if (active.current) refreshButton.current?.focus(); });
  };

  const complete = async (activity: Activity) => {
    const outcome = await status.run('complete', activity);
    if (!active.current) return;
    if (outcome.kind === 'success') notify(t('activities.completedNamed', { subject: activity.subject }));
    else if (outcome.kind === 'error') notify(t('errors.generic'), 'error', errorMessage(outcome.error, t));
  };

  return (
    <Panel title={t('myDay.myTasks')} actions={<Button ref={refreshButton} size="small" disabled={tasks.checking} disabledFocusable={tasks.checking}
      onClick={() => { status.clearConflicts(); tasks.refresh(); }}>{t('myDay.refreshMyTasks')}</Button>}>
      {tasks.checking && <Spinner size="small" label={t('common.loading')} />}
      {Boolean(tasks.error) && <MessageBar intent="error"><MessageBarBody><Text role="status">{t('myDay.myTasksReadFailed')}</Text></MessageBarBody></MessageBar>}
      {!tasks.checking && !tasks.error && data.length === 0 && <Text className={styles.muted}>{t('myDay.myTasksEmpty')}</Text>}
      <ul key={tasks.revision} className={styles.list}>
        {data.map((activity) => (
          <li key={activity.id} className={styles.row}>
            <span className={styles.text}>
              <AppLink to={activityUrl(activity.organizationId, activity.id)}>
                <Text weight="semibold">{activity.subject}</Text>
                <span className={styles.context}>{` · ${t('activities.openForCustomer', { customer: activity.organizationName ?? '' })}`}</span>
              </AppLink>
              <span className={activity.isOverdue ? styles.overdue : styles.muted}>
                <AppLink to={`/organizations/${activity.organizationId}`}>{activity.organizationName}</AppLink>
                {activity.dueAt ? ` · ${t(activity.isOverdue ? 'activities.overdueAt' : 'activities.dueAt', { at: formatDateTime(activity.dueAt) })}` : ''}
                {` · ${t('activities.loggedAt', { at: formatDateTime(activity.createdAt) })}`}
              </span>
              {status.isStale(activity) && <ActivityStatusFeedback activity={activity} />}
            </span>
            <span className={styles.actions}>
              {activity.hasTechnicalSource && <AtlasTaskSourceButton activityId={activity.id} />}
              <TaskTicketButton activity={activity} onCloseAfterChange={refreshAfterTicket} />
              {canWrite && <Button
                size="small"
                appearance="subtle"
                icon={<CheckmarkCircle20Regular />}
                aria-label={t('activities.completeNamed', { subject: activity.subject })}
                disabled={status.pending.has(activity.id) || status.isStale(activity)}
                disabledFocusable={status.pending.has(activity.id) || status.isStale(activity)}
                onClick={() => void complete(activity)}
              />}
            </span>
          </li>
        ))}
      </ul>
      <ListFooter shown={data.length} total={tasks.total} hasMore={tasks.hasMore} loading={tasks.loadingMore} onMore={() => void tasks.loadMore()} />
    </Panel>
  );
}
