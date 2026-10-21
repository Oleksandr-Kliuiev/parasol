import { useMemo, useState } from 'react';
import { Dropdown, Option, Spinner, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, makeStyles } from '@fluentui/react-components';
import { DataTrending16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { h } from '../../../app/hearth';
import { ErrorState } from '../../../shared/components/ErrorState';
import { Panel } from '../../../shared/components/Panel';
import { FilterField, Toolbar } from '../../../shared/components/Toolbar';
import { formatDate, formatNumber } from '../../../shared/utils/format';
import { FigureGrid } from '../../reports/FigureGrid';
import { monthLabel } from '../period';
import { useKpi, type KpiReport } from './api';
import { ScrollRegion } from './parts';
import { usePilotStyles } from './styles';

const percent = (share: number | null) => (share === null ? '—' : `${formatNumber(share * 100, 1)} %`);
const hours = (value: number | null) => (value === null ? '—' : formatNumber(value, 1));

const useStyles = makeStyles({
  month: { minWidth: '180px' },
  missing: { display: 'grid', gap: '2px' },
  missingName: { color: h.text, fontWeight: 700 },
});

export function KpiView({ report }: { report: KpiReport }) {
  const styles = usePilotStyles();
  const local = useStyles();
  const { t, i18n } = useTranslation();
  const totals = report.totals;
  return (
    <>
      <p className={styles.lead}>{t('pilot.kpi.range', { from: formatDate(report.from), to: formatDate(report.to), asOf: formatDate(report.asOf) })}</p>
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
                  <span className={styles.neutral}>{monthLabel(run.periodStart, i18n.language)}</span>
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
      <FigureGrid
        items={[
          { label: t('pilot.kpi.tiles.runs'), value: String(totals.runs), note: t('pilot.kpi.tiles.closed', { count: totals.closedRuns }) },
          { label: t('pilot.kpi.tiles.hours'), value: hours(totals.averageHoursCollectedToClosed) },
          { label: t('pilot.kpi.tiles.lines'), value: String(totals.lines), note: t('pilot.kpi.tiles.manual', { count: totals.manualLines, share: percent(totals.manualShare) }) },
          { label: t('pilot.kpi.anomalies'), value: String(totals.anomalyEntries) },
          { label: t('pilot.kpi.conflicts'), value: String(totals.unresolvedConflicts) },
          { label: t('pilot.kpi.tiles.failed'), value: String(totals.basesFailed) },
          { label: t('pilot.kpi.reconciliation'), value: String(totals.basesReconciliationRequired) },
          { label: t('pilot.kpi.overdueReminders'), value: String(report.overdueUnacknowledgedReminders) },
        ]}
      />
      <div className={styles.well}>
        <h3 className={styles.wellHeading}>{t('pilot.kpi.notMeasuredTitle')}</h3>
        <p className={styles.muted} style={{ margin: 0 }}>{t('pilot.kpi.notMeasuredIntro')}</p>
        <ul className={styles.plainList} aria-label={t('pilot.kpi.notMeasuredTitle')}>
          {report.notMeasured.map((item) => (
            <li key={item.kpi} className={local.missing}>
              <span className={local.missingName}>{t(`pilot.kpi.notMeasured.${item.kpi}.name`, { defaultValue: item.kpi })}</span>
              <span className={styles.muted}>{t(`pilot.kpi.notMeasured.${item.kpi}.reason`, { defaultValue: item.reason })}</span>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

/** The last two years of months, newest first, as YYYY-MM. */
const recentMonths = () => {
  const now = new Date();
  return Array.from({ length: 24 }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth() - index, 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  });
};

/** Process figures of the billing runs (needs finance.read). A figure the data cannot give is listed with the reason, never invented. */
export function KpiPanel() {
  const local = useStyles();
  const { t, i18n } = useTranslation();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const months = useMemo(() => recentMonths(), []);
  const range = { from: from ? `${from}-01` : undefined, to: to ? `${to}-01` : undefined };
  const kpi = useKpi(range, true);
  const label = (value: string) => monthLabel(`${value}-01`, i18n.language);
  // Without labels above them, the two pickers say which end of the range they set ("From May 2026", "Up to now").
  const monthPicker = (value: string, onChange: (value: string) => void, end: 'from' | 'to') => (
    <Dropdown className={local.month} value={value ? t(`pilot.kpi.${end}Value`, { month: label(value) }) : t(`pilot.kpi.${end}Any`)}
      selectedOptions={[value]} onOptionSelect={(_, d) => onChange(d.optionValue ?? '')}>
      <Option value="" text={t(`pilot.kpi.${end}Any`)}>{t(`pilot.kpi.${end}Any`)}</Option>
      {months.map((month) => (
        <Option key={month} value={month} text={label(month)}>
          {label(month)}
        </Option>
      ))}
    </Dropdown>
  );
  return (
    <Panel title={t('pilot.kpi.title')} icon={<DataTrending16Regular />}>
      <Toolbar>
        <FilterField label={t('pilot.kpi.from')}>{monthPicker(from, setFrom, 'from')}</FilterField>
        <FilterField label={t('pilot.kpi.to')}>{monthPicker(to, setTo, 'to')}</FilterField>
      </Toolbar>
      {kpi.isPending ? <Spinner size="small" label={t('common.loading')} /> : kpi.error ? <ErrorState error={kpi.error} onRetry={() => void kpi.refetch()} /> : <KpiView report={kpi.data} />}
    </Panel>
  );
}
