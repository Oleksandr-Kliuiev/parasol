import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import type { UserSummary } from '../../api/types';
import { holdSearch } from '../../test/heldSearch';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { UsersPage } from './UsersPage';

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const user = (id: string, displayName: string): UserSummary => ({ id, displayName, email: `${id}@parasoll.example`, isActive: true });
const listOf = (items: UserSummary[]) => ({ items, nextCursor: null, totalCount: items.length });

describe('users', () => {
  it('keeps the rows in place while a search is read instead of emptying the table, and claims no count or empty answer for them', async () => {
    const { fetch, requested, answer } = holdSearch((url) => /search=(Kari|Nord)/.test(url),
      (url) => json(listOf(url.includes('search=Nothing') ? [] : [user('u1', 'Kari Nordmann'), user('u2', 'Ola Tekniker')])));
    vi.stubGlobal('fetch', fetch);
    renderRoutes([page(<UsersPage />, '/admin/users')], '/admin/users', testUser(['users.read']));
    await screen.findByText('Kari Nordmann');
    expect(screen.getByText('Showing 2 of 2')).toBeVisible();
    const search = screen.getByRole('searchbox', { name: 'Search users' });

    // An empty answer is not repeated while another search is read.
    fireEvent.change(search, { target: { value: 'Nothing' } });
    expect(await screen.findByText('No user matches the search.')).toBeVisible();
    fireEvent.change(search, { target: { value: 'Kari' } });
    await requested();
    expect(screen.queryByText('No user matches the search.')).not.toBeInTheDocument();
    await answer(listOf([user('u1', 'Kari Nordmann')]));
    const row = (await screen.findByText('Kari Nordmann')).closest('tr');
    expect(screen.getByText('Showing 1 of 1')).toBeVisible();

    // The same row; it is not the new answer, so the end of the list says the list is loading.
    fireEvent.change(search, { target: { value: 'Nord' } });
    await requested();
    expect(screen.getByText('Kari Nordmann').closest('tr')).toBe(row);
    expect(screen.getByRole('table', { name: 'Users' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Loading…')).toHaveAttribute('aria-live', 'polite');
    expect(screen.queryByText('Showing 1 of 1')).not.toBeInTheDocument();
    await answer(listOf([user('u1', 'Kari Nordmann'), user('u3', 'Nora Nord')]));
    expect(await screen.findByText('Showing 2 of 2')).toBeVisible();
    expect(screen.getByRole('table', { name: 'Users' })).not.toHaveAttribute('aria-busy');
  }, 15_000);
});
