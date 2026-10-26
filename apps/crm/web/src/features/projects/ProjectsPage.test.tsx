import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { holdSearch } from '../../test/heldSearch';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { ProjectsPage } from './ProjectsPage';
import type { ProjectListItem } from './types';

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const project = (id: string, name: string): ProjectListItem => ({
  id, number: `P-${id}`, name, organization: { id: 'o1', name: 'Fjord IT AS' }, type: 'Other', status: 'Active', manager: null,
  startDate: '2026-10-01', endDate: null, budgetHours: 10, hours: 2, phasesDone: 0, phases: 1,
});
const listOf = (items: ProjectListItem[]) => ({ items, nextCursor: null, totalCount: items.length });

describe('projects', () => {
  // The search is read after a pause in typing; a click on a row must not get lost while its answer is on the way (M42 e2e).
  it('keeps the rows in place while a search is read, so a click on one still lands, and claims no count or empty answer for them', async () => {
    const { fetch, requested, answer } = holdSearch((url) => /search=(Utrulling|Fjord)/.test(url),
      (url) => json(listOf(url.includes('search=Nothing') ? [] : [project('p1', 'Fjord utrulling'), project('p2', 'Vik migrering')])));
    vi.stubGlobal('fetch', fetch);
    const { router } = renderRoutes([page(<ProjectsPage />, '/projects'), page(<p>Project page</p>, '/projects/:id')], '/projects',
      testUser(['projects.read', 'projects.all']));
    await screen.findByRole('link', { name: 'Fjord utrulling' });
    expect(screen.getByText('Showing 2 of 2')).toBeVisible();
    const search = screen.getByRole('searchbox', { name: 'Search project or number' });

    // An empty answer is not repeated while another search is read: the placeholder shows, as before.
    fireEvent.change(search, { target: { value: 'Nothing' } });
    expect(await screen.findByText('No projects yet.')).toBeVisible();
    fireEvent.change(search, { target: { value: 'Utrulling' } });
    await requested();
    expect(screen.queryByText('No projects yet.')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Loading…')).toBeInTheDocument();
    await answer(listOf([project('p1', 'Fjord utrulling')]));
    const row = await screen.findByRole('link', { name: 'Fjord utrulling' });
    expect(screen.getByText('Showing 1 of 1')).toBeVisible();

    // The same row, not a placeholder in its place; it is not the new answer, so the end of the list says the list is loading.
    fireEvent.change(search, { target: { value: 'Fjord' } });
    await requested();
    expect(screen.getByRole('link', { name: 'Fjord utrulling' })).toBe(row);
    expect(screen.getByRole('table', { name: 'Projects' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Loading…')).toHaveAttribute('aria-live', 'polite');
    expect(screen.queryByText('Showing 1 of 1')).not.toBeInTheDocument();
    await userEvent.click(row);
    expect(router.state.location.pathname).toBe('/projects/p1');
  }, 15_000);
});
