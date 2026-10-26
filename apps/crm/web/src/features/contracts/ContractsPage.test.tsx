import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { holdSearch } from '../../test/heldSearch';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { ContractsPage } from './ContractsPage';
import type { ContractListItem } from './types';

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const contract = (id: string, title: string): ContractListItem => ({
  id, number: `K-${id}`, title, organization: { id: 'o1', name: 'Fjord IT AS' }, type: 'Msp', status: 'Active',
  startDate: '2026-01-01', endDate: null, autoRenew: false, owner: null, slaName: null,
});
const listOf = (items: ContractListItem[]) => ({ items, nextCursor: null, totalCount: items.length });

describe('contracts', () => {
  // The search is read after a pause in typing; a click on a row must not get lost while its answer is on the way (M42 e2e).
  it('keeps the rows in place while a search is read, so a click on one still lands, and claims no count or empty answer for them', async () => {
    const { fetch, requested, answer } = holdSearch((url) => /search=(Fjord|Drift)/.test(url),
      (url) => json(listOf(url.includes('search=Nothing') ? [] : [contract('c1', 'Drift Fjord IT'), contract('c2', 'Lisenser Vik')])));
    vi.stubGlobal('fetch', fetch);
    const { router } = renderRoutes([page(<ContractsPage />, '/contracts'), page(<p>Contract page</p>, '/contracts/:id')], '/contracts',
      testUser(['contracts.read']));
    await screen.findByRole('link', { name: 'Drift Fjord IT' });
    expect(screen.getByText('Showing 2 of 2')).toBeVisible();
    const search = screen.getByRole('searchbox', { name: 'Search by number, title or reference' });

    // An empty answer is not repeated while another search is read: the placeholder shows, as before.
    fireEvent.change(search, { target: { value: 'Nothing' } });
    expect(await screen.findByText('No contracts match the filter.')).toBeVisible();
    fireEvent.change(search, { target: { value: 'Fjord' } });
    await requested();
    expect(screen.queryByText('No contracts match the filter.')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Loading…')).toBeInTheDocument();
    await answer(listOf([contract('c1', 'Drift Fjord IT')]));
    const row = await screen.findByRole('link', { name: 'Drift Fjord IT' });
    expect(screen.getByText('Showing 1 of 1')).toBeVisible();

    // The same row, not a placeholder in its place; it is not the new answer, so the end of the list says the list is loading.
    fireEvent.change(search, { target: { value: 'Drift' } });
    await requested();
    expect(screen.getByRole('link', { name: 'Drift Fjord IT' })).toBe(row);
    expect(screen.getByRole('table', { name: 'Contracts' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Loading…')).toHaveAttribute('aria-live', 'polite');
    expect(screen.queryByText('Showing 1 of 1')).not.toBeInTheDocument();
    await userEvent.click(row);
    expect(router.state.location.pathname).toBe('/contracts/c1');
    expect(screen.getByText('Contract page')).toBeVisible();
  }, 15_000);
});
