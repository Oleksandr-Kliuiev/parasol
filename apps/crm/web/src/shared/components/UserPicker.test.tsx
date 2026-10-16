import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoutes, testUser } from '../../test/renderWithProviders';
import { UserPicker } from './UserPicker';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const users = Array.from({ length: 20 }, (_, i) => ({ id: `u${i}`, displayName: `Person ${String(i).padStart(2, '0')}`, email: null, isActive: true }));

afterEach(() => vi.unstubAllGlobals());

describe('User picker (DEV-12)', () => {
  it('offers the first matches and says that typing finds the others', async () => {
    const fetch = vi.fn(async (url: string) => json(url.startsWith('/api/v1/identity/users') ? { items: users, nextCursor: 'c1', totalCount: 45 } : {}));
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();
    renderRoutes([{ path: '*', element: <UserPicker value={null} onChange={() => undefined} aria-labelledby="label" /> }], '/', testUser(['users.read']));

    await user.click(screen.getByRole('combobox'));

    expect(await screen.findByText('and 25 more — type to narrow')).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(21);
    expect(fetch.mock.calls[0]![0]).toBe('/api/v1/identity/users?limit=20');
  });
});
