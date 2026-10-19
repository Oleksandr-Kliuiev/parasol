import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toaster } from '@fluentui/react-components';
import { TOASTER_ID } from '../../app/toaster';
import { renderRoutes, testUser } from '../../test/renderWithProviders';
import { QuotePage } from './QuotePage';
import { QuotesPage } from './QuotesPage';
import type { Quote } from './types';

const quote = (overrides: Partial<Quote> = {}): Quote => ({
  id: 'q1', number: 'T-2026-0042', rootId: 'q1', versionNo: 1, organization: { id: 'o1', name: 'Havbris AS' }, contactId: null,
  contactName: null, opportunityId: null, opportunityName: null, title: 'Drift', owner: { id: 'u1', name: 'Kari Nordmann' }, language: 'nb',
  issuedOn: '2026-10-04', validUntil: '2026-11-03', termMonths: 12, introText: null, termsText: null, customerReference: null, status: 'Ready',
  maxDiscountPct: 0, discountLimitPct: 15, needsApproval: false, approvalRequestedBy: null, approvalRequestedAt: null, approvedBy: null,
  approvedAt: null, rejectedReason: null, sentAt: null, sentTo: null, decidedOn: null, declineReason: null, isEditable: false, hasDocument: true,
  canSendByEmail: true, oneTimeExVat: 0, oneTimeVat: 0, monthlyExVat: 4_500, monthlyVat: 1_125, contractValue: 54_000, lines: [],
  versions: [{ id: 'q1', versionNo: 1, status: 'Ready', issuedOn: '2026-10-04', sentAt: null }], documents: [], etag: '"7"',
  ...overrides,
});

function stub(data: Quote) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return new Response(null, { status: 204 });
    if (url.startsWith('/api/v1/identity/users')) {
      return new Response(JSON.stringify({ items: [{ id: 'u2', displayName: 'Per Hansen', email: 'per@example.no', isActive: true }], nextCursor: null, totalCount: 1 }), { status: 200 });
    }
    return new Response(JSON.stringify(url === '/api/v1/sales/quotes/q1' ? data : []), { status: 200 });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const openedDialog = (title: string) => screen.findByRole('dialog', { name: title });

afterEach(() => vi.unstubAllGlobals());

describe('Quotes and record scope (DEV-09)', () => {
  it('hands the current version over and leaves the page of a quote the salesperson no longer sees', async () => {
    const fetch = stub(quote());
    const user = userEvent.setup();
    const { router } = renderRoutes(
      [
        { path: '/quotes/:id', element: <><Toaster toasterId={TOASTER_ID} /><QuotePage /></> },
        { path: '/quotes', element: <><Toaster toasterId={TOASTER_ID} /><p>Quote list</p></> },
      ],
      '/quotes/q1',
      testUser(['sales.read', 'sales.write', 'finance.read']),
    );

    await user.click(await screen.findByRole('button', { name: 'Hand over' }));
    const dialog = await openedDialog('Hand over quote T-2026-0042');
    expect(within(dialog).getByText('Afterwards you will no longer see the quote.')).toBeInTheDocument();
    const submit = within(dialog).getByRole('button', { name: 'Hand over' });
    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByRole('combobox'), 'Per');
    await user.click(await screen.findByRole('option', { name: /Per Hansen/ }));
    await user.click(submit);

    await waitFor(() => expect(router.state.location.pathname).toBe('/quotes'));
    expect(await screen.findByText('The quote now belongs to Per Hansen.')).toBeInTheDocument();
    const post = fetch.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(post[0]).toBe('/api/v1/sales/quotes/q1/transfer');
    expect(JSON.parse(String(post[1]!.body))).toEqual({ ownerId: 'u2' });
    expect((post[1]!.headers as Record<string, string>)['If-Match']).toBe('"7"');
  });

  it('stays on the quote when the user still sees every quote, and offers no hand-over on an earlier version', async () => {
    stub(quote({ versions: [{ id: 'q1', versionNo: 1, status: 'Superseded', issuedOn: '2026-10-01', sentAt: null }, { id: 'q2', versionNo: 2, status: 'Draft', issuedOn: '2026-10-04', sentAt: null }], status: 'Superseded' }));
    renderRoutes([{ path: '/quotes/:id', element: <QuotePage /> }], '/quotes/q1', testUser(['sales.read', 'sales.write', 'sales.quotes.all']));

    expect(await screen.findByText('T-2026-0042')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hand over' })).not.toBeInTheDocument();
  });

  it('keeps the owner of an editable quote fixed for a salesperson limited to their own quotes', async () => {
    stub(quote({ status: 'Draft', isEditable: true, versions: [{ id: 'q1', versionNo: 1, status: 'Draft', issuedOn: '2026-10-04', sentAt: null }] }));
    renderRoutes([{ path: '/quotes/:id', element: <QuotePage /> }], '/quotes/q1', testUser(['sales.read', 'sales.write']));

    expect(await screen.findByText('You are the owner; to change it, hand the quote over.')).toBeInTheDocument();
    expect(screen.getAllByText('Kari Nordmann').length).toBeGreaterThan(0);
  });

  it('tells a salesperson the list holds the quotes they own, without an "only mine" filter that would change nothing', async () => {
    stub(quote());
    renderRoutes([{ path: '/quotes', element: <QuotesPage /> }], '/quotes', testUser(['sales.read', 'sales.write']));

    expect(await screen.findByText('The quotes you own. To pass one on, hand it over from the quote.')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Only mine' })).not.toBeInTheDocument();
  });

  it('keeps "only mine" for those who see every quote', async () => {
    stub(quote());
    renderRoutes([{ path: '/quotes', element: <QuotesPage /> }], '/quotes', testUser(['sales.read', 'sales.quotes.all']));

    expect(await screen.findByRole('checkbox', { name: 'Only mine' })).toBeInTheDocument();
    expect(screen.queryByText('The quotes you own. To pass one on, hand it over from the quote.')).not.toBeInTheDocument();
  });
});
