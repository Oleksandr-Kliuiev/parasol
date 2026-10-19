import { useEffect, useRef, useState } from 'react';
import { Button, Spinner, Text, makeStyles, useRestoreFocusTarget } from '@fluentui/react-components';
import { Add20Regular, ArrowSync20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { Permissions, useCurrentUser } from '../../auth/CurrentUserContext';
import { EmptyState } from '../../shared/components/EmptyState';
import { ListFooter } from '../../shared/components/ListFooter';
import { ErrorState } from '../../shared/components/ErrorState';
import { Panel } from '../../shared/components/Panel';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { useActivities, useActivityActions, useOutlookStatus } from './api';
import { ActivityDialog } from './ActivityDialog';
import { ActivityTimelineItem } from './ActivityTimelineItem';
import { useSelectedActivity } from './useSelectedActivity';
import type { ActivitySelection } from './activityNavigation';
import type { Activity } from './types';
import { useActivityStatusCommands } from './useActivityStatusCommands';

const useStyles = makeStyles({ list: { listStyle: 'none', margin: 0, padding: 0 } });

interface TimelineProps {
  organizationId: string;
  opportunityId?: string;
  contractId?: string;
  title?: string;
  selection?: ActivitySelection;
  navigationKey?: string;
  onShowAll?: () => void;
}

/** Exact selection and editor lifetimes follow the customer, URL and signed-in employee. */
export function ActivityTimeline(props: TimelineProps) {
  const user = useCurrentUser();
  if (!user.permissions.includes(Permissions.activitiesRead)) return null;
  const scopeKey = JSON.stringify([user.id, [...user.permissions].sort(), props.organizationId, props.opportunityId,
    props.contractId, props.selection ?? { kind: 'all' }, props.navigationKey]);
  return <Timeline key={scopeKey} {...props} scopeKey={scopeKey} canWrite={user.permissions.includes(Permissions.activitiesWrite)} />;
}

function Timeline({ organizationId, opportunityId, contractId, title, selection = { kind: 'all' }, onShowAll, scopeKey, canWrite }: TimelineProps & {
  scopeKey: string;
  canWrite: boolean;
}) {
  const styles = useStyles(); const { t } = useTranslation(); const notify = useNotify();
  const [ticketRefreshing, setTicketRefreshing] = useState(false);
  const ticketCloseFocus = useRef<HTMLButtonElement>(null);
  const actions = useActivityActions(); const restoreFocusTarget = useRestoreFocusTarget();
  const filters = { organizationId, opportunityId, contractId };
  const activities = useActivities(filters, selection.kind === 'all', undefined, scopeKey);
  const selected = useSelectedActivity(filters, selection, scopeKey);
  const focused = selection.kind !== 'all';
  const error = focused ? selected.error : activities.error;
  const errorUpdatedAt = focused ? selected.errorUpdatedAt : activities.errorUpdatedAt;
  const checking = ticketRefreshing || (focused ? selected.isFetching : activities.isPending);
  const data = ticketRefreshing ? [] : focused ? (!checking && !error && selected.data?.activity ? [selected.data.activity] : []) : activities.items;
  const missingRevision = focused ? selected.data?.missingRevision ?? 0 : 0;
  const refetch = focused ? selected.refetch : activities.refetch;
  const [dialog, setDialog] = useState<{ activity?: Activity; errorUpdatedAt: number; missingRevision: number } | null>(null);
  const editorOpen = dialog !== null && !error && dialog.errorUpdatedAt === errorUpdatedAt && dialog.missingRevision === missingRevision;
  const status = useActivityStatusCommands(actions, { restoreFocus: true, focusBlocked: editorOpen });
  const alive = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const heading = useRef<HTMLHeadingElement>(null); const alreadyFocused = useRef(false);
  const refreshing = useRef(false);
  const focusReadSettled = !(focused ? selected.isFetching : activities.isFetching);
  const focusReplacementPresent = data.some(activity => activity.id === status.focusRequest?.id && activity.status === status.focusRequest.status);
  useEffect(() => {
    const request = status.focusRequest;
    if (request && focusReadSettled && (error || !focusReplacementPresent)) status.discardFocus(request);
  }, [status, focusReadSettled, error, focusReplacementPresent]);
  useEffect(() => {
    if (focused && data.length === 1 && !alreadyFocused.current) {
      alreadyFocused.current = true; heading.current?.focus();
    }
  }, [focused, data.length]);
  const outlook = useOutlookStatus();
  const refreshSelected = async () => {
    if (checking || refreshing.current) return;
    refreshing.current = true; setDialog(null); status.clearConflicts();
    try { await selected.refetch(); }
    finally { refreshing.current = false; }
  };
  const refreshAfterTicket = () => {
    if (refreshing.current) return;
    refreshing.current = true; setTicketRefreshing(true); setDialog(null); status.clearConflicts();
    void refetch().finally(() => { refreshing.current = false; if (alive.current) setTicketRefreshing(false); });
    queueMicrotask(() => { if (alive.current) ticketCloseFocus.current?.focus(); });
  };

  const reportFailure = (e: unknown) => { if (alive.current) notify(t('errors.generic'), 'error', errorMessage(e, t)); };
  const syncCalendar = async () => {
    try {
      const { data: result } = await actions.syncCalendar.mutateAsync();
      if (alive.current) notify(t('activities.calendarSynced', { updated: result.updated }));
    } catch (e) { reportFailure(e); }
  };
  const changeStatus = async (command: 'complete' | 'reopen', activity: Activity, trigger: HTMLButtonElement) => {
    const outcome = await status.run(command, activity, trigger);
    if (!alive.current) return;
    if (outcome.kind === 'success') notify(t(command === 'complete' ? 'activities.completed' : 'activities.reopened'));
    else if (outcome.kind === 'error') reportFailure(outcome.error);
  };
  const calendar = async (activity: Activity) => {
    try { await (activity.inCalendar ? actions.removeFromCalendar.mutateAsync(activity.id) : actions.addToCalendar.mutateAsync(activity.id)); }
    catch (e) { reportFailure(e); }
  };

  return <Panel title={title ?? t('activities.title')} actions={<>
    {selection.kind === 'selected' && <Button ref={ticketCloseFocus} size="small" disabled={checking} disabledFocusable={checking}
      onClick={() => void refreshSelected()}>{t('activities.refresh')}</Button>}
    {focused && <Button size="small" onClick={onShowAll}>{t('activities.showAll')}</Button>}
    {canWrite && !focused && <>
      {outlook.data?.calendar && <Button size="small" icon={<ArrowSync20Regular />} disabled={actions.syncCalendar.isPending}
        onClick={() => void syncCalendar()}>{t('activities.syncCalendar')}</Button>}
      <Button {...restoreFocusTarget} ref={ticketCloseFocus} size="small" icon={<Add20Regular />} onClick={() => setDialog({ errorUpdatedAt, missingRevision })}>{t('activities.log')}</Button>
    </>}
  </>}>
    {focused && <h3 ref={heading} tabIndex={-1}>{t('activities.selected')}</h3>}
    {selection.kind === 'invalid' ? <Text role="status">{t('activities.invalidLink')}</Text>
      : error ? <ErrorState error={error} onRetry={() => { setDialog(null); void (focused ? refreshSelected() : refetch()); }} />
      : <>
        {checking && <Spinner size="small" label={t('common.loading')} />}
        <ul className={styles.list}>
          {data.map(activity => <ActivityTimelineItem key={activity.id} activity={activity} selected={focused} canWrite={canWrite}
            calendar={outlook.data?.calendar === true} calendarPending={actions.addToCalendar.isPending || actions.removeFromCalendar.isPending}
            statusPending={status.pending.has(activity.id)} statusStale={status.isStale(activity)} focusRequest={status.focusRequest} onFocusReady={status.consumeFocus}
            onEdit={activity => setDialog({ activity, errorUpdatedAt, missingRevision })}
            onComplete={(activity, trigger) => void changeStatus('complete', activity, trigger)}
            onReopen={(activity, trigger) => void changeStatus('reopen', activity, trigger)} onCalendar={activity => void calendar(activity)} onTicketChanged={refreshAfterTicket} />)}
        </ul>
        {!checking && data.length === 0 && <EmptyState message={t(focused ? 'activities.selectedMissing' : 'activities.empty')} />}
        {!focused && !ticketRefreshing && <ListFooter shown={data.length} total={activities.total} hasMore={activities.hasNextPage}
          loading={activities.isFetchingNextPage} onMore={() => void activities.fetchNextPage()} />}
      </>}
    <ActivityDialog open={editorOpen}
      onClose={() => setDialog(null)} organizationId={organizationId} opportunityId={opportunityId} contractId={contractId} activity={dialog?.activity} />
  </Panel>;
}
