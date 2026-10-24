import { Button, MessageBar, MessageBarActions, MessageBarBody, Spinner, Text, makeStyles, tokens } from '@fluentui/react-components';
import { ArrowClockwise16Regular, CheckmarkCircle20Regular, Info20Regular, TaskListSquareLtr16Regular, TaskListSquareLtr24Regular } from '@fluentui/react-icons';
import { useEffect, useRef } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { Panel } from '../../shared/components/Panel';
import { ListFooter } from '../../shared/components/ListFooter';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDateTime, formatReadAt } from '../../shared/utils/format';
import { useActivityActions } from './api';
import { AtlasTaskSourceButton } from '../parasol/AtlasTaskSourceButton';
import { Permissions, useCurrentUser } from '../../auth/CurrentUserContext';
import { usePersonalTasks } from './usePersonalTasks';
import { activityUrl } from './activityNavigation';
import type { Activity } from './types';
import { useActivityStatusCommands } from './useActivityStatusCommands';
import { ActivityStatusFeedback } from './ActivityStatusFeedback';
import { TaskTicketButton } from './TaskTicketButton';
import { TaskPeek } from './TaskPeek';

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
  // The task and its customer are two links on top of each other: the task gets a 24 px tall target (WCAG 2.5.8).
  subject: { display: 'inline-flex', alignItems: 'center', minHeight: '24px' },
  actions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: tokens.spacingHorizontalS, maxWidth: '100%', marginInlineStart: 'auto' },
  muted: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  readAt: { color: tokens.colorNeutralForeground3, fontSize: '12.5px' },
  changed: { marginBottom: tokens.spacingVerticalS },
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

  // The side panel of one task has its own address (?task=), so Back closes it and a link can open it.
  const [params, setParams] = useSearchParams(); const location = useLocation(); const navigate = useNavigate();
  const peekId = params.get('task');
  const peeked = peekId ? data.find((activity) => activity.id === peekId) ?? null : null;
  const openPeek = (id: string) => {
    const next = new URLSearchParams(params); next.set('task', id); setParams(next, { state: { taskPeek: true } });
  };
  const closePeek = () => {
    if ((location.state as { taskPeek?: boolean } | null)?.taskPeek) { void navigate(-1); return; }
    const next = new URLSearchParams(params); next.delete('task'); setParams(next, { replace: true });
  };

  const complete = async (activity: Activity) => {
    const outcome = await status.run('complete', activity);
    if (!active.current) return;
    if (outcome.kind === 'success') notify(t('activities.completedNamed', { subject: activity.subject }));
    else if (outcome.kind === 'error') notify(t('errors.generic'), 'error', errorMessage(outcome.error, t));
  };

  // The same actions in the row and in the side panel: the source, the ticket and its hours, done.
  // In the side panel there is room for the word next to the done mark.
  const actionsOf = (activity: Activity, labelled = false) => <>
    {activity.hasTechnicalSource && <AtlasTaskSourceButton activityId={activity.id} />}
    <TaskTicketButton activity={activity} onCloseAfterChange={refreshAfterTicket} />
    {canWrite && <Button
      size="small"
      appearance="subtle"
      icon={<CheckmarkCircle20Regular />}
      // The visible words start the accessible name (WCAG 2.5.3); the task's name follows for a list of buttons.
      aria-label={labelled ? `${t('myDay.taskPeek.markDone')}: ${activity.subject}` : t('activities.completeNamed', { subject: activity.subject })}
      disabled={status.pending.has(activity.id) || status.isStale(activity)}
      disabledFocusable={status.pending.has(activity.id) || status.isStale(activity)}
      onClick={() => void complete(activity)}
    >{labelled ? t('myDay.taskPeek.markDone') : undefined}</Button>}
  </>;

  return (
    <Panel title={t('myDay.myTasks')} icon={<TaskListSquareLtr16Regular />} actions={<>
      {tasks.readAt !== null && <Text className={styles.readAt}>{t('myDay.tasksReadAt', { time: formatReadAt(new Date(tasks.readAt).toISOString()) })}</Text>}
      <Button ref={refreshButton} size="small" icon={<ArrowClockwise16Regular />}
        aria-label={t('myDay.refreshMyTasks')} disabled={tasks.checking} disabledFocusable={tasks.checking}
        onClick={() => { status.clearConflicts(); tasks.refresh(); }}>{t('common.refresh')}</Button>
    </>}>
      {tasks.checking && <Spinner size="small" label={t('common.loading')} />}
      {/* A later count differs from the list shown: say so and leave the refresh to the person (M17 keeps the rows). */}
      {tasks.changed && <MessageBar intent="info" className={styles.changed}><MessageBarBody>
        <Text role="status">{t('myDay.tasksChanged')}</Text>
      </MessageBarBody><MessageBarActions>
        <Button size="small" onClick={() => { status.clearConflicts(); tasks.refresh(); }}>{t('myDay.tasksChangedRefresh')}</Button>
      </MessageBarActions></MessageBar>}
      {Boolean(tasks.error) && <MessageBar intent="error"><MessageBarBody><Text role="status">{t('myDay.myTasksReadFailed')}</Text></MessageBarBody></MessageBar>}
      {!tasks.checking && !tasks.error && data.length === 0 && <EmptyState compact icon={<TaskListSquareLtr24Regular />} message={t('myDay.myTasksEmpty')} />}
      <ul key={tasks.revision} className={styles.list}>
        {data.map((activity) => (
          <li key={activity.id} className={styles.row}>
            <span className={styles.text}>
              <AppLink className={styles.subject} to={activityUrl(activity.organizationId, activity.id)}>
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
              {actionsOf(activity)}
              <Button size="small" appearance="subtle" icon={<Info20Regular />} aria-label={t('myDay.taskPeek.openNamed', { subject: activity.subject })}
                onClick={() => openPeek(activity.id)} />
            </span>
          </li>
        ))}
      </ul>
      <ListFooter shown={data.length} total={tasks.total} hasMore={tasks.hasMore} loading={tasks.loadingMore} onMore={() => void tasks.loadMore()} />
      <TaskPeek open={Boolean(peekId) && !tasks.checking} activity={peeked} onClose={closePeek} actions={peeked && actionsOf(peeked, true)} />
    </Panel>
  );
}
