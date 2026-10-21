import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { atlasAttention } from '../../test/atlasAttention';
import { MyDayPage } from './MyDayPage';

const permissions = ['customers.read', 'parasol.atlas.read', 'activities.read'];
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
const scroll = vi.fn();
beforeEach(() => Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll }));
afterEach(() => {
  if (originalScroll) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScroll);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  scroll.mockClear(); vi.unstubAllGlobals();
});

function setup(allowed = permissions, path = '/') {
  const fetch = vi.fn(async (url: string) => response(url.endsWith('/my-day/atlas-attention')
    ? atlasAttention() : { items: [], nextCursor: null, totalCount: 0 }));
  vi.stubGlobal('fetch', fetch);
  return { ...renderRoutes([page(<MyDayPage />)], path, testUser(allowed)), fetch };
}

describe('direct access to My day sections', () => {
  it.each([
    [[], []], [['customers.read'], []], [['parasol.atlas.read'], []],
    [['activities.read'], ['My tasks']],
    [['customers.read', 'parasol.atlas.read'], ['Technical attention · Atlas']],
    [permissions, ['My tasks', 'Technical attention · Atlas']],
  ])('offers only mounted sections for %j', async (allowed, names) => {
    setup(allowed);
    await screen.findByRole('heading', { name: /^Good (morning|afternoon|evening), Kari$/ });
    const nav = screen.queryByRole('navigation', { name: 'My day sections' });
    if (!names.length) expect(nav).not.toBeInTheDocument();
    else expect(within(nav!).getAllByRole('link').map(link => link.textContent)).toEqual(names);
  });

  it.each([
    ['tasks', 'my-day-tasks', 'My tasks'], ['attention', 'my-day-attention', 'Technical attention · Atlas'],
  ])('supports a direct section URL and focuses its panel (%s)', async (name, id, title) => {
    setup(permissions, `/?section=${name}`);
    const region = await screen.findByRole('region', { name: title });
    const target = document.getElementById(id);
    expect(target).toContainElement(region); await waitFor(() => expect(target).toHaveFocus());
    expect(target).toHaveAttribute('tabindex', '-1');
    expect(scroll).toHaveBeenCalledWith({ block: 'start' });
    const nav = within(screen.getByRole('navigation', { name: 'My day sections' }));
    expect(nav.getByRole('link', { name: title })).toHaveAttribute('href', `/?section=${name}#${id}`);
  });

  it('does not move focus for an unknown or unavailable section', async () => {
    const { router } = setup(['customers.read'], '/?section=tasks');
    await screen.findByRole('heading', { name: /^Good (morning|afternoon|evening), Kari$/ });
    expect(scroll).not.toHaveBeenCalled();
    await act(() => router.navigate('/?section=unknown#my-day-tasks'));
    expect(scroll).not.toHaveBeenCalled();
    expect(screen.queryByRole('navigation', { name: 'My day sections' })).not.toBeInTheDocument();
  });

  it('switches between panels without changing reads or moving focus again on an unrelated rerender', async () => {
    const { fetch, router } = setup(permissions, '/#main');
    await screen.findByText('Customers read successfully: 1 of 2 selected');
    await screen.findByText('Nothing assigned to you right now.');
    const reads = fetch.mock.calls.length;
    await act(() => router.navigate('/?section=tasks'));
    await waitFor(() => expect(document.getElementById('my-day-tasks')).toHaveFocus());
    await act(() => router.navigate('/?section=attention'));
    expect(document.getElementById('my-day-attention')).toHaveFocus();
    expect(fetch).toHaveBeenCalledTimes(reads);
    const refresh = screen.getByRole('button', { name: 'Refresh technical attention' });
    refresh.focus();
    await act(() => router.navigate('/?local-view=unchanged&section=attention'));
    expect(refresh).toHaveFocus(); expect(fetch).toHaveBeenCalledTimes(reads);
    await act(() => router.navigate('/#main'));
    expect(screen.getByRole('navigation', { name: 'My day sections' })).toHaveFocus();
    expect(fetch).toHaveBeenCalledTimes(reads);
  });
});

describe('the urgent Atlas tile', () => {
  it.each([['NOT_CONFIGURED', 'Atlas not connected'], ['UNAVAILABLE', 'Could not be read']] as const)('says %s instead of waiting for figures', async (status, foot) => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url.endsWith('/my-day/atlas-attention')
      ? { status, checkedAt: '2026-10-16T10:01:01Z', coverage: null, totals: null, customers: null } : { items: [], nextCursor: null, totalCount: 0 })));
    renderRoutes([page(<MyDayPage />)], '/', testUser(permissions));
    const tile = await screen.findByRole('link', { name: /^Urgent in Atlas/ });
    expect(await within(tile).findByText(foot)).toBeVisible();
    expect(within(tile).getByText('—')).toBeVisible();
    expect(within(tile).queryByText('Not read yet')).not.toBeInTheDocument();
  });
});
