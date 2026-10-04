import { useSearchParams } from 'react-router';
import {
  Badge,
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
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { Panel } from '../../shared/components/Panel';
import { formatDate, formatMoney, formatNumber } from '../../shared/utils/format';
import { useCatalogStyles } from '../catalog/styles';
import { useDashboard } from './api';
import { RevenueChart } from './RevenueChart';

const useStyles = makeStyles({
  tiles: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: tokens.spacingHorizontalM, marginBottom: tokens.spacingVerticalL },
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
  panels: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: tokens.spacingHorizontalL, alignItems: 'start' },
  stack: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  share: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  meter: { width: '80px', height: '8px', backgroundColor: tokens.colorNeutralBackground4, borderRadius: tokens.borderRadiusSmall, overflow: 'hidden' },
  meterFill: { height: '100%', backgroundColor: tokens.colorBrandBackground, display: 'block' },
  split: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalM, marginTop: tokens.spacingVerticalS },
});

/** The dashboard of FR-RPT-01: recurring revenue, what was invoiced, the pipeline, renewals and the load on the team. */
export function DashboardPage() {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const { t } = useTranslation();
  const canSeeMoney = useCan(Permissions.financeRead);
  const [params, setParams] = useSearchParams();
  const months = Number(params.get('months') ?? 6);
  const { data, error, isPending, refetch } = useDashboard(Number.isFinite(months) ? months : 6);

  if (isPending) return <Spinner label={t('common.loading')} />;
  if (error || !data) return <ErrorState error={error} onRetry={() => void refetch()} />;

  return (
    <>
      <PageHeader title={t('dashboard.title')} subtitle={t('dashboard.subtitle', { date: formatDate(data.asOf) })} />

      <div className={styles.tiles}>
        {canSeeMoney && (
          <>
            <div className={styles.tile}>
              <span className={styles.value}>{formatMoney(data.recurring.mrr)}</span>
              <span className={styles.label}>{t('dashboard.tiles.mrr', { count: data.recurring.contracts })}</span>
            </div>
            <div className={styles.tile}>
              <span className={styles.value}>{formatMoney(data.recurring.arr)}</span>
              <span className={styles.label}>{t('dashboard.tiles.arr')}</span>
            </div>
            <div className={styles.tile}>
              <span className={styles.value}>{formatMoney(data.invoices.outstanding)}</span>
              <span className={styles.label}>{t('dashboard.tiles.outstanding', { count: data.invoices.open })}</span>
            </div>
            <div className={styles.tile}>
              <span className={`${styles.value} ${data.invoices.overdueCount > 0 ? styles.warn : ''}`}>{formatMoney(data.invoices.overdue)}</span>
              <span className={styles.label}>{t('dashboard.tiles.overdue', { count: data.invoices.overdueCount })}</span>
            </div>
            <div className={styles.tile}>
              <span className={styles.value}>{formatMoney(data.pipeline.weightedForecast)}</span>
              <span className={styles.label}>{t('dashboard.tiles.forecast', { count: data.pipeline.open })}</span>
            </div>
          </>
        )}
        <div className={styles.tile}>
          <span className={styles.value}>{formatNumber(data.licenses.licenses, 0)}</span>
          <span className={styles.label}>{t('dashboard.tiles.licenses', { count: data.licenses.subscriptions })}</span>
        </div>
        <div className={styles.tile}>
          <span className={`${styles.value} ${data.service.criticalAlerts > 0 ? styles.warn : ''}`}>{data.service.openTickets}</span>
          <span className={styles.label}>{t('dashboard.tiles.tickets', { alerts: data.service.criticalAlerts })}</span>
        </div>
      </div>

      <div className={styles.stack}>
        {canSeeMoney && (
          <Panel
            title={t('dashboard.revenue')}
            actions={
              <Text className={styles.label}>
                {[3, 6, 12].map((option) => (
                  <AppLink
                    key={option}
                    to={`/dashboard?months=${option}`}
                    onClick={(event) => {
                      event.preventDefault();
                      setParams({ months: String(option) }, { replace: true });
                    }}
                  >
                    <span style={{ marginInlineEnd: 8, fontWeight: option === months ? 600 : 400 }}>{t('dashboard.months', { count: option })}</span>
                  </AppLink>
                ))}
              </Text>
            }
          >
            <RevenueChart months={data.revenue} />
            <div className={styles.split}>
              {(data.revenue.at(-1)?.byBusinessLine ?? []).map((line) => (
                <Text key={line.label} className={styles.label}>
                  {t(`dashboard.businessLines.${line.label}`, { defaultValue: line.label })}: {formatMoney(line.amount)}
                </Text>
              ))}
            </div>
          </Panel>
        )}

        <div className={styles.panels}>
          <Panel title={t('dashboard.renewals')}>
            {data.renewals.length === 0 ? (
              <EmptyState message={t('dashboard.noRenewals')} />
            ) : (
              <div className={catalog.tableWrap} style={{ borderStyle: 'none' }}>
                <Table aria-label={t('dashboard.renewals')} size="small">
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
                          {renewal.autoRenew && (
                            <div>
                              <Badge appearance="outline" color="informative">
                                {t('dashboard.autoRenews')}
                              </Badge>
                            </div>
                          )}
                        </TableCell>
                        <TableCell>{renewal.organization}</TableCell>
                        <TableCell className="tabular">
                          {formatDate(renewal.endDate)}
                          <div className={renewal.daysLeft <= 30 ? styles.warn : styles.label}>
                            {t('dashboard.inDays', { count: renewal.daysLeft })}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {data.renewalsTotal > data.renewals.length && (
                  <Text className={styles.label}>{t('common.shownOf', { shown: data.renewals.length, total: data.renewalsTotal })}</Text>
                )}
              </div>
            )}
          </Panel>

          <Panel title={t('dashboard.utilization')}>
            {data.utilization.length === 0 ? (
              <EmptyState message={t('dashboard.noHours')} />
            ) : (
              <div className={catalog.tableWrap} style={{ borderStyle: 'none' }}>
                <Table aria-label={t('dashboard.utilization')} size="small">
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
                            <Text>{formatNumber(row.billablePct, 0)} %</Text>
                          </span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {data.techniciansTotal > data.utilization.length && (
                  <Text className={styles.label}>{t('common.shownOf', { shown: data.utilization.length, total: data.techniciansTotal })}</Text>
                )}
              </div>
            )}
          </Panel>

          <Panel title={t('dashboard.pipeline')}>
            <div className={styles.tiles} style={{ marginBottom: 0 }}>
              <div className={styles.tile}>
                <span className={styles.value}>{data.pipeline.open}</span>
                <span className={styles.label}>{t('dashboard.pipelineOpen')}</span>
              </div>
              <div className={styles.tile}>
                <span className={`${styles.value} ${data.pipeline.stale > 0 ? styles.warn : ''}`}>{data.pipeline.stale}</span>
                <span className={styles.label}>{t('dashboard.pipelineStale')}</span>
              </div>
              <div className={styles.tile}>
                <span className={styles.value}>{data.pipeline.wonLast90Days}</span>
                <span className={styles.label}>
                  {canSeeMoney
                    ? t('dashboard.pipelineWonWithAmount', { amount: formatMoney(data.pipeline.wonAmountLast90Days) })
                    : t('dashboard.pipelineWon')}
                </span>
              </div>
              <div className={styles.tile}>
                <span className={styles.value}>{data.pipeline.lostLast90Days}</span>
                <span className={styles.label}>{t('dashboard.pipelineLost')}</span>
              </div>
            </div>
          </Panel>

          <Panel title={t('dashboard.service')}>
            <div className={styles.tiles} style={{ marginBottom: 0 }}>
              <div className={styles.tile}>
                <span className={styles.value}>{data.service.unassignedTickets}</span>
                <span className={styles.label}>{t('dashboard.unassigned')}</span>
              </div>
              <div className={styles.tile}>
                <span className={`${styles.value} ${data.service.criticalAlerts > 0 ? styles.warn : ''}`}>{data.service.criticalAlerts}</span>
                <span className={styles.label}>{t('dashboard.criticalAlerts')}</span>
              </div>
              <div className={styles.tile}>
                <span className={styles.value}>{data.service.devices}</span>
                <span className={styles.label}>{t('dashboard.devices', { offline: data.service.devicesOffline })}</span>
              </div>
              <div className={styles.tile}>
                <span className={`${styles.value} ${data.licenses.cancellationWindowOpen > 0 ? styles.warn : ''}`}>
                  {data.licenses.cancellationWindowOpen}
                </span>
                <span className={styles.label}>{t('dashboard.cancellationWindow')}</span>
              </div>
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}
