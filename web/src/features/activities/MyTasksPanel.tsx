import { Button, Text, makeStyles, tokens } from '@fluentui/react-components';
import { CheckmarkCircle20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { AppLink } from '../../shared/components/AppLink';
import { Panel } from '../../shared/components/Panel';
import { ListFooter } from '../../shared/components/ListFooter';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDateTime } from '../../shared/utils/format';
import { useActivities, useActivityActions } from './api';

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
  text: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 },
  muted: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  overdue: { color: tokens.colorPaletteRedForeground1, fontSize: tokens.fontSizeBase200 },
});

/** Open tasks and meetings assigned to the signed-in user (FR-ACT-01, "My day"). */
export function MyTasksPanel() {
  const styles = useStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const actions = useActivityActions();
  // The ten due first, and the rest on request: the panel says how many open tasks there are (DEV-12).
  const tasks = useActivities({ mine: true, open: true }, true, 10);
  const { items: data, isPending } = tasks;

  const complete = async (id: string, subject: string) => {
    try {
      await actions.complete.mutateAsync(id);
      notify(t('activities.completedNamed', { subject }));
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  return (
    <Panel title={t('myDay.myTasks')}>
      {!isPending && data.length === 0 && <Text className={styles.muted}>{t('myDay.myTasksEmpty')}</Text>}
      <ul className={styles.list}>
        {data.map((activity) => (
          <li key={activity.id} className={styles.row}>
            <span className={styles.text}>
              <Text weight="semibold">{activity.subject}</Text>
              <span className={activity.isOverdue ? styles.overdue : styles.muted}>
                <AppLink to={`/organizations/${activity.organizationId}`}>{activity.organizationName}</AppLink>
                {activity.dueAt ? ` · ${t(activity.isOverdue ? 'activities.overdueAt' : 'activities.dueAt', { at: formatDateTime(activity.dueAt) })}` : ''}
              </span>
            </span>
            <Button
              size="small"
              appearance="subtle"
              icon={<CheckmarkCircle20Regular />}
              aria-label={t('activities.completeNamed', { subject: activity.subject })}
              onClick={() => void complete(activity.id, activity.subject)}
            />
          </li>
        ))}
      </ul>
      <ListFooter shown={data.length} total={tasks.total} hasMore={tasks.hasNextPage} loading={tasks.isFetchingNextPage} onMore={() => void tasks.fetchNextPage()} />
    </Panel>
  );
}
