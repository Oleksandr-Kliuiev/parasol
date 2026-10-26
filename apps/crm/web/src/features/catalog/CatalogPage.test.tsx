import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { holdSearch } from '../../test/heldSearch';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { CatalogPage } from './CatalogPage';
import type { ProductListItem } from './types';

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const product = (id: string, name: string): ProductListItem => ({
  id, sku: `SKU-${id}`, name, type: 'ManagedService', businessLine: 'Atera', unit: 'Device', billingPeriod: 'Monthly', listPrice: 199, currency: 'NOK',
  isActive: true,
});
const listOf = (items: ProductListItem[]) => ({ items, nextCursor: null, totalCount: items.length });

describe('catalog products', () => {
  // The search is read after a pause in typing; a click on a row must not get lost while its answer is on the way (M42 e2e).
  it('keeps the rows in place while a search is read, so a click on one still lands, and claims no count or empty answer for them', async () => {
    const { fetch, requested, answer } = holdSearch((url) => /search=(Drift|Server)/.test(url),
      (url) => json(listOf(url.includes('search=Nothing') ? [] : [product('p1', 'Server drift'), product('p2', 'Klient drift')])));
    vi.stubGlobal('fetch', fetch);
    const { router } = renderRoutes([page(<CatalogPage />, '/catalog'), page(<p>Product page</p>, '/catalog/products/:id')], '/catalog',
      testUser(['catalog.read']));
    await screen.findByRole('link', { name: 'Server drift' });
    expect(screen.getByText('Showing 2 of 2')).toBeVisible();
    const search = screen.getByRole('searchbox', { name: 'Search products' });

    // An empty answer is not repeated while another search is read: the placeholder shows, as before.
    fireEvent.change(search, { target: { value: 'Nothing' } });
    expect(await screen.findByText('No products match the filter.')).toBeVisible();
    fireEvent.change(search, { target: { value: 'Drift' } });
    await requested();
    expect(screen.queryByText('No products match the filter.')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Loading…')).toBeInTheDocument();
    await answer(listOf([product('p1', 'Server drift')]));
    const row = await screen.findByRole('link', { name: 'Server drift' });
    expect(screen.getByText('Showing 1 of 1')).toBeVisible();

    // The same row, not a placeholder in its place; it is not the new answer, so the end of the list says the list is loading.
    fireEvent.change(search, { target: { value: 'Server' } });
    await requested();
    expect(screen.getByRole('link', { name: 'Server drift' })).toBe(row);
    expect(screen.getByRole('table', { name: 'Products' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Loading…')).toHaveAttribute('aria-live', 'polite');
    expect(screen.queryByText('Showing 1 of 1')).not.toBeInTheDocument();
    await userEvent.click(row);
    expect(router.state.location.pathname).toBe('/catalog/products/p1');
  }, 15_000);
});
