import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { CustomerHighlights } from './CustomerHighlights';

const organizationId = 'org-1';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

const contract = {
  id: 'c1', number: 'AVT-1', title: 'Managed services', organization: { id: organizationId, name: 'Fjord IT AS' }, status: 'Active',
  startDate: '2026-01-01', endDate: '2026-12-31', slaName: 'Gold', type: 'Msp',
};
const bank = (remainingHours: number, purchasedHours = 40, status = 'Active') => ({
  id: `b${remainingHours}`, organization: { id: organizationId, name: 'Fjord IT AS' }, purchasedHours, usedHours: purchasedHours - remainingHours,
  remainingHours, overageHours: 0, lowBalancePct: 20, status,
});

/** The four reads of the strip, each answered from its own list endpoint. */
function stubReads(overrides: Partial<Record<'contracts' | 'banks' | 'activities' | 'invoices', () => Response>> = {}) {
  const fetch = vi.fn(async (url: string) => {
    if (url.includes('/hour-banks')) return overrides.banks?.() ?? json({ items: [bank(6), bank(30, 40, 'Closed')], nextCursor: null, totalCount: 2 });
    if (url.includes('/contracts')) return overrides.contracts?.() ?? json({ items: [contract], nextCursor: null, totalCount: 2 });
    if (url.includes('/activities')) return overrides.activities?.() ?? json({ items: [], nextCursor: null, totalCount: 3 });
    if (url.includes('/invoices')) return overrides.invoices?.() ?? json({ count: 2, outstanding: 12500, overdue: 2500, invoices: [], nextCursor: null, asOf: '2026-10-20T06:00:00Z' });
    return json({}, 404);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const all = ['customers.read', 'contracts.read', 'activities.read', 'billing.read', 'finance.read'];
const render = (permissions = all) => renderRoutes([page(<CustomerHighlights organizationId={organizationId} />)], '/', testUser(permissions));
const strip = () => within(screen.getByRole('group', { name: 'Customer at a glance' }));
afterEach(() => vi.unstubAllGlobals());

describe('customer highlights', () => {
  it('sums the hours left in active banks, flags a low bank and opens each tab', async () => {
    stubReads(); render();
    expect(await strip().findByText('6 h')).toBeVisible();
    // 6 of 40 hours is under the bank's own 20 % threshold.
    expect(strip().getByText('left of 40 h · running low')).toBeVisible();
    expect(strip().getByText('Gold · until 31/12/2026 · +1 more')).toBeVisible();
    expect(await strip().findByText('3')).toBeVisible();
    expect(await strip().findByText(/2,500\.00 overdue/)).toBeVisible();
    expect(strip().getByRole('link', { name: /Agreement/ })).toHaveAttribute('href', '/?tab=contracts');
    expect(strip().getByRole('link', { name: /Open work/ })).toHaveAttribute('href', '/?tab=activities');
    expect(strip().getByRole('link', { name: /Outstanding/ })).toHaveAttribute('href', '/?tab=invoices');
  });

  it('asks nothing a role may not read and shows counts instead of amounts without finance.read', async () => {
    const fetch = stubReads(); render(['customers.read', 'billing.read']);
    expect(await strip().findByText('2 open invoices')).toBeVisible();
    expect(strip().queryByText(/overdue/)).not.toBeInTheDocument();
    expect(strip().queryByText('Agreement')).not.toBeInTheDocument();
    expect(strip().queryByText('Open work')).not.toBeInTheDocument();
    const urls = fetch.mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.includes('/contracts') || url.includes('/activities'))).toBe(false);
  });

  it('says a customer has no open invoices instead of an amount of zero', async () => {
    stubReads({ invoices: () => json({ count: 0, outstanding: 0, overdue: 0, invoices: [], nextCursor: null, asOf: '2026-10-20T06:00:00Z' }) }); render();
    const money = strip().getByRole('link', { name: /Outstanding/ });
    expect(await within(money).findByText('No open invoices')).toBeVisible();
    expect(within(money).getByText('None')).toBeVisible();
    expect(within(money).queryByText(/0\.00/)).not.toBeInTheDocument();
  });

  it('says the hours cover only the banks read when there is a further page', async () => {
    stubReads({ banks: () => json({ items: [bank(6)], nextCursor: 'next', totalCount: 30 }) }); render();
    expect(await strip().findByText(/first 1 of 30 hour banks/)).toBeVisible();
  });

  it('says a figure could not be read instead of showing a zero', async () => {
    stubReads({ activities: () => json({ detail: 'synthetic failure' }, 503) }); render();
    const work = strip().getByRole('link', { name: /Open work/ });
    expect(await within(work).findByText('Could not be read')).toBeVisible();
    expect(within(work).queryByText('0')).not.toBeInTheDocument();
  });

  it('renders nothing for a role without any of the lists', () => {
    const fetch = stubReads(); render(['customers.read']);
    expect(screen.queryByRole('group', { name: 'Customer at a glance' })).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
});
