import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SearchResponse } from '../api/types';
import { renderRoutes } from '../test/renderWithProviders';
import { GlobalSearch } from './GlobalSearch';

const response: SearchResponse = {
  query: 'fjord',
  groups: [
    { group: 'organizations', items: [{ id: 'o1', title: 'Fjord IT AS', subtitle: '923 609 016 · Oslo', url: '/organizations/o1' }] },
    { group: 'contacts', items: [{ id: 'c1', title: 'Kari Fjord', subtitle: 'Fjord IT AS', url: '/contacts/c1' }] },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe('GlobalSearch', () => {
  it('shows grouped results and opens the selected one with the keyboard', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(response), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();
    const { router } = renderRoutes([{ path: '*', element: <GlobalSearch /> }], '/');

    await user.type(screen.getByRole('combobox', { name: 'Search organizations' }), 'fjord');

    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Fjord IT AS923 609 016 · Oslo', 'Kari FjordFjord IT AS']);
    expect(screen.getByText('Contacts')).toBeInTheDocument();
    expect(fetch.mock.calls.at(-1)![0]).toBe('/api/v1/search?q=fjord&take=6');

    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toBe('/contacts/c1'));
  });

  it('Enter without a selection searches the organization list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ query: 'x', groups: [] }), { status: 200 })));
    const user = userEvent.setup();
    const { router } = renderRoutes([{ path: '*', element: <GlobalSearch /> }], '/');

    await user.type(screen.getByRole('combobox', { name: 'Search organizations' }), 'nordlys{Enter}');

    await waitFor(() => expect(router.state.location.pathname + router.state.location.search).toBe('/organizations?search=nordlys'));
  });
});
