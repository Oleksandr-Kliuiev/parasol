import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoutes, testUser } from '../../test/renderWithProviders';
import { InvoicesPage } from './InvoicesPage';
import type { Invoice, InvoiceSummary } from './types';

const invoice = (n: number): Invoice => ({
  id: `i${n}`, system: 'poweroffice', invoiceNo: `F-${n}`, orderNo: null, organization: { id: 'o1', name: 'Havbris AS' }, basisId: null,
  invoiceDate: '2026-09-01', dueDate: '2026-09-15', totalIncVat: 100, outstanding: 100, status: 'Sent', isOverdue: true, url: null, movements: [],
} as unknown as Invoice);

const page = (from: number, to: number, nextCursor: string | null, count: number): InvoiceSummary => ({
  count, outstanding: count * 100, overdue: count * 100, invoices: Array.from({ length: to - from + 1 }, (_, i) => invoice(from + i)), nextCursor, asOf: '2026-10-04',
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('Invoices (DEV-12)', () => {
  it('shows the totals of the whole filter, how many are loaded, and loads the next page with the cursor', async () => {
    const fetch = vi.fn(async (url: string) => (url.includes('cursor=c1') ? json(page(51, 60, null, 61)) : json(page(1, 50, 'c1', 60))));
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();
    renderRoutes([{ path: '*', element: <InvoicesPage /> }], '/billing/invoices', testUser(['billing.read', 'finance.read']));

    expect(await screen.findByText('Showing 50 of 60')).toBeInTheDocument();
    expect(screen.getByText(/Totals of all invoices matching the filter \(60\)/)).toBeInTheDocument();
    expect(fetch.mock.calls[0]![0]).toBe('/api/v1/billing/invoices?openOnly=false&overdueOnly=false&limit=50');

    await user.click(screen.getByRole('button', { name: 'Load more' }));

    // The second answer counts an invoice that arrived meanwhile: the totals follow the newest answer.
    expect(await screen.findByText('Showing 60 of 61')).toBeInTheDocument();
    expect(fetch.mock.calls.at(-1)![0]).toBe('/api/v1/billing/invoices?openOnly=false&overdueOnly=false&limit=50&cursor=c1');
    expect(screen.getByText(/Totals of all invoices matching the filter \(61\)/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(61);
  });

  it('names a fall of the remaining amount an observed decrease, with the day the sync saw it, and a credit note a credit note', async () => {
    const rows: Invoice[] = [
      { ...invoice(1), movements: [{ kind: 'BalanceDecrease', observedOn: '2026-10-21', amount: 10000, source: 'Inferred' }] },
      { ...invoice(2), status: 'Credited', movements: [{ kind: 'CreditNote', observedOn: '2026-10-22', amount: 500, source: 'Credited' }] },
      { ...invoice(3), movements: [{ kind: 'BalanceIncrease', observedOn: '2026-10-23', amount: 50, source: 'Raised' }] },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => json({ count: 3, outstanding: 300, overdue: 300, invoices: rows, nextCursor: null, asOf: '2026-10-24' })));
    renderRoutes([{ path: '*', element: <InvoicesPage /> }], '/billing/invoices', testUser(['billing.read', 'finance.read']));

    expect(await screen.findByText(/Observed decrease \(not a ledger payment\)/)).toBeInTheDocument();
    expect(screen.getAllByText(/Observed \d{2}\.\d{2}\.2026|Observed .*2026/)).toHaveLength(3);
    expect(screen.getByText(/Credit note/)).toBeInTheDocument();
    expect(screen.getByText(/Remaining amount went up/)).toBeInTheDocument();
    expect(screen.queryByText(/^(Paid|Partly paid)$/)).not.toBeInTheDocument();
  });

  it('gives a role without finance the count and the rows but no amounts', async () => {
    // As the server answers this role: the amounts are left out of the totals and of every row.
    const withoutMoney = (row: Invoice) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'totalIncVat' && key !== 'outstanding'));
    vi.stubGlobal('fetch', vi.fn(async () => json({ count: 3, invoices: [1, 2, 3].map((n) => withoutMoney(invoice(n))), nextCursor: null, asOf: '2026-10-04' })));
    renderRoutes([{ path: '*', element: <InvoicesPage /> }], '/billing/invoices', testUser(['billing.read']));

    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(4));
    expect(screen.queryByText('Outstanding')).not.toBeInTheDocument();
    expect(screen.queryByText(/Totals of all invoices/)).not.toBeInTheDocument();
  });
});
