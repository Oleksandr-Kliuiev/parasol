import { useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Dropdown,
  Field,
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
  tokens,
} from '@fluentui/react-components';
import { Copy20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { useNotify } from '../../shared/components/useNotify';
import { formatDate, formatMoney, formatNumber } from '../../shared/utils/format';
import { useCatalogStyles } from '../catalog/styles';
import { useMargins, useMartDatasets } from './api';
import { ScrollTable } from '../../shared/components/ScrollTable';

const useStyles = makeStyles({
  bar: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: tokens.spacingHorizontalM, marginBottom: tokens.spacingVerticalM },
  narrow: { minWidth: '160px' },
  tiles: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(170px, 100%), 1fr))', gap: tokens.spacingHorizontalM, marginBottom: tokens.spacingVerticalL },
  tile: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingHorizontalM,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
  },
  value: { fontSize: tokens.fontSizeHero700, lineHeight: tokens.lineHeightHero700, fontWeight: tokens.fontWeightSemibold, fontVariantNumeric: 'tabular-nums' },
  label: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  warn: { color: tokens.colorPaletteDarkOrangeForeground1 },
  good: { color: tokens.colorPaletteGreenForeground1 },
  mart: { marginTop: tokens.spacingVerticalXXL },
  datasets: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalS },
});

const lastMonths = (count: number) => {
  const now = new Date();
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth() - index, 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  });
};

const formatPeriod = (period: string) => {
  const [year, month] = period.split('-');
  return `${month}.${year}`;
};

/** Customer margin (FR-RPT-02) and the Power BI mart (FR-RPT-03) — both read the same numbers. */
export function MarginsPage() {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const canMart = useCan(Permissions.reportsMart);
  const months = useMemo(() => lastMonths(12), []);
  const [period, setPeriod] = useState(months[0]!);
  const [window, setWindow] = useState('1');
  const { data, error, isPending, refetch } = useMargins(period, Number(window));
  const datasets = useMartDatasets(canMart);

  const copy = async (dataset: string) => {
    const url = `${globalThis.location.origin}/api/v1/reports/mart/${dataset}?format=csv`;
    await navigator.clipboard.writeText(url);
    notify(t('margins.mart.copied', { dataset }));
  };

  return (
    <>
      <PageHeader title={t('margins.title')} subtitle={t('margins.subtitle')} />

      <div className={styles.bar}>
        <Field label={t('margins.period')} className={styles.narrow}>
          <Dropdown value={formatPeriod(period)} selectedOptions={[period]} onOptionSelect={(_, d) => setPeriod(d.optionValue ?? period)}>
            {months.map((value) => (
              <Option key={value} value={value}>
                {formatPeriod(value)}
              </Option>
            ))}
          </Dropdown>
        </Field>
        <Field label={t('margins.window')} className={styles.narrow}>
          <Dropdown value={t('margins.windowMonths', { count: Number(window) })} selectedOptions={[window]} onOptionSelect={(_, d) => setWindow(d.optionValue ?? '1')}>
            {['1', '3', '6', '12'].map((value) => (
              <Option key={value} value={value}>
                {t('margins.windowMonths', { count: Number(value) })}
              </Option>
            ))}
          </Dropdown>
        </Field>
        {data && <Text className={styles.label}>{t('margins.hourlyCost', { cost: formatMoney(data.hourlyCost) })}</Text>}
      </div>

      {isPending && <Spinner label={t('common.loading')} />}
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        data && (
          <>
            <div className={styles.tiles}>
              <div className={styles.tile}>
                <span className={styles.value}>{formatMoney(data.revenue ?? 0)}</span>
                <span className={styles.label}>{t('margins.tiles.revenue', { from: formatDate(data.periodStart), to: formatDate(data.periodEnd) })}</span>
              </div>
              <div className={styles.tile}>
                <span className={styles.value}>{formatMoney(data.cost ?? 0)}</span>
                <span className={styles.label}>{t('margins.tiles.cost')}</span>
              </div>
              <div className={styles.tile}>
                <span className={`${styles.value} ${(data.margin ?? 0) < 0 ? styles.warn : styles.good}`}>{formatMoney(data.margin ?? 0)}</span>
                <span className={styles.label}>{t('margins.tiles.margin', { pct: formatNumber(data.marginPct ?? 0, 1) })}</span>
              </div>
              <div className={styles.tile}>
                <span className={`${styles.value} ${data.withoutLicenseCost > 0 ? styles.warn : ''}`}>{data.withoutLicenseCost}</span>
                <span className={styles.label}>{t('margins.tiles.withoutCost')}</span>
              </div>
            </div>

            <ScrollTable className={catalog.tableWrap}>
              <Table className={catalog.table} aria-label={t('margins.title')}>
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
                        <AppLink to={`/organizations/${row.organizationId}?tab=invoices`}>{row.organizationName}</AppLink>
                        {row.costIncomplete && (
                          <div>
                            <Badge appearance="outline" color="warning">
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
              {data.rows.length === 0 && <EmptyState message={t('margins.empty')} />}
            </ScrollTable>
          </>
        )
      )}

      {canMart && (datasets.data?.length ?? 0) > 0 && (
        <section className={styles.mart}>
          <Text weight="semibold" block>
            {t('margins.mart.title')}
          </Text>
          <Text className={styles.label} block>
            {t('margins.mart.body')}
          </Text>
          <div className={styles.datasets}>
            {(datasets.data ?? []).map((dataset) => (
              <Button key={dataset} appearance="outline" icon={<Copy20Regular />} onClick={() => void copy(dataset)}>
                {dataset}
              </Button>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
