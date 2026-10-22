import { useRef, useState, type ReactNode } from 'react';
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, makeStyles } from '@fluentui/react-components';
import { AlertOn24Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { h } from '../../../app/hearth';
import { AppLink } from '../../../shared/components/AppLink';
import { EmptyState } from '../../../shared/components/EmptyState';
import { ScrollTable } from '../../../shared/components/ScrollTable';
import { useContainerWidth } from '../../../shared/utils/useContainerWidth';
import { NARROW_SCREEN, useMediaQuery } from '../../../shared/utils/useMediaQuery';
import { useCatalogStyles } from '../../catalog/styles';
import type { Alert } from '../types';
import { AlertAge, AlertFacts, AlertSeverityBadge, AlertSource, AlertTitle } from './AlertBits';
import { AlertTaskCell } from './AlertTaskCell';
import type { AlertTask } from './alertTasks';

const useStyles = makeStyles({
  cell: { display: 'grid', gap: '2px', minWidth: 0, paddingTop: '8px', paddingBottom: '8px' },
  age: { color: h.muted, fontSize: '13px', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  customer: { fontWeight: 600, overflowWrap: 'anywhere' },
  // A phone card: the severity and the title, the facts in one muted line, the task under them.
  cardHead: { display: 'flex', alignItems: 'flex-start', gap: '8px', minWidth: 0 },
  cardTask: { paddingTop: '4px' },
  // Fixed columns for the short facts; the alert's title takes what is left (Fluent's table is table-layout: fixed).
  severity: { width: '112px' },
  customerColumn: { width: '18%' },
  waiting: { width: '128px' },
  task: { width: '24%' },
});

/**
 * Below this width of its own the table would squeeze the titles into a word per line: the list shows cards instead. At 900 px
 * the title column keeps about 280 px; a 1280 px window with the side menu leaves 950–970 px, scrollbar or not, so every engine
 * shows the table there, while 1100 px and narrower show cards.
 */
const tableWidth = 900;
/**
 * Cards go back to the table only this much above the threshold. Switching changes the page's height, and with it whether the
 * window shows a scrollbar (about 15 px in Firefox and WebKit): without the margin a width near 960 px would switch back and forth.
 */
const switchBackMargin = 24;

/**
 * The alerts of the queue: a table where it has room, cards on a phone and in a narrow content column (UX concept §8). Each row
 * says how severe, what, where, how long it has waited and who has it; the title opens the alert.
 */
export function AlertQueueList({ alerts, tasks, resolved, empty, footer, onOpen }: {
  alerts: readonly Alert[];
  tasks: ReadonlyMap<string, AlertTask>;
  /** The list shows resolved alerts: the age is how long ago they were resolved. */
  resolved: boolean;
  empty: ReactNode;
  footer: ReactNode;
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
  const title = (alert: Alert) => <AlertTitle title={alert.title} onOpen={() => onOpen(alert)} />;
  const customer = (alert: Alert) => <AppLink className={styles.customer} to={`/organizations/${alert.organizationId}?tab=drift`}>
    {alert.organizationName ?? t('alerts.detail.unknownCustomer')}</AppLink>;
  const source = (alert: Alert) => <AlertSource system={alert.system} />;

  let body: ReactNode;
  if (alerts.length === 0) {
    // An empty list is the empty state in the card the rows would have had: no column headers over nothing.
    body = <><div className={list.emptyCard}>{empty}</div>{footer}</>;
  } else if (narrow) {
    body = <>
      <ul className={list.cards} aria-label={t('alerts.list')}>
        {alerts.map((alert) => <li key={alert.id} className={list.card}>
          <span className={styles.cardHead}><AlertSeverityBadge severity={alert.severity} />{title(alert)}</span>
          <AlertFacts parts={[customer(alert), alert.deviceName, age(alert), source(alert)]} />
          <span className={styles.cardTask}><AlertTaskCell alert={alert} task={tasks.get(alert.id)} /></span>
        </li>)}
      </ul>
      {footer}
    </>;
  } else {
    body = <ScrollTable className={list.tableWrap}>
      <Table className={list.table} style={{ minWidth: 760 }} aria-label={t('alerts.list')}>
        <TableHeader><TableRow>
          <TableHeaderCell className={styles.severity}>{t('alerts.columns.severity')}</TableHeaderCell>
          <TableHeaderCell>{t('alerts.columns.alert')}</TableHeaderCell>
          <TableHeaderCell className={styles.customerColumn}>{t('alerts.columns.customer')}</TableHeaderCell>
          <TableHeaderCell className={styles.waiting}>{t(resolved ? 'alerts.columns.resolved' : 'alerts.columns.waiting')}</TableHeaderCell>
          <TableHeaderCell className={styles.task}>{t('alerts.columns.task')}</TableHeaderCell>
        </TableRow></TableHeader>
        <TableBody>{alerts.map((alert) => <TableRow key={alert.id}>
          <TableCell><AlertSeverityBadge severity={alert.severity} /></TableCell>
          <TableCell><span className={styles.cell}>{title(alert)}<AlertFacts parts={[alert.deviceName, source(alert)]} /></span></TableCell>
          <TableCell>{customer(alert)}</TableCell>
          <TableCell className={styles.age}>{age(alert)}</TableCell>
          <TableCell><AlertTaskCell alert={alert} task={tasks.get(alert.id)} /></TableCell>
        </TableRow>)}</TableBody>
      </Table>
      {footer}
    </ScrollTable>;
  }
  return <div ref={box}>{body}</div>;
}

/** The empty list of the queue: what there is to know, and the way back to everything when a filter hid it. */
export function AlertQueueEmpty({ message, action }: { message: string; action?: ReactNode }) {
  return <EmptyState icon={<AlertOn24Regular />} message={message} action={action} />;
}
