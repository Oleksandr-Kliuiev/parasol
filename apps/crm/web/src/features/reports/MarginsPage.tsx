import { useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Dropdown,
  Option,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  makeStyles,
  mergeClasses,
} from '@fluentui/react-components';
import {
  ArrowTrending16Regular,
  Copy20Regular,
  Database16Regular,
  DataBarVertical24Regular,
  Money16Regular,
  Receipt16Regular,
  Table16Regular,
  Warning16Regular,
} from '@fluentui/react-icons';
import { h } from '../../app/hearth';
import { StatGrid, StatTile } from '../../shared/components/KpiTile';
import { useFlushStyles, useStatFitStyles } from '../billing/flushStyles';
import { RecordRow, RowMeta } from '../billing/RecordRow';
import { Panel } from '../../shared/components/Panel';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { FilterChips, FilterField, Toolbar } from '../../shared/components/Toolbar';
import { useNotify } from '../../shared/components/useNotify';
import { formatDate, formatMoney, formatNumber } from '../../shared/utils/format';
import { useCatalogStyles } from '../catalog/styles';
import { monthName } from '../time/monthName';
import { useMargins, useMartDatasets } from './api';
import { ScrollTable } from '../../shared/components/ScrollTable';

const useStyles = makeStyles({
  month: { minWidth: '200px' },
  label: { color: h.muted, fontSize: '12.5px', lineHeight: '18px' },
  warn: { color: h.emberT },
  customer: { fontWeight: 600 },
  mart: { marginTop: '16px' },
  martBody: { display: 'block', maxWidth: '75ch', marginBottom: '14px', paddingLeft: '20px', paddingRight: '20px', color: h.muted, fontSize: '13px', lineHeight: '20px',
    '@media (max-width: 600px)': { paddingLeft: '16px', paddingRight: '16px' } },
  // The datasets as record rows, two columns on a wide card.
  datasets: { listStyleType: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(420px, 100%), 1fr))' },
  dataset: { fontFamily: 'inherit' },
});

const windows = ['1', '3', '6', '12'] as const;
type MarginWindow = (typeof windows)[number];

const lastMonths = (count: number) => {
  const now = new Date();
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth() - index, 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  });
};

/** Customer margin (FR-RPT-02) and the Power BI mart (FR-RPT-03) — both read the same numbers. */
export function MarginsPage() {
  const styles = useStyles();
  const stat = useStatFitStyles();
  const catalog = useCatalogStyles();
  const flush = useFlushStyles();
  const { t, i18n } = useTranslation();
  const notify = useNotify();
  const canMart = useCan(Permissions.reportsMart);
  const months = useMemo(() => lastMonths(12), []);
  // The month that has ended: the running month is billed only after it ends, and its margin would show costs alone.
  const [period, setPeriod] = useState(months[1] ?? months[0]!);
  const [window, setWindow] = useState<MarginWindow>('1');
  const { data, error, isPending, refetch } = useMargins(period, Number(window));
  const datasets = useMartDatasets(canMart);
  const periodName = (value: string) => monthName(Number(value.slice(0, 4)), Number(value.slice(5, 7)), i18n.language);

  const copy = async (dataset: string) => {
    const url = `${globalThis.location.origin}/api/v1/reports/mart/${dataset}?format=csv`;
    await navigator.clipboard.writeText(url);
    notify(t('margins.mart.copied', { dataset }));
  };

  return (
    <>
      <PageHeader title={t('margins.title')} subtitle={t('margins.subtitle')} />

      <Toolbar>
        <FilterField label={t('margins.period')}>
          <Dropdown className={styles.month} value={periodName(period)} selectedOptions={[period]} onOptionSelect={(_, d) => setPeriod(d.optionValue ?? period)}>
            {months.map((value) => (
              <Option key={value} value={value} text={periodName(value)}>
                {periodName(value)}
              </Option>
            ))}
          </Dropdown>
        </FilterField>
        <FilterChips<MarginWindow>
          label={t('margins.window')}
          value={window}
          options={windows.map((value) => ({ value, label: t('margins.windowMonths', { count: Number(value) }) }))}
          onChange={setWindow}
        />
      </Toolbar>

      {isPending && <Spinner label={t('common.loading')} />}
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        data && (
          <>
            <StatGrid className={stat.fit}>
              <StatTile className={stat.money}
                icon={<Money16Regular />}
                tone="iris"
                label={t('margins.tiles.revenue')}
                value={formatMoney(data.revenue ?? 0)}
                note={t('margins.periodRange', { from: formatDate(data.periodStart), to: formatDate(data.periodEnd) })}
              />
              <StatTile className={stat.money} icon={<Receipt16Regular />} tone="saffron" label={t('margins.tiles.cost')} value={formatMoney(data.cost ?? 0)}
                note={t('margins.hourlyCost', { cost: formatMoney(data.hourlyCost) })} />
              <StatTile className={stat.money}
                icon={<ArrowTrending16Regular />}
                tone="spruce"
                label={t('margins.tiles.margin')}
                value={formatMoney(data.margin ?? 0)}
                // Nothing billed yet: the figure is costs alone, said in the note, not a loss in red.
                note={(data.revenue ?? 0) > 0 ? t('margins.tiles.marginNote', { pct: formatNumber(data.marginPct ?? 0, 1) })
                  : (data.cost ?? 0) > 0 ? t('margins.notBilledYet', { month: periodName(period) }) : undefined}
                status={(data.revenue ?? 0) === 0 ? undefined : (data.margin ?? 0) < 0 ? 'bad' : (data.margin ?? 0) > 0 ? 'good' : undefined}
              />
              <StatTile
                icon={<Warning16Regular />}
                tone="ember"
                label={t('margins.tiles.withoutCost')}
                value={data.withoutLicenseCost}
                note={t('margins.tiles.customersNote', { count: data.customers })}
                status={data.withoutLicenseCost > 0 ? 'bad' : undefined}
              />
            </StatGrid>

            {data.rows.length === 0 ? (
              <div className={catalog.tableWrap}>
                <EmptyState icon={<DataBarVertical24Regular />} message={t('margins.empty')} />
              </div>
            ) : (
              <ScrollTable className={catalog.tableWrap}>
                <Table className={mergeClasses(catalog.table, flush.cells)} aria-label={t('margins.title')}>
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>{t('margins.fields.customer')}</TableHeaderCell>
                      <TableHeaderCell className={catalog.number}>{t('margins.fields.revenue')}</TableHeaderCell>
                      <TableHeaderCell className={catalog.number}>{t('margins.fields.licenseCost')}</TableHeaderCell>
                      <TableHeaderCell className={catalog.number}>{t('margins.fields.hourCost')}</TableHeaderCell>
                      <TableHeaderCell className={catalog.number}>{t('margins.fields.margin')}</TableHeaderCell>
                      <TableHeaderCell className={catalog.number}>{t('margins.fields.marginPct')}</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.rows.map((row) => (
                      <TableRow key={row.organizationId}>
                        <TableCell>
                          <AppLink to={`/organizations/${row.organizationId}?tab=invoices`} className={styles.customer}>{row.organizationName}</AppLink>
                          {row.costIncomplete && (
                            <div>
                              <Badge appearance="tint" color="warning">
                                {t('margins.costIncomplete')}
                              </Badge>
                            </div>
                          )}
                        </TableCell>
                        <TableCell className={catalog.number}>{formatMoney(row.revenue ?? 0)}</TableCell>
                        <TableCell className={catalog.number}>{formatMoney(row.licenseCost ?? 0)}</TableCell>
                        <TableCell className={catalog.number}>
                          {formatMoney(row.hourCost ?? 0)}
                          <div className={styles.label}>{t('margins.hours', { hours: formatNumber(row.hours, 1) })}</div>
                        </TableCell>
                        <TableCell className={catalog.number}>
                          <Text className={(row.margin ?? 0) < 0 ? styles.warn : undefined}>{formatMoney(row.margin ?? 0)}</Text>
                        </TableCell>
                        <TableCell className={catalog.number}>{(row.revenue ?? 0) === 0 ? '—' : `${formatNumber(row.marginPct ?? 0, 1)} %`}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollTable>
            )}
          </>
        )
      )}

      {canMart && (datasets.data?.length ?? 0) > 0 && (
        <Panel title={t('margins.mart.title')} icon={<Database16Regular />} flush className={mergeClasses(styles.mart, flush.panel)}>
          <Text className={styles.martBody}>{t('margins.mart.body')}</Text>
          <ul className={styles.datasets}>
            {(datasets.data ?? []).map((dataset) => (
              <RecordRow
                key={dataset}
                icon={<Table16Regular />}
                tone="iris"
                title={<span className={styles.dataset}>{dataset}</span>}
                meta={<RowMeta>{t('margins.mart.csv')}</RowMeta>}
                end={
                  <Button size="small" icon={<Copy20Regular />} aria-label={t('margins.mart.copy', { dataset })} onClick={() => void copy(dataset)}>
                    {t('margins.mart.copyShort')}
                  </Button>
                }
              />
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}
