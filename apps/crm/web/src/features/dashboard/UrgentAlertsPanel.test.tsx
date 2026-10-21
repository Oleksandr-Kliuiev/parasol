import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { urgentAlert, urgentAlerts } from '../../test/urgentAlerts';
import { formatReadAt } from '../../shared/utils/format';
import { MyDayPage } from './MyDayPage';
import { UrgentAlertsPanel } from './UrgentAlertsPanel';

const urgent = '/api/v1/service/alerts/urgent?limit=5';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const empty = { items: [], nextCursor: null, totalCount: 0 };
afterEach(() => vi.unstubAllGlobals());

/** Answers the urgent list with `reply` and every other read of My day with an empty page. */
function stub(reply: () => Response | Promise<Response>) {
  const fetch = vi.fn(async (url: string) => (url === urgent ? reply() : json(empty)));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const urgentReads = (fetch: ReturnType<typeof stub>) => fetch.mock.calls.filter(([url]) => url === urgent).length;

describe('the urgent alerts of My day', () => {
  it('lists the most severe alerts with customer, device and age, links each one to the queue and says how many are open', async () => {
    const fetch = stub(() => json(urgentAlerts()));
    renderRoutes([page(<UrgentAlertsPanel />)], '/', testUser(['service.read']));
    const panel = await screen.findByRole('region', { name: 'Urgent alerts' });
    expect(await within(panel).findByText(`Atera read at ${formatReadAt('2026-10-21T06:30:00Z')}`)).toBeVisible();
    expect(within(panel).getByText('2 of 7 open alerts, most severe and oldest first')).toBeVisible();
    const rows = within(panel).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    // The customer completes each link's name: alerts of one kind share a title (jsdom drops the space before the dot).
    expect(within(rows[0]!).getByRole('link', { name: /^Disk C: almost full ?· Fjordkraft Test AS$/ })).toHaveAttribute('href', '/alerts?alert=a1');
    expect(within(rows[0]!).getByText('Critical')).toBeVisible();
    expect(within(rows[0]!).getByText(/^Fjordkraft Test AS · SRV-01 ·/)).toBeVisible();
    expect(rows[0]!.querySelector('time')).toHaveAttribute('datetime', '2026-10-20T06:00:00Z');
    expect(within(rows[1]!).getByRole('link', { name: /^Backup agent offline ?· Havbris Test AS$/ })).toHaveAttribute('href', '/alerts?alert=a2');
    expect(within(rows[1]!).getByText('Warning')).toBeVisible();
    expect(within(panel).getByRole('link', { name: 'All open alerts (7)' })).toHaveAttribute('href', '/alerts');
    expect(urgentReads(fetch)).toBe(1);
  });

  it('says when the last read did not finish, and never calls a source nobody has read empty', async () => {
    let reply = urgentAlerts({ items: [urgentAlert('a1')], totalCount: 1, warning: 0, reads: [{ system: 'atera', startedAt: '2026-10-21T06:30:00Z', complete: false }] });
    stub(() => json(reply));
    renderRoutes([page(<UrgentAlertsPanel />)], '/', testUser(['service.read']));
    const panel = await screen.findByRole('region', { name: 'Urgent alerts' });
    expect(await within(panel).findByText(`Atera: the read at ${formatReadAt('2026-10-21T06:30:00Z')} did not finish`)).toBeVisible();
    expect(within(panel).getByText('1 open alert')).toBeVisible();

    reply = urgentAlerts({ items: [], totalCount: 0, critical: 0, warning: 0, reads: [{ system: 'atera', startedAt: null, complete: false }] });
    await userEvent.click(within(panel).getByRole('button', { name: 'Refresh urgent alerts' }));
    expect(await within(panel).findByText('Atera not read yet')).toBeVisible();
    expect(within(panel).getByText('Alerts appear here after the first read.')).toBeVisible();
    expect(within(panel).queryByText('No open alerts.')).not.toBeInTheDocument();
    expect(within(panel).queryByRole('link', { name: /All open alerts/ })).not.toBeInTheDocument();
  });

  it('hides the earlier list while it reads again and after a failed read, and keeps focus on the refresh', async () => {
    let finish!: (response: Response) => void;
    let reads = 0;
    stub(() => (++reads === 1 ? json(urgentAlerts()) : new Promise<Response>((resolve) => { finish = resolve; })));
    renderRoutes([page(<UrgentAlertsPanel />)], '/', testUser(['service.read']));
    const panel = await screen.findByRole('region', { name: 'Urgent alerts' });
    await within(panel).findByRole('link', { name: /^Disk C: almost full/ });
    const refresh = within(panel).getByRole('button', { name: 'Refresh urgent alerts' });
    refresh.focus(); await userEvent.keyboard('{Enter}');
    expect(refresh).toHaveAttribute('aria-disabled', 'true'); expect(refresh).toHaveFocus();
    expect(within(panel).queryByRole('listitem')).not.toBeInTheDocument();
    await userEvent.keyboard('{Enter}'); expect(reads).toBe(2);
    await act(async () => finish(json({ detail: 'synthetic-private-error' }, 503)));
    expect(await within(panel).findByText('Urgent alerts could not be read. No earlier list is shown. Refresh to try again.')).toBeVisible();
    expect(within(panel).queryByRole('listitem')).not.toBeInTheDocument();
    expect(within(panel).queryByText(/synthetic-private/)).not.toBeInTheDocument();
    expect(within(panel).queryByText(/Atera read at/)).not.toBeInTheDocument();
  });

  it('is neither shown nor asked for without service access', async () => {
    const fetch = stub(() => json(urgentAlerts()));
    renderRoutes([page(<MyDayPage />)], '/', testUser(['activities.read', 'customers.read']));
    await screen.findByRole('heading', { name: /^Good (morning|afternoon|evening), Kari$/ });
    await screen.findByText('Nothing assigned to you right now.');
    expect(screen.queryByRole('region', { name: 'Urgent alerts' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Critical alerts/ })).not.toBeInTheDocument();
    expect(urgentReads(fetch)).toBe(0);
  });
});

describe('the critical alerts figure', () => {
  const tile = () => screen.findByRole('link', { name: /^Critical alerts/ });

  it('counts the critical alerts with the warnings beside them from the panel\'s own read', async () => {
    const fetch = stub(() => json(urgentAlerts()));
    renderRoutes([page(<MyDayPage />)], '/', testUser(['service.read', 'customers.read']));
    const figure = await tile();
    expect(await within(figure).findByText('6 warnings')).toBeVisible();
    expect(within(figure).getByText('1')).toBeVisible();
    expect(figure).toHaveAttribute('href', '/?section=alerts#my-day-alerts');
    expect(urgentReads(fetch)).toBe(1);
  });

  it.each([
    ['nobody has read the source', () => json(urgentAlerts({ items: [], totalCount: 0, critical: 0, warning: 0, reads: [{ system: 'atera', startedAt: null, complete: false }] })), 'Not read yet'],
    ['the read failed', () => json({ detail: 'synthetic-private-error' }, 500), 'Could not be read'],
  ])('shows no zero when %s', async (_, reply, foot) => {
    stub(reply);
    renderRoutes([page(<MyDayPage />)], '/', testUser(['service.read', 'customers.read']));
    const figure = await tile();
    expect(await within(figure).findByText(foot)).toBeVisible();
    expect(within(figure).getByText('—')).toBeVisible();
    expect(within(figure).queryByText('0')).not.toBeInTheDocument();
  });

  it('says a read that did not finish in its footer too', async () => {
    stub(() => json(urgentAlerts({ reads: [{ system: 'atera', startedAt: '2026-10-21T06:30:00Z', complete: false }] })));
    renderRoutes([page(<MyDayPage />)], '/', testUser(['service.read', 'customers.read']));
    expect(await within(await tile()).findByText('6 warnings · last read incomplete')).toBeVisible();
  });

  it('waits with the panel while it reads again instead of showing the figure of the last read', async () => {
    let finish!: (response: Response) => void;
    let reads = 0;
    stub(() => (++reads === 1 ? json(urgentAlerts()) : new Promise<Response>((resolve) => { finish = resolve; })));
    renderRoutes([page(<MyDayPage />)], '/', testUser(['service.read', 'customers.read']));
    const figure = await tile();
    await within(figure).findByText('6 warnings');
    await userEvent.click(screen.getByRole('button', { name: 'Refresh urgent alerts' }));
    await waitFor(() => expect(within(figure).queryByText('6 warnings')).not.toBeInTheDocument());
    await act(async () => finish(json(urgentAlerts({ critical: 3, warning: 4 }))));
    expect(await within(figure).findByText('4 warnings')).toBeVisible();
    expect(within(figure).getByText('3')).toBeVisible();
  });
});
