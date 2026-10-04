import { Button, Text, makeStyles, tokens } from '@fluentui/react-components';
import { AlertUrgent20Regular, CalendarClock20Regular, Timer20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { AppLink } from '../../shared/components/AppLink';
import { ListFooter } from '../../shared/components/ListFooter';
import { Panel } from '../../shared/components/Panel';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDate, formatNumber } from '../../shared/utils/format';
import { useAcknowledgeReminder, useReminders } from './api';
import type { Reminder } from './types';

const useStyles = makeStyles({
  list: { listStyle: 'none', margin: 0, padding: 0 },
  row: {
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr) auto',
    gap: tokens.spacingHorizontalS,
    alignItems: 'start',
    paddingBlock: tokens.spacingVerticalS,
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
    ':last-child': { borderBottom: 'none' },
  },
  icon: { color: tokens.colorPaletteDarkOrangeForeground1, paddingTop: '2px' },
  text: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  muted: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
});

/** Contract ends, notice deadlines and low hour banks assigned to the current user (FR-CON-04, BR-CON-05). */
export function RemindersPanel() {
  const styles = useStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const reminders = useReminders({ mine: true });
  const data = reminders.items;
  const acknowledge = useAcknowledgeReminder();

  const done = async (reminder: Reminder) => {
    try {
      await acknowledge.mutateAsync(reminder.id);
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  return (
    <Panel title={t('myDay.reminders')}>
      {!reminders.isPending && data.length === 0 && <Text className={styles.muted}>{t('myDay.remindersEmpty')}</Text>}
      <ul className={styles.list}>
        {data.map((r) => (
          <li key={r.id} className={styles.row}>
            <span className={styles.icon} aria-hidden>
              {r.kind === 'HourBankLow' ? <Timer20Regular /> : r.kind === 'NoticeDeadline' ? <AlertUrgent20Regular /> : <CalendarClock20Regular />}
            </span>
            <span className={styles.text}>
              {r.kind === 'HourBankLow' && r.hourBank ? (
                <>
                  <AppLink to={`/contracts/hour-banks/${r.hourBank.id}`}>{t('myDay.reminderKinds.HourBankLow', { name: r.hourBank.name })}</AppLink>
                  <span className={styles.muted}>
                    {r.organization.name} · {t('contracts.hourBanks.remainingOf', { remaining: formatNumber(r.hourBank.remainingHours), purchased: formatNumber(r.hourBank.purchasedHours) })}
                  </span>
                </>
              ) : r.contract ? (
                <>
                  <AppLink to={`/contracts/${r.contract.id}`}>
                    {r.kind === 'NoticeDeadline'
                      ? t('myDay.reminderKinds.NoticeDeadline', { number: r.contract.number, date: formatDate(r.dueDate) })
                      : t('myDay.reminderKinds.ContractEnding', { number: r.contract.number, date: formatDate(r.contract.endDate), days: r.daysBefore })}
                  </AppLink>
                  <span className={styles.muted}>
                    {r.organization.name} · {r.contract.title}
                    {r.contract.autoRenew && r.kind === 'ContractEnding' ? ` · ${t('contracts.autoRenews')}` : ''}
                  </span>
                </>
              ) : (
                <span>{r.organization.name}</span>
              )}
            </span>
            <Button size="small" appearance="subtle" onClick={() => void done(r)} aria-label={t('myDay.acknowledgeNamed', { name: (r.kind === 'HourBankLow' ? r.hourBank?.name : r.contract?.number) ?? r.organization.name })}>
              {t('myDay.acknowledge')}
            </Button>
          </li>
        ))}
      </ul>
      <ListFooter shown={data.length} total={reminders.total} hasMore={reminders.hasNextPage} loading={reminders.isFetchingNextPage} onMore={() => void reminders.fetchNextPage()} />
    </Panel>
  );
}
