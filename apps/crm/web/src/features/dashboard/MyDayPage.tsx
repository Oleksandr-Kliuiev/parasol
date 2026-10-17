import { useNavigate } from 'react-router';
import { Button, Skeleton, SkeletonItem, Text, makeStyles, tokens } from '@fluentui/react-components';
import { Add20Regular, Warning20Filled } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan, useCurrentUser } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { Panel } from '../../shared/components/Panel';
import { OrganizationStatusBadge, RegistryStatusBadge } from '../../shared/components/StatusBadges';
import { registryWarningStatuses } from '../../shared/utils/registry';
import { formatOrgNumber } from '../../shared/utils/orgNumber';
import { formatDate, formatMoney } from '../../shared/utils/format';
import { RunStatusBadge } from '../billing/shared';
import { monthLabel } from '../billing/period';
import { useOrganizations } from '../organizations/api';
import { RemindersPanel } from '../contracts/RemindersPanel';
import { MyTasksPanel } from '../activities/MyTasksPanel';
import { useOpportunities } from '../sales/api';
import { useLicensingAttention } from '../licensing/api';
import { useInvoices, useRuns } from '../billing/api';
import { AtlasAttentionPanel } from '../parasol/AtlasAttentionPanel';

const useStyles = makeStyles({
  grid: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 2fr) minmax(260px, 1fr)',
    gap: tokens.spacingHorizontalL,
    alignItems: 'start',
    '@media (max-width: 900px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
  },
  list: { listStyle: 'none', margin: 0, padding: 0 },
  row: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
    paddingBlock: tokens.spacingVerticalS,
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
    ':last-child': { borderBottom: 'none' },
  },
  rowText: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  muted: { color: tokens.colorNeutralForeground3, fontVariantNumeric: 'tabular-nums' },
  warning: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-start', color: tokens.colorPaletteDarkOrangeForeground1 },
  side: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
});

export function MyDayPage() {
  const styles = useStyles();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const user = useCurrentUser();
  const canCreate = useCan(Permissions.customersWrite);
  const canContracts = useCan(Permissions.contractsRead);
  const canActivities = useCan(Permissions.activitiesRead);
  const canSales = useCan(Permissions.salesRead);
  const canLicensing = useCan(Permissions.licensingRead);
  const canBilling = useCan(Permissions.billingRead);
  const { data, error, isPending, refetch } = useOrganizations({ accountManagerId: user.id, limit: 200 });
  const organizations = data?.pages.flatMap((p) => p.items) ?? [];
  const warnings = organizations.filter((o) => registryWarningStatuses.includes(o.registryStatus));
  const firstName = user.displayName.split(' ')[0];

  return (
    <>
      <PageHeader title={t('myDay.greeting', { name: firstName })} documentTitle={t('nav.myDay')} subtitle={t('myDay.subtitle')} />
      <div className={styles.grid}>
        <div className={styles.side}>
          <AtlasAttentionPanel />
          {canActivities && <MyTasksPanel />}
          {canSales && <StaleDealsPanel />}
          {canLicensing && <LicensingAttentionPanel />}
          {canBilling && <BillingPanel />}
        <Panel title={t('myDay.myOrganizations')}>
          {isPending && (
            <Skeleton aria-label={t('common.loading')}>
              <SkeletonItem />
              <SkeletonItem />
              <SkeletonItem />
            </Skeleton>
          )}
          {error && <ErrorState error={error} onRetry={() => void refetch()} />}
          {!isPending && !error && organizations.length === 0 && <EmptyState message={t('myDay.myOrganizationsEmpty')} />}
          <ul className={styles.list}>
            {organizations.map((o) => (
              <li key={o.id} className={styles.row}>
                <div className={styles.rowText}>
                  <AppLink to={`/organizations/${o.id}`}>
                    <Text weight="semibold">{o.name}</Text>
                  </AppLink>
                  <Text size={200} className={styles.muted}>
                    {[formatOrgNumber(o.orgNumber), o.city].filter(Boolean).join(' · ')}
                  </Text>
                </div>
                <span style={{ display: 'flex', gap: 6 }}>
                  <RegistryStatusBadge status={o.registryStatus} />
                  <OrganizationStatusBadge status={o.status} />
                </span>
              </li>
            ))}
          </ul>
        </Panel>
        </div>
        <div className={styles.side}>
          {canContracts && <RemindersPanel />}
          <Panel title={t('myDay.registryWarnings')}>
            {warnings.length === 0 ? (
              <Text className={styles.muted}>{t('myDay.registryWarningsEmpty')}</Text>
            ) : (
              <ul className={styles.list}>
                {warnings.map((o) => (
                  <li key={o.id} className={styles.row}>
                    <span className={styles.warning}>
                      <Warning20Filled aria-hidden />
                      <span>
                        <AppLink to={`/organizations/${o.id}`}>{o.name}</AppLink>
                        <Text block size={200}>
                          {t(`registry.${o.registryStatus}`)}
                        </Text>
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          {canCreate && (
            <Panel title={t('myDay.quickActions')}>
              <Button icon={<Add20Regular />} onClick={() => navigate('/organizations/new')}>
                {t('myDay.newOrganization')}
              </Button>
            </Panel>
          )}
        </div>
      </div>
    </>
  );
}

/** Deals nobody has touched for 30 days (BR-SAL-03): the reminder lives here instead of in e-mail. */
function StaleDealsPanel() {
  const styles = useStyles();
  const { t } = useTranslation();
  const canSeeMoney = useCan(Permissions.financeRead);
  // The eight that have waited longest to close first; the count says how many there are in all (DEV-12).
  const deals = useOpportunities({ mine: true, stale: true }, true, 8);
  const { items: data, isPending } = deals;

  if (!isPending && data.length === 0) return null;

  return (
    <Panel title={t('myDay.staleDeals')}>
      <ul className={styles.list}>
        {data.map((opportunity) => (
          <li key={opportunity.id} className={styles.row}>
            <div className={styles.rowText}>
              <AppLink to={`/sales/opportunities/${opportunity.id}`}>
                <Text weight="semibold">{opportunity.name}</Text>
              </AppLink>
              <Text size={200} className={styles.muted}>
                {opportunity.organization.name} · {t('opportunities.closesOn', { date: formatDate(opportunity.expectedCloseDate) })}
              </Text>
            </div>
            {canSeeMoney && <Text className={styles.muted}>{formatMoney(opportunity.forecastAmount)}</Text>}
          </li>
        ))}
      </ul>
      {(deals.total ?? 0) > data.length && (
        <AppLink to="/pipeline?mine=true&stale=true">{t('myDay.allStaleDeals', { count: deals.total ?? 0 })}</AppLink>
      )}
    </Panel>
  );
}

/** CSP subscriptions where the cancellation window closes soon or nothing is billed (BR-LIC-02/03). */
function LicensingAttentionPanel() {
  const styles = useStyles();
  const { t } = useTranslation();
  const { data } = useLicensingAttention();
  const closing = data?.cancellationWindow ?? [];
  // The summary counts every subscription; the lists only hold the first twenty of each kind (DEV-12).
  const notBilledCount = data?.summary.notBilled ?? 0;

  if (closing.length === 0 && notBilledCount === 0) return null;

  return (
    <Panel title={t('myDay.licensingAttention')}>
      <ul className={styles.list}>
        {closing.slice(0, 5).map((subscription) => (
          <li key={subscription.id} className={styles.row}>
            <span className={styles.warning}>
              <Warning20Filled aria-hidden />
              <span>
                <AppLink to="/licenses?window=true">{subscription.offerName ?? subscription.offerId}</AppLink>
                <Text block size={200}>
                  {t('myDay.cancellationWindow', {
                    name: subscription.organizationName ?? subscription.cspCustomerName ?? '',
                    date: subscription.cancellationWindowEndsAt ? formatDate(subscription.cancellationWindowEndsAt) : '',
                  })}
                </Text>
              </span>
            </span>
          </li>
        ))}
        {(data?.summary.cancellationWindowOpen ?? 0) > Math.min(closing.length, 5) && (
          <li className={styles.row}>
            <AppLink to="/licenses?window=true">{t('myDay.allCancellationWindows', { count: data?.summary.cancellationWindowOpen ?? 0 })}</AppLink>
          </li>
        )}
        {notBilledCount > 0 && (
          <li className={styles.row}>
            <AppLink to="/licenses?notBilled=true">{t('myDay.licensesNotBilled', { count: notBilledCount })}</AppLink>
          </li>
        )}
      </ul>
    </Panel>
  );
}

/** Where the money stands: the run that is still open and what customers owe (docs/02 §4.9). */
function BillingPanel() {
  const styles = useStyles();
  const { t, i18n } = useTranslation();
  const canSeeMoney = useCan(Permissions.financeRead);
  // The newest open run, whatever its period, and how many more are open (DEV-12) — not whatever the last six runs hold.
  const runs = useRuns({ openOnly: true, limit: 1 });
  // Only the totals are shown: they cover every overdue invoice, so one row is enough to ask for (DEV-12).
  const invoices = useInvoices({ overdueOnly: true, limit: 1 });
  const open = runs.items.at(0);
  const moreOpen = Math.max((runs.total ?? 0) - 1, 0);
  const overdueCount = invoices.data?.count ?? 0;

  if (!open && overdueCount === 0) return null;

  return (
    <Panel title={t('myDay.billing')}>
      <ul className={styles.list}>
        {open && (
          <li className={styles.row}>
            <div className={styles.rowText}>
              <AppLink to={`/billing/runs/${open.id}`}>
                <Text weight="semibold">{monthLabel(open.periodStart, i18n.language)}</Text>
              </AppLink>
              <Text size={200} className={styles.muted}>
                {t('myDay.runCustomers', { count: open.organizations })}
                {open.withAnomalies > 0 ? ` · ${t('myDay.runAnomalies', { count: open.withAnomalies })}` : ''}
              </Text>
            </div>
            <RunStatusBadge status={open.status} requiresSecondApproval={open.requiresSecondApproval} />
          </li>
        )}
        {moreOpen > 0 && (
          <li className={styles.row}>
            <AppLink to="/billing">{t('myDay.moreOpenRuns', { count: moreOpen })}</AppLink>
          </li>
        )}
        {overdueCount > 0 && (
          <li className={styles.row}>
            <span className={styles.warning}>
              <Warning20Filled aria-hidden />
              <span>
                <AppLink to="/billing/invoices?overdue=true">{t('myDay.overdueInvoices', { count: overdueCount })}</AppLink>
                {canSeeMoney && (
                  <Text block size={200}>
                    {formatMoney(invoices.data?.overdue)}
                  </Text>
                )}
              </span>
            </span>
          </li>
        )}
      </ul>
    </Panel>
  );
}
