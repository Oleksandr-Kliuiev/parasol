import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { holdSearch } from '../../test/heldSearch';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { LicensesPage } from './LicensesPage';
import type { Subscription } from './types';

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const subscription = (id: string, organizationName: string): Subscription => ({
  id, source: 'PartnerCenter', subscriptionId: `s-${id}`, cspCustomerName: organizationName, organizationId: `o-${id}`, organizationName,
  offerId: 'CFQ7TTC0LDPB', offerName: 'Microsoft 365 Business Premium', sku: null, quantity: 5, status: 'Active', term: 'P1Y', billingCycle: 'Monthly',
  startDate: '2026-01-01', commitmentEndDate: '2026-12-31', renewalDate: '2026-12-31', autoRenew: true, cancellationWindowEndsAt: null,
  cancellationWindowOpen: false, productId: null, productName: null, isBilled: true, syncedAt: '2026-10-21T06:00:00Z',
});
const listOf = (items: Subscription[]) => ({ items, nextCursor: null, totalCount: items.length });
const attention = { summary: { subscriptions: 2, licenses: 10, renewingSoon: 0, cancellationWindowOpen: 0, notBilled: 0, withoutOrganization: 0 },
  cancellationWindow: [], renewing: [], notBilled: [] };

describe('licenses', () => {
  // The search is read after a pause in typing; a click on a row must not get lost while its answer is on the way (M42 e2e).
  it('keeps the rows and their read time in place while a search is read, so a click still lands, and claims no count or empty answer', async () => {
    const { fetch, requested, answer } = holdSearch((url) => /search=(Fjord|Lisens)/.test(url),
      (url) => json(url.startsWith('/api/v1/licensing/attention') ? attention
        : listOf(url.includes('search=Nothing') ? [] : [subscription('1', 'Fjord Lisens AS'), subscription('2', 'Vik Regnskap AS')])));
    vi.stubGlobal('fetch', fetch);
    const { router } = renderRoutes([page(<LicensesPage />, '/licenses'), page(<p>Customer page</p>, '/organizations/:id')], '/licenses',
      testUser(['licensing.read']));
    await screen.findByRole('link', { name: 'Fjord Lisens AS' });
    expect(screen.getByText('Showing 2 of 2')).toBeVisible();
    const search = screen.getByRole('searchbox', { name: 'Search offer or customer' });

    // An empty answer is not repeated while another search is read.
    fireEvent.change(search, { target: { value: 'Nothing' } });
    expect(await screen.findByText('No subscriptions.')).toBeVisible();
    fireEvent.change(search, { target: { value: 'Fjord' } });
    await requested();
    expect(screen.queryByText('No subscriptions.')).not.toBeInTheDocument();
    await answer(listOf([subscription('1', 'Fjord Lisens AS')]));
    const row = await screen.findByRole('link', { name: 'Fjord Lisens AS' });
    expect(screen.getByText('Showing 1 of 1')).toBeVisible();

    // The same row, and the read time above the table stays with it; the end of the list says the list is loading.
    fireEvent.change(search, { target: { value: 'Lisens' } });
    await requested();
    expect(screen.getByRole('link', { name: 'Fjord Lisens AS' })).toBe(row);
    expect(screen.getByText(/^Read from Partner Center/)).toBeVisible();
    expect(screen.getByRole('table', { name: 'Licenses' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Loading…')).toHaveAttribute('aria-live', 'polite');
    expect(screen.queryByText('Showing 1 of 1')).not.toBeInTheDocument();
    await userEvent.click(row);
    expect(router.state.location.pathname).toBe('/organizations/o-1');
  }, 15_000);
});
