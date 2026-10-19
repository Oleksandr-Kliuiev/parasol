import type { Invoice } from '../features/billing/types';
import type { InvoiceDocuments, InvoiceHistory, LedgerItem, LedgerPage } from '../features/billing/customerFinanceTypes';

export const financeInvoice = (id = 'invoice-a', organizationId = 'customer-a'): Invoice => ({
  id, system: 'poweroffice', invoiceNo: id === 'invoice-a' ? '10001' : '10002', organization: { id: organizationId, name: 'Synthetic customer' },
  orderNo: null, basisId: null, invoiceDate: '2026-01-01', dueDate: '2026-01-15', totalIncVat: 1250, outstanding: 250,
  status: 'PartiallyPaid', isOverdue: true, url: null, syncedAt: '2026-10-18T10:00:00Z', movements: [],
  documentKind: 'Invoice', documentCurrencyCode: 'EUR', lineCoverage: 'Reconciled', lineCount: 1,
});
export const financeHistory = (id = 'invoice-a', organizationId = 'customer-a'): InvoiceHistory => ({
  invoice: financeInvoice(id, organizationId), history: {
    kind: 'Invoice', currencyCode: 'EUR', netAmount: 80, totalAmount: 100, netPostedAmount: 1000, totalPostedAmount: 1250, balance: 250,
    relatedInvoiceNo: null, isReversed: false, lastChangedAt: '2026-10-18T10:00:00Z', balanceChangedAt: '2026-10-18T10:00:00Z',
    lineCoverage: 'Reconciled', lines: [{ id: 71, sortOrder: 0, lineType: 'Normal', description: 'Synthetic support service', productCode: 'SUPPORT',
      unitCode: 'HUR', quantity: 2, unitPrice: 40, allowance: null, vatRate: .25, netAmount: 80, vatAmount: 20, totalAmount: 100 }],
  },
});
export const financeDocuments = (id = 'invoice-a'): InvoiceDocuments => ({ invoiceId: id, sourceHasPdf: true, checkedAt: '2026-10-18T10:00:00Z',
  documents: [{ id: 'pdf-a', sourceName: 'Synthetic-invoice.pdf', contentSha256: 'a'.repeat(64), length: 1024, importedAt: '2026-10-18T10:00:00Z' }] });
export const financeEntry = (id = 'payment-a', organizationId = 'customer-a'): LedgerItem => ({ id, organizationId, lastSeenAt: '2026-10-18T10:00:00Z', presentInLatestScan: true,
  source: { kind: 'Payment', invoiceNo: '10001', postingDate: '2026-01-10', voucherDate: '2026-01-10', dueDate: null,
    amount: -1000, balance: 0, currencyAmount: -80, currencyCode: 'EUR', lastChangedAt: '2026-10-18T10:00:00Z' },
  invoices: [{ invoiceId: 'invoice-a', invoiceNo: '10001', sourceVoucherId: 'synthetic-voucher', relation: 'MatchGroup' }],
});
export const financeLedger = (entries: LedgerItem[] = [financeEntry()]): LedgerPage => ({ total: entries.length, offset: 0, limit: 25, entries,
  sourceCustomers: 1, oldestSnapshotAt: '2026-10-18T10:00:00Z' });
