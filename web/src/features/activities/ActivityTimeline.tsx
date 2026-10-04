import { useState } from 'react';
import { Badge, Button, Link, Text, makeStyles, tokens, useRestoreFocusTarget } from '@fluentui/react-components';
import { Add20Regular, ArrowSync20Regular, CalendarLtr16Regular, CheckmarkCircle20Regular, Edit20Regular, Open16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { EmptyState } from '../../shared/components/EmptyState';
import { ListFooter } from '../../shared/components/ListFooter';
import { ErrorState } from '../../shared/components/ErrorState';
import { Panel } from '../../shared/components/Panel';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDateTime } from '../../shared/utils/format';
import { useActivities, useActivityActions, useOutlookStatus } from './api';
import { ActivityDialog } from './ActivityDialog';
import type { Activity } from './types';

const useStyles = makeStyles({
  list: { listStyle: 'none', margin: 0, padding: 0 },
  item: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    gap: tokens.spacingHorizontalS,
    paddingBlock: tokens.spacingVerticalS,
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
    ':last-child': { borderBottom: 'none' },
  },
  head: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: tokens.spacingHorizontalS },
  body: { whiteSpace: 'pre-wrap', color: tokens.colorNeutralForeground2, fontSize: tokens.fontSizeBase200 },
  meta: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  overdue: { color: tokens.colorPaletteRedForeground1, fontSize: tokens.fontSizeBase200 },
  done: { color: tokens.colorNeutralForeground3 },
  // Tinted and brand-coloured badges do not keep their contrast in the dark theme, so priority is plain text.
  high: { color: tokens.colorPaletteDarkOrangeForeground1, fontSize: tokens.fontSizeBase200, fontWeight: tokens.fontWeightSemibold },
  actions: { display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'start' },
});

/** Tasks, calls, meetings and notes about one customer, deal or contract, newest open first. */
export function ActivityTimeline({
  organizationId,
  opportunityId,
  contractId,
  title,
}: {
  organizationId: string;
  opportunityId?: string;
  contractId?: string;
  title?: string;
}) {
  const styles = useStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const canWrite = useCan(Permissions.activitiesWrite);
  const actions = useActivityActions();
  const [dialog, setDialog] = useState<{ activity?: Activity } | null>(null);
  const restoreFocusTarget = useRestoreFocusTarget();
  const activities = useActivities({ organizationId, opportunityId, contractId });
  const { items: data, error, isPending, refetch } = activities;
  const outlook = useOutlookStatus();

  const syncCalendar = async () => {
    try {
      const { data: result } = await actions.syncCalendar.mutateAsync();
      notify(t('activities.calendarSynced', { updated: result.updated }));
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  const complete = async (activity: Activity) => {
    try {
      await actions.complete.mutateAsync(activity.id);
      notify(t('activities.completed'));
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  return (
    <Panel
      title={title ?? t('activities.title')}
      actions={
        canWrite && (
          <>
            {outlook.data?.calendar && (
              <Button
                size="small"
                icon={<ArrowSync20Regular />}
                disabled={actions.syncCalendar.isPending}
                onClick={() => void syncCalendar()}
              >
                {t('activities.syncCalendar')}
              </Button>
            )}
            <Button {...restoreFocusTarget} size="small" icon={<Add20Regular />} onClick={() => setDialog({})}>
              {t('activities.log')}
            </Button>
          </>
        )
      }
    >
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <>
          <ul className={styles.list}>
            {data.map((activity) => (
              <li key={activity.id} className={styles.item}>
                <span>
                  <span className={styles.head}>
                    <Badge appearance="outline" color={activity.status === 'Open' ? 'informative' : 'subtle'}>
                      {t(`activities.types.${activity.type}`)}
                    </Badge>
                    <Text weight="semibold" className={activity.status === 'Done' ? styles.done : undefined}>
                      {activity.subject}
                    </Text>
                    {activity.priority === 'High' && activity.status === 'Open' && (
                      <Text className={styles.high}>{t('activities.priorities.High')}</Text>
                    )}
                    {activity.inCalendar && (
                      <Badge appearance="outline" color="informative" icon={<CalendarLtr16Regular />}>
                        {t('activities.inCalendar')}
                      </Badge>
                    )}
                    {activity.webLink && (
                      <Link href={activity.webLink} target="_blank" rel="noopener noreferrer">
                        {t('activities.openInOutlook')}
                        <Open16Regular aria-hidden style={{ marginInlineStart: 4 }} />
                      </Link>
                    )}
                  </span>
                  {activity.body && <div className={styles.body}>{activity.body}</div>}
                  {activity.fromAddress && <div className={styles.meta}>{activity.fromAddress}</div>}
                  <div className={activity.isOverdue ? styles.overdue : styles.meta}>
                    {activity.dueAt
                      ? t(activity.isOverdue ? 'activities.overdueAt' : 'activities.dueAt', { at: formatDateTime(activity.dueAt) })
                      : t('activities.loggedAt', { at: formatDateTime(activity.createdAt) })}
                    {activity.assignee ? ` · ${activity.assignee.name}` : ''}
                    {activity.status === 'Done' && activity.completedAt ? ` · ${t('activities.doneAt', { at: formatDateTime(activity.completedAt) })}` : ''}
                  </div>
                </span>
                {canWrite && activity.type !== 'Email' && (
                  <span className={styles.actions}>
                    {activity.type === 'Meeting' && outlook.data?.calendar && (
                      <Button
                        size="small"
                        appearance="subtle"
                        icon={<CalendarLtr16Regular />}
                        aria-label={t(activity.inCalendar ? 'activities.removeFromCalendarNamed' : 'activities.addToCalendarNamed', { subject: activity.subject })}
                        disabled={actions.addToCalendar.isPending || actions.removeFromCalendar.isPending}
                        onClick={() =>
                          void (activity.inCalendar
                            ? actions.removeFromCalendar.mutateAsync(activity.id)
                            : actions.addToCalendar.mutateAsync(activity.id)
                          ).catch((e: unknown) => notify(t('errors.generic'), 'error', errorMessage(e, t)))
                        }
                      />
                    )}
                    {activity.status === 'Open' && (
                      <Button
                        size="small"
                        appearance="subtle"
                        icon={<CheckmarkCircle20Regular />}
                        aria-label={t('activities.completeNamed', { subject: activity.subject })}
                        onClick={() => void complete(activity)}
                      />
                    )}
                    <Button
                      {...restoreFocusTarget}
                      size="small"
                      appearance="subtle"
                      icon={<Edit20Regular />}
                      aria-label={t('activities.editNamed', { subject: activity.subject })}
                      onClick={() => setDialog({ activity })}
                    />
                  </span>
                )}
              </li>
            ))}
          </ul>
          {!isPending && data.length === 0 && <EmptyState message={t('activities.empty')} />}
          <ListFooter shown={data.length} total={activities.total} hasMore={activities.hasNextPage} loading={activities.isFetchingNextPage} onMore={() => void activities.fetchNextPage()} />
        </>
      )}
      <ActivityDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        organizationId={organizationId}
        opportunityId={opportunityId}
        contractId={contractId}
        activity={dialog?.activity}
      />
    </Panel>
  );
}
