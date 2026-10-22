import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../../test/renderWithProviders';
import { alertPage, alertRead, syntheticAlert } from '../../../test/alerts';
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
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Close in Atera', 'Delete in Atera…']);

    await user.click(within(menu).getByRole('menuitem', { name: 'Close in Atera' }));
    expect(await screen.findByRole('dialog', { name: 'Close the alert in Atera' })).toBeVisible();
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url === '/api/v1/actions/preview')).toBe(true));
    const [, init] = fetch.mock.calls.find(([url]) => url === '/api/v1/actions/preview')!;
    expect(JSON.parse(String(init!.body))).toEqual({ system: 'atera', kind: 'alert.resolve', targetType: 'alert', targetId: '920029', parameters: {} });
  });

  it('shows no actions while Atera takes none, nor to a person who may only read', async () => {
    stub([]);
    const { unmount } = renderRoutes([page(<AlertQueuePage />)], '/alerts', testUser(['service.read', 'service.write']));
    expect(await screen.findByRole('button', { name: 'Disk almost full on SRV-01' })).toBeVisible();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Actions for Disk almost full on SRV-01' })).not.toBeInTheDocument());
    unmount();

    stub(['alert.resolve', 'alert.delete']);
    renderRoutes([page(<AlertQueuePage />)], '/alerts', testUser(['service.read']));
    expect(await screen.findByRole('button', { name: 'Disk almost full on SRV-01' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Actions for Disk almost full on SRV-01' })).not.toBeInTheDocument();
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
