import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toaster } from '@fluentui/react-components';
import type { ConnectionTestStatus, IntegrationStatus } from '../../api/types';
import { TOASTER_ID } from '../../app/toaster';
import { renderRoutes, testUser } from '../../test/renderWithProviders';
import { SystemsPanel } from './SystemsPanels';

const status: IntegrationStatus[] = [
  {
    system: 'poweroffice', enabled: true, recordTypes: ['Customer'], records: 3, unlinked: 1,
    pendingOutbound: 0, failedOutbound: 0, paused: false, pauseReason: null, pausedAt: null, pausedBy: null,
  },
];

const queued: ConnectionTestStatus = {
  id: 't1', system: 'poweroffice', status: 'Running', success: null, message: null, requestedAt: '2026-10-04T08:00:00Z', finishedAt: null,
};

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** The panel and its toaster: reads get `systems`, a POST gets `post`'s answer. */
function renderPanel(post: Fetch = async () => new Response('{}'), systems = status) {
  const fetch = vi.fn<Fetch>(async (url, init) => (init?.method === 'POST' ? post(url, init) : new Response(JSON.stringify(systems))));
  vi.stubGlobal('fetch', fetch);
  // The browser's own box ignores the app's theme and motion; the reason is asked for in the app's dialog.
  const prompt = vi.fn(() => null);
  vi.stubGlobal('prompt', prompt);
  renderRoutes(
    [{ path: '/admin', element: <><Toaster toasterId={TOASTER_ID} /><SystemsPanel /></> }],
    '/admin',
    testUser(['integrations.manage']),
  );
  return { prompt, posts: () => fetch.mock.calls.filter(([, init]) => init?.method === 'POST') };
}

async function openPause(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Pause' }));
  return screen.findByRole('dialog', { name: 'Pause PowerOffice Go' });
}

const required = 'Write why the integration is being paused.';

afterEach(() => vi.unstubAllGlobals());

describe('SystemsPanel', () => {
  it('asks for the reason in its own dialog and refuses an empty one', async () => {
    const { prompt, posts } = renderPanel();
    const user = userEvent.setup();
    const dialog = await openPause(user);
    const reason = within(dialog).getByRole('textbox', { name: 'Reason' });
    await waitFor(() => expect(reason).toHaveFocus());

    await user.click(within(dialog).getByRole('button', { name: 'Pause' }));
    expect(within(dialog).getByText(required)).toBeVisible();
    expect(reason).toHaveAttribute('aria-invalid', 'true');
    expect(reason).toHaveAccessibleDescription(expect.stringContaining(required));
    expect(reason).toHaveFocus();

    // Spaces are no reason either.
    await user.type(reason, '   ');
    await user.click(within(dialog).getByRole('button', { name: 'Pause' }));
    expect(within(dialog).getByText(required)).toBeVisible();
    expect(posts()).toEqual([]);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('sends the reason with the pause, stays busy until the answer and then closes', async () => {
    let answer: (response: Response) => void = () => {};
    const { posts } = renderPanel(() => new Promise<Response>((resolve) => { answer = resolve; }));
    const user = userEvent.setup();
    const dialog = await openPause(user);

    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), '  PowerOffice answers 500 to every write  ');
    await user.click(within(dialog).getByRole('button', { name: 'Pause' }));

    const confirm = within(dialog).getByRole('button', { name: 'Pause' });
    await waitFor(() => expect(confirm).toHaveAttribute('aria-disabled', 'true'));
    expect(confirm).toHaveFocus();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    // Neither a second press nor Escape leaves the request without its answer.
    await user.click(confirm);
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Pause PowerOffice Go' })).toBeVisible();
    expect(posts()).toHaveLength(1);
    const [url, init] = posts()[0]!;
    expect(url).toBe('/api/v1/integrations/poweroffice/pause');
    expect(JSON.parse(String(init?.body))).toEqual({ paused: true, reason: 'PowerOffice answers 500 to every write' });
    expect(new Headers(init?.headers).has('If-Match')).toBe(false);

    answer(new Response(JSON.stringify({ system: 'poweroffice', paused: true, reason: 'PowerOffice answers 500 to every write' })));
    expect(await screen.findByText('The integration is paused: jobs skip and the queue waits.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('keeps the dialog and the reason when the pause is refused', async () => {
    const { posts } = renderPanel(async () => new Response(JSON.stringify({ status: 403, title: 'Forbidden' }), { status: 403 }));
    const user = userEvent.setup();
    const dialog = await openPause(user);

    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Atera sync loops');
    await user.click(within(dialog).getByRole('button', { name: 'Pause' }));

    expect(await within(dialog).findByText("You don't have permission to do this.")).toBeVisible();
    expect(within(dialog).getByRole('textbox', { name: 'Reason' })).toHaveValue('Atera sync loops');
    expect(within(dialog).getByRole('button', { name: 'Pause' })).not.toHaveAttribute('aria-disabled');
    expect(posts()).toHaveLength(1);
  });

  it('closes without pausing when cancelled', async () => {
    const { posts } = renderPanel();
    const user = userEvent.setup();
    const dialog = await openPause(user);

    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Not yet');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(posts()).toEqual([]);
  });

  it('resumes without asking for a reason', async () => {
    const paused = { ...status[0]!, paused: true, pauseReason: 'Incident 42', pausedAt: '2026-10-20T08:00:00Z', pausedBy: 'Kari Nordmann' };
    const { posts } = renderPanel(undefined, [paused]);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Resume' }));

    expect(await screen.findByText('The integration runs again.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const [url, init] = posts()[0]!;
    expect(url).toBe('/api/v1/integrations/poweroffice/pause');
    expect(JSON.parse(String(init?.body))).toEqual({ paused: false, reason: null });
  });

  it('queues the connection test for the worker and shows its answer when it comes', async () => {
    let answered = false;
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify(queued), { status: 202 });
      if (url === '/api/v1/integrations/poweroffice/test/t1') {
        // The worker answers on the second question.
        const answer = answered
          ? { ...queued, status: 'Succeeded', success: true, message: 'Connected to PowerOffice Go (Demo).', finishedAt: '2026-10-04T08:00:03Z' }
          : queued;
        answered = true;
        return new Response(JSON.stringify(answer), { status: 200 });
      }
      return new Response(JSON.stringify(status), { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();
    renderRoutes(
      [{ path: '/admin', element: <><Toaster toasterId={TOASTER_ID} /><SystemsPanel /></> }],
      '/admin',
      testUser(['integrations.manage']),
    );

    await user.click(await screen.findByRole('button', { name: 'Test connection' }));

    expect(await screen.findByRole('button', { name: 'Testing…' })).toBeDisabled();
    expect(await screen.findByText('Connected to PowerOffice Go (Demo).', undefined, { timeout: 5_000 })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Test connection' })).toBeEnabled());
    expect(fetch.mock.calls.filter(([url]) => url === '/api/v1/integrations/poweroffice/test/t1').length).toBeGreaterThanOrEqual(2);
    expect(fetch.mock.calls.find(([, init]) => init?.method === 'POST')?.[0]).toBe('/api/v1/integrations/poweroffice/test');
  });
});
