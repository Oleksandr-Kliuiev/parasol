import { describe, expect, it, vi, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OrganizationListItem, PagedResult } from '../../api/types';
import { renderRoutes, testUser } from '../../test/renderWithProviders';
import { OrganizationsPage } from './OrganizationsPage';

const rows: PagedResult<OrganizationListItem> = {
  items: [
    { id: 'a', name: 'Fjord IT AS', orgNumber: '923609016', status: 'Customer', city: 'Oslo', accountManager: { id: 'u1', displayName: 'Kari Nordmann' }, registryStatus: 'Active' },
    { id: 'b', name: 'Nordlys Drift AS', orgNumber: '974760673', status: 'Prospect', city: 'Tromsø', accountManager: null, registryStatus: 'Bankrupt' },
  ],
  nextCursor: null,
};

// Count reads ask for one row of a status; they answer with that status's total.
const totals: Record<string, number> = { Customer: 12, Prospect: 3 };

function renderAs(permissions: string[]) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    const params = new URL(url, 'http://localhost').searchParams;
    const body = params.get('limit') === '1' ? { items: [], nextCursor: null, totalCount: totals[params.get('status') ?? ''] ?? 0 } : rows;
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }));
  renderRoutes([{ path: '/organizations', element: <OrganizationsPage /> }], '/organizations', testUser(permissions));
}

afterEach(() => vi.unstubAllGlobals());

describe('OrganizationsPage', () => {
  it('lists organizations with formatted org numbers and registry warnings', async () => {
    renderAs(['customers.read', 'customers.write']);

    expect(await screen.findByRole('link', { name: 'Fjord IT AS' })).toHaveAttribute('href', '/organizations/a');
    expect(screen.getByText('923 609 016')).toBeInTheDocument();
    expect(screen.getByText('Bankrupt')).toBeInTheDocument();
    // Active registry status is not shown as a badge; only statuses that need attention are.
    expect(screen.queryByText('Active in registry')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New organization' })).toBeInTheDocument();
    // An organization without an account manager says so instead of leaving the cell blank.
    expect(screen.getByText('No account manager')).toBeInTheDocument();
  });

  it('counts the organizations of each status on the status filters', async () => {
    renderAs(['customers.read']);

    const filters = await screen.findByRole('group', { name: 'Status' });
    expect(await within(filters).findByRole('button', { name: 'All, 15' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(filters).getByRole('button', { name: 'Customer, 12' })).toBeInTheDocument();
    expect(within(filters).getByRole('button', { name: 'Partner, 0' })).toBeInTheDocument();
  });

  it('hides the create button without customers.write', async () => {
    renderAs(['customers.read']);

    await screen.findByRole('link', { name: 'Fjord IT AS' });
    expect(screen.queryByRole('button', { name: 'New organization' })).not.toBeInTheDocument();
  });
});

describe('whom to attend to (UX 2026, В6)', () => {
  const asOf = '2026-10-21';
  const factsOf = (id: string) => id === 'a'
    ? { organizationId: 'a', work: { open: 3, overdue: 1 }, agreements: { active: 1, nextEnd: '2026-11-10' }, hourBanks: { active: 1, remainingHours: 6, purchasedHours: 40, low: true },
      invoices: { open: 2, overdue: 1, outstanding: 12500, overdueAmount: 2500 } }
    : { organizationId: id, work: { open: 0, overdue: 0 }, agreements: { active: 0, nextEnd: null }, hourBanks: { active: 0, remainingHours: 0, purchasedHours: 0, low: false },
      invoices: { open: 0, overdue: 0, outstanding: 0, overdueAmount: 0 } };
  const attention = { asOf, total: 7, items: Array.from({ length: 6 }, (_, i) => ({
    organization: { id: `c${i}`, name: `Attention customer ${i}`, status: 'Customer', accountManager: { id: 'u2', displayName: 'Ola Nordmann' } },
    reasons: ['OverdueInvoices'], facts: { ...factsOf('a'), organizationId: undefined } })) };
  attention.items.forEach((item) => delete (item.facts as { organizationId?: string }).organizationId);

  function renderWithFacts(permissions = ['customers.read', 'activities.read', 'contracts.read', 'billing.read', 'finance.read']) {
    const fetch = vi.fn(async (url: string) => {
      const parsed = new URL(url, 'http://localhost');
      if (parsed.pathname.endsWith('/organizations/facts')) {
        const ids = parsed.searchParams.get('ids')!.split(',');
        return new Response(JSON.stringify({ asOf, items: ids.map(factsOf) }));
      }
      if (parsed.pathname.endsWith('/organizations/attention')) return new Response(JSON.stringify(attention));
      const body = parsed.searchParams.get('limit') === '1' ? { items: [], nextCursor: null, totalCount: 1 } : rows;
      return new Response(JSON.stringify(body));
    });
    vi.stubGlobal('fetch', fetch);
    renderRoutes([{ path: '/organizations', element: <OrganizationsPage /> }], '/organizations', testUser(permissions));
    return fetch;
  }

  it('shows each customer\'s open work, agreement, hour bank and invoices from one read for the page', async () => {
    const fetch = renderWithFacts();
    const row = within((await screen.findByRole('link', { name: 'Fjord IT AS' })).closest('tr')!);
    expect(await row.findByText('3 open')).toBeVisible(); expect(row.getByText('1 overdue')).toBeVisible();
    expect(row.getByText('until 10/11/2026')).toBeVisible(); expect(row.getByText('ends in 20 days')).toBeVisible();
    expect(row.getByText('6 h left')).toBeVisible(); expect(row.getByText('running low')).toBeVisible();
    expect(row.getByText('NOK 2,500.00 overdue')).toBeVisible();
    const quiet = within(screen.getByRole('link', { name: 'Nordlys Drift AS' }).closest('tr')!);
    expect(quiet.getByText('No open work')).toBeInTheDocument(); expect(quiet.getByText('No open invoices')).toBeInTheDocument();
    const factReads = fetch.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('/organizations/facts'));
    expect(factReads).toEqual(['/api/v1/customers/organizations/facts?ids=a%2Cb']);
  });

  it('lists the customers that need attention first, five at a time, and says when there are more than it read', async () => {
    renderWithFacts();
    const panel = within(await screen.findByRole('region', { name: 'Needs attention (7)' }));
    expect(await panel.findAllByRole('listitem')).toHaveLength(5);
    expect(panel.getAllByText('NOK 2,500.00 overdue · 1 overdue · agreement ends 10/11/2026 · hour bank running low')).toHaveLength(5);
    expect(panel.getByText('The 6 most urgent of 7')).toBeVisible();
    await userEvent.click(panel.getByRole('button', { name: 'Show all 6' }));
    expect(panel.getAllByRole('listitem')).toHaveLength(6);
  });

  it('narrows the list and the attention view to the person\'s own customers with Mine', async () => {
    const fetch = renderWithFacts();
    const scope = within(await screen.findByRole('group', { name: 'Whose customers' }));
    await userEvent.click(scope.getByRole('button', { name: 'Mine' }));
    await vi.waitFor(() => {
      const urls = fetch.mock.calls.map(([url]) => String(url));
      expect(urls.some((url) => url.includes('/organizations?') && url.includes('accountManagerId=u1'))).toBe(true);
      expect(urls.some((url) => url.includes('/organizations/attention?mine=true'))).toBe(true);
    });
  });

  it('asks for no facts and shows no fact columns to a role that reads none of those records', async () => {
    const fetch = renderWithFacts(['customers.read']);
    await screen.findByRole('link', { name: 'Fjord IT AS' });
    expect(screen.queryByRole('columnheader', { name: 'Open work' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /^Needs attention/ })).not.toBeInTheDocument();
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/facts') || String(url).includes('/attention'))).toBe(false);
  });
});
