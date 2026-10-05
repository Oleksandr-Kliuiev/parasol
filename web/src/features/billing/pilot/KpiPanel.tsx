import { useState } from 'react';
import { Field, Input, Spinner, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { ErrorState } from '../../../shared/components/ErrorState';
import { Panel } from '../../../shared/components/Panel';
import { formatNumber } from '../../../shared/utils/format';
import { monthLabel } from '../period';
import { useKpi, type KpiReport } from './api';
import { ScrollRegion } from './parts';
import { usePilotStyles } from './styles';

const percent = (share: number | null) => (share === null ? '—' : `${formatNumber(share * 100, 1)} %`);
const hours = (value: number | null) => (value === null ? '—' : formatNumber(value, 1));

export function KpiView({ report }: { report: KpiReport }) {
  const styles = usePilotStyles();
  const { t, i18n } = useTranslation();
  const totals = report.totals;
  return (
    <>
      <p className={styles.muted} style={{ marginTop: 0 }}>
        {t('pilot.kpi.range', { from: report.from, to: report.to, asOf: report.asOf })}
      </p>
      <ScrollRegion label={t('pilot.kpi.tableLabel')}>
        <Table className={styles.table} style={{ minWidth: 1000 }} aria-label={t('pilot.kpi.tableLabel')}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>{t('pilot.kpi.period')}</TableHeaderCell>
              <TableHeaderCell>{t('common.status')}</TableHeaderCell>
              <TableHeaderCell className={styles.number}>{t('pilot.kpi.hoursClosed')}</TableHeaderCell>
              <TableHeaderCell className={styles.number}>{t('pilot.kpi.hoursExported')}</TableHeaderCell>
              <TableHeaderCell className={styles.number}>{t('pilot.kpi.bases')}</TableHeaderCell>
              <TableHeaderCell className={styles.number}>{t('pilot.kpi.failed')}</TableHeaderCell>
              <TableHeaderCell className={styles.number}>{t('pilot.kpi.reconciliation')}</TableHeaderCell>
              <TableHeaderCell className={styles.number}>{t('pilot.kpi.anomalies')}</TableHeaderCell>
              <TableHeaderCell className={styles.number}>{t('pilot.kpi.lines')}</TableHeaderCell>
              <TableHeaderCell className={styles.number}>{t('pilot.kpi.manual')}</TableHeaderCell>
              <TableHeaderCell className={styles.number}>{t('pilot.kpi.conflicts')}</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.runs.map((run) => (
              <TableRow key={run.runId}>
                <TableCell>
                  {monthLabel(run.periodStart, i18n.language)}
                  {run.kind === 'Supplementary' && <div className={styles.muted}>{t('billing.supplementary.badge')}</div>}
                </TableCell>
                <TableCell>{t(`billing.runStatus.${run.status}`, { defaultValue: run.status })}</TableCell>
                <TableCell className={styles.number}>{hours(run.hoursCollectedToClosed)}</TableCell>
                <TableCell className={styles.number}>{hours(run.hoursCollectedToExported)}</TableCell>
                <TableCell className={styles.number}>{run.bases}</TableCell>
                <TableCell className={styles.number}>{run.basesFailed}</TableCell>
                <TableCell className={styles.number}>{run.basesReconciliationRequired}</TableCell>
                <TableCell className={styles.number}>{run.anomalyEntries}</TableCell>
                <TableCell className={styles.number}>{run.lines}</TableCell>
                <TableCell className={styles.number}>
                  {run.manualLines} ({percent(run.manualShare)})
                </TableCell>
                <TableCell className={styles.number}>{run.unresolvedConflicts}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ScrollRegion>
      <h3 className={styles.heading}>{t('pilot.kpi.totalsTitle')}</h3>
      <ul className={styles.list}>
        <li>{t('pilot.kpi.totalRuns', { runs: totals.runs, closed: totals.closedRuns })}</li>
        <li>{t('pilot.kpi.totalHours', { hours: hours(totals.averageHoursCollectedToClosed) })}</li>
        <li>{t('pilot.kpi.totalLines', { lines: totals.lines, manual: totals.manualLines, share: percent(totals.manualShare) })}</li>
        <li>{t('pilot.kpi.totalExceptions', { anomalies: totals.anomalyEntries, conflicts: totals.unresolvedConflicts, failed: totals.basesFailed, reconciliation: totals.basesReconciliationRequired })}</li>
        <li>{t('pilot.kpi.overdueReminders', { number: report.overdueUnacknowledgedReminders })}</li>
      </ul>
      <h3 className={styles.heading}>{t('pilot.kpi.notMeasuredTitle')}</h3>
      <p className={styles.muted}>{t('pilot.kpi.notMeasuredIntro')}</p>
      <ul className={styles.list} aria-label={t('pilot.kpi.notMeasuredTitle')}>
        {report.notMeasured.map((item) => (
          <li key={item.kpi}>
            <strong>{t(`pilot.kpi.notMeasured.${item.kpi}.name`, { defaultValue: item.kpi })}</strong>
            {': '}
            {t(`pilot.kpi.notMeasured.${item.kpi}.reason`, { defaultValue: item.reason })}
          </li>
        ))}
      </ul>
    </>
  );
}

/** Process figures of the billing runs (needs finance.read). A figure the data cannot give is listed with the reason, never invented. */
export function KpiPanel() {
  const styles = usePilotStyles();
  const { t } = useTranslation();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const range = { from: from ? `${from}-01` : undefined, to: to ? `${to}-01` : undefined };
  const kpi = useKpi(range, true);
  return (
    <Panel title={t('pilot.kpi.title')}>
      <div className={styles.filters}>
        <Field label={t('pilot.kpi.from')}>
          <Input type="month" value={from} onChange={(_, d) => setFrom(d.value)} />
        </Field>
        <Field label={t('pilot.kpi.to')}>
          <Input type="month" value={to} onChange={(_, d) => setTo(d.value)} />
        </Field>
      </div>
      {kpi.isPending ? <Spinner label={t('common.loading')} /> : kpi.error ? <ErrorState error={kpi.error} onRetry={() => void kpi.refetch()} /> : <KpiView report={kpi.data} />}
    </Panel>
  );
}
