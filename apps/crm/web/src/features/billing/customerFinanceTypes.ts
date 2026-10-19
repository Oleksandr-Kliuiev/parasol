import type { Invoice } from './types';

export type LedgerKind = 'Invoice' | 'CreditNote' | 'Payment' | 'WriteOff' | 'Reversal' | 'Other';
export interface InvoiceLine {
  id: number; sortOrder: number; lineType: string; description: string | null;
  productCode: string | null; unitCode: string | null; quantity: number | null; unitPrice: number | null;
  allowance: number | null; vatRate: number | null; netAmount: number | null; vatAmount: number | null; totalAmount: number | null;
}
export interface InvoiceHistory {
  invoice: Invoice;
  history: null | {
    kind: 'Invoice' | 'CreditNote'; currencyCode: string; netAmount: number; totalAmount: number;
    netPostedAmount: number; totalPostedAmount: number; balance: number; relatedInvoiceNo: string | null; isReversed: boolean;
    lastChangedAt: string; balanceChangedAt: string | null;
    lineCoverage: 'EmptyUnverified' | 'RetrievedUnverified' | 'Reconciled'; lines: InvoiceLine[];
  };
}
export interface InvoiceDocuments {
  invoiceId: string; sourceHasPdf: boolean | null; checkedAt: string | null;
  documents: { id: string; sourceName: string; contentSha256: string; length: number; importedAt: string }[];
}
export interface LedgerItem {
  id: string; organizationId: string | null; lastSeenAt: string; presentInLatestScan: boolean;
  source: { kind: LedgerKind; invoiceNo: string | null; postingDate: string; voucherDate: string; dueDate: string | null;
    amount: number; balance: number; currencyAmount: number; currencyCode: string | null; lastChangedAt: string };
  invoices: { invoiceId: string; invoiceNo: string; sourceVoucherId: string; relation: 'DirectVoucher' | 'MatchGroup' }[];
}
export interface LedgerPage {
  total: number; offset: number; limit: number; entries: LedgerItem[]; sourceCustomers: number; oldestSnapshotAt: string | null;
}
