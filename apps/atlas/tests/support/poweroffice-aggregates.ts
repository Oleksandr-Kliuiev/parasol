/**
 * One adversarial aggregate corpus for BOTH validators: packages/poweroffice/aggregate.ts validateSummary (unit test) and
 * the SQL snapshot guard of migration 202610091210 (PostgreSQL test). `valid` is the single expected verdict, so the two
 * implementations are checked against the same cases rather than against each other's code.
 */
export interface AggregateCase { label: string; value: unknown; valid: boolean }
const group = (currency: string, over: Record<string, unknown> = {}) => ({ currency, count: 2, openInvoiceCount: 1, overdueInvoiceCount: 1, creditNoteCount: 1,
  outstandingInvoiceAmount: '1250.50', outstandingCreditAmount: '99.99', ...over });
const one = (over: Record<string, unknown>, total = 2) => ({ totalCount: total, currencies: [group('NOK', over)] });
const without = (o: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));
const SIX = ['DKK', 'EUR', 'GBP', 'NOK', 'SEK', 'USD'];

export const AGGREGATE_CASES: readonly AggregateCase[] = [
  { label: 'known empty', value: { totalCount: 0, currencies: [] }, valid: true },
  { label: 'two currencies', value: { totalCount: 3, currencies: [group('EUR', { count: 1, creditNoteCount: 0, overdueInvoiceCount: 0, outstandingCreditAmount: '0.00' }), group('NOK')] }, valid: true },
  { label: 'all six sorted', value: { totalCount: 12, currencies: SIX.map(c => group(c)) }, valid: true },
  { label: 'maximum 10000 in one group, 19-digit sum', value: { totalCount: 10000, currencies: [group('NOK', { count: 10000, openInvoiceCount: 10000,
    overdueInvoiceCount: 10000, creditNoteCount: 0, outstandingInvoiceAmount: '9999999999999999900.00', outstandingCreditAmount: '0.00' })] }, valid: true },
  { label: 'credit notes only', value: one({ count: 1, creditNoteCount: 1, openInvoiceCount: 0, overdueInvoiceCount: 0, outstandingInvoiceAmount: '0.00' }, 1), valid: true },
  { label: 'credit note with zero outstanding', value: one({ count: 1, creditNoteCount: 1, openInvoiceCount: 0, overdueInvoiceCount: 0,
    outstandingInvoiceAmount: '0.00', outstandingCreditAmount: '0.00' }, 1), valid: true },
  { label: 'paid invoice only', value: one({ count: 1, creditNoteCount: 0, openInvoiceCount: 0, overdueInvoiceCount: 0, outstandingInvoiceAmount: '0.00',
    outstandingCreditAmount: '0.00' }, 1), valid: true },
  { label: 'extra top-level key', value: { totalCount: 0, currencies: [], asOf: '2026-01-01' }, valid: false },
  { label: 'missing currencies', value: { totalCount: 0 }, valid: false },
  { label: 'string total', value: { totalCount: '0', currencies: [] }, valid: false },
  { label: 'fractional total', value: { totalCount: 1.5, currencies: [] }, valid: false },
  { label: 'negative total', value: { totalCount: -1, currencies: [] }, valid: false },
  { label: 'total above 10000', value: { totalCount: 10001, currencies: [group('NOK', { count: 10001 })] }, valid: false },
  { label: 'total mismatch', value: one({}, 3), valid: false },
  { label: 'currencies object', value: { totalCount: 0, currencies: {} }, valid: false },
  { label: 'seven groups', value: { totalCount: 14, currencies: [...SIX, 'USD'].map(c => group(c)) }, valid: false },
  { label: 'duplicate currency', value: { totalCount: 4, currencies: [group('NOK'), group('NOK')] }, valid: false },
  { label: 'unsorted currencies', value: { totalCount: 4, currencies: [group('NOK'), group('EUR')] }, valid: false },
  { label: 'lower-case currency', value: one({ currency: 'nok' }), valid: false },
  { label: 'unknown currency', value: one({ currency: 'CHF' }), valid: false },
  { label: 'currency with zero-width space', value: one({ currency: 'NOK​' }), valid: false },
  { label: 'group extra key', value: one({ invoiceIds: [] }), valid: false },
  { label: 'group missing key', value: { totalCount: 2, currencies: [without(group('NOK'), 'overdueInvoiceCount')] }, valid: false },
  { label: 'empty group', value: one({ count: 0, openInvoiceCount: 0, overdueInvoiceCount: 0, creditNoteCount: 0, outstandingInvoiceAmount: '0.00',
    outstandingCreditAmount: '0.00' }, 0), valid: false },
  { label: 'string count', value: one({ count: '2' }), valid: false },
  { label: 'credit above count', value: one({ creditNoteCount: 3, openInvoiceCount: 0, overdueInvoiceCount: 0, outstandingInvoiceAmount: '0.00' }), valid: false },
  { label: 'open above invoices', value: one({ openInvoiceCount: 2, overdueInvoiceCount: 0 }), valid: false },
  { label: 'overdue above open', value: one({ overdueInvoiceCount: 2 }), valid: false },
  { label: 'one decimal', value: one({ outstandingInvoiceAmount: '1250.5' }), valid: false },
  { label: 'leading zero', value: one({ outstandingInvoiceAmount: '01250.50' }), valid: false },
  { label: 'signed amount', value: one({ outstandingCreditAmount: '-99.99' }), valid: false },
  { label: 'exponent', value: one({ outstandingInvoiceAmount: '1e3' }), valid: false },
  { label: 'numeric amount', value: one({ outstandingInvoiceAmount: 1250.5 }), valid: false },
  { label: 'twenty integer digits', value: one({ outstandingInvoiceAmount: '10000000000000000000.00' }), valid: false },
  { label: 'full-width digits', value: one({ outstandingInvoiceAmount: '１２５０.５０' }), valid: false },
  { label: 'open invoices with zero outstanding', value: one({ outstandingInvoiceAmount: '0.00' }), valid: false },
  { label: 'outstanding without open invoices', value: one({ openInvoiceCount: 0, overdueInvoiceCount: 0 }), valid: false },
  { label: 'credit outstanding without credit notes', value: one({ creditNoteCount: 0 }), valid: false },
  { label: 'null', value: null, valid: false },
  { label: 'array', value: [], valid: false },
  { label: 'group string', value: { totalCount: 0, currencies: ['NOK'] }, valid: false },
];
