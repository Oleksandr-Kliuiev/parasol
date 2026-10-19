import { Badge, Text, makeStyles, tokens } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { AppLink } from '../../shared/components/AppLink';
import { ListFooter } from '../../shared/components/ListFooter';
import { formatDate, formatNumber } from '../../shared/utils/format';
import { useHourBanks } from './api';
import { HoursMeter } from './ContractBadges';

const useStyles = makeStyles({
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  item: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: tokens.spacingHorizontalM, paddingBlock: tokens.spacingVerticalXS },
  name: { fontWeight: tokens.fontWeightSemibold, minWidth: '160px' },
  muted: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  hours: { fontVariantNumeric: 'tabular-nums' },
});

export function HourBankList({ contractId, organizationId }: { contractId?: string; organizationId?: string }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const banks = useHourBanks({ contractId, organizationId, includeClosed: true });
  const data = banks.items;

  if (banks.isPending) return null;
  if (data.length === 0) return <Text className={styles.muted}>{t('contracts.hourBanks.empty')}</Text>;

  return (
    <>
      <ul className={styles.list}>
        {data.map((b) => (
          <li key={b.id} className={styles.item}>
            <AppLink to={`/contracts/hour-banks/${b.id}`} className={styles.name}>
              {b.name}
            </AppLink>
            <HoursMeter remaining={b.remainingHours} purchased={b.purchasedHours} isLow={b.isLow} />
            <span className={styles.hours}>{t('contracts.hourBanks.remainingOf', { remaining: formatNumber(b.remainingHours), purchased: formatNumber(b.purchasedHours) })}</span>
            {b.isLow && b.status === 'Active' && <Badge appearance="tint" color="warning">{t('contracts.hourBanks.low')}</Badge>}
            {b.overageHours > 0 && <Badge appearance="tint" color="danger">{t('contracts.hourBanks.overage', { hours: formatNumber(b.overageHours) })}</Badge>}
            {b.status === 'Closed' && <Badge appearance="outline" color="informative">{t('contracts.hourBanks.closed')}</Badge>}
            <span className={styles.muted}>
              {formatDate(b.validFrom)}
              {b.validTo ? ` – ${formatDate(b.validTo)}` : ''}
              {b.contractNumber && !contractId ? ` · ${b.contractNumber}` : ''}
            </span>
          </li>
        ))}
      </ul>
      <ListFooter shown={data.length} total={banks.total} hasMore={banks.hasNextPage} loading={banks.isFetchingNextPage} onMore={() => void banks.fetchNextPage()} />
    </>
  );
}
