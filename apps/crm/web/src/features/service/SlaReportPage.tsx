import { useMemo, useState } from 'react';
import {
  Badge,
  Dropdown,
  Option,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  makeStyles,
  mergeClasses,
} from '@fluentui/react-components';
import { CheckmarkCircle16Regular, Headset16Regular, ShieldError16Regular, ShieldTask24Regular, Timer16Regular } from '@fluentui/react-icons';
import { h } from '../../app/hearth';
import { StatGrid, StatTile } from '../../shared/components/KpiTile';
import { useFlushStyles, useStatFitStyles } from '../billing/flushStyles';
import { useTranslation } from 'react-i18next';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { FilterField, Toolbar } from '../../shared/components/Toolbar';
import { formatDate, formatNumber } from '../../shared/utils/format';
import { monthName } from '../time/monthName';
import { useCatalogStyles } from '../catalog/styles';
import { useSlaReport } from './api';
import type { SlaOrganizationRow } from './types';
import { ScrollTable } from '../../shared/components/ScrollTable';

const useStyles = makeStyles({
  month: { minWidth: '200px' },
  breach: { color: h.muted, fontSize: '12.5px', lineHeight: '18px' },
  breaches: { color: h.emberT, fontSize: '12.5px', lineHeight: '18px' },
  customer: { fontWeight: 600 },
});

/** The share of tickets within target below which a figure is marked: the service desk's own goal. */
const TARGET_PCT = 95;

const lastMonths = (count: number) => {
  const now = new Date();
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth() - index, 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  });
};


/** SLA report per customer (FR-SRV-04): response and resolution measured in the support hours of their contract. */
export function SlaReportPage() {
  const styles = useStyles();
  const stat = useStatFitStyles();
  const catalog = useCatalogStyles();
  const flush = useFlushStyles();
  const { t, i18n } = useTranslation();
  const months = useMemo(() => lastMonths(12), []);
  const periodName = (value: string) => monthName(Number(value.slice(0, 4)), Number(value.slice(5, 7)), i18n.language);
  const [period, setPeriod] = useState(months[0]!);
  const { data, error, isPending, refetch } = useSlaReport(period);
  const measured = (data?.tickets ?? 0) > 0;

  return (
    <>
      <PageHeader title={t('sla.title')} subtitle={t('sla.subtitle')} />

      <Toolbar>
        <FilterField label={t('sla.period')}>
          <Dropdown
            id="sla-period"
            className={styles.month}
            value={periodName(period)}
            selectedOptions={[period]}
            onOptionSelect={(_, d) => setPeriod(d.optionValue ?? period)}
          >
            {months.map((value) => (
              <Option key={value} value={value} text={periodName(value)}>
                {periodName(value)}
              </Option>
            ))}
          </Dropdown>
        </FilterField>
      </Toolbar>

      {isPending && <Spinner label={t('common.loading')} />}
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        data && (
          <>
            <StatGrid className={stat.fit}>
              <StatTile icon={<Headset16Regular />} tone="iris" label={t('sla.tiles.tickets')} value={formatNumber(data.tickets, 0)}
                note={t('sla.window', { from: formatDate(data.periodStart), to: formatDate(data.periodEnd) })} />
              <StatTile icon={<ShieldError16Regular />} tone="ember" label={t('sla.tiles.withoutSla')} value={formatNumber(data.withoutSla, 0)}
                note={t('sla.tiles.withoutSlaNote')} status={data.withoutSla > 0 ? 'bad' : undefined} />
              <StatTile
                icon={<Timer16Regular />}
                tone="saffron"
                label={t('sla.tiles.response')}
                // A share of no tickets is not a missed target: nothing was measured, and the tile says so.
                value={measured ? `${formatNumber(data.responseMetPct, 1)} %` : '—'}
                note={measured ? t('sla.tiles.target', { pct: TARGET_PCT }) : t('sla.tiles.notMeasured')}
                status={measured && data.responseMetPct < TARGET_PCT ? 'bad' : undefined}
              />
              <StatTile
                icon={<CheckmarkCircle16Regular />}
                tone="spruce"
                label={t('sla.tiles.resolution')}
                value={measured ? `${formatNumber(data.resolutionMetPct, 1)} %` : '—'}
                note={measured ? t('sla.tiles.target', { pct: TARGET_PCT }) : t('sla.tiles.notMeasured')}
                status={measured && data.resolutionMetPct < TARGET_PCT ? 'bad' : undefined}
              />
            </StatGrid>

            {data.organizations.length === 0 ? (
              <div className={catalog.tableWrap}>
                <EmptyState icon={<ShieldTask24Regular />} message={t('sla.empty')} />
              </div>
            ) : (
              <ScrollTable className={catalog.tableWrap}>
                <Table className={mergeClasses(catalog.table, flush.cells)} aria-label={t('sla.title')}>
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
                          <AppLink to={`/organizations/${row.organizationId}?tab=service`} className={styles.customer}>{row.organizationName}</AppLink>
                          {row.breaches.length > 0 && (
                            <div className={styles.breaches}>
                              {[t('sla.breachList', { count: row.breachCount }), row.breaches.slice(0, 3).map((b) => `#${b.externalId}`).join(', ')].join(' · ')}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          {row.policyName ? (
                            <>
                              <span className={styles.customer}>{row.policyName}</span>
                              <div className={styles.breach}>
                                {[row.contractNumber, row.coverage ? t(`contracts.coverages.${row.coverage}`) : null].filter(Boolean).join(' · ')}
                              </div>
                            </>
                          ) : (
                            <Badge appearance="tint" color="warning">
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
              </ScrollTable>
            )}
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
