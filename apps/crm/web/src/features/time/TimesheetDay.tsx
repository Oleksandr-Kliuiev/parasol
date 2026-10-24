import { useId } from 'react';
import { Badge, Button, Text, makeStyles, mergeClasses, tokens, useRestoreFocusTarget, type BadgeProps } from '@fluentui/react-components';
import { Add20Regular, Delete20Regular, Edit20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { CompactControls } from '../../app/hearthStyles';
import { localeOf } from '../../i18n';
import { AppLink } from '../../shared/components/AppLink';
import { formatDate, formatNumber } from '../../shared/utils/format';
import type { TimeEntry, TimeEntryStatus } from './types';

const useStyles = makeStyles({
  // One day of the week: a date tile, the day in display type with its total, then the entries as quiet rows.
  day: {
    display: 'grid',
    gridTemplateColumns: '44px minmax(0, 1fr)',
    columnGap: '14px',
    rowGap: '8px',
    paddingTop: '14px',
    paddingBottom: '14px',
    paddingLeft: '20px',
    paddingRight: '20px',
    borderTop: `1px solid ${h.line}`,
    ':first-child': { borderTop: 'none' },
    '@media (max-width: 600px)': { columnGap: '12px', paddingLeft: '16px', paddingRight: '16px' },
  },
  date: {
    display: 'grid',
    placeItems: 'center',
    alignContent: 'center',
    width: '44px',
    height: '44px',
    borderRadius: '12px',
    backgroundColor: h.well,
    color: h.muted,
  },
  today: { backgroundColor: h.emberSoft, color: h.emberT },
  weekday: { fontSize: '12px', lineHeight: '14px', fontWeight: tokens.fontWeightSemibold, textTransform: 'uppercase', letterSpacing: '0.04em' },
  dayNumber: { fontFamily: h.display, fontSize: '18px', lineHeight: '20px', fontWeight: 600, color: h.text, fontVariantNumeric: 'tabular-nums' },
  todayNumber: { color: h.emberT },
  // Title, the quiet "no hours" line and the action on one line; on a phone the action stays beside the title.
  head: {
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr) auto',
    gridTemplateAreas: '"title empty action"',
    alignItems: 'center',
    columnGap: '12px',
    rowGap: '2px',
    minHeight: '44px',
    minWidth: 0,
    '@media (max-width: 600px)': { gridTemplateColumns: 'minmax(0, 1fr) auto', gridTemplateAreas: '"title action" "empty action"' },
  },
  title: { gridArea: 'title', display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: '8px', rowGap: '2px', minWidth: 0 },
  heading: {
    margin: 0,
    fontFamily: h.display,
    fontSize: '16px',
    lineHeight: '22px',
    fontWeight: 600,
    letterSpacing: '-0.01em',
    '&::first-letter': { textTransform: 'uppercase' },
  },
  dateText: { color: h.muted, fontSize: '13px', fontVariantNumeric: 'tabular-nums' },
  empty: { gridArea: 'empty', color: h.faint, fontSize: '13px' },
  register: { gridArea: 'action', justifySelf: 'end' },
  // Below 480 px the action keeps its icon and its accessible name; the words would push the day to two lines.
  registerText: { '@media (max-width: 480px)': { display: 'none' } },
  list: { gridColumn: '2', listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '6px', minWidth: 0,
    '@media (max-width: 600px)': { gridColumn: '1 / -1' } },
  entry: {
    display: 'grid',
    gridTemplateColumns: '64px minmax(0, 1fr) auto',
    alignItems: 'center',
    columnGap: '12px',
    rowGap: '6px',
    minHeight: '48px',
    paddingTop: '8px',
    paddingBottom: '8px',
    paddingLeft: '12px',
    paddingRight: '8px',
    borderRadius: '12px',
    backgroundColor: h.well,
    minWidth: 0,
    '@media (max-width: 600px)': { gridTemplateColumns: '52px minmax(0, 1fr)', '& > :last-child': { gridColumn: '1 / -1' } },
  },
  hours: { fontFamily: h.display, fontSize: '16px', fontWeight: 600, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  work: { display: 'grid', gap: '2px', minWidth: 0, overflowWrap: 'anywhere' },
  org: { fontWeight: tokens.fontWeightSemibold },
  description: { color: h.muted, fontSize: '13px', lineHeight: '18px' },
  side: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: '6px', minWidth: 0,
    '@media (max-width: 600px)': { justifyContent: 'flex-start' } },
  // Edit and Delete sit apart: a slip of the pointer must not land on the other one.
  actions: { display: 'flex', gap: '8px' },
});

// The same tones as the dots of the entries list: new work is iris, approved spruce, the rest quiet.
const statusColor: Record<TimeEntryStatus, BadgeProps['color']> = { New: 'informative', Approved: 'success', NonBillable: 'subtle', Invoiced: 'subtle' };

const weekdayOf = (iso: string, language: string, weekday: 'short' | 'long') =>
  new Intl.DateTimeFormat(localeOf(language), { weekday, timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`));

interface TimesheetDayProps {
  day: string;
  today: boolean;
  entries: TimeEntry[];
  loading: boolean;
  onRegister: (date: string) => void;
  onEdit: (entry: TimeEntry) => void;
  onRemove: (entry: TimeEntry) => void;
}

/** A day of the timesheet; a day without hours is one quiet line with its register action. */
export function TimesheetDay({ day, today, entries, loading, onRegister, onEdit, onRemove }: TimesheetDayProps) {
  const styles = useStyles();
  const { t, i18n } = useTranslation();
  const restoreFocusTarget = useRestoreFocusTarget();
  const headingId = useId();
  const total = entries.reduce((sum, e) => sum + e.hours, 0);
  return (
    <section className={styles.day} aria-labelledby={headingId}>
      <span className={mergeClasses(styles.date, today && styles.today)} aria-hidden>
        <span className={styles.weekday}>{weekdayOf(day, i18n.language, 'short').replace('.', '')}</span>
        <span className={mergeClasses(styles.dayNumber, today && styles.todayNumber)}>{Number(day.slice(8, 10))}</span>
      </span>
      <div className={styles.head}>
        <div className={styles.title}>
          <h2 id={headingId} className={styles.heading}>
            {weekdayOf(day, i18n.language, 'long')} <span className={styles.dateText}>{formatDate(day)}</span>
          </h2>
          <Badge appearance="tint" color={total > 0 ? 'success' : 'subtle'}>{t('time.dayTotal', { hours: formatNumber(total) })}</Badge>
        </div>
        {entries.length === 0 && !loading && <Text className={styles.empty}>{t('time.noEntriesDay')}</Text>}
        <CompactControls.Provider value>
          <Button {...restoreFocusTarget} id={`register-${day}`} className={styles.register} icon={<Add20Regular />} appearance="subtle" onClick={() => onRegister(day)}
            aria-label={t('time.registerOn', { date: formatDate(day) })}>
            <span className={styles.registerText}>{t('time.register')}</span>
          </Button>
        </CompactControls.Provider>
      </div>
      {entries.length > 0 && (
        <ul className={styles.list}>
          {entries.map((entry) => (
            <li key={entry.id} className={styles.entry}>
              <span className={styles.hours}>{formatNumber(entry.hours)} {t('contracts.hoursShort')}</span>
              <span className={styles.work}>
                <AppLink to={`/organizations/${entry.organizationId}`} className={styles.org}>{entry.organizationName}</AppLink>
                {(entry.description ?? entry.ticketTitle) && <span className={styles.description}>{entry.description ?? entry.ticketTitle}</span>}
              </span>
              <span className={styles.side}>
                {entry.workType && <Badge appearance="outline">{entry.workType}</Badge>}
                {!entry.billable && entry.status !== 'NonBillable' && <Badge appearance="tint" color="subtle">{t('time.nonBillable')}</Badge>}
                {entry.source === 'Atera' && <Badge appearance="tint" color="informative">Atera</Badge>}
                <Badge appearance="tint" color={statusColor[entry.status]}>{t(`time.statuses.${entry.status}`)}</Badge>
                {entry.source === 'Crm' && entry.status === 'New' && !entry.isLocked && (
                  <span className={styles.actions}>
                    <Button {...restoreFocusTarget} size="small" appearance="subtle" icon={<Edit20Regular />}
                      aria-label={t('time.editNamed', { hours: formatNumber(entry.hours), organization: entry.organizationName, date: formatDate(day) })} onClick={() => onEdit(entry)} />
                    <Button {...restoreFocusTarget} size="small" appearance="subtle" icon={<Delete20Regular />}
                      aria-label={t('time.deleteNamed', { hours: formatNumber(entry.hours), organization: entry.organizationName, date: formatDate(day) })} onClick={() => onRemove(entry)} />
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
