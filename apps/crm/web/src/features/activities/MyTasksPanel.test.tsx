import { useState } from 'react';
import { Toaster } from '@fluentui/react-components';
import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CurrentUserContext } from '../../auth/CurrentUserContext';
import { TOASTER_ID } from '../../app/toaster';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { syntheticActivity } from '../../test/activities';
import { MyTasksPanel } from './MyTasksPanel';

const permissions = ['activities.read', 'activities.write', 'parasol.atlas.read'];
const first = syntheticActivity(); const second = syntheticActivity('task-two');
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const result = (items = [first], nextCursor: string | null = null, totalCount = items.length) => response({ items, nextCursor, totalCount });
const render = (allowed = permissions) => renderRoutes([page(<MyTasksPanel />)], '/', testUser(allowed));
const refresh = () => screen.getByRole('button', { name: 'Refresh my tasks' });
const failure = 'Your tasks could not be read. No previous tasks are shown. Refresh to try again.';
afterEach(() => vi.unstubAllGlobals());

it('does not request or show personal tasks without activities.read', () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); render(['parasol.atlas.read']);
  expect(screen.queryByRole('region', { name: 'My tasks' })).not.toBeInTheDocument(); expect(fetch).not.toHaveBeenCalled();
});

it('shows an initial read error instead of no tasks, and recovers only on explicit keyboard refresh', async () => {
  let failed = true; const fetch = vi.fn(async () => failed ? response({ detail: 'synthetic-private-error' }, 503) : result());
  vi.stubGlobal('fetch', fetch); render(); expect(await screen.findByText(failure)).toBeVisible();
  expect(screen.queryByText('Nothing assigned to you right now.')).not.toBeInTheDocument();
  expect(screen.queryByText('synthetic-private-error')).not.toBeInTheDocument();
  fireEvent(document, new Event('visibilitychange')); fireEvent(window, new Event('online')); expect(fetch).toHaveBeenCalledTimes(1);
  failed = false; refresh().focus(); await userEvent.keyboard('{Enter}');
  expect(await screen.findByText(first.subject)).toBeVisible(); expect(refresh()).toHaveFocus(); expect(fetch).toHaveBeenCalledTimes(2);
});

it('clears source controls while a refresh waits, retains focus and refuses repeated activation', async () => {
  let finish!: (value: Response) => void; let reads = 0;
  const fetch = vi.fn(async () => ++reads === 1 ? result() : new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal('fetch', fetch); render(); await screen.findByText(first.subject);
  refresh().focus(); await userEvent.keyboard('{Enter}');
  expect(refresh()).toHaveFocus(); expect(refresh()).toHaveAttribute('aria-disabled', 'true');
  expect(screen.queryByText(first.subject)).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'View Atlas source' })).not.toBeInTheDocument();
  await userEvent.keyboard('{Enter} '); fireEvent.click(refresh()); expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => finish(result([second]))); expect(await screen.findByText(second.subject)).toBeVisible(); expect(refresh()).toHaveFocus();
});

it('removes old tasks and source controls after a failed refresh', async () => {
  let failed = false; vi.stubGlobal('fetch', vi.fn(async () => failed ? response({}, 403) : result()));
  render(); await screen.findByText(first.subject); failed = true; await userEvent.click(refresh());
  expect(await screen.findByText(failure)).toBeVisible(); expect(screen.queryByText(first.subject)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'View Atlas source' })).not.toBeInTheDocument();
  expect(screen.queryByText('Nothing assigned to you right now.')).not.toBeInTheDocument();
});

it('loads pages only on request, respects a terminal cursor and refreshes from page one', async () => {
  const fetch = vi.fn(async (url: string) => url.includes('cursor=') ? result([second], null, 2) : result([first], 'next-one', 2));
  vi.stubGlobal('fetch', fetch); render(); await screen.findByText('Showing 1 of 2'); expect(fetch).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole('button', { name: 'Load more' })); expect(await screen.findByText('Showing 2 of 2')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  await userEvent.click(refresh()); await screen.findByText('Showing 1 of 2'); expect(screen.queryByText(second.subject)).not.toBeInTheDocument();
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/v1/activities/?mine=true&open=true&limit=10',
    '/api/v1/activities/?mine=true&open=true&limit=10&cursor=next-one', '/api/v1/activities/?mine=true&open=true&limit=10']);
});

it('clears earlier pages after a next-page error and recovers from the first page', async () => {
  const fetch = vi.fn(async (url: string) => url.includes('cursor=') ? response({}, 500) : result([first], 'next-one', 2));
  vi.stubGlobal('fetch', fetch); render(); await screen.findByText(first.subject); await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
  expect(await screen.findByText(failure)).toBeVisible(); expect(screen.queryByText(first.subject)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  await userEvent.click(refresh()); expect(await screen.findByText(first.subject)).toBeVisible();
  expect(fetch.mock.calls.at(-1)![0]).not.toContain('cursor='); expect(fetch).toHaveBeenCalledTimes(3);
});

it('shows a repeated task only once with its latest value and counts distinct rows', async () => {
  const updated = { ...first, subject: 'Updated due date task', dueAt: '2026-10-18T08:00:00Z' };
  const fetch = vi.fn(async (url: string) => url.includes('cursor=') ? result([updated, second], null, 3) : result([first], 'next-one', 3));
  vi.stubGlobal('fetch', fetch); render(); await screen.findByText(first.subject);
  await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
  expect(await screen.findByText('Showing 2 of 3')).toBeVisible();
  expect(screen.queryByText(first.subject)).not.toBeInTheDocument();
  expect(screen.getAllByText(updated.subject)).toHaveLength(1);
  expect(within(screen.getByRole('region', { name: 'My tasks' })).getAllByRole('listitem')).toHaveLength(2);
  expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('aborts a pending page on refresh and ignores its late reply', async () => {
  let finish!: (value: Response) => void; let signal!: AbortSignal;
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url.includes('cursor=')) { signal = init.signal as AbortSignal; return new Promise<Response>(resolve => { finish = resolve; }); }
    return result([first], 'next-one', 2);
  });
  vi.stubGlobal('fetch', fetch); render(); await screen.findByText(first.subject); await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
  await userEvent.click(refresh()); await screen.findByText(first.subject); expect(signal.aborted).toBe(true);
  await act(async () => finish(result([second]))); expect(screen.queryByText(second.subject)).not.toBeInTheDocument(); expect(fetch).toHaveBeenCalledTimes(3);
});

it.each(['employee', 'permissions', 'revoked'])('aborts an old read and drops its late data after changing %s', async change => {
  let finish!: (value: Response) => void; let signal!: AbortSignal; let reads = 0;
  const fetch = vi.fn(async (_: string, init: RequestInit) => {
    if (++reads === 1) { signal = init.signal as AbortSignal; return new Promise<Response>(resolve => { finish = resolve; }); }
    return result([second]);
  });
  vi.stubGlobal('fetch', fetch);
  function Host() {
    const [user, setUser] = useState(testUser(permissions));
    return <CurrentUserContext.Provider value={user}><button onClick={() => setUser({ ...testUser(change === 'revoked' ? [] : ['activities.read']),
      id: change === 'employee' ? 'new-employee' : user.id })}>Change scope</button><MyTasksPanel /></CurrentUserContext.Provider>;
  }
  renderRoutes([page(<Host />)], '/', testUser(permissions)); await waitFor(() => expect(reads).toBe(1));
  await userEvent.click(screen.getByRole('button', { name: 'Change scope' })); expect(signal.aborted).toBe(true);
  if (change !== 'revoked') expect(await screen.findByText(second.subject)).toBeVisible();
  await act(async () => finish(result([first]))); expect(screen.queryByText(first.subject)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'View Atlas source' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^Mark .* as done$/ })).not.toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(change === 'revoked' ? 1 : 2);
});

it('allows a read-only Atlas user to read source without offering completion', async () => {
  const fetch = vi.fn(async () => result()); vi.stubGlobal('fetch', fetch); render(['activities.read', 'parasol.atlas.read']);
  await screen.findByText(first.subject); expect(screen.getByRole('button', { name: 'View Atlas source' })).toBeVisible();
  expect(screen.queryByRole('button', { name: /^Mark .* as done$/ })).not.toBeInTheDocument(); expect(fetch).toHaveBeenCalledTimes(1);
});

it('rechecks only page one after completion and discards prior continuations', async () => {
  let completed = false;
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === 'POST') { completed = true; return response(second); }
    return url.includes('cursor=') ? result([second], null, 2) : result([first], completed ? null : 'next-one', completed ? 1 : 2);
  });
  vi.stubGlobal('fetch', fetch); renderRoutes([page(<><Toaster toasterId={TOASTER_ID} /><MyTasksPanel /></>)], '/', testUser(permissions));
  await screen.findByText(first.subject); await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
  await screen.findByText(second.subject); await userEvent.click(screen.getByRole('button', { name: `Mark ${second.subject} as done` }));
  expect(await screen.findByText(`${second.subject} marked as done`)).toBeVisible();
  await waitFor(() => expect(screen.queryByText(second.subject)).not.toBeInTheDocument());
  expect(fetch.mock.calls.filter(([, init]) => init.method === 'GET').map(([url]) => url)).toEqual([
    '/api/v1/activities/?mine=true&open=true&limit=10', '/api/v1/activities/?mine=true&open=true&limit=10&cursor=next-one',
    '/api/v1/activities/?mine=true&open=true&limit=10']);
});

it('shows no tasks only after a successful empty read', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => result([]))); render();
  expect(await screen.findByText('Nothing assigned to you right now.')).toBeVisible(); expect(screen.queryByText(failure)).not.toBeInTheDocument();
});

it.each([['success', 'employee'], ['failure', 'permissions']])('does not publish late completion %s after changing %s', async (outcome, scope) => {
  let finish!: (value: Response) => void; let writes = 0; let changed = false;
  const fetch = vi.fn(async (_: string, init: RequestInit) => {
    if (init.method === 'POST') { ++writes; return new Promise<Response>(resolve => { finish = resolve; }); }
    return result([changed ? second : first]);
  });
  vi.stubGlobal('fetch', fetch);
  function Host() {
    const [user, setUser] = useState(testUser(permissions));
    return <CurrentUserContext.Provider value={user}><Toaster toasterId={TOASTER_ID} />
      <button onClick={() => { changed = true; setUser({ ...testUser(scope === 'permissions' ? ['activities.read'] : permissions),
        id: scope === 'employee' ? 'new-employee' : user.id }); }}>Change scope</button><MyTasksPanel /></CurrentUserContext.Provider>;
  }
  renderRoutes([page(<Host />)], '/', testUser(permissions)); await screen.findByText(first.subject);
  await userEvent.click(screen.getByRole('button', { name: `Mark ${first.subject} as done` }));
  await waitFor(() => expect(writes).toBe(1)); await userEvent.click(screen.getByRole('button', { name: 'Change scope' }));
  await screen.findByText(second.subject);
  await act(async () => finish(outcome === 'success' ? response(first) : response({ detail: 'synthetic-prior-scope-error' }, 500)));
  expect(screen.queryByText(`${first.subject} marked as done`)).not.toBeInTheDocument();
  expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  expect(screen.queryByText('synthetic-prior-scope-error')).not.toBeInTheDocument();
  expect(screen.getByText(second.subject)).toBeVisible(); expect(writes).toBe(1);
});
