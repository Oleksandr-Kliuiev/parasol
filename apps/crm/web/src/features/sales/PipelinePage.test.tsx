import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { holdSearch } from '../../test/heldSearch';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { PipelinePage } from './PipelinePage';
import type { Opportunity, PipelineView } from './types';

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const deal = (id: string, name: string): Opportunity => ({
  id, organization: { id: 'o1', name: 'Fjord IT AS' }, contactId: null, contactName: null, name, businessLine: 'Msp', stageId: 's1',
  stageName: 'Qualified', probability: 50, expectedCloseDate: '2026-11-30', oneOffAmount: 0, mrr: 1000, termMonths: 12, forecastAmount: 6000,
  owner: null, source: null, competitor: null, status: 'Open', lostReason: null, closedOn: null, lastActivityAt: '2026-10-20T08:00:00Z',
  isStale: false, etag: 'e1',
});
// Two stages: the deals in the first, none in the second; a forecast month for the deals.
const board = (deals: Opportunity[]): PipelineView => ({
  columns: [
    { stageId: 's1', stageName: 'Qualified', probability: 50, count: deals.length, forecast: 3000 * deals.length, opportunities: deals, nextCursor: null },
    { stageId: 's2', stageName: 'Proposal', probability: 70, count: 0, forecast: 0, opportunities: [], nextCursor: null },
  ],
  forecast: [{ year: 2026, month: 11, count: deals.length, weighted: 3000 * deals.length }],
  stale: 0,
});

describe('pipeline', () => {
  // The search is read after a pause in typing; a click on a card must not get lost while its answer is on the way (M42 e2e).
  it('keeps the board in place while a search is read, so a click on a card still lands, and hides its figures until the answer', async () => {
    const { fetch, requested, answer } = holdSearch((url) => url.includes('search=Fjord'),
      (url) => json(url.startsWith('/api/v1/sales/pipeline') ? board([deal('d1', 'Fjord fornyelse'), deal('d2', 'Vik utvidelse')]) : []));
    vi.stubGlobal('fetch', fetch);
    const { router } = renderRoutes([page(<PipelinePage />, '/sales/pipeline'), page(<p>Deal page</p>, '/sales/opportunities/:id')],
      '/sales/pipeline', testUser(['sales.read', 'finance.read']));
    const card = await screen.findByRole('link', { name: 'Fjord fornyelse' });
    expect(screen.getByText('2 deals')).toBeVisible();
    expect(screen.getByText('No deals in this stage')).toBeVisible();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search deals' }), { target: { value: 'Fjord' } });
    await requested();
    // The same card, not an emptied board; the figures are not the new answer, so they keep their places unseen.
    expect(screen.getByRole('link', { name: 'Fjord fornyelse' })).toBe(card);
    expect(card.closest('[aria-busy]')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('2 deals')).not.toBeVisible();
    expect(screen.getByText('No deals in this stage')).not.toBeVisible();

    await answer(board([deal('d1', 'Fjord fornyelse')]));
    expect(await screen.findByText('1 deal')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Vik utvidelse' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Fjord fornyelse' }).closest('[aria-busy]')).toBeNull();
    await userEvent.click(screen.getByRole('link', { name: 'Fjord fornyelse' }));
    expect(router.state.location.pathname).toBe('/sales/opportunities/d1');
  }, 15_000);

  it('takes a click on a card while the search is read', async () => {
    const { fetch, requested } = holdSearch((url) => url.includes('search=Fjord'),
      (url) => json(url.startsWith('/api/v1/sales/pipeline') ? board([deal('d1', 'Fjord fornyelse')]) : []));
    vi.stubGlobal('fetch', fetch);
    const { router } = renderRoutes([page(<PipelinePage />, '/sales/pipeline'), page(<p>Deal page</p>, '/sales/opportunities/:id')],
      '/sales/pipeline', testUser(['sales.read']));
    const card = await screen.findByRole('link', { name: 'Fjord fornyelse' });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search deals' }), { target: { value: 'Fjord' } });
    await requested();
    await userEvent.click(card);
    expect(router.state.location.pathname).toBe('/sales/opportunities/d1');
  }, 15_000);

  it('keeps the cards a column loaded beyond its first while the search is read, and reads no more with the earlier board\'s cursor', async () => {
    const more = board([deal('d1', 'Fjord fornyelse')]);
    more.columns[0] = { ...more.columns[0]!, count: 3, nextCursor: 'c2' };
    const { fetch, requested } = holdSearch((url) => url.includes('search=Fjord'), (url) => json(url.startsWith('/api/v1/sales/pipeline') ? more
      : url.startsWith('/api/v1/sales/opportunities') ? { items: [deal('d2', 'Vik utvidelse')], nextCursor: 'c3', totalCount: 3 } : []));
    vi.stubGlobal('fetch', fetch);
    renderRoutes([page(<PipelinePage />, '/sales/pipeline')], '/sales/pipeline', testUser(['sales.read']));
    await screen.findByRole('link', { name: 'Fjord fornyelse' });
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    const extra = await screen.findByRole('link', { name: 'Vik utvidelse' });
    expect(screen.getByText('Showing 2 of 3')).toBeVisible();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search deals' }), { target: { value: 'Fjord' } });
    await requested();
    expect(screen.getByRole('link', { name: 'Vik utvidelse' })).toBe(extra);
    expect(screen.getByText('Loading…')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('button', { name: 'Load more' })).toBeDisabled();
    expect(fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/v1/sales/opportunities'))).toHaveLength(1);
  }, 15_000);
});

