import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../../test/renderWithProviders';
import { alertPage, alertRead, syntheticAlert } from '../../../test/alerts';
import type { Alert } from '../types';
import { AlertDetailDrawer } from './AlertDetailDrawer';
import { AlertQueuePage } from './AlertQueuePage';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const empty = { items: [], nextCursor: null, totalCount: 0 };
const kinds = (enabled: string[]) => enabled.map((kind) => ({ system: 'atera', kind, targetType: 'alert', level: kind === 'alert.delete' ? 'Destructive' : 'Standard',
  simulated: false, limitedToCustomers: false }));

afterEach(() => vi.unstubAllGlobals());

function stub(enabled: string[]) {
  const alert = syntheticAlert();
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/v1/actions/kinds')) return json(kinds(enabled));
    if (url === '/api/v1/actions/preview' && init?.method === 'POST') return json({ title: 'synthetic stop', status: 409, code: 'VND_KIND_DISABLED' }, 409);
    if (url.startsWith('/api/v1/actions?')) return json({ ...empty, uncertain: 0, waiting: 0 });
    if (url === `/api/v1/service/alerts/${alert.id}`) return json(alert);
    if (url.startsWith('/api/v1/service/alerts?limit=1')) return json(alertPage([], null, 0, [alertRead()]));
    if (url.startsWith('/api/v1/service/alerts')) return json(alertPage([alert]));
    if (url.endsWith('/source-tasks/lookup')) return json({ items: [] });
    return json(empty);
  });
  vi.stubGlobal('fetch', fetch);
  return { alert, fetch };
}

describe('Alert actions at the source (M40)', () => {
  it('offers closing and deleting in Atera from the row, and opens the one confirmation with the alert as its target', async () => {
    const user = userEvent.setup();
    const { fetch } = stub(['alert.resolve', 'alert.delete']);
    renderRoutes([page(<AlertQueuePage />)], '/alerts', testUser(['service.read', 'service.write']));
    await user.click(await screen.findByRole('button', { name: 'Actions for Disk almost full on SRV-01' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Hide until…', 'Close in Atera', 'Delete in Atera…']);

    await user.click(within(menu).getByRole('menuitem', { name: 'Close in Atera' }));
    expect(await screen.findByRole('dialog', { name: 'Close the alert in Atera' })).toBeVisible();
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url === '/api/v1/actions/preview')).toBe(true));
    const [, init] = fetch.mock.calls.find(([url]) => url === '/api/v1/actions/preview')!;
    expect(JSON.parse(String(init!.body))).toEqual({ system: 'atera', kind: 'alert.resolve', targetType: 'alert', targetId: '920029', parameters: {} });
  });

  it('offers only hiding while Atera takes no action, and nothing to a person who may only read', async () => {
    const user = userEvent.setup();
    stub([]);
    const { unmount } = renderRoutes([page(<AlertQueuePage />)], '/alerts', testUser(['service.read', 'service.write']));
    await user.click(await screen.findByRole('button', { name: 'Actions for Disk almost full on SRV-01' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Hide until…']);
    unmount();

    stub(['alert.resolve', 'alert.delete']);
    renderRoutes([page(<AlertQueuePage />)], '/alerts', testUser(['service.read']));
    expect(await screen.findByRole('button', { name: 'Disk almost full on SRV-01' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Actions for Disk almost full on SRV-01' })).not.toBeInTheDocument();
  });

  it('hides an alert until a day with a reason, sending the ETag of the alert it read', async () => {
    const user = userEvent.setup();
    const { alert, fetch } = stub([]);
    const read = { ...alert, etag: '"AAAAAAAAB9E="' };
    fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/v1/service/alerts/a1/hide' && init?.method === 'POST') return json({ ...read, hidden: { until: '2026-10-29T22:00:00Z', reason: 'Disk ordered', byName: 'Kari Nordmann', at: null } });
      if (url === '/api/v1/service/alerts/a1') return json(read);
      if (url.startsWith('/api/v1/actions/kinds')) return json([]);
      if (url.startsWith('/api/v1/service/alerts')) return json(alertPage([alert]));
      return json(empty);
    });
    renderRoutes([page(<AlertQueuePage />)], '/alerts', testUser(['service.read', 'service.write']));
    await user.click(await screen.findByRole('button', { name: 'Actions for Disk almost full on SRV-01' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Hide until…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Hide the alert until a day' });
    expect(within(dialog).getByText(/API cannot snooze an alert, so it stays open there/)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'In a week' }));
    await user.click(within(dialog).getByRole('button', { name: 'Hide' }));
    expect(await within(dialog).findByText('Say why the alert is hidden.')).toBeVisible();
    await user.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'Disk ordered');
    await user.click(within(dialog).getByRole('button', { name: 'Hide' }));

    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url === '/api/v1/service/alerts/a1/hide')).toBe(true));
    const [, init] = fetch.mock.calls.find(([url]) => url === '/api/v1/service/alerts/a1/hide')!;
    expect(new Headers(init!.headers).get('If-Match')).toBe('"AAAAAAAAB9E="');
    const body = JSON.parse(String(init!.body)) as { until: string; reason: string };
    expect(body.reason).toBe('Disk ordered');
    expect(body.until).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Hide the alert until a day' })).not.toBeInTheDocument());
    // The row leaves the open list with its menu: focus goes to the list, not to the page behind it.
    await waitFor(() => expect(document.querySelector('[data-alert-list]')).toHaveFocus());
  });

  it('shows a hidden alert again from its panel with the ETag it reads, keeping focus in the panel', async () => {
    const user = userEvent.setup();
    const { alert, fetch } = stub([]);
    let hidden: Alert['hidden'] = { until: '2026-10-29T23:00:00Z', reason: 'Disk ordered', byName: 'Kari Nordmann', at: '2026-10-22T08:00:00Z' };
    fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/v1/service/alerts/a1/show' && init?.method === 'POST') { hidden = null; return json({ ...alert, hidden }); }
      if (url === '/api/v1/service/alerts/a1') return json({ ...alert, hidden, etag: '"AAAAAAAAB9F="' });
      if (url.startsWith('/api/v1/actions/kinds')) return json([]);
      if (url.startsWith('/api/v1/actions?')) return json({ ...empty, uncertain: 0, waiting: 0 });
      return json(empty);
    });
    renderRoutes([page(<AlertDetailDrawer alertId="a1" onClose={() => {}} />)], '/', testUser(['service.read', 'service.write']));
    const own = within(await screen.findByRole('region', { name: 'In Parasoll' }));
    expect(own.getByText(/^Hidden until .*30.* by Kari Nordmann: “Disk ordered”$/)).toBeVisible();
    await user.click(own.getByRole('button', { name: 'Show again' }));

    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url === '/api/v1/service/alerts/a1/show')).toBe(true));
    const [, init] = fetch.mock.calls.find(([url]) => url === '/api/v1/service/alerts/a1/show')!;
    expect(new Headers(init!.headers).get('If-Match')).toBe('"AAAAAAAAB9F="');
    // The panel reads the alert again and draws it anew: focus lands on the section that now says it is not hidden.
    await waitFor(() => expect(screen.getByRole('heading', { name: 'In Parasoll' })).toHaveFocus());
    expect(within(screen.getByRole('region', { name: 'In Parasoll' })).getByRole('button', { name: 'Hide until…' })).toBeVisible();
  });

  it('gives the alert panel its actions in Atera and the log of what was asked', async () => {
    stub(['alert.resolve', 'alert.delete']);
    renderRoutes([page(<AlertDetailDrawer alertId="a1" onClose={() => {}} />)], '/', testUser(['service.read', 'service.write']));
    const section = within(await screen.findByRole('region', { name: 'In Atera' }));
    expect(await section.findByRole('button', { name: 'Close in Atera' })).toBeVisible();
    expect(section.getByRole('button', { name: 'Delete in Atera…' })).toBeVisible();
    expect(await section.findByText('Nothing has been asked of Atera for this alert.')).toBeVisible();
  });
});
