import { useRef, type ReactNode } from 'react';
import { Link, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, makeStyles, useRestoreFocusTarget } from '@fluentui/react-components';
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
import { AlertAge, AlertFacts, AlertSeverityBadge, AlertSource } from './AlertBits';
import { AlertTaskCell } from './AlertTaskCell';
import type { AlertTask } from './alertTasks';

const useStyles = makeStyles({
  // The title opens the alert's side panel: a link-styled button with a 24 px hit box (WCAG 2.5.8) that wraps like text.
  title: {
    display: 'inline-flex', alignItems: 'center', minHeight: '24px', maxWidth: '100%', textAlign: 'start', fontWeight: 700, fontSize: '14px',
    lineHeight: '20px', overflowWrap: 'anywhere', color: h.text, textDecorationLine: 'none', ':hover': { color: h.emberT, textDecorationLine: 'underline' },
  },
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

/** Below this width of its own the table would squeeze the titles into a word per line: the list shows cards instead. */
const tableWidth = 960;

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
  const box = useRef<HTMLDivElement>(null); const width = useContainerWidth(box);
  const narrow = useMediaQuery(NARROW_SCREEN) || (width > 0 && width < tableWidth); const restore = useRestoreFocusTarget();
  const age = (alert: Alert) => <AlertAge at={resolved && alert.resolvedAt ? alert.resolvedAt : alert.createdAt} />;
  // The side panel gives focus back to the title that opened it (Fluent's restore target), also after Back closed it.
  const title = (alert: Alert) => <Link {...restore} as="button" className={styles.title} onClick={() => onOpen(alert)}>{alert.title}</Link>;
  const customer = (alert: Alert) => <AppLink className={styles.customer} to={`/organizations/${alert.organizationId}?tab=drift`}>
    {alert.organizationName ?? t('alerts.detail.unknownCustomer')}</AppLink>;
  const source = (alert: Alert) => <AlertSource system={alert.system} />;

  // An empty list is the empty state in the card the rows would have had: no column headers over nothing.
  if (alerts.length === 0) return <div ref={box}><div className={list.emptyCard}>{empty}</div>{footer}</div>;

  if (narrow) {
    return <div ref={box}>
      <ul className={list.cards} aria-label={t('alerts.list')}>
        {alerts.map((alert) => <li key={alert.id} className={list.card}>
          <span className={styles.cardHead}><AlertSeverityBadge severity={alert.severity} />{title(alert)}</span>
          <AlertFacts parts={[customer(alert), alert.deviceName, age(alert), source(alert)]} />
          <span className={styles.cardTask}><AlertTaskCell alert={alert} task={tasks.get(alert.id)} /></span>
        </li>)}
      </ul>
      {footer}
    </div>;
  }

  return <div ref={box}><ScrollTable className={list.tableWrap}>
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
  </ScrollTable></div>;
}

/** The empty list of the queue: what there is to know, and the way back to everything when a filter hid it. */
export function AlertQueueEmpty({ message, action }: { message: string; action?: ReactNode }) {
  return <EmptyState icon={<AlertOn24Regular />} message={message} action={action} />;
}
