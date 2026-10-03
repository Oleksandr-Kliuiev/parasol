import { describe, expect, it, vi, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
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

function renderAs(permissions: string[]) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(rows), { status: 200 })));
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
  });

  it('hides the create button without customers.write', async () => {
    renderAs(['customers.read']);

    await screen.findByRole('link', { name: 'Fjord IT AS' });
    expect(screen.queryByRole('button', { name: 'New organization' })).not.toBeInTheDocument();
  });
});
