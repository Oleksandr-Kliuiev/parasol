import { useMemo, useState } from 'react';
import {
  Badge,
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
import { useTranslation } from 'react-i18next';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { formatDate, formatNumber } from '../../shared/utils/format';
import { useCatalogStyles } from '../catalog/styles';
import { useSlaReport } from './api';
import type { SlaOrganizationRow } from './types';

const useStyles = makeStyles({
  bar: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: tokens.spacingHorizontalM, marginBottom: tokens.spacingVerticalM },
  month: { minWidth: '160px' },
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
  breach: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
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

/** SLA report per customer (FR-SRV-04): response and resolution measured in the support hours of their contract. */
export function SlaReportPage() {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const { t } = useTranslation();
  const months = useMemo(() => lastMonths(12), []);
  const [period, setPeriod] = useState(months[0]!);
  const { data, error, isPending, refetch } = useSlaReport(period);

  return (
    <>
      <PageHeader title={t('sla.title')} subtitle={t('sla.subtitle')} />

      <div className={styles.bar}>
        <Field label={t('sla.period')} className={styles.month}>
          <Dropdown
            id="sla-period"
            value={formatPeriod(period)}
            selectedOptions={[period]}
            onOptionSelect={(_, d) => setPeriod(d.optionValue ?? period)}
          >
            {months.map((value) => (
              <Option key={value} value={value}>
                {formatPeriod(value)}
              </Option>
            ))}
          </Dropdown>
        </Field>
        {data && <Text className={styles.label}>{t('sla.window', { from: formatDate(data.periodStart), to: formatDate(data.periodEnd) })}</Text>}
      </div>

      {isPending && <Spinner label={t('common.loading')} />}
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        data && (
          <>
            <div className={styles.tiles}>
              <div className={styles.tile}>
                <span className={styles.value}>{formatNumber(data.tickets, 0)}</span>
                <span className={styles.label}>{t('sla.tiles.tickets', { withoutSla: data.withoutSla })}</span>
              </div>
              <div className={styles.tile}>
                <span className={`${styles.value} ${data.responseMetPct < 95 ? styles.warn : ''}`}>{formatNumber(data.responseMetPct, 1)} %</span>
                <span className={styles.label}>{t('sla.tiles.response')}</span>
              </div>
              <div className={styles.tile}>
                <span className={`${styles.value} ${data.resolutionMetPct < 95 ? styles.warn : ''}`}>{formatNumber(data.resolutionMetPct, 1)} %</span>
                <span className={styles.label}>{t('sla.tiles.resolution')}</span>
              </div>
            </div>

            <div className={catalog.tableWrap}>
              <Table className={catalog.table} aria-label={t('sla.title')}>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>{t('sla.fields.customer')}</TableHeaderCell>
                    <TableHeaderCell>{t('sla.fields.policy')}</TableHeaderCell>
                    <TableHeaderCell className={catalog.number}>{t('sla.fields.tickets')}</TableHeaderCell>
                    <TableHeaderCell className={catalog.number}>{t('sla.fields.response')}</TableHeaderCell>
                    <TableHeaderCell className={catalog.number}>{t('sla.fields.resolution')}</TableHeaderCell>
                    <TableHeaderCell className={catalog.number}>{t('sla.fields.median')}</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.organizations.map((row) => (
                    <TableRow key={row.organizationId}>
                      <TableCell>
                        <AppLink to={`/organizations/${row.organizationId}?tab=service`}>{row.organizationName}</AppLink>
                        {row.breaches.length > 0 && (
                          <div className={styles.breach}>
                            {t('sla.breachList', { count: row.breachCount })}: {row.breaches.slice(0, 3).map((b) => `#${b.externalId}`).join(', ')}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        {row.policyName ? (
                          <>
                            <span>{row.policyName}</span>
                            <div className={catalog.sku}>
                              {row.contractNumber} · {row.coverage ? t(`contracts.sla.coverages.${row.coverage}`) : ''}
                            </div>
                          </>
                        ) : (
                          <Badge appearance="outline" color="warning">
                            {t('sla.noPolicy')}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className={catalog.number}>
                        {row.tickets}
                        <div className={styles.breach}>{t('sla.resolvedOf', { resolved: row.resolved })}</div>
                      </TableCell>
                      <TableCell className={catalog.number}>{percent(row, 'response', t)}</TableCell>
                      <TableCell className={catalog.number}>{percent(row, 'resolution', t)}</TableCell>
                      <TableCell className={catalog.number}>
                        {row.medianResponseMinutes === null ? '—' : t('sla.minutes', { minutes: formatNumber(row.medianResponseMinutes, 0) })}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {data.organizations.length === 0 && <EmptyState message={t('sla.empty')} />}
            </div>
          </>
        )
      )}
    </>
  );
}

function percent(row: SlaOrganizationRow, kind: 'response' | 'resolution', t: (key: string, options?: Record<string, unknown>) => string) {
  const measured = kind === 'response' ? row.responseMeasured : row.resolutionMeasured;
  const met = kind === 'response' ? row.responseMet : row.resolutionMet;
  const pct = kind === 'response' ? row.responseMetPct : row.resolutionMetPct;
  if (measured === 0) return '—';
  return t('sla.metOf', { pct: formatNumber(pct, 1), met, measured });
}
