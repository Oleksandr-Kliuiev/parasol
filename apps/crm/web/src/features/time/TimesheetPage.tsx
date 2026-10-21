import { useState } from 'react';
import { Button, Text, makeStyles, useRestoreFocusTarget } from '@fluentui/react-components';
import { Add20Regular, CheckmarkCircle20Regular, ChevronLeft20Regular, ChevronRight20Regular, Clock20Regular, MoneyOff20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { cardSurface, h } from '../../app/hearth';
import { localeOf } from '../../i18n';
import { ConfirmDialog } from '../../shared/components/ConfirmDialog';
import { StatGrid, StatTile } from '../../shared/components/KpiTile';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { Toolbar } from '../../shared/components/Toolbar';
import { useKeptWhileClosing } from '../../shared/components/useKeptWhileClosing';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDate, formatNumber, todayIso } from '../../shared/utils/format';
import { addDays, startOfWeek } from '../../shared/utils/week';
import { useCurrentUser } from '../../auth/CurrentUserContext';
import { ActionDetailDialog } from '../actions/ActionDetailDialog';
import { ActionDialog } from '../actions/ActionDialog';
import { useAction, useActionAvailable, useActionFacts } from '../actions/api';
import { useAllTimeEntries, useTimeActions } from './api';
import { TimeEntryDialogHost } from './TimeEntryDialog';
import { TimesheetDay, type AteraRecording } from './TimesheetDay';
import type { TimeEntry } from './types';

const useStyles = makeStyles({
  // The week switcher of the reference calendar: arrows around the week, then "This week". The week is named by its
  // number (how Norwegian offices talk about it) with its days under it, so the bar stays one line on a phone.
  toolbar: { flexWrap: 'nowrap' },
  range: {
    display: 'grid',
    justifyItems: 'center',
    minWidth: '168px',
    '@media (max-width: 480px)': { minWidth: 0, flex: '1 1 0' },
  },
  weekNumber: { fontFamily: h.display, fontSize: '16px', lineHeight: '20px', fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
  days: { color: h.muted, fontSize: '12.5px', lineHeight: '18px', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  // Three figures of the week in one row; on a phone the third takes the whole second row instead of half of it.
  stats: {
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    '@media (max-width: 560px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', '& > :nth-child(3)': { gridColumn: '1 / -1' } },
  },
  week: { ...cardSurface, overflow: 'hidden', minWidth: 0 },
});

/** The ISO week number of a Monday (YYYY-MM-DD): the week that holds that year's 4 January is week 1. */
function isoWeek(monday: string): number {
  const thursday = new Date(`${monday}T12:00:00Z`);
  thursday.setUTCDate(thursday.getUTCDate() + 3);
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4, 12));
  firstThursday.setUTCDate(firstThursday.getUTCDate() + 3 - ((firstThursday.getUTCDay() + 6) % 7));
  return 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
}

/** "19–25 Oct 2026" in the interface language. */
const weekDays = (monday: string, sunday: string, language: string) =>
  new Intl.DateTimeFormat(localeOf(language), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    .formatRange(new Date(`${monday}T12:00:00Z`), new Date(`${sunday}T12:00:00Z`));

/** The week a technician books their own hours in (FR-TIM-02). */
export function TimesheetPage() {
  const styles = useStyles();
  const { t, i18n } = useTranslation();
  const notify = useNotify();
  const actions = useTimeActions();
  const [monday, setMonday] = useState(() => startOfWeek(todayIso()));
  const [dialog, setDialog] = useState<{ entry?: TimeEntry; date?: string } | null>(null);
  const shown = useKeptWhileClosing(dialog);
  const [removing, setRemoving] = useState<TimeEntry | null>(null);
  const shownRemoval = useKeptWhileClosing(removing);
  const restoreFocusTarget = useRestoreFocusTarget();
  const sunday = addDays(monday, 6);
  // A week is short: all of it is loaded, page after page, so no day misses an entry (DEV-12).
  const { data, error, isPending, refetch } = useAllTimeEntries({ from: monday, to: sunday, mine: true });
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const today = todayIso();
  const waiting = (data?.items ?? []).filter((e) => e.status === 'New').length;
  const hoursText = (hours: number | undefined) => (hours === undefined ? t('myDay.loadingValue') : t('myDay.kpi.hoursValue', { hours: formatNumber(hours) }));

  // M39: the person's own Parasoll entries on a ticket can be recorded in Atera later; what Atera has of them is read for the week
  // in one lookup (per 50 entries), and a recording without a clear answer is checked from its card.
  const user = useCurrentUser();
  const onTickets = (data?.items ?? []).filter((e) => e.source === 'Crm' && e.externalTicketId !== null && e.technicianId === user.id);
  const recordings = useActionFacts('atera', 'time-entry', [onTickets.map((e) => e.id)]);
  const recordAvailable = useActionAvailable('atera', 'time.record', onTickets.length > 0);
  const [recording, setRecording] = useState<TimeEntry | null>(null);
  const shownRecording = useKeptWhileClosing(recording);
  const [checking, setChecking] = useState<string | null>(null);
  const checked = useAction(checking).data ?? null;
  const atera: AteraRecording = { facts: recordings.facts, available: recordAvailable, onRecord: setRecording, onCheck: setChecking };

  // Deleting an entry cannot be undone, so it asks first; the day's register button then takes the focus the row had.
  const remove = async () => {
    if (!removing) return;
    try {
      await actions.remove.mutateAsync(removing.id);
      setRemoving(null);
      notify(t('time.deleted'));
      document.getElementById(`register-${removing.workDate}`)?.focus();
    } catch {
      // The dialog stays and says why.
    }
  };

  return (
    <>
      <PageHeader
        title={t('time.myTimesheet')}
        subtitle={t('time.myTimesheetSubtitle')}
        actions={
          <Button {...restoreFocusTarget} appearance="primary" icon={<Add20Regular />} onClick={() => setDialog({ date: todayIso() })}>
            {t('time.register')}
          </Button>
        }
      />
      <Toolbar className={styles.toolbar}>
        <Button icon={<ChevronLeft20Regular />} aria-label={t('time.previousWeek')} onClick={() => setMonday(addDays(monday, -7))} />
        <span className={styles.range}>
          <span className={styles.weekNumber}>{t('time.weekNumber', { week: isoWeek(monday) })}</span>
          <span className={styles.days}>{weekDays(monday, sunday, i18n.language)}</span>
        </span>
        <Button icon={<ChevronRight20Regular />} aria-label={t('time.nextWeek')} onClick={() => setMonday(addDays(monday, 7))} />
        <Button onClick={() => setMonday(startOfWeek(todayIso()))}>{t('time.thisWeek')}</Button>
      </Toolbar>

      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <>
          <StatGrid className={styles.stats}>
            <StatTile icon={<Clock20Regular />} tone="ember" label={t('time.fields.hours')} value={hoursText(data?.summary.hours)}
              note={t('time.billableTotal', { hours: formatNumber(data?.summary.billableHours ?? 0) })} />
            <StatTile icon={<CheckmarkCircle20Regular />} tone="spruce" label={t('time.statuses.Approved')} value={hoursText(data?.summary.approvedHours)}
              note={t('time.pendingCount', { count: waiting })} />
            <StatTile icon={<MoneyOff20Regular />} label={t('time.nonBillable')}
              value={hoursText(data ? data.summary.hours - data.summary.billableHours : undefined)} />
          </StatGrid>
          <div className={styles.week}>
            {days.map((day) => (
              <TimesheetDay key={day} day={day} today={day === today} entries={(data?.items ?? []).filter((e) => e.workDate === day)}
                loading={isPending} atera={atera} onRegister={(date) => setDialog({ date })} onEdit={(entry) => setDialog({ entry })} onRemove={setRemoving} />
            ))}
          </div>
        </>
      )}

      <ConfirmDialog open={removing !== null} busy={actions.remove.isPending}
        title={t('time.deleteTitle', { hours: formatNumber(shownRemoval?.hours ?? 0), organization: shownRemoval?.organizationName ?? '', date: formatDate(shownRemoval?.workDate) })}
        confirm={t('time.deleteConfirm')} error={actions.remove.error ? errorMessage(actions.remove.error, t) : null}
        onConfirm={() => void remove()} onCancel={() => { setRemoving(null); actions.remove.reset(); }}>
        {t('time.deleteBody')}
      </ConfirmDialog>
      <TimeEntryDialogHost open={dialog !== null} entry={shown?.entry} defaultDate={shown?.date} onClose={() => setDialog(null)} />
      <ActionDialog
        request={recording ? { system: 'atera', kind: 'time.record', targetType: 'time-entry', targetId: recording.id, parameters: {} } : null}
        title={t('time.recordTitle', { number: `#${shownRecording?.externalTicketId ?? ''}` })} confirm={t('time.recordConfirm')}
        details={<Text block>{t('time.recordLater')}</Text>} onClose={() => setRecording(null)} />
      <ActionDetailDialog action={checking !== null && checked?.id === checking ? checked : null} onClose={() => setChecking(null)} />
    </>
  );
}
