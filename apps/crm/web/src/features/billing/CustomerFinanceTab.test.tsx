import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useParams } from 'react-router';
import { renderRoutes, testUser } from '../../test/renderWithProviders';
import { financeDocuments, financeEntry, financeHistory, financeInvoice, financeLedger } from '../../test/customerFinance';
import { CustomerFinanceTab } from './CustomerFinanceTab';
import { OrganizationInvoicesTab } from './InvoicesPage';
import { CustomerInvoiceDetail } from './CustomerInvoiceDetail';
import { CustomerLedgerPanel } from './CustomerLedgerPanel';
import { CustomerInvoiceDocuments } from './CustomerInvoiceDocuments';

const permissions = ['customers.read', 'billing.read', 'finance.read'];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const summary = () => ({ invoices: [financeInvoice(), { ...financeInvoice('invoice-b'), documentKind: 'CreditNote', outstanding: -1250, totalIncVat: -1250 }],
  count: 2, nextCursor: null, outstanding: -1000, overdue: 250, asOf: '2026-10-18' });
const defaults = (url: string) => {
  if (url.includes('/history')) return json(financeHistory());
  if (url.includes('/documents')) return json(financeDocuments());
  if (url.includes('/customer-ledger')) return json(financeLedger());
  if (url.includes('/invoices?')) return json(summary());
  throw new Error('Unexpected synthetic request');
};
function mount(element = <CustomerFinanceTab organizationId="customer-a" />, grants = permissions) {
  return renderRoutes([{ path: '*', element }], '/', testUser(grants));
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function RoutedFinance() { const { organizationId = '' } = useParams(); return <CustomerFinanceTab organizationId={organizationId} />; }

describe('Customer imported finances', () => {
  it('opens invoices and credit notes, shows document currency and returns keyboard focus to the selected invoice', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => defaults(url)));
    const user = userEvent.setup(); mount();
    expect(await screen.findByText('Invoice 10001')).toBeVisible();
    expect(screen.getByText('Credit note 10002')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'View 10001' }));
    expect(screen.getByRole('heading', { name: 'Document details' })).toHaveFocus();
    expect(await screen.findByText('Synthetic support service')).toBeVisible();
    expect(screen.getByText('Net · EUR')).toBeVisible();
    expect(screen.queryByText(/NOK/)).not.toBeInTheDocument();
    expect(screen.getByText('25%')).toBeVisible();
    expect(await screen.findByRole('button', { name: 'Download PDF 1' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Back to invoices' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'View 10001' })).toHaveFocus());
  });

  it.each([{ grants: [] }, { grants: ['billing.read'] }, { grants: ['finance.read'] }])('does not mount protected queries without both grants: $grants', async ({ grants }) => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); mount(undefined, grants);
    expect(screen.queryByText('Customer finance')).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves the existing BillingRead-only summary without requesting protected history, ledger or PDFs', async () => {
    const fetch = vi.fn(async () => json(summary())); vi.stubGlobal('fetch', fetch);
    mount(<OrganizationInvoicesTab organizationId="customer-a" />, ['billing.read']);
    expect(await screen.findByText('10001')).toBeVisible();
    expect(fetch.mock.calls).toHaveLength(1);
    expect(screen.queryByText('1250')).not.toBeInTheDocument();
  });

  it('distinguishes posted payments, signed refunds, write-offs and inactive historical copies', async () => {
    let onlyPayments = true;
    const refund = financeEntry('refund'); refund.source.amount = 500; refund.source.currencyAmount = 40; refund.invoices = [];
    const inactive = financeEntry('historical'); inactive.presentInLatestScan = false; inactive.invoices = [];
    const writeOff = financeEntry('writeoff'); writeOff.source.kind = 'WriteOff';
    const fetch = vi.fn(async (url: string) => { onlyPayments = url.includes('kind=Payment'); return json(financeLedger(onlyPayments ? [financeEntry(), refund, inactive] : [writeOff])); });
    vi.stubGlobal('fetch', fetch); const user = userEvent.setup(); mount(<CustomerLedgerPanel organizationId="customer-a" onInvoice={vi.fn()} />);
    expect((await screen.findAllByText('-1,000')).length).toBeGreaterThan(0);
    expect(screen.getByText('500')).toBeVisible();
    expect(screen.getByText(/Absent from the latest scan/)).toBeVisible();
    expect(screen.getAllByText(/No confirmed invoice link/)).toHaveLength(2);
    await user.click(screen.getByRole('switch', { name: 'Only posted payments' }));
    expect(await screen.findByText('Write-off')).toBeVisible();
    expect(onlyPayments).toBe(false);
    expect(screen.queryByText('Posted payment')).not.toBeInTheDocument();
  });

  it('paginates posted payments on the server and opens an exact related invoice', async () => {
    const open = vi.fn();
    const fetch = vi.fn(async (url: string) => {
      const offset = new URL(url, 'https://synthetic.invalid').searchParams.get('offset');
      return json({ ...financeLedger([financeEntry(offset === '0' ? 'first' : 'second')]), offset: Number(offset), total: 2 });
    });
    vi.stubGlobal('fetch', fetch); const user = userEvent.setup(); mount(<CustomerLedgerPanel organizationId="customer-a" onInvoice={open} />);
    expect(await screen.findByText('Showing 1 of 2')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Showing 2 of 2')).toBeVisible();
    expect(fetch.mock.calls.at(-1)?.[0]).toContain('offset=1');
    expect(fetch.mock.calls.at(-1)?.[0]).toContain('kind=Payment');
    await user.click(screen.getAllByRole('button', { name: 'Open related 10001' })[0]!);
    expect(open).toHaveBeenCalledWith('invoice-a');
  });

  it('does not render a foreign customer history or ledger response', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('history') ? json(financeHistory('invoice-a', 'customer-b')) : json(financeLedger([financeEntry('foreign', 'customer-b')]))));
    mount(<CustomerInvoiceDetail organizationId="customer-a" invoiceId="invoice-a" onInvoice={vi.fn()} />);
    expect(await screen.findByText('The customer context changed. Refresh the customer card before opening these records.')).toBeVisible();
    expect(screen.queryByText('Synthetic support service')).not.toBeInTheDocument();
  });

  it('blocks a foreign ledger page before displaying amounts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(financeLedger([financeEntry('foreign', 'customer-b')]))));
    mount(<CustomerLedgerPanel organizationId="customer-a" onInvoice={vi.fn()} />);
    expect(await screen.findByText('The customer context changed. Refresh the customer card before opening these records.')).toBeVisible();
    expect(screen.queryByText('-1,000')).not.toBeInTheDocument();
  });

  it('shows a retryable invoice error and does not present stale money after a failed refresh', async () => {
    let fail = false; vi.stubGlobal('fetch', vi.fn(async (url: string) => fail ? json({ detail: 'Synthetic finance unavailable' }, 503) : defaults(url)));
    const user = userEvent.setup(); mount();
    expect(await screen.findByText('Invoice 10001')).toBeVisible();
    fail = true; await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Synthetic finance unavailable')).toBeVisible();
    expect(screen.queryByText('Invoice 10001')).not.toBeInTheDocument();
    fail = false; await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Invoice 10001')).toBeVisible();
  });

  it('keeps imported PDF versions available when the source no longer advertises a PDF and reports integrity failures', async () => {
    const data = financeDocuments(); data.sourceHasPdf = false;
    data.documents.push({ ...data.documents[0]!, id: 'pdf-b' });
    const fetch = vi.fn(async (url: string) => url.includes('download') ? json({ code: 'BIL_DOCUMENT_INTEGRITY' }, 500) : json(data));
    vi.stubGlobal('fetch', fetch); const user = userEvent.setup(); mount(<CustomerInvoiceDocuments organizationId="customer-a" invoiceId="invoice-a" />);
    expect(await screen.findByText(/PowerOffice reported no PDF/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Download PDF 2' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('PDF download failed');
    expect(fetch.mock.calls.at(-1)?.[0]).toBe('/api/v1/billing/invoices/invoice-a/documents/pdf-b/download?organizationId=customer-a');
    expect(screen.getByRole('button', { name: 'Download PDF 1' })).toBeEnabled();
  });

  it.each([['notChecked', null, null], ['noSource', false, '2026-10-18T10:00:00Z'], ['unavailable', null, '2026-10-18T10:00:00Z']] as const)(
    'distinguishes PDF absence states: %s', async (_state, hasPdf, checkedAt) => {
      vi.stubGlobal('fetch', vi.fn(async () => json({ ...financeDocuments(), documents: [], sourceHasPdf: hasPdf, checkedAt })));
      mount(<CustomerInvoiceDocuments organizationId="customer-a" invoiceId="invoice-a" />);
      expect(await screen.findByText('No PDF has been saved locally.')).toBeVisible();
      expect(screen.queryByRole('button', { name: /Download PDF/ })).not.toBeInTheDocument();
    });

  it('does not reuse the previous customer selection or a late response after customer navigation', async () => {
    let release!: (response: Response) => void;
    const held = new Promise<Response>(resolve => { release = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('organizationId=customer-a') ? held : json({ ...summary(), invoices: [], count: 0 })));
    const view = renderRoutes([{ path: '/:organizationId', element: <RoutedFinance /> }], '/customer-a', testUser(permissions));
    await view.router.navigate('/customer-b');
    expect(await screen.findByText('No invoices for this customer.')).toBeVisible();
    release(json(summary()));
    await waitFor(() => expect(screen.queryByText('Invoice 10001')).not.toBeInTheDocument());
  });

  it('downloads the exact scoped PDF using the server filename and clears the busy state', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:synthetic-pdf');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/download')
      ? new Response('%PDF-1.4 synthetic', { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="synthetic-invoice.pdf"' } })
      : json(financeDocuments())));
    const user = userEvent.setup(); mount(<CustomerInvoiceDocuments organizationId="customer-a" invoiceId="invoice-a" />);
    await user.click(await screen.findByRole('button', { name: 'Download PDF 1' }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledTimes(1); expect(revoke).toHaveBeenCalledWith('blob:synthetic-pdf');
    expect(screen.getByRole('button', { name: 'Download PDF 1' })).toBeEnabled();
  });

  it('shows source line completeness honestly and pages long line snapshots', async () => {
    const data = financeHistory(); data.history!.lineCoverage = 'RetrievedUnverified';
    data.history!.lines = Array.from({ length: 26 }, (_, i) => ({ ...data.history!.lines[0]!, id: i + 1, sortOrder: i, description: `Synthetic line ${i + 1}` }));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('history') ? json(data) : defaults(url)));
    const user = userEvent.setup(); mount(<CustomerInvoiceDetail organizationId="customer-a" invoiceId="invoice-a" onInvoice={vi.fn()} />);
    expect(await screen.findByText(/Their totals could not be reconciled/)).toBeVisible();
    const lines = screen.getByRole('region', { name: 'Invoice lines' });
    expect(within(lines).queryByText('Synthetic line 26')).not.toBeInTheDocument();
    await user.click(within(lines).getByRole('button', { name: 'Load more' }));
    expect(within(lines).getByText('Synthetic line 26')).toBeVisible();
  });
});
