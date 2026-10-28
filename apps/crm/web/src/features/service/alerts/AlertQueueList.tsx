import { useRef, useState, type ReactNode } from 'react';
import { Checkbox, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { AlertOn24Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { h } from '../../../app/hearth';
import { AppLink } from '../../../shared/components/AppLink';
import { EmptyState } from '../../../shared/components/EmptyState';
import { ScrollTable } from '../../../shared/components/ScrollTable';
import { useContainerWidth } from '../../../shared/utils/useContainerWidth';
import { NARROW_SCREEN, useMediaQuery } from '../../../shared/utils/useMediaQuery';
import { formatDate } from '../../../shared/utils/format';
import { useCatalogStyles } from '../../catalog/styles';
import type { Alert } from '../types';
import { AlertActionsMenu } from './AlertActions';
import { AlertAge, AlertFacts, AlertSeverityBadge, AlertSource, AlertTitle, ClosedAtSource } from './AlertBits';
import { AlertTaskCell } from './AlertTaskCell';
import { alertTitle } from './alertText';
import type { AlertTask } from './alertTasks';

const useStyles = makeStyles({
  cell: { display: 'grid', gap: '2px', minWidth: 0, paddingTop: '8px', paddingBottom: '8px' },
  age: { color: h.muted, fontSize: '13px', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  customer: { fontWeight: 600, overflowWrap: 'anywhere' },
  // A phone card: the severity and the title, the facts in one muted line, the task and the row's menu under them.
  cardHead: { display: 'flex', alignItems: 'flex-start', gap: '8px', minWidth: 0 },
  cardFoot: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '8px', paddingTop: '4px' },
  // Fixed columns for the short facts; the alert's title takes what is left (Fluent's table is table-layout: fixed). The widths are
  // border-box, padding included: content-box header cells gave each fixed column its padding on top, and with the selection
  // column (M45) the titles were left a word per line at 1280 px.
  table: { '& th': { boxSizing: 'border-box' } },
  severity: { width: '112px' },
  customerColumn: { width: '16%' },
  waiting: { width: '144px' },
  task: { width: '20%' },
  // M40: what can be done with the alert at its source, behind one button; the column has a name for screen readers only.
  more: { width: '52px' },
  // M45: the box that chooses a row for a bulk action, first in the row as in the time entries.
  select: { width: '48px' },
  selectAll: { display: 'flex', alignItems: 'center', minHeight: '40px', marginBottom: '8px' },
  // A card's box sits on the first line of its title: Fluent's 32 px box would otherwise centre 4 px below the badge beside it.
  cardBox: { flexShrink: 0, marginTop: '-4px', marginBottom: '-4px' },
  // A chosen row is told apart at a glance, not only by its box.
  chosen: { backgroundColor: h.surface2 },
  // The list takes focus when the row that held it leaves (hidden, shown again; M45: the bulk bar with its selection): its outer box,
  // which stays while the rows are read again and the table gives way to cards or to the empty state, so focus is never left on a
  // part that is about to go. An outline only for the keyboard.
  listFocus: { borderRadius: '16px', ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '2px' } },
  srOnly: { position: 'absolute', width: '1px', height: '1px', margin: '-1px', overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0, padding: 0 },
});

/**
 * Below this width of its own the table would squeeze the titles into a word per line: the list shows cards instead. At 900 px
 * the title column keeps about 220 px beside the selection and actions columns (M45); a 1280 px window with the side menu leaves
 * 950–970 px, scrollbar or not, so every engine shows the table there, while 1100 px and narrower show cards.
 */
const tableWidth = 900;
/**
 * Cards go back to the table only this much above the threshold. Switching changes the page's height, and with it whether the
 * window shows a scrollbar (about 15 px in Firefox and WebKit): without the margin a width near 960 px would switch back and forth.
 */
const switchBackMargin = 24;

/** M45: rows a person may choose for a bulk action; the header box chooses or clears every row shown. */
export interface AlertRowSelection {
  /** The rows are those of an earlier filter while its answer is read: they cannot be chosen for this one. */
  disabled?: boolean;
  isChosen: (alertId: string) => boolean;
  onToggle: (alert: Alert, on: boolean) => void;
  onToggleAll: (on: boolean) => void;
}

/**
 * The alerts of the queue: a table where it has room, cards on a phone and in a narrow content column (UX concept §8). Each row
 * says how severe, what, where, how long it has waited and who has it; the title opens the alert. With a selection (M45) each row
 * starts with the box that chooses it for a bulk action.
 */
export function AlertQueueList({ alerts, tasks, resolved, busy, empty, footer, selection, onOpen }: {
  alerts: readonly Alert[];
  tasks: ReadonlyMap<string, AlertTask>;
  /** The list shows resolved alerts: the age is how long ago they were resolved. */
  resolved: boolean;
  /** The rows are those of an earlier search or filter while its answer is read. */
  busy?: boolean;
  empty: ReactNode;
  footer: ReactNode;
  selection?: AlertRowSelection;
  onOpen: (alert: Alert) => void;
}) {
  const { t } = useTranslation(); const styles = useStyles(); const list = useCatalogStyles();
  // One box around every branch: the width is read from the element on the page, never from a branch that was replaced.
  const box = useRef<HTMLDivElement>(null); const width = useContainerWidth(box);
  const [cards, setCards] = useState(false);
  const wantCards = width > 0 && width < (cards ? tableWidth + switchBackMargin : tableWidth);
  if (wantCards !== cards) setCards(wantCards);
  const narrow = useMediaQuery(NARROW_SCREEN) || wantCards;
  const age = (alert: Alert) => <AlertAge at={resolved && alert.resolvedAt ? alert.resolvedAt : alert.createdAt} />;
  const title = (alert: Alert) => <AlertTitle title={alertTitle(t, alert)} onOpen={() => onOpen(alert)} />;
  const customer = (alert: Alert) => <AppLink className={styles.customer} to={`/organizations/${alert.organizationId}?tab=drift`}>
    {alert.organizationName ?? t('alerts.detail.unknownCustomer')}</AppLink>;
  const source = (alert: Alert) => <AlertSource system={alert.system} />;
  // M40: a hidden alert says until when, beside its other facts; M41: an urgent one its source closed waits for a person.
  const hiddenUntil = (alert: Alert) => alert.hidden && t('alerts.hide.untilFact', { date: formatDate(alert.hidden.until) });
  const closedAtSource = (alert: Alert) => alert.sourceClosedAt && alert.state !== 'Resolved' && <ClosedAtSource alert={alert} />;
  const chosen = selection ? alerts.filter((alert) => selection.isChosen(alert.id)).length : 0;
  const allBox = selection && <Checkbox checked={chosen > 0 && chosen === alerts.length ? true : chosen > 0 ? 'mixed' : false}
    disabled={selection.disabled} onChange={(_, d) => selection.onToggleAll(d.checked === true)}
    {...(narrow ? { label: t('alerts.bulk.selectShown') } : { 'aria-label': t('alerts.bulk.selectShown') })} />;
  // Each box is named by its alert with what tells it apart from a namesake: the device and the customer.
  const rowBox = (alert: Alert) => selection && <Checkbox className={narrow ? styles.cardBox : undefined} checked={selection.isChosen(alert.id)}
    disabled={selection.disabled} onChange={(_, d) => selection.onToggle(alert, d.checked === true)}
    aria-label={t('alerts.bulk.selectOne', { title: alertTitle(t, alert),
      facts: [alert.deviceName, alert.organizationName ?? t('alerts.detail.unknownCustomer')].filter(Boolean).join(', ') })} />;
  const isChosen = (alert: Alert) => selection?.isChosen(alert.id) === true;

  let body: ReactNode;
  if (alerts.length === 0) {
    // An empty list is the empty state in the card the rows would have had: no column headers over nothing.
    body = <><div className={list.emptyCard}>{empty}</div>{footer}</>;
  } else if (narrow) {
    body = <>
      {allBox && <div className={styles.selectAll}>{allBox}</div>}
      <ul className={list.cards} aria-label={t('alerts.list')}>
        {alerts.map((alert) => <li key={alert.id} className={mergeClasses(list.card, isChosen(alert) && styles.chosen)}>
          <span className={styles.cardHead}>{rowBox(alert)}<AlertSeverityBadge severity={alert.severity} />{title(alert)}</span>
          <AlertFacts parts={[customer(alert), alert.deviceName, age(alert), source(alert), hiddenUntil(alert), closedAtSource(alert)]} />
          <span className={styles.cardFoot}><AlertTaskCell alert={alert} task={tasks.get(alert.id)} /><AlertActionsMenu alert={alert} /></span>
        </li>)}
      </ul>
      {footer}
    </>;
  } else {
    body = <ScrollTable className={list.tableWrap}>
      <Table className={mergeClasses(list.table, styles.table)} style={{ minWidth: selection ? 808 : 760 }} aria-label={t('alerts.list')}>
        <TableHeader><TableRow>
          {allBox && <TableHeaderCell className={styles.select}>{allBox}</TableHeaderCell>}
          <TableHeaderCell className={styles.severity}>{t('alerts.columns.severity')}</TableHeaderCell>
          <TableHeaderCell>{t('alerts.columns.alert')}</TableHeaderCell>
          <TableHeaderCell className={styles.customerColumn}>{t('alerts.columns.customer')}</TableHeaderCell>
          <TableHeaderCell className={styles.waiting}>{t(resolved ? 'alerts.columns.resolved' : 'alerts.columns.waiting')}</TableHeaderCell>
          <TableHeaderCell className={styles.task}>{t('alerts.columns.task')}</TableHeaderCell>
          <TableHeaderCell className={styles.more}><span className={styles.srOnly}>{t('alerts.columns.actions')}</span></TableHeaderCell>
        </TableRow></TableHeader>
        <TableBody>{alerts.map((alert) => <TableRow key={alert.id} className={isChosen(alert) ? styles.chosen : undefined}>
          {selection && <TableCell>{rowBox(alert)}</TableCell>}
          <TableCell><AlertSeverityBadge severity={alert.severity} /></TableCell>
          <TableCell><span className={styles.cell}>{title(alert)}<AlertFacts parts={[alert.deviceName, source(alert), hiddenUntil(alert), closedAtSource(alert)]} /></span></TableCell>
          <TableCell>{customer(alert)}</TableCell>
          <TableCell className={styles.age}>{age(alert)}</TableCell>
          <TableCell><AlertTaskCell alert={alert} task={tasks.get(alert.id)} /></TableCell>
          <TableCell><AlertActionsMenu alert={alert} /></TableCell>
        </TableRow>)}</TableBody>
      </Table>
      {footer}
    </ScrollTable>;
  }
  return <div ref={box} data-alert-list tabIndex={-1} role="group" aria-label={t('alerts.list')} aria-busy={busy || undefined} className={styles.listFocus}>
    {body}</div>;
}

/** The empty list of the queue: what there is to know, and the way back to everything when a filter hid it. */
export function AlertQueueEmpty({ message, action }: { message: string; action?: ReactNode }) {
  return <EmptyState icon={<AlertOn24Regular />} message={message} action={action} />;
}
