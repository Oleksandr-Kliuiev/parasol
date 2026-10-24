import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Organization } from '../../api/types';
import { renderRoutes, testUser } from '../../test/renderWithProviders';
import { OrganizationDetailPage } from './OrganizationDetailPage';

const address = { street: null, postalCode: null, city: null, countryCode: null };
const organization: Organization = {
  id: 'o1', name: 'Fjord IT AS', orgNumber: null, legalForm: null, status: 'Customer', naceCode: null, website: null, phone: null, email: null,
  invoiceEmail: null, ehfEnabled: false, accountManager: null, primaryTechnician: null, postalAddress: address, visitAddress: address,
  billingAddress: address, domains: [], registryStatus: 'Unknown', registryCheckedAt: null, parent: null, billedThroughParent: false, children: [],
  createdAt: '2026-01-01T00:00:00Z', modifiedAt: null,
};
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function stub() {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const path = new URL(input, 'https://parasoll.invalid').pathname;
    if (path === '/api/v1/customers/organizations/o1') return json(organization);
    if (path.endsWith('/summary')) return json({ openTickets: 0, ticketsLast90Days: 0, devices: {}, devicesOnline: 0, criticalAlerts: 0, warningAlerts: 0, lastSyncedAt: null });
    if (path.endsWith('/contacts')) return json([]);
    return json({ items: [], nextCursor: null, totalCount: 0 });
  }));
}
const render = (path: string) => renderRoutes([{ path: '/organizations/:id', element: <OrganizationDetailPage /> }], path,
  testUser(['customers.read', 'service.read']));

// jsdom has no layout: the tab row reveals the selected tab by scrolling, which it cannot do there.
beforeAll(() => { Element.prototype.scrollBy ??= () => {}; });
afterEach(() => vi.unstubAllGlobals());

describe('customer Drift tab', () => {
  it('is the Operations tab, in the row of daily tabs', async () => {
    stub(); const { router } = render('/organizations/o1?tab=contacts');
    const tab = await screen.findByRole('tab', { name: 'Operations' });
    await userEvent.click(tab);
    await waitFor(() => expect(router.state.location.search).toBe('?tab=drift'));
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('region', { name: 'Open alerts' })).toBeVisible();
  });

  it('still opens from an old Service link and then names itself in the address', async () => {
    stub(); const { router } = render('/organizations/o1?tab=service&from=sla');
    expect(await screen.findByRole('tab', { name: 'Operations', selected: true })).toBeVisible();
    expect(await screen.findByRole('region', { name: 'Saved service summary' })).toBeVisible();
    await waitFor(() => expect(router.state.location.search).toBe('?tab=drift&from=sla'));
    expect(screen.queryByRole('tab', { name: 'Service' })).not.toBeInTheDocument();
  });
});
