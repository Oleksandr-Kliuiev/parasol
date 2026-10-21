import { useSearchParams } from 'react-router';
import {
  Link,
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
  tokens,
} from '@fluentui/react-components';
import type { ReactNode } from 'react';
import {
  ArrowRepeatAll20Regular,
  CalendarClock16Regular,
  CalendarClock20Regular,
  Clock16Regular,
  DataBarVertical16Regular,
  DataFunnel20Regular,
  DataTrending20Regular,
  Desktop20Regular,
  Headset16Regular,
  Headset20Regular,
  Key20Regular,
  Wallet20Regular,
} from '@fluentui/react-icons';
import { h } from '../../app/hearth';
import { KpiRow, KpiTile } from '../../shared/components/KpiTile';
import { useFlushStyles } from '../billing/flushStyles';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { Panel } from '../../shared/components/Panel';
import i18n, { localeOf } from '../../i18n';
import { formatDate, formatNumber, wrapAtCurrency } from '../../shared/utils/format';
import { useCatalogStyles } from '../catalog/styles';
import { useDashboard } from './api';
import { FigureGrid } from './FigureGrid';
import { RevenueChart } from './RevenueChart';

const useStyles = makeStyles({
  label: { color: h.muted, fontSize: '12.5px', lineHeight: '18px' },
  warn: { color: h.emberT },
  // A customer name with a long word wraps inside its narrow column on a phone instead of running into the date.
  wrap: { overflowWrap: 'anywhere' },
  // Cards of a row share their height, as the reference's panels do.
  panels: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(420px, 100%), 1fr))', gap: '16px', alignItems: 'stretch' },
  stack: { display: 'flex', flexDirection: 'column', gap: '16px' },
  share: { display: 'flex', alignItems: 'center', gap: '8px', whiteSpace: 'nowrap' },
  meter: { width: '80px', flexShrink: 0, height: '8px', backgroundColor: h.well, borderRadius: '999px', overflow: 'hidden', '@media (max-width: 560px)': { width: '44px' } },
  meterFill: { height: '100%', backgroundColor: h.spruce, display: 'block', borderRadius: '999px' },
  // Business lines of the latest month, as a legend under the bars: the line, then its amount.
  split: { display: 'flex', flexWrap: 'wrap', gap: '8px 20px', marginTop: '16px', paddingTop: '16px', borderTop: `1px solid ${h.line}` },
  line: { display: 'inline-flex', alignItems: 'center', gap: '8px', '::before': { content: '""', width: '8px', height: '8px', borderRadius: '3px', backgroundColor: h.ink, flexShrink: 0 } },
  lineAmount: { color: h.text, fontWeight: 700, fontVariantNumeric: 'tabular-nums' },
  // The month choice is a segmented control of links: the URL keeps the choice, the look follows the tab list.
  months: { display: 'inline-flex', gap: '2px', padding: '3px', borderRadius: '12px', backgroundColor: h.well },
  month: {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: '28px',
    paddingLeft: '10px',
    paddingRight: '10px',
    borderRadius: '9px',
    color: h.muted,
    fontSize: '12.5px',
    fontWeight: 600,
    textDecorationLine: 'none',
    ':hover': { color: h.text, textDecorationLine: 'none' },
  },
  monthOn: { backgroundColor: tokens.colorNeutralBackground1, color: h.text, boxShadow: '0 1px 2px rgba(0, 0, 0, 0.06), 0 4px 10px -4px rgba(0, 0, 0, 0.14)' },
  shown: { display: 'block', paddingTop: '8px', paddingBottom: '16px', paddingLeft: '20px', paddingRight: '20px' },
});

/** The overview reads in whole kroner, as the reference's figures do; lists and documents keep the øre. */
const kroner = (value: number | null | undefined) =>
  value === null || value === undefined ? '' : wrapAtCurrency(new Intl.NumberFormat(localeOf(i18n.language), { style: 'currency', currency: 'NOK', maximumFractionDigits: 0 }).format(value));

/** The dashboard of FR-RPT-01: recurring revenue, what was invoiced, the pipeline, renewals and the load on the team. */
export function DashboardPage() {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const flush = useFlushStyles();
  const { t } = useTranslation();
  const canSeeMoney = useCan(Permissions.financeRead);
  // A tile opens the list behind its number only for someone who may open that list.
  const canBilling = useCan(Permissions.billingRead);
  const canSales = useCan(Permissions.salesRead);
  const canLicensing = useCan(Permissions.licensingRead);
  const [params, setParams] = useSearchParams();
  const months = Number(params.get('months') ?? 6);
  const { data, error, isPending, refetch } = useDashboard(Number.isFinite(months) ? months : 6);

  if (isPending) return <Spinner label={t('common.loading')} />;
  if (error || !data) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const warn = (value: ReactNode, bad: boolean) => (bad ? <span className={styles.warn}>{value}</span> : value);
  const flagged = (value: number) => (value > 0 ? <span className={styles.warn}>{value}</span> : String(value));
  // A footer fact: the figure in bold, then what it counts.
  const fact = (figure: ReactNode, words: string) => (
    <span>
      <b>{figure}</b> {words}
    </span>
  );
  const ticketsTile = (
    <KpiTile
      icon={<Headset20Regular />}
      tone="ember"
      label={t('dashboard.tiles.tickets')}
      value={warn(data.service.openTickets, data.service.criticalAlerts > 0)}
      foot={
        <>
          {fact(data.service.unassignedTickets, t('dashboard.foot.unassigned'))}
          {fact(flagged(data.service.criticalAlerts), t('dashboard.foot.critical', { count: data.service.criticalAlerts }))}
        </>
      }
    />
  );

  return (
    <>
      <PageHeader title={t('dashboard.title')} subtitle={t('dashboard.subtitle', { date: formatDate(data.asOf) })} />

      {/* Four figures with their context in the footer; the panels below hold the rest of each area. */}
      <KpiRow label={t('myDay.kpiLabel')}>
        {canSeeMoney ? (
          <>
            <KpiTile
              icon={<ArrowRepeatAll20Regular />}
              tone="spruce"
              label={t('dashboard.tiles.mrr')}
              value={kroner(data.recurring.mrr)}
              foot={
                <>
                  {fact(data.recurring.contracts, t('dashboard.foot.contracts', { count: data.recurring.contracts }))}
                  {fact(kroner(data.recurring.arr), t('dashboard.foot.perYear'))}
                </>
              }
            />
            <KpiTile
              icon={<Wallet20Regular />}
              tone="iris"
              label={t('dashboard.tiles.outstanding')}
              value={kroner(data.invoices.outstanding)}
              foot={
                <>
                  {fact(data.invoices.open, t('dashboard.foot.invoices', { count: data.invoices.open }))}
                  {fact(warn(kroner(data.invoices.overdue), data.invoices.overdueCount > 0), t('dashboard.foot.overdue'))}
                </>
              }
              to={canBilling ? (data.invoices.overdueCount > 0 ? '/billing/invoices?overdue=true' : '/billing/invoices?open=true') : undefined}
            />
            <KpiTile
              icon={<DataTrending20Regular />}
              tone="saffron"
              label={t('dashboard.tiles.forecast')}
              value={kroner(data.pipeline.weightedForecast)}
              foot={
                <>
                  {fact(data.pipeline.open, t('dashboard.foot.deals', { count: data.pipeline.open }))}
                  {fact(flagged(data.pipeline.stale), t('dashboard.foot.quiet'))}
                </>
              }
              to={canSales ? '/pipeline' : undefined}
            />
            {ticketsTile}
          </>
        ) : (
          <>
            <KpiTile
              icon={<Key20Regular />}
              tone="iris"
              label={t('dashboard.tiles.licenses')}
              value={formatNumber(data.licenses.licenses, 0)}
              foot={
                <>
                  {fact(data.licenses.subscriptions, t('dashboard.foot.subscriptions', { count: data.licenses.subscriptions }))}
                  {fact(flagged(data.licenses.cancellationWindowOpen), t('dashboard.foot.windows', { count: data.licenses.cancellationWindowOpen }))}
                </>
              }
              to={canLicensing ? '/licenses' : undefined}
            />
            {ticketsTile}
            {/* Without the money tiles the row keeps four figures: what ends soon and the devices under watch. */}
            <KpiTile
              icon={<CalendarClock20Regular />}
              tone="saffron"
              label={t('dashboard.renewals')}
              value={String(data.renewalsTotal)}
              foot={data.renewals[0] ? fact(formatDate(data.renewals[0].endDate), t('dashboard.foot.nextEnds')) : <span>{t('dashboard.noRenewals')}</span>}
            />
            <KpiTile
              icon={<Desktop20Regular />}
              tone="spruce"
              label={t('dashboard.devices')}
              value={formatNumber(data.service.devices, 0)}
              foot={fact(flagged(data.service.devicesOffline), t('dashboard.foot.offline'))}
            />
          </>
        )}
      </KpiRow>

      <div className={styles.stack}>
        {canSeeMoney && (
          <Panel
            title={t('dashboard.revenue')}
            icon={<DataBarVertical16Regular />}
            actions={
              <span className={styles.months}>
                {[3, 6, 12].map((option) => (
                  <Link
                    key={option}
                    href={`?months=${option}`}
                    className={mergeClasses(styles.month, option === months && styles.monthOn)}
                    aria-current={option === months ? 'true' : undefined}
                    onClick={(event) => {
                      event.preventDefault();
                      setParams({ months: String(option) }, { replace: true });
                    }}
                  >
                    {t('dashboard.months', { count: option })}
                  </Link>
                ))}
              </span>
            }
          >
            <RevenueChart months={data.revenue} />
            {(data.revenue.at(-1)?.byBusinessLine ?? []).length > 0 && (
              <div className={styles.split}>
                {(data.revenue.at(-1)?.byBusinessLine ?? []).map((line) => (
                  <Text key={line.label} className={mergeClasses(styles.label, styles.line)}>
                    {t(`dashboard.businessLines.${line.label}`, { defaultValue: line.label })}
                    <span className={styles.lineAmount}>{kroner(line.amount)}</span>
                  </Text>
                ))}
              </div>
            )}
          </Panel>
        )}

        <div className={styles.panels}>
          <Panel title={t('dashboard.renewals')} icon={<CalendarClock16Regular />} flush={data.renewals.length > 0} className={data.renewals.length > 0 ? flush.panel : undefined}>
            {data.renewals.length === 0 ? (
              <EmptyState message={t('dashboard.noRenewals')} />
            ) : (
              <>
                <div className={flush.scroll}>
                  <Table aria-label={t('dashboard.renewals')} size="small" className={flush.table}>
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell>{t('dashboard.fields.contract')}</TableHeaderCell>
                        <TableHeaderCell>{t('dashboard.fields.customer')}</TableHeaderCell>
                        <TableHeaderCell>{t('dashboard.fields.ends')}</TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.renewals.map((renewal) => (
                        <TableRow key={renewal.contractId}>
                          <TableCell>
                            <AppLink to={`/contracts/${renewal.contractId}`}>{renewal.number}</AppLink>
                            {renewal.autoRenew && <div className={styles.label}>{t('dashboard.autoRenews')}</div>}
                          </TableCell>
                          <TableCell className={styles.wrap}>{renewal.organization}</TableCell>
                          <TableCell className="tabular">
                            {formatDate(renewal.endDate)}
                            <div className={mergeClasses(styles.label, renewal.daysLeft <= 30 && styles.warn)}>
                              {t('dashboard.inDays', { count: renewal.daysLeft })}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                {data.renewalsTotal > data.renewals.length ? (
                  <Text className={mergeClasses(styles.label, styles.shown)}>
                    {t('common.shownOf', { shown: data.renewals.length, total: data.renewalsTotal })}
                  </Text>
                ) : (
                  <span className={styles.shown} aria-hidden />
                )}
              </>
            )}
          </Panel>

          <Panel title={t('dashboard.utilization')} icon={<Clock16Regular />} flush={data.utilization.length > 0} className={data.utilization.length > 0 ? flush.panel : undefined}>
            {data.utilization.length === 0 ? (
              <EmptyState message={t('dashboard.noHours')} />
            ) : (
              <>
                <div className={flush.scroll}>
                  <Table aria-label={t('dashboard.utilization')} size="small" className={flush.table}>
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell>{t('dashboard.fields.technician')}</TableHeaderCell>
                        <TableHeaderCell className={catalog.number}>{t('dashboard.fields.hours')}</TableHeaderCell>
                        <TableHeaderCell>{t('dashboard.fields.billableShare')}</TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.utilization.map((row) => (
                        <TableRow key={row.technician}>
                          <TableCell>{row.technician}</TableCell>
                          <TableCell className={catalog.number}>
                            {formatNumber(row.totalHours, 1)}
                            <div className={styles.label}>{t('dashboard.billedHours', { hours: formatNumber(row.billedHours, 1) })}</div>
                          </TableCell>
                          <TableCell>
                            <span className={styles.share}>
                              <span className={styles.meter} aria-hidden>
                                <span className={styles.meterFill} style={{ width: `${Math.min(100, row.billablePct)}%` }} />
                              </span>
                              <Text className="tabular">{formatNumber(row.billablePct, 0)} %</Text>
                            </span>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                {data.techniciansTotal > data.utilization.length ? (
                  <Text className={mergeClasses(styles.label, styles.shown)}>
                    {t('common.shownOf', { shown: data.utilization.length, total: data.techniciansTotal })}
                  </Text>
                ) : (
                  <span className={styles.shown} aria-hidden />
                )}
              </>
            )}
          </Panel>

          <Panel title={t('dashboard.pipeline')} icon={<DataFunnel20Regular />}>
            <FigureGrid
              items={[
                { label: t('dashboard.pipelineOpen'), value: String(data.pipeline.open) },
                { label: t('dashboard.pipelineStale'), value: flagged(data.pipeline.stale) },
                { label: t('dashboard.pipelineWon'), value: String(data.pipeline.wonLast90Days), note: canSeeMoney ? kroner(data.pipeline.wonAmountLast90Days) : undefined },
                { label: t('dashboard.pipelineLost'), value: String(data.pipeline.lostLast90Days) },
              ]}
            />
          </Panel>

          <Panel title={t('dashboard.service')} icon={<Headset16Regular />}>
            {/* The figures the tile row does not show already: licences and devices for Finance, the licence risks otherwise. */}
            <FigureGrid
              items={canSeeMoney ? [
                { label: t('dashboard.tiles.licenses'), value: formatNumber(data.licenses.licenses, 0),
                  note: `${data.licenses.subscriptions} ${t('dashboard.foot.subscriptions', { count: data.licenses.subscriptions })}` },
                { label: t('dashboard.devices'), value: formatNumber(data.service.devices, 0), note: t('dashboard.offline', { count: data.service.devicesOffline }) },
                { label: t('dashboard.notBilled'), value: flagged(data.licenses.notBilled), note: t('dashboard.notBilledNote') },
                { label: t('dashboard.cancellationWindow'), value: flagged(data.licenses.cancellationWindowOpen) },
              ] : [
                { label: t('dashboard.renewingSoon'), value: String(data.licenses.renewingSoon), note: t('dashboard.renewingSoonNote') },
                { label: t('dashboard.notBilled'), value: flagged(data.licenses.notBilled), note: t('dashboard.notBilledNote') },
                { label: t('dashboard.withoutCustomer'), value: flagged(data.licenses.withoutOrganization) },
                { label: t('dashboard.warnings'), value: String(data.service.warningAlerts) },
              ]}
            />
          </Panel>
        </div>
      </div>
    </>
  );
}
