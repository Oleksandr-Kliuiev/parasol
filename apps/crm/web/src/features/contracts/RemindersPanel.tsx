import { Button, Skeleton, SkeletonItem, makeStyles } from '@fluentui/react-components';
import { AlertUrgent16Regular, CalendarCheckmark24Regular, CalendarClock16Regular, Timer16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ListFooter } from '../../shared/components/ListFooter';
import { Panel } from '../../shared/components/Panel';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDate, formatNumber } from '../../shared/utils/format';
import { RecordCell } from '../organizations/RecordCell';
import { useAcknowledgeReminder, useReminders } from './api';
import type { Reminder } from './types';

const useStyles = makeStyles({
  list: { listStyle: 'none', margin: 0, padding: 0 },
  // One reminder per row with a hairline between rows, the "Done" button on the right of its row.
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    minWidth: 0,
    paddingTop: '4px',
    paddingBottom: '4px',
    borderBottom: `1px solid ${h.line}`,
    ':last-child': { borderBottom: 'none' },
  },
  main: { flex: '1 1 auto', minWidth: 0 },
  // The button keeps its word on one line in the narrow side column of My day.
  done: { flexShrink: 0 },
});

const kindIcon = { HourBankLow: <Timer16Regular />, NoticeDeadline: <AlertUrgent16Regular />, ContractEnding: <CalendarClock16Regular /> } as const;
const kindTone = { HourBankLow: 'saffron', NoticeDeadline: 'ember', ContractEnding: 'iris' } as const;

/** Contract ends, notice deadlines and low hour banks assigned to the current user (FR-CON-04, BR-CON-05). */
export function RemindersPanel() {
  const styles = useStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const reminders = useReminders({ mine: true });
  const data = reminders.items;
  const acknowledge = useAcknowledgeReminder();
  // Acknowledging changes a shared record, so it needs the contract write right (the server enforces it).
  const canAcknowledge = useCan(Permissions.contractsWrite);

  const done = async (reminder: Reminder) => {
    try {
      await acknowledge.mutateAsync(reminder.id);
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  const describe = (r: Reminder) => {
    if (r.kind === 'HourBankLow' && r.hourBank) {
      return {
        name: <AppLink to={`/contracts/hour-banks/${r.hourBank.id}`}>{t('myDay.reminderKinds.HourBankLow', { name: r.hourBank.name })}</AppLink>,
        meta: [r.organization.name, t('contracts.hourBanks.remainingOf', { remaining: formatNumber(r.hourBank.remainingHours), purchased: formatNumber(r.hourBank.purchasedHours) })],
      };
    }
    if (r.contract) {
      return {
        name: (
          <AppLink to={`/contracts/${r.contract.id}`}>
            {r.kind === 'NoticeDeadline'
              ? t('myDay.reminderKinds.NoticeDeadline', { number: r.contract.number, date: formatDate(r.dueDate) })
              : t('myDay.reminderKinds.ContractEnding', { number: r.contract.number, date: formatDate(r.contract.endDate), days: r.daysBefore })}
          </AppLink>
        ),
        meta: [r.organization.name, r.contract.title, r.contract.autoRenew && r.kind === 'ContractEnding' && t('contracts.autoRenews')],
      };
    }
    return { name: r.organization.name, meta: [] };
  };

  return (
    <Panel title={t('myDay.reminders')} icon={<CalendarClock16Regular />}>
      {reminders.isPending && (
        <Skeleton aria-label={t('common.loading')}>
          <SkeletonItem />
          <SkeletonItem />
          <SkeletonItem />
        </Skeleton>
      )}
      {!reminders.isPending && data.length === 0 && <EmptyState compact icon={<CalendarCheckmark24Regular />} message={t('myDay.remindersEmpty')} />}
      {data.length > 0 && (
        <ul className={`${styles.list} h-stagger`}>
          {data.map((r) => {
            const { name, meta } = describe(r);
            return (
              <li key={r.id} className={styles.row}>
                <span className={styles.main}>
                  <RecordCell icon={kindIcon[r.kind]} tone={kindTone[r.kind]} name={name} meta={meta} />
                </span>
                {canAcknowledge && (
                  <Button
                    className={styles.done}
                    size="small"
                    appearance="subtle"
                    onClick={() => void done(r)}
                    aria-label={t('myDay.acknowledgeNamed', { name: (r.kind === 'HourBankLow' ? r.hourBank?.name : r.contract?.number) ?? r.organization.name })}
                  >
                    {t('myDay.acknowledge')}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <ListFooter shown={data.length} total={reminders.total} hasMore={reminders.hasNextPage} loading={reminders.isFetchingNextPage} onMore={() => void reminders.fetchNextPage()} />
    </Panel>
  );
}
