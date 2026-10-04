import { afterEach, describe, expect, it, vi } from 'vitest';
import { configure, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoutes, testUser } from '../../test/renderWithProviders';
import { BillingRunsPage } from './BillingRunsPage';
import type { LegacyChargeReport, RunListItem } from './types';

const supplementaryRun: RunListItem = {
  id: 'r2',
  periodStart: '2032-01-01',
  periodEnd: '2032-01-31',
  kind: 'Supplementary',
  status: 'Collected',
  organizations: 1,
  withAnomalies: 0,
  totalExVat: 2000,
  requiresSecondApproval: false,
  collectedAt: '2032-02-10T08:00:00Z',
  approvedAt: null,
  exportedAt: null,
  closedAt: null,
};

const legacy: LegacyChargeReport = {
  count: 1,
  amount: 4000,
  byReason: [{ reason: 'Unprovable', count: 1, amount: 4000 }],
  items: [
    {
      id: 'c1',
      organization: { id: 'o1', name: 'Havbris AS' },
      periodStart: '2032-09-01',
      description: 'Managed services (01.09.2032–30.09.2032)',
      amount: 4000,
      reason: 'Unprovable: billed before charge keys.',
      etag: '"charge-etag"',
    },
  ],
};

function mockApi() {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && url === '/api/v1/billing/runs') {
      return new Response(JSON.stringify({ ...supplementaryRun, id: 'r3' }), { status: 201 });
    }
    if (init?.method === 'POST') return new Response(null, { status: 204 });
    if (url.startsWith('/api/v1/billing/charges/legacy')) return new Response(JSON.stringify(legacy), { status: 200 });
    return new Response(JSON.stringify([supplementaryRun]), { status: 200 });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const finance = testUser(['billing.read', 'billing.manage', 'finance.read']);
const show = () =>
  renderRoutes(
    [
      { path: '/billing', element: <BillingRunsPage /> },
      { path: '/billing/runs/:id', element: <p>run page</p> },
    ],
    '/billing',
    finance,
  );

// Fluent's modal handling (Tabster) sets aria-hidden outside the active dialog on a timer; in jsdom, on a loaded machine, it
// sometimes hides the open dialog itself, which real browsers never do (the e2e and axe checks of these dialogs pass). Role
// queries therefore include hidden nodes here; accessibility is checked in the browser.
configure({ defaultHidden: true });

afterEach(() => vi.unstubAllGlobals());

const openedDialog = () => screen.findByRole('dialog', undefined, { timeout: 5_000 });


describe('BillingRunsPage', () => {
  it('marks a supplementary run and creates one for a closed month when asked', async () => {
    const fetch = mockApi();
    const user = userEvent.setup();
    show();

    expect(await screen.findByText('Supplementary')).toBeInTheDocument();
    // Both queries have settled before the dialog opens; under load the dialog takes longer than the default second.
    await screen.findByRole('region', { name: 'Lines billed before the charge register' });
    await user.click(screen.getByRole('button', { name: 'New run' }));
    const dialog = await openedDialog();
    await user.click(within(dialog).getByRole('switch', { name: 'Supplementary run' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));

    const post = fetch.mock.calls.find(([url, init]) => init?.method === 'POST' && url === '/api/v1/billing/runs')!;
    expect(JSON.parse(String(post[1]!.body))).toMatchObject({ supplementary: true });
  });

  it('lists lines billed before the charge register and saves Finance’s decision with its reason', async () => {
    const fetch = mockApi();
    const user = userEvent.setup();
    show();

    const panel = await screen.findByRole('region', { name: 'Lines billed before the charge register' });
    expect(within(panel).getByText('Havbris AS')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Was not billed' }));
    const dialog = await openedDialog();
    const save = within(dialog).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Ikke fakturert i gammelt system');
    await user.click(save);

    const post = fetch.mock.calls.find(([url, init]) => init?.method === 'POST' && String(url).includes('legacy-decision'))!;
    expect(post[0]).toBe('/api/v1/billing/charges/c1/legacy-decision');
    expect(JSON.parse(String(post[1]!.body))).toEqual({ billed: false, reason: 'Ikke fakturert i gammelt system' });
    expect((post[1]!.headers as Record<string, string>)['If-Match']).toBe('"charge-etag"');
  });

  it('shows the legacy panel only to users who manage billing', async () => {
    mockApi();
    renderRoutes([{ path: '/billing', element: <BillingRunsPage /> }], '/billing', testUser(['billing.read']));

    expect(await screen.findByText('Supplementary')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Lines billed before the charge register' })).not.toBeInTheDocument();
  });
});
