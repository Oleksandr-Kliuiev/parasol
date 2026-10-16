import { useState } from 'react';
import { Badge, Button, Dialog, DialogSurface, Text, makeStyles, tokens, useRestoreFocusTarget } from '@fluentui/react-components';
import { Add20Regular, ChevronLeft20Regular, ChevronRight20Regular, Delete20Regular, Edit20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { Panel } from '../../shared/components/Panel';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDate, formatNumber, todayIso } from '../../shared/utils/format';
import { AppLink } from '../../shared/components/AppLink';
import { useAllTimeEntries, useTimeActions } from './api';
import { TimeEntryDialog } from './TimeEntryDialog';
import type { TimeEntry } from './types';

const useStyles = makeStyles({
  toolbar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: tokens.spacingHorizontalM, marginBottom: tokens.spacingVerticalM },
  week: { fontWeight: tokens.fontWeightSemibold, fontVariantNumeric: 'tabular-nums' },
  spacer: { flex: 1 },
  days: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  dayHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: tokens.spacingHorizontalM },
  entry: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingBlock: tokens.spacingVerticalS,
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
    ':last-child': { borderBottom: 'none' },
  },
  hours: { fontVariantNumeric: 'tabular-nums', fontWeight: tokens.fontWeightSemibold, minWidth: '56px' },
  muted: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  list: { listStyle: 'none', margin: 0, padding: 0 },
  actions: { display: 'flex', gap: tokens.spacingHorizontalXS, marginInlineStart: 'auto' },
});

function startOfWeek(iso: string): string {
  const date = new Date(`${iso}T12:00:00Z`);
  const weekday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - weekday);
  return date.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The week a technician books their own hours in (FR-TIM-02). */
export function TimesheetPage() {
  const styles = useStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const actions = useTimeActions();
  const [monday, setMonday] = useState(() => startOfWeek(todayIso()));
  const [dialog, setDialog] = useState<{ entry?: TimeEntry; date?: string } | null>(null);
  const restoreFocusTarget = useRestoreFocusTarget();
  const sunday = addDays(monday, 6);
  // A week is short: all of it is loaded, page after page, so no day misses an entry (DEV-12).
  const { data, error, isPending, refetch } = useAllTimeEntries({ from: monday, to: sunday, mine: true });
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));

  const remove = async (entry: TimeEntry) => {
    try {
      await actions.remove.mutateAsync(entry.id);
      notify(t('time.deleted'));
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
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
      <div className={styles.toolbar}>
        <Button icon={<ChevronLeft20Regular />} aria-label={t('time.previousWeek')} onClick={() => setMonday(addDays(monday, -7))} />
        <span className={styles.week}>
          {formatDate(monday)} – {formatDate(sunday)}
        </span>
        <Button icon={<ChevronRight20Regular />} aria-label={t('time.nextWeek')} onClick={() => setMonday(addDays(monday, 7))} />
        <Button onClick={() => setMonday(startOfWeek(todayIso()))}>{t('time.thisWeek')}</Button>
        <span className={styles.spacer} />
        <Text className={styles.muted}>
          {t('time.weekTotal', { hours: formatNumber(data?.summary.hours ?? 0) })} · {t('time.billableTotal', { hours: formatNumber(data?.summary.billableHours ?? 0) })}
        </Text>
      </div>

      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <div className={styles.days}>
          {days.map((day) => {
            const entries = (data?.items ?? []).filter((e) => e.workDate === day);
            const total = entries.reduce((sum, e) => sum + e.hours, 0);
            return (
              <Panel key={day} title={formatDate(day)}>
                <div className={styles.dayHead}>
                  <Text className={styles.muted}>{t('time.dayTotal', { hours: formatNumber(total) })}</Text>
                  <Button size="small" icon={<Add20Regular />} appearance="subtle" onClick={() => setDialog({ date: day })} aria-label={t('time.registerOn', { date: formatDate(day) })}>
                    {t('time.register')}
                  </Button>
                </div>
                <ul className={styles.list}>
                  {entries.map((entry) => (
                    <li key={entry.id} className={styles.entry}>
                      <span className={styles.hours}>{formatNumber(entry.hours)} {t('contracts.hoursShort')}</span>
                      <AppLink to={`/organizations/${entry.organizationId}`}>{entry.organizationName}</AppLink>
                      <span>{entry.description ?? entry.ticketTitle}</span>
                      {entry.workType && <Badge appearance="outline">{entry.workType}</Badge>}
                      {!entry.billable && <Badge appearance="tint" color="subtle">{t('time.nonBillable')}</Badge>}
                      {entry.source === 'Atera' && <Badge appearance="tint" color="informative">Atera</Badge>}
                      <Badge appearance="outline" color={entry.status === 'New' ? 'brand' : 'success'}>
                        {t(`time.statuses.${entry.status}`)}
                      </Badge>
                      {entry.source === 'Crm' && entry.status === 'New' && !entry.isLocked && (
                        <span className={styles.actions}>
                          <Button {...restoreFocusTarget} size="small" appearance="subtle" icon={<Edit20Regular />} aria-label={t('time.editNamed', { hours: formatNumber(entry.hours) })} onClick={() => setDialog({ entry })} />
                          <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label={t('time.deleteNamed', { hours: formatNumber(entry.hours) })} onClick={() => void remove(entry)} />
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                {entries.length === 0 && !isPending && <EmptyState message={t('time.noEntriesDay')} />}
              </Panel>
            );
          })}
        </div>
      )}

      <Dialog open={dialog !== null} onOpenChange={(_, d) => !d.open && setDialog(null)}>
        <DialogSurface>{dialog !== null && <TimeEntryDialog entry={dialog.entry} defaultDate={dialog.date} onClose={() => setDialog(null)} />}</DialogSurface>
      </Dialog>
    </>
  );
}
