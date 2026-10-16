import { CURRENCY_GROUP_KEYS, MAX_TOTAL_COUNT, POWEROFFICE_CURRENCIES, powerOfficeError } from './contracts.ts';
import type { CurrencyGroup, InvoiceSummary, PowerOfficeCurrency } from './contracts.ts';
import type { Invoice } from './dto.ts';
import { isCount, readArray, readRecord } from './dto.ts';
import { formatSum, parseAmount, parseSum } from './money.ts';

/**
 * The exact bounded aggregate (docs/stage4/02_CONTRACTS.md): {totalCount, currencies}, currencies lexically sorted and
 * unique, each group exactly {currency, count, openInvoiceCount, overdueInvoiceCount, creditNoteCount,
 * outstandingInvoiceAmount, outstandingCreditAmount}. Counts 0..10000 (a present group has count >= 1), sums canonical
 * 2-decimal strings of at most 19 integer digits; creditNoteCount <= count, openInvoiceCount <= count - creditNoteCount,
 * overdueInvoiceCount <= openInvoiceCount; open invoices exist exactly when the outstanding invoice sum is positive; no
 * credit outstanding without a credit note; totalCount = sum(count). Known empty is {totalCount: 0, currencies: []};
 * missing/unavailable is null, never this object. The snapshot guard of migration 202610091210 enforces the same rules.
 */
const CURRENCIES: readonly string[] = POWEROFFICE_CURRENCIES;
const invalid = () => powerOfficeError('POWEROFFICE_DTO_INVALID');

/** Strictly validated, detached and frozen copy of an aggregate (from computation or storage); DTO_INVALID otherwise. */
export function validateSummary(raw: unknown): InvoiceSummary {
  const r = readRecord(raw, ['totalCount', 'currencies']);
  const totalCount = r.get('totalCount');
  if (!isCount(totalCount, 0, MAX_TOTAL_COUNT)) throw invalid();
  let previous = '';
  let sum = 0;
  const currencies = readArray(r.get('currencies'), CURRENCIES.length).map((value): CurrencyGroup => {
    const g = readRecord(value, CURRENCY_GROUP_KEYS);
    const currency = g.get('currency'); const count = g.get('count'); const open = g.get('openInvoiceCount');
    const overdue = g.get('overdueInvoiceCount'); const credit = g.get('creditNoteCount');
    const invoiceAmount = g.get('outstandingInvoiceAmount'); const creditAmount = g.get('outstandingCreditAmount');
    const invoiceMinor = parseSum(invoiceAmount); const creditMinor = parseSum(creditAmount);
    if (typeof currency !== 'string' || !CURRENCIES.includes(currency) || currency <= previous || !isCount(count, 1, MAX_TOTAL_COUNT)
      || !isCount(credit, 0, count) || !isCount(open, 0, count - credit) || !isCount(overdue, 0, open)
      || invoiceMinor === null || creditMinor === null || (open === 0) !== (invoiceMinor === 0n) || (credit === 0 && creditMinor !== 0n)) throw invalid();
    previous = currency;
    sum += count;
    return Object.freeze({ currency: currency as PowerOfficeCurrency, count, openInvoiceCount: open, overdueInvoiceCount: overdue,
      creditNoteCount: credit, outstandingInvoiceAmount: invoiceAmount as string, outstandingCreditAmount: creditAmount as string });
  });
  if (sum !== totalCount) throw invalid();
  return Object.freeze({ totalCount, currencies: Object.freeze(currencies) });
}

interface Bucket { count: number; open: number; overdue: number; credit: number; invoiceMinor: bigint; creditMinor: bigint }
/**
 * Exact grouped aggregation of validated invoices for one fixed business date (YYYY-MM-DD, Europe/Oslo of the claim asOf).
 * BigInt minor units; INVOICE and CREDIT_NOTE magnitudes stay separate; currencies never combine. An invoice is open when
 * outstanding > 0 and overdue when also dueDate < businessDate. Credit notes are counted, never netted or "open".
 */
export class SummaryBuilder {
  readonly #buckets = new Map<PowerOfficeCurrency, Bucket>();
  #total = 0;
  readonly businessDate: string;
  constructor(businessDate: string) { this.businessDate = businessDate; }
  add(invoice: Invoice): void {
    const outstanding = parseAmount(invoice.outstanding);
    if (outstanding === null) throw invalid();
    const b = this.#buckets.get(invoice.currency) ?? { count: 0, open: 0, overdue: 0, credit: 0, invoiceMinor: 0n, creditMinor: 0n };
    b.count++;
    if (invoice.kind === 'CREDIT_NOTE') { b.credit++; b.creditMinor += outstanding; }
    else {
      b.invoiceMinor += outstanding;
      if (outstanding > 0n) { b.open++; if (invoice.dueDate < this.businessDate) b.overdue++; }
    }
    this.#buckets.set(invoice.currency, b);
    this.#total++;
  }
  /** The validated frozen aggregate; known empty when nothing was added. */
  build(): InvoiceSummary {
    const currencies = [...this.#buckets.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([currency, b]) => ({
      currency, count: b.count, openInvoiceCount: b.open, overdueInvoiceCount: b.overdue, creditNoteCount: b.credit,
      outstandingInvoiceAmount: formatSum(b.invoiceMinor), outstandingCreditAmount: formatSum(b.creditMinor) }));
    return validateSummary({ totalCount: this.#total, currencies });
  }
}
