import { afterEach, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { syntheticActivity } from '../../test/activities';
import { association, auxiliary, json, ticket } from './taskTicketTestFixture';
import { MyTasksPanel } from './MyTasksPanel';

const task = syntheticActivity();
const permissions = ['activities.read', 'activities.write', 'service.read', 'time.own'];
const list = () => json({ items: [task], nextCursor: null, totalCount: 1 });
const render = (allowed = permissions) => renderRoutes([page(<MyTasksPanel />)], '/my-day', testUser(allowed));
const trigger = () => screen.getByRole('button', { name: `Service ticket for ${task.subject}` });
afterEach(() => vi.unstubAllGlobals());

it('opens the saved ticket and an empty own-time form directly from My Day without eager reads or navigation', async () => {
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    expect(init.method).toBe('GET');
    return url.startsWith('/api/v1/activities/?') ? list()
      : url.includes('/ticket?') ? json(association(ticket)) : auxiliary(url) ?? json({});
  });
  vi.stubGlobal('fetch', fetch); const { router } = render();
  await screen.findByText(task.subject); expect(fetch).toHaveBeenCalledTimes(1);
  trigger().focus(); await userEvent.keyboard('{Enter}');
  expect(await screen.findByText(`#${ticket.externalId} · ${ticket.title}`)).toBeVisible();
  expect(fetch.mock.calls[1]![0]).toBe(`/api/v1/activities/${task.id}/ticket?organizationId=${task.organizationId}`);
  await userEvent.click(screen.getByRole('button', { name: /^Register hours$/ }));
  expect(await screen.findByRole('dialog', { name: 'Register hours' })).toBeVisible();
  expect(screen.getByRole('textbox', { name: /^Hours$/ })).toHaveValue('');
  expect(screen.getByRole('textbox', { name: /^Description$/ })).toHaveValue('');
  expect(screen.getByRole('button', { name: /^Register hours$/ })).toBeDisabled();
  expect(router.state.location.pathname).toBe('/my-day');
});

it('does not expose a ticket action or request ticket data without Service read permission', async () => {
  const fetch = vi.fn(async () => list()); vi.stubGlobal('fetch', fetch); render(['activities.read', 'activities.write', 'time.own']);
  await screen.findByText(task.subject);
  expect(screen.queryByRole('button', { name: `Service ticket for ${task.subject}` })).not.toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('lets a Service reader inspect the saved ticket without link changes or time registration', async () => {
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    expect(init.method).toBe('GET');
    return url.includes('/ticket?') ? json(association(ticket)) : list();
  });
  vi.stubGlobal('fetch', fetch); render(['activities.read', 'service.read']);
  await screen.findByText(task.subject); await userEvent.click(trigger());
  expect(await screen.findByText(`#${ticket.externalId} · ${ticket.title}`)).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Register hours' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Change saved ticket' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Unlink ticket' })).not.toBeInTheDocument();
});

it('cancels a pending ticket read when the personal list refreshes and never restores its late dialog', async () => {
  let signal!: AbortSignal; let finish!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url.includes('/ticket?')) {
      signal = init.signal as AbortSignal;
      return new Promise<Response>(resolve => { finish = resolve; });
    }
    return list();
  }));
  render(); await screen.findByText(task.subject); await userEvent.click(trigger());
  await waitFor(() => expect(signal).toBeDefined());
  await userEvent.click(screen.getByRole('button', { name: 'Refresh my tasks' }));
  await waitFor(() => expect(signal.aborted).toBe(true));
  await act(async () => finish(json(association(ticket))));
  await screen.findByText(task.subject);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByText(`#${ticket.externalId} · ${ticket.title}`)).not.toBeInTheDocument();
});
