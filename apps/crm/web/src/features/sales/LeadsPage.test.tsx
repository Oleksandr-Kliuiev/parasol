import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { holdSearch } from '../../test/heldSearch';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { LeadsPage } from './LeadsPage';
import type { Lead } from './types';

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const lead = (id: string, companyName: string): Lead => ({
  id, companyName, orgNumber: null, contactName: 'Kari Kunde', email: null, phone: null, source: 'Web', status: 'New', owner: null, notes: null,
  disqualifyReason: null, organizationId: null, opportunityId: null, createdAt: '2026-10-20T08:00:00Z', etag: 'e1',
});
const listOf = (items: Lead[]) => ({ items, nextCursor: null, totalCount: items.length });

describe('leads', () => {
  // The search is read after a pause in typing; a click on a row must not get lost while its answer is on the way (M42 e2e).
  it('keeps the rows in place while a search is read, so a button in one still works, and claims no count or empty answer for them', async () => {
    const { fetch, requested, answer } = holdSearch((url) => /search=(Fjord|Lead)/.test(url),
      (url) => json(url.startsWith('/api/v1/sales/leads') ? listOf(url.includes('search=Nothing') ? [] : [lead('l1', 'Fjord Lead AS'), lead('l2', 'Vik Lead AS')]) : []));
    vi.stubGlobal('fetch', fetch);
    renderRoutes([page(<LeadsPage />, '/sales/leads')], '/sales/leads', testUser(['sales.read', 'sales.write']));
    await screen.findByText('Fjord Lead AS');
    expect(screen.getByText('Showing 2 of 2')).toBeVisible();
    const search = screen.getByRole('searchbox', { name: 'Search leads' });

    // An empty answer is not repeated while another search is read.
    fireEvent.change(search, { target: { value: 'Nothing' } });
    expect(await screen.findByText('No leads.')).toBeVisible();
    fireEvent.change(search, { target: { value: 'Fjord' } });
    await requested();
    expect(screen.queryByText('No leads.')).not.toBeInTheDocument();
    await answer(listOf([lead('l1', 'Fjord Lead AS')]));
    const edit = await screen.findByRole('button', { name: 'Edit Fjord Lead AS' });
    expect(screen.getByText('Showing 1 of 1')).toBeVisible();

    // The same row with its buttons, not an emptied table; it is not the new answer, so the end of the list says the list is loading.
    fireEvent.change(search, { target: { value: 'Lead' } });
    await requested();
    expect(screen.getByRole('button', { name: 'Edit Fjord Lead AS' })).toBe(edit);
    expect(screen.getByRole('table', { name: 'Leads' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Loading…')).toHaveAttribute('aria-live', 'polite');
    expect(screen.queryByText('Showing 1 of 1')).not.toBeInTheDocument();
    await userEvent.click(edit);
    expect(within(await screen.findByRole('dialog')).getByDisplayValue('Fjord Lead AS')).toBeVisible();
  }, 15_000);
});
