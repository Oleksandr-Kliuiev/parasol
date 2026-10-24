import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { holdSearch } from '../../test/heldSearch';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { QuotesPage } from './QuotesPage';
import type { QuoteListItem } from './types';

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const quote = (id: string, number: string, organization: string): QuoteListItem => ({
  id, number, versionNo: 1, organization: { id: `o-${id}`, name: organization }, title: 'Microsoft 365', status: 'Draft', issuedOn: '2026-10-01',
  validUntil: '2026-10-31', owner: null, maxDiscountPct: 0, isLatestVersion: true, etag: 'e1',
});
const listOf = (items: QuoteListItem[]) => ({ items, nextCursor: null, totalCount: items.length });

describe('quotes', () => {
  // The search is read after a pause in typing; a click on a row must not get lost while its answer is on the way (M42 e2e).
  it('keeps the rows in place while a search is read, so a click on one still lands, and claims no count or empty answer for them', async () => {
    const { fetch, requested, answer } = holdSearch((url) => /search=(Fjord|Q-1)/.test(url),
      (url) => json(listOf(url.includes('search=Nothing') ? [] : [quote('q1', 'Q-1001', 'Fjord IT AS'), quote('q2', 'Q-1002', 'Vik Regnskap AS')])));
    vi.stubGlobal('fetch', fetch);
    const { router } = renderRoutes([page(<QuotesPage />, '/quotes'), page(<p>Quote page</p>, '/quotes/:id')], '/quotes',
      testUser(['sales.read', 'sales.quotes.all']));
    await screen.findByRole('link', { name: 'Q-1001' });
    expect(screen.getByText('Showing 2 of 2')).toBeVisible();
    const search = screen.getByRole('searchbox', { name: 'Search quotes' });

    // An empty answer is not repeated while another search is read: the placeholder shows, as before.
    fireEvent.change(search, { target: { value: 'Nothing' } });
    expect(await screen.findByText('No quotes.')).toBeVisible();
    fireEvent.change(search, { target: { value: 'Fjord' } });
    await requested();
    expect(screen.queryByText('No quotes.')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Loading…')).toBeInTheDocument();
    await answer(listOf([quote('q1', 'Q-1001', 'Fjord IT AS')]));
    const row = await screen.findByRole('link', { name: 'Q-1001' });
    expect(screen.getByText('Showing 1 of 1')).toBeVisible();

    // The same row, not a placeholder in its place; it is not the new answer, so the end of the list says the list is loading.
    fireEvent.change(search, { target: { value: 'Q-1' } });
    await requested();
    expect(screen.getByRole('link', { name: 'Q-1001' })).toBe(row);
    expect(screen.getByRole('table', { name: 'Quotes' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Loading…')).toHaveAttribute('aria-live', 'polite');
    expect(screen.queryByText('Showing 1 of 1')).not.toBeInTheDocument();
    await userEvent.click(row);
    expect(router.state.location.pathname).toBe('/quotes/q1');
  }, 15_000);
});
