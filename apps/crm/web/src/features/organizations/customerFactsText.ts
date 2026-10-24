import { formatDate, formatMoney } from '../../shared/utils/format';
import type { CustomerFacts } from './customerFactsContract';

/** An agreement that ends within this many days is named as ending (the attention view uses the same window). */
export const ENDING_DAYS = 60;

/** Whole days from `asOf` to `date` (both YYYY-MM-DD, the Oslo day the server measured against). */
export const daysUntil = (date: string, asOf: string) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 86_400_000);

/** The facts that ask for a look, as short phrases: for a phone card and the attention view. Quiet facts are left out. */
export function attentionPhrases(facts: CustomerFacts, asOf: string, t: (key: string, options?: Record<string, unknown>) => string): string[] {
  const days = facts.agreements?.nextEnd ? daysUntil(facts.agreements.nextEnd, asOf) : null;
  return [
    facts.invoices && facts.invoices.overdue > 0 && (facts.invoices.overdueAmount != null
      ? t('customerFacts.overdueAmount', { amount: formatMoney(facts.invoices.overdueAmount) }) : t('customerFacts.overdueInvoices', { count: facts.invoices.overdue })),
    facts.work && facts.work.overdue > 0 && t('customerFacts.overdueWork', { count: facts.work.overdue }),
    days !== null && days >= 0 && days <= ENDING_DAYS && t('customerFacts.agreementEnds', { date: formatDate(facts.agreements!.nextEnd) }),
    facts.hourBanks?.low && t('customerFacts.hourBankLow'),
  ].filter((phrase): phrase is string => Boolean(phrase));
}
