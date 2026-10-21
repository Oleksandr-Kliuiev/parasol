import { makeStyles, mergeClasses } from '@fluentui/react-components';
import { Clock20Regular, DocumentText20Regular, Receipt20Regular, TaskListSquareLtr20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { StatGrid, StatTile } from '../../shared/components/KpiTile';
import { formatDate, formatMoney, formatNumber } from '../../shared/utils/format';
import { useActivities } from '../activities/api';
import { useInvoices } from '../billing/api';
import { useContracts, useHourBanks } from '../contracts/api';

/** Router state of a highlight link: the card moves focus to the tab it opened (the link itself unmounts with the overview). */
const openedTab = { focusTab: true } as const;

const useStyles = makeStyles({
  // The facts share the row (no empty column after the last one); the grid's own phone rule puts two side by side.
  grid: { gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))', marginBottom: '16px' },
  // Four facts make two rows of two until one row holds all four: never three and one left alone (768 px).
  four: { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', '@media (min-width: 1101px)': { gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' } },
});

/**
 * The state of the relationship at a glance, before the technical detail (UX 2026 §4): the agreement, the hours left
 * in its banks, the open work and the money. Each figure comes from the list its tab reads, shows only to a role that
 * may read that list, and opens the tab. A figure that could not be read says so instead of showing a zero.
 */
export function CustomerHighlights({ organizationId }: { organizationId: string }) {
  const { t } = useTranslation();
  const styles = useStyles();
  const canContracts = useCan(Permissions.contractsRead);
  const canActivities = useCan(Permissions.activitiesRead);
  const canBilling = useCan(Permissions.billingRead);
  const canMoney = useCan(Permissions.financeRead);
  const contracts = useContracts({ organizationId, status: 'Active', limit: 5 }, canContracts);
  const banks = useHourBanks({ organizationId }, canContracts);
  const work = useActivities({ organizationId, open: true }, canActivities, 1);
  const money = useInvoices({ organizationId, openOnly: true, limit: 1 }, canBilling);
  if (!canContracts && !canActivities && !canBilling) return null;

  const pending = t('myDay.loadingValue');
  const unread = t('organizations.highlights.unread');
  const hours = (value: number) => t('myDay.kpi.hoursValue', { hours: formatNumber(value) });

  const agreements = contracts.data?.pages.flatMap((page) => page.items) ?? [];
  const agreementTotal = contracts.data?.pages.at(-1)?.totalCount ?? 0;
  const first = agreements[0];
  const agreementNote = first
    ? [first.slaName, first.endDate ? t('organizations.highlights.until', { date: formatDate(first.endDate) }) : t('organizations.highlights.noEnd'),
      agreementTotal > 1 ? t('organizations.highlights.more', { count: agreementTotal - 1 }) : null].filter(Boolean).join(' · ')
    : t('organizations.highlights.noAgreement');

  const activeBanks = banks.items.filter((bank) => bank.status === 'Active');
  const remaining = activeBanks.reduce((sum, bank) => sum + bank.remainingHours, 0);
  const purchased = activeBanks.reduce((sum, bank) => sum + bank.purchasedHours, 0);
  // Low as the contract module defines it for each bank, not by a threshold of this page.
  const low = activeBanks.some((bank) => bank.purchasedHours > 0 && (bank.remainingHours / bank.purchasedHours) * 100 <= bank.lowBalancePct);
  // The sum covers the banks read; more than one page of banks is said, never summed silently (DEV-12).
  const partialBanks = banks.hasNextPage && banks.total !== null
    ? t('organizations.highlights.firstBanks', { shown: banks.items.length, total: banks.total }) : null;

  const overdue = money.data?.overdue ?? 0;

  return (
    <StatGrid label={t('organizations.highlights.label')} className={mergeClasses(styles.grid, canContracts && canActivities && canBilling && styles.four)}>
      {canContracts && (
        <StatTile
          icon={<DocumentText20Regular />}
          tone="iris"
          label={t('organizations.highlights.agreement')}
          value={contracts.isPending ? pending : contracts.isError ? '—' : first ? t('organizations.highlights.active') : t('organizations.highlights.none')}
          status={first ? 'good' : undefined}
          note={contracts.isError ? unread : contracts.isPending ? undefined : agreementNote}
          to="?tab=contracts" replace state={openedTab}
        />
      )}
      {canContracts && (
        <StatTile
          icon={<Clock20Regular />}
          tone="spruce"
          label={t('organizations.highlights.hourBank')}
          value={banks.isPending ? pending : banks.isError ? '—' : activeBanks.length ? hours(remaining) : t('organizations.highlights.none')}
          status={low ? 'bad' : undefined}
          note={banks.isError ? unread : banks.isPending ? undefined : [activeBanks.length
            ? t(low ? 'organizations.highlights.leftOfLow' : 'organizations.highlights.leftOf', { hours: hours(purchased), count: activeBanks.length })
            : t('organizations.highlights.noHourBank'), partialBanks].filter(Boolean).join(' · ')}
          to="?tab=contracts" replace state={openedTab}
        />
      )}
      {canActivities && (
        <StatTile
          icon={<TaskListSquareLtr20Regular />}
          tone="ember"
          label={t('organizations.highlights.openWork')}
          value={work.isPending ? pending : work.isError ? '—' : formatNumber(work.total ?? 0)}
          note={work.isError ? unread : t('organizations.highlights.openWorkNote')}
          to="?tab=activities" replace state={openedTab}
        />
      )}
      {canBilling && (
        <StatTile
          icon={<Receipt20Regular />}
          tone="saffron"
          label={t('organizations.highlights.outstanding')}
          // No open invoice is said as such, not as an amount of zero; "overdue" is counted on today's date, which needs no stamp.
          value={money.isPending ? pending : money.isError || !money.data ? '—' : money.data.count === 0 ? t('organizations.highlights.none')
            : canMoney ? formatMoney(money.data.outstanding ?? 0) : t('organizations.highlights.openInvoices', { count: money.data.count })}
          status={canMoney && overdue > 0 ? 'bad' : undefined}
          note={money.isError ? unread : !money.data ? undefined : money.data.count === 0 ? t('organizations.highlights.noOpenInvoices')
            : canMoney ? (overdue > 0 ? t('organizations.highlights.overdue', { amount: formatMoney(overdue) }) : t('organizations.highlights.noOverdue'))
            : undefined}
          to="?tab=invoices" replace state={openedTab}
        />
      )}
    </StatGrid>
  );
}
