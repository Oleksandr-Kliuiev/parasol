import { Badge, makeStyles } from '@fluentui/react-components';
import { HourglassHalf16Regular, HourglassHalf24Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ListFooter } from '../../shared/components/ListFooter';
import { formatDate, formatNumber } from '../../shared/utils/format';
import { RecordCell } from '../organizations/RecordCell';
import { useHourBanks } from './api';
import { HoursMeter } from './ContractBadges';
import { h } from '../../app/hearth';

const useStyles = makeStyles({
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' },
  // One bank per row, hairlines between them, like the reference's quiet table rows: the bank on the left, its balance right.
  item: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '6px 16px',
    paddingTop: '4px',
    paddingBottom: '4px',
    borderBottom: `1px solid ${h.line}`,
    ':last-child': { borderBottom: 'none' },
  },
  name: { fontWeight: 700 },
  balance: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: '6px 12px' },
  hours: { fontVariantNumeric: 'tabular-nums', fontSize: '13px', fontWeight: 600, whiteSpace: 'nowrap' },
});

export function HourBankList({ contractId, organizationId }: { contractId?: string; organizationId?: string }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const banks = useHourBanks({ contractId, organizationId, includeClosed: true });
  const data = banks.items;

  if (banks.isPending) return null;
  if (data.length === 0) return <EmptyState icon={<HourglassHalf24Regular />} message={t('contracts.hourBanks.empty')} />;

  return (
    <>
      <ul className={`${styles.list} h-stagger`}>
        {data.map((b) => (
          <li key={b.id} className={styles.item}>
            <RecordCell
              icon={<HourglassHalf16Regular />}
              tone="saffron"
              name={<AppLink to={`/contracts/hour-banks/${b.id}`} className={styles.name}>{b.name}</AppLink>}
              meta={[
                <span className="tabular">{formatDate(b.validFrom)}{b.validTo ? ` – ${formatDate(b.validTo)}` : ''}</span>,
                b.contractNumber && !contractId && <span>{b.contractNumber}</span>,
              ]}
            />
            <span className={styles.balance}>
              {b.isLow && b.status === 'Active' && <Badge appearance="tint" color="warning">{t('contracts.hourBanks.low')}</Badge>}
              {b.overageHours > 0 && <Badge appearance="tint" color="danger">{t('contracts.hourBanks.overage', { hours: formatNumber(b.overageHours) })}</Badge>}
              {b.status === 'Closed' && <Badge appearance="tint" color="subtle">{t('contracts.hourBanks.closed')}</Badge>}
              <HoursMeter remaining={b.remainingHours} purchased={b.purchasedHours} isLow={b.isLow} />
              <span className={styles.hours}>{t('contracts.hourBanks.remainingOf', { remaining: formatNumber(b.remainingHours), purchased: formatNumber(b.purchasedHours) })}</span>
            </span>
          </li>
        ))}
      </ul>
      <ListFooter shown={data.length} total={banks.total} hasMore={banks.hasNextPage} loading={banks.isFetchingNextPage} onMore={() => void banks.fetchNextPage()} />
    </>
  );
}
