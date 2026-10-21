import { Text, mergeClasses } from '@fluentui/react-components';
import { Warning20Filled } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { Panel } from '../../shared/components/Panel';
import { formatDate, formatMoney, todayIso } from '../../shared/utils/format';
import { usePeriods } from '../time/api';
import { monthName } from '../time/monthName';
import { RunStatusBadge } from '../billing/shared';
import { monthLabel } from '../billing/period';
import { useOpportunities } from '../sales/api';
import { useLicensingAttention } from '../licensing/api';
import { useInvoices, useRuns } from '../billing/api';
import { useMyDayStyles } from './myDayStyles';

/** Deals nobody has touched for 30 days (BR-SAL-03): the reminder lives here instead of in e-mail. */
export function StaleDealsPanel() {
  const styles = useMyDayStyles();
  const { t } = useTranslation();
  const canSeeMoney = useCan(Permissions.financeRead);
  // The eight that have waited longest to close first; the count says how many there are in all (DEV-12).
  const deals = useOpportunities({ mine: true, stale: true }, true, 8);
  const { items: data, isPending } = deals;

  if (isPending || data.length === 0) return null;

  return (
    <Panel title={t('myDay.staleDeals')}>
      <ul className={mergeClasses(styles.list, 'h-stagger')}>
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
export function LicensingAttentionPanel() {
  const styles = useMyDayStyles();
  const { t } = useTranslation();
  const { data } = useLicensingAttention();
  const closing = data?.cancellationWindow ?? [];
  // The summary counts every subscription; the lists only hold the first twenty of each kind (DEV-12).
  const notBilledCount = data?.summary.notBilled ?? 0;

  if (closing.length === 0 && notBilledCount === 0) return null;

  return (
    <Panel title={t('myDay.licensingAttention')}>
      <ul className={mergeClasses(styles.list, 'h-stagger')}>
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
export function BillingPanel() {
  const styles = useMyDayStyles();
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
      <ul className={mergeClasses(styles.list, 'h-stagger')}>
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

/**
 * What waits for the team lead's approval: the open months of this year that hold entries in the "New" state, each with its
 * count and a link to exactly those entries (the periods list counts them; nothing is estimated here).
 */
export function HoursReviewPanel() {
  const styles = useMyDayStyles();
  const { t, i18n } = useTranslation();
  const year = Number(todayIso().slice(0, 4));
  const periods = usePeriods(year);
  const waiting = (periods.data ?? []).filter((p) => !p.isClosed && p.newEntries > 0).sort((a, b) => b.month - a.month);
  return (
    <Panel title={t('myDay.hoursReview')}>
      {periods.isError ? <Text block className={styles.muted}>{t('organizations.highlights.unread')}</Text>
        : periods.isPending ? <Text block className={styles.muted}>{t('common.loading')}</Text>
        : waiting.length === 0 ? <Text block className={styles.muted}>{t('myDay.hoursReviewNone', { year })}</Text>
        : <ul className={styles.list}>{waiting.map((p) => (
            <li key={p.month}>
              <AppLink to={`/time/entries?year=${p.year}&month=${p.month}&status=New`}>
                {t('myDay.hoursReviewMonth', { month: monthName(p.year, p.month, i18n.language), count: p.newEntries })}
              </AppLink>
            </li>))}</ul>}
      <AppLink to="/time/entries">{t('myDay.hoursReviewOpen')}</AppLink>
    </Panel>
  );
}
