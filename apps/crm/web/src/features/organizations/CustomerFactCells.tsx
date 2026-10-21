import { makeStyles } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { NoValue } from '../../shared/components/NoValue';
import { formatDate, formatMoney, formatNumber } from '../../shared/utils/format';
import type { CustomerFacts } from './customerFactsContract';
import { ENDING_DAYS, daysUntil } from './customerFactsText';

const useStyles = makeStyles({
  cell: { display: 'grid', gap: '2px', fontSize: '13px', lineHeight: '18px', minWidth: 0 },
  muted: { color: h.muted },
  bad: { color: h.emberT, fontWeight: 600 },
  soon: { color: h.saffronT, fontWeight: 600 },
});

type Facts<K extends keyof CustomerFacts> = NonNullable<CustomerFacts[K]>;

/** Open tasks and meetings, as the activity tab counts them, with what is past its time. */
export function WorkFact({ work }: { work: Facts<'work'> }) {
  const styles = useStyles(); const { t } = useTranslation();
  if (work.open === 0) return <NoValue label={t('customerFacts.noWork')} />;
  return <span className={styles.cell}>
    <span>{t('customerFacts.open', { count: work.open })}</span>
    {work.overdue > 0 && <span className={styles.bad}>{t('customerFacts.overdueWork', { count: work.overdue })}</span>}
  </span>;
}

/** The agreement that ends first, said as ending when it is within the window. */
export function AgreementFact({ agreements, asOf }: { agreements: Facts<'agreements'>; asOf: string }) {
  const styles = useStyles(); const { t } = useTranslation();
  if (agreements.active === 0) return <NoValue label={t('customerFacts.noAgreement')} />;
  const days = agreements.nextEnd ? daysUntil(agreements.nextEnd, asOf) : null;
  return <span className={styles.cell}>
    <span>{agreements.nextEnd ? t('customerFacts.until', { date: formatDate(agreements.nextEnd) }) : t('customerFacts.noEnd')}</span>
    {days !== null && days >= 0 && days <= ENDING_DAYS && <span className={styles.soon}>{t('customerFacts.endsIn', { count: days })}</span>}
    {agreements.active > 1 && <span className={styles.muted}>{t('customerFacts.agreements', { count: agreements.active })}</span>}
  </span>;
}

/** Hours left in the active banks, with the bank's own "running low". */
export function HourBankFact({ hourBanks }: { hourBanks: Facts<'hourBanks'> }) {
  const styles = useStyles(); const { t } = useTranslation();
  if (hourBanks.active === 0) return <NoValue label={t('customerFacts.noHourBank')} />;
  return <span className={styles.cell}>
    <span>{t('customerFacts.hoursLeft', { hours: formatNumber(hourBanks.remainingHours) })}</span>
    {hourBanks.low && <span className={styles.bad}>{t('customerFacts.low')}</span>}
  </span>;
}

/** What is overdue first, then what is open; amounts only for a role that may see money (the counts otherwise). */
export function InvoiceFact({ invoices }: { invoices: Facts<'invoices'> }) {
  const styles = useStyles(); const { t } = useTranslation();
  if (invoices.open === 0) return <NoValue label={t('customerFacts.noInvoices')} />;
  return <span className={styles.cell}>
    {invoices.overdue > 0 && <span className={styles.bad}>{invoices.overdueAmount != null
      ? t('customerFacts.overdueAmount', { amount: formatMoney(invoices.overdueAmount) }) : t('customerFacts.overdueInvoices', { count: invoices.overdue })}</span>}
    <span className={invoices.overdue > 0 ? styles.muted : undefined}>{invoices.outstanding != null
      ? t('customerFacts.outstanding', { amount: formatMoney(invoices.outstanding) }) : t('customerFacts.openInvoices', { count: invoices.open })}</span>
  </span>;
}
