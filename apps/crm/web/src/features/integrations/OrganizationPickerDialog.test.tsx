import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SearchHit, SearchResponse } from '../../api/types';
import { holdSearch } from '../../test/heldSearch';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { OrganizationPickerDialog } from './OrganizationPickerDialog';

afterEach(() => vi.unstubAllGlobals());

const hit = (id: string, title: string): SearchHit => ({ id, title, subtitle: null, url: `/organizations/${id}` });
const found = (items: SearchHit[]): SearchResponse => ({ query: '', groups: [{ group: 'organizations', items }] });

describe('the organization picker of the mappings', () => {
  // The search is read after a pause in typing; a click on a hit must not get lost while its answer is on the way (M42 e2e).
  it('keeps the hits in place while another search is read, so Link still takes the click, and shows none under two letters', async () => {
    const { fetch, requested, answer } = holdSearch((url) => url.includes('q=Fjord&'),
      () => new Response(JSON.stringify(found([hit('o1', 'Fjord IT AS'), hit('o2', 'Fjordkraft AS')])), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const onPick = vi.fn();
    renderRoutes([page(<OrganizationPickerDialog open initialSearch="Fjord IT" onPick={onPick} onClose={() => {}} />)], '/', testUser(['integrations.manage']));
    const item = (await screen.findByText('Fjord IT AS')).closest('li')!;
    const search = screen.getByRole('searchbox', { name: 'Search organizations' });

    fireEvent.change(search, { target: { value: 'Fjord' } });
    await requested();
    // The same hit with its button, not an emptied list; it is not the new answer, so the list is marked busy.
    expect(screen.getByText('Fjord IT AS').closest('li')).toBe(item);
    expect(item.closest('ul')).toHaveAttribute('aria-busy', 'true');
    await userEvent.click(within(item).getByRole('button', { name: 'Link' }));
    expect(onPick).toHaveBeenCalledWith({ id: 'o1', name: 'Fjord IT AS' });

    await answer(found([hit('o1', 'Fjord IT AS')]));
    await waitFor(() => expect(screen.queryByText('Fjordkraft AS')).not.toBeInTheDocument());
    expect(item.closest('ul')).not.toHaveAttribute('aria-busy');
    // Under two letters nothing is searched, and the hits of the earlier search do not stay under the hint.
    fireEvent.change(search, { target: { value: 'F' } });
    expect(await screen.findByText('Type at least two letters to search.')).toBeVisible();
    expect(screen.queryByText('Fjord IT AS')).not.toBeInTheDocument();
  }, 15_000);
});
