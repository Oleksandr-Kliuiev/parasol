import { useRef, type ReactNode } from 'react';
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
import { AlertActionsMenu } from './AlertActions';
import { AlertAge, AlertFacts, AlertSeverityBadge, AlertSource, AlertTitle } from './AlertBits';
import { AlertTaskCell } from './AlertTaskCell';
import type { AlertTask } from './alertTasks';

const useStyles = makeStyles({
  cell: { display: 'grid', gap: '2px', minWidth: 0, paddingTop: '8px', paddingBottom: '8px' },
  age: { color: h.muted, fontSize: '13px', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  customer: { fontWeight: 600, overflowWrap: 'anywhere' },
  // A phone card: the severity and the title, the facts in one muted line, the task under them.
  cardHead: { display: 'flex', alignItems: 'flex-start', gap: '8px', minWidth: 0 },
  // Fixed columns for the short facts; the alert's title takes what is left (Fluent's table is table-layout: fixed).
  severity: { width: '112px' },
  customerColumn: { width: '18%' },
  waiting: { width: '128px' },
  task: { width: '24%' },
  // M40: what can be done with the alert at its source, behind one button; the column has a name for screen readers only.
  more: { width: '52px' },
  srOnly: { position: 'absolute', width: '1px', height: '1px', margin: '-1px', overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0, padding: 0 },
  cardFoot: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '8px', paddingTop: '4px' },
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
  const narrow = useMediaQuery(NARROW_SCREEN) || (width > 0 && width < tableWidth);
  const age = (alert: Alert) => <AlertAge at={resolved && alert.resolvedAt ? alert.resolvedAt : alert.createdAt} />;
  const title = (alert: Alert) => <AlertTitle title={alert.title} onOpen={() => onOpen(alert)} />;
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
          <span className={styles.cardFoot}><AlertTaskCell alert={alert} task={tasks.get(alert.id)} /><AlertActionsMenu alert={alert} /></span>
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
        <TableHeaderCell className={styles.more}><span className={styles.srOnly}>{t('alerts.columns.actions')}</span></TableHeaderCell>
      </TableRow></TableHeader>
      <TableBody>{alerts.map((alert) => <TableRow key={alert.id}>
        <TableCell><AlertSeverityBadge severity={alert.severity} /></TableCell>
        <TableCell><span className={styles.cell}>{title(alert)}<AlertFacts parts={[alert.deviceName, source(alert)]} /></span></TableCell>
        <TableCell>{customer(alert)}</TableCell>
        <TableCell className={styles.age}>{age(alert)}</TableCell>
        <TableCell><AlertTaskCell alert={alert} task={tasks.get(alert.id)} /></TableCell>
        <TableCell><AlertActionsMenu alert={alert} /></TableCell>
      </TableRow>)}</TableBody>
    </Table>
    {footer}
  </ScrollTable></div>;
}

/** The empty list of the queue: what there is to know, and the way back to everything when a filter hid it. */
export function AlertQueueEmpty({ message, action }: { message: string; action?: ReactNode }) {
  return <EmptyState icon={<AlertOn24Regular />} message={message} action={action} />;
}
