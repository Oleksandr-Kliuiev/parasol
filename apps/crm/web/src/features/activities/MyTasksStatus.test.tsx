import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { MyTasksPanel } from './MyTasksPanel';
import { first, second, response, result } from './activityNavigationTestFixture';

afterEach(() => vi.unstubAllGlobals());
const render = () => renderRoutes([page(<MyTasksPanel />)], '/', testUser(['activities.read', 'activities.write']));
const command = (activity = first) => screen.getByRole('button', { name: `Mark ${activity.subject} as done` });
const posts = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.filter(([, init]) => (init as RequestInit).method === 'POST');

it('keeps both independent pending rows locked and rejects repeated same-row activation synchronously', async () => {
  const replies = new Map<string, (value: Response) => void>();
  const fetch = vi.fn(async (url: string, init: RequestInit) => init.method === 'POST' ? new Promise<Response>(resolve => { replies.set(url, resolve); }) : result([first, second]));
  vi.stubGlobal('fetch', fetch); render(); await screen.findByText(first.subject);
  const a = command(); const b = command(second);
  act(() => { fireEvent.click(a); fireEvent.click(a); }); await waitFor(() => expect(posts(fetch)).toHaveLength(1));
  expect(a).toHaveAttribute('aria-disabled', 'true'); expect(b).not.toHaveAttribute('aria-disabled', 'true');
  act(() => { fireEvent.click(b); fireEvent.click(a); fireEvent.click(b); }); await waitFor(() => expect(posts(fetch)).toHaveLength(2));
  expect(a).toHaveAttribute('aria-disabled', 'true'); expect(b).toHaveAttribute('aria-disabled', 'true');
  expect(posts(fetch).map(([, init]) => init.headers)).toEqual([expect.objectContaining({ 'If-Match': first.etag }), expect.objectContaining({ 'If-Match': second.etag })]);
  await act(async () => replies.get(`/api/v1/activities/${second.id}/complete`)!(response({}, 500)));
  expect(a).toHaveAttribute('aria-disabled', 'true'); expect(b).not.toHaveAttribute('aria-disabled', 'true');
  await act(async () => replies.get(`/api/v1/activities/${first.id}/complete`)!(response({}, 412)));
  expect(await screen.findByRole('alert')).toHaveTextContent('displayed version'); expect(a).toHaveAttribute('aria-disabled', 'true');
});

it('keeps a conflicted displayed Task until explicit refresh then completes using the new ETag', async () => {
  let fail = true; let fresh = false; let done = false;
  const fetch = vi.fn(async (_: string, init: RequestInit) => {
    if (init.method === 'POST') { if (fail) return response({ code: 'CONCURRENCY_CONFLICT' }, 412); done = true; return response(first); }
    return result(done ? [] : [{ ...first, etag: fresh ? '"refreshed-version"' : first.etag }]);
  });
  vi.stubGlobal('fetch', fetch); render(); await screen.findByText(first.subject);
  command().focus(); await userEvent.keyboard('{Enter}'); await screen.findByRole('alert');
  expect(screen.getByText(first.subject)).toBeVisible(); expect(screen.getByRole('link', { name: 'Review current activity' })).toHaveAttribute('href', `/organizations/${first.organizationId}?tab=activities&activityId=${first.id}`);
  fireEvent.click(command()); await userEvent.keyboard('{Enter} '); expect(fetch).toHaveBeenCalledTimes(2);
  fail = false; fresh = true; await userEvent.click(screen.getByRole('button', { name: 'Refresh my tasks' })); await screen.findByText(first.subject);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument(); await userEvent.click(command());
  await screen.findByText('Nothing assigned to you right now.'); expect(posts(fetch)).toHaveLength(2);
  expect(posts(fetch)[1]![1].headers).toMatchObject({ 'If-Match': '"refreshed-version"' }); expect(fetch).toHaveBeenCalledTimes(5);
});

it('refuses a command with no displayed ETag and offers an explicit review path without sending a write', async () => {
  const fetch = vi.fn(async () => result([{ ...first, etag: '' }])); vi.stubGlobal('fetch', fetch); render(); await screen.findByText(first.subject);
  await userEvent.click(command()); expect(await screen.findByRole('alert')).toHaveTextContent('displayed version');
  expect(posts(fetch)).toHaveLength(0); expect(fetch).toHaveBeenCalledTimes(1);
});

it('does not retry or reread after a failed command whose outcome is unknown', async () => {
  const fetch = vi.fn(async (_: string, init: RequestInit) => { if (init.method === 'POST') throw new TypeError('Synthetic connection loss'); return result(); });
  vi.stubGlobal('fetch', fetch); render(); await screen.findByText(first.subject); await userEvent.click(command());
  await waitFor(() => expect(command()).not.toHaveAttribute('aria-disabled', 'true')); expect(fetch).toHaveBeenCalledTimes(2); expect(posts(fetch)).toHaveLength(1);
  expect(screen.getByText(first.subject)).toBeVisible();
});
