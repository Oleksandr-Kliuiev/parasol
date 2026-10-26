import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { connectionGaps, connectionStatus } from '../../test/connectionStatus';
import { CurrentUserContext } from '../../auth/CurrentUserContext';
import { ConnectionReadinessPage } from './ConnectionReadinessPage';

const permissions = ['integrations.manage'];
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const render = (allowed = permissions) => renderRoutes([page(<ConnectionReadinessPage />)], '/connections', testUser(allowed));
const worker = 'Background service';
const emptyLog = { items: [], nextCursor: null, totalCount: 0, uncertain: 0, waiting: 0 };
/** The action log under the cards (M39.1) reads on its own; these tests count the reads of the status only. */
const withLog = (status: (url: string, init: RequestInit) => Promise<Response>) => vi.fn((url: string, init: RequestInit) =>
  url.startsWith('/api/v1/actions') ? Promise.resolve(response(emptyLog)) : status(url, init));
afterEach(() => vi.unstubAllGlobals());

describe('the connections page', () => {
  it.each([[['customers.read']], [['customers.read', 'service.read', 'activities.read']]])(
    'does not ask for the status without integration administration (%j)', async allowed => {
      const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); render(allowed);
      expect(await screen.findByRole('heading', { name: 'No access' })).toBeVisible();
      expect(screen.queryByRole('heading', { name: 'Connection status' })).not.toBeInTheDocument(); expect(fetch).not.toHaveBeenCalled();
    });

  it('is green for a complete picture and shows each integration, its jobs and the worker without asking again', async () => {
    const fetch = vi.fn(async () => response(connectionStatus())); vi.stubGlobal('fetch', withLog(fetch)); render();
    expect(await screen.findByText(/^Everything is up to date/)).toBeVisible();
    expect(fetch).toHaveBeenCalledWith('/api/v1/integrations/connections', expect.anything());
    expect(screen.getByText(/The systems themselves are not contacted/)).toBeVisible();
    for (const name of [worker, 'Atera', 'PowerOffice Go', 'Brønnøysund Register Centre']) expect(screen.getByRole('region', { name })).toBeVisible();
    const atera = within(screen.getByRole('region', { name: 'Atera' }));
    expect(atera.getByText('Changes made in Parasoll are not sent to Atera.')).toBeVisible();
    // The jobs, then Atera's webhook (M44).
    const [alerts, tickets, webhook, ...rest] = atera.getAllByRole('listitem'); const rows = [alerts!, tickets!];
    expect(rest).toHaveLength(0);
    expect(rows.map((row) => within(row).getByText(/\(Atera\)$/).textContent)).toEqual(['Alerts (Atera)', 'Open tickets (Atera)']);
    expect(within(webhook!).getByText('Webhook')).toBeVisible();
    expect(within(webhook!).getByText('On')).toBeVisible();
    expect(webhook!).toHaveTextContent(/Last event .+: ticket changed · deliveries received: 12/);
    expect(within(webhook!).getByText(/Last early read/)).toBeVisible();
    // The limit says what it is for: the job counts as late after it.
    expect(within(rows[1]!).getByText(/late after 15 min/)).toBeVisible();
    expect(rows[1]!.querySelector('time')).toHaveAttribute('datetime', '2026-10-16T09:55:00Z');
    expect(within(rows[1]!).getByText('Up to date')).toBeVisible();
    const office = within(screen.getByRole('region', { name: 'PowerOffice Go' }));
    expect(office.getByText("Switched off in this installation's settings, so its jobs do not run.")).toBeVisible();
    expect(office.queryByRole('listitem')).not.toBeInTheDocument();
    const service = within(screen.getByRole('region', { name: worker }));
    expect(service.getAllByRole('listitem')
      .map((row) => within(row).getByText(/^(Change delivery|Scheduled jobs|Action delivery to vendors|Early reads from webhooks)$/).textContent))
      .toEqual(['Change delivery', 'Scheduled jobs', 'Action delivery to vendors', 'Early reads from webhooks']);
    expect(service.getAllByText('Running')).toHaveLength(4);
    // Nothing needs attention: the way to administration stays in the note at the end only; the action log has only its filters.
    expect(screen.getByRole('link', { name: 'Open integration administration' })).toHaveAttribute('href', '/admin/integrations');
    const log = screen.getByRole('region', { name: 'Actions at vendors' });
    expect(await within(log).findByText('No actions yet.')).toBeVisible();
    expect(screen.getAllByRole('button').filter((button) => !log.contains(button))).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Refresh status' })).toBeVisible();
    fireEvent(document, new Event('visibilitychange')); fireEvent(window, new Event('online')); expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('names every gap in the same box and marks the cards that need attention', async () => {
    vi.stubGlobal('fetch', withLog(vi.fn(async () => response(connectionGaps())))); render();
    const box = (await screen.findByText('6 things need attention')).closest('.fui-MessageBar') as HTMLElement;
    expect(within(box).getAllByRole('listitem').map((item) => item.textContent?.replace(/ \d+ \w+ ago/, ' …'))).toEqual([
      'Alerts (Atera): the last run failed …',
      'Open tickets (Atera): last complete read …, late after 15 min',
      'Customers (Atera): no complete read yet',
      'Atera: 2 changes could not be sent',
      'Brønnøysund Register Centre is paused: its jobs are skipped until someone resumes it',
      'Background service, Scheduled jobs: last sign of life …',
    ]);
    // The way to act on the gaps is in the box that names them, not only at the end of the page.
    expect(within(box).getByRole('link', { name: 'Open integration administration' })).toHaveAttribute('href', '/admin/integrations');
    expect(screen.getAllByRole('link', { name: 'Open integration administration' })).toHaveLength(2);
    const atera = within(screen.getByRole('region', { name: 'Atera' }));
    expect(atera.getByText('Needs attention')).toBeVisible();
    expect(atera.getByText('2 changes could not be sent.')).toBeVisible();
    expect(atera.getByText('Last run failed')).toBeVisible();
    expect(atera.getByText('Never read')).toBeVisible();
    expect(within(screen.getByRole('region', { name: 'Brønnøysund Register Centre' })).getAllByText('Paused')).toHaveLength(2);
    expect(within(screen.getByRole('region', { name: worker })).getByText('Late')).toBeVisible();
    expect(screen.queryByText(/^Everything is up to date/)).not.toBeInTheDocument();
  });

  it('says so when the saved state could not be read, without zeroes or old figures', async () => {
    const value = connectionStatus(); value.status = 'Unavailable'; value.worker = null;
    for (const integration of value.integrations) { integration.state = null; integration.webhook = null; }
    vi.stubGlobal('fetch', withLog(vi.fn(async () => response(value)))); render();
    expect(await screen.findByText('The saved state could not be read, so nothing is shown as up to date. Refresh to try again.')).toBeVisible();
    for (const name of [worker, 'Atera', 'PowerOffice Go']) expect(within(screen.getByRole('region', { name })).getByText('Saved state could not be read.')).toBeVisible();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
    expect(screen.queryByText('Up to date')).not.toBeInTheDocument();
  });

  it('names a webhook that is off, and one that refuses deliveries with the reason, without making the page yellow (M44)', async () => {
    const value = connectionStatus();
    // An event Parasoll has no words for keeps the vendor's name.
    Object.assign(value.integrations[0]!.webhook!, { lastRefusedAt: '2026-10-16T09:58:00Z', lastRefusal: 'BadSignature', lastEventType: 'ping' });
    value.integrations.push({ ...value.integrations[0]!, system: 'huntress', webhook: { ...value.integrations[0]!.webhook!, enabled: false } });
    vi.stubGlobal('fetch', withLog(vi.fn(async () => response(value)))); render();
    expect(await screen.findByText(/^Everything is up to date/)).toBeVisible();
    const atera = within(screen.getByRole('region', { name: 'Atera' })).getAllByRole('listitem')[2]!;
    expect(within(atera).getByText('Needs attention')).toBeVisible();
    expect(atera).toHaveTextContent(/Last refused delivery .+: the signature or key does not match the one set in Parasoll/);
    expect(atera).toHaveTextContent(/Last event .+: ping/);
    const huntress = within(screen.getByRole('region', { name: 'Huntress' })).getAllByRole('listitem')[2]!;
    expect(within(huntress).getByText('Off')).toBeVisible();
    expect(within(huntress).getByText('Changes arrive with the scheduled reads.')).toBeVisible();
    expect(huntress).not.toHaveTextContent(/refused/i);
  });

  it('does not salvage a reply with an unexpected section', async () => {
    vi.stubGlobal('fetch', withLog(vi.fn(async () => response({ ...connectionStatus(), personal: { status: 'PRESENT' } })))); render();
    expect(await screen.findByText('The connection status reply was invalid. No unverified details are shown.')).toBeVisible();
    expect(screen.queryByRole('region', { name: worker })).not.toBeInTheDocument(); expect(screen.queryByText('Atera')).not.toBeInTheDocument();
  });

  it('hides old details during a keyboard refresh, keeps focus, and refuses repeated activation', async () => {
    let finish!: (r: Response) => void; let reads = 0;
    const fetch = vi.fn(async () => ++reads === 1 ? response(connectionStatus()) : new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal('fetch', withLog(fetch)); render(); await screen.findByRole('region', { name: worker });
    const refresh = screen.getByRole('button', { name: 'Refresh status' }); refresh.focus(); await userEvent.keyboard('{Enter}');
    expect(refresh).toHaveFocus(); expect(refresh).toHaveAttribute('aria-disabled', 'true'); expect(screen.queryByRole('region', { name: worker })).not.toBeInTheDocument();
    await userEvent.keyboard('{Enter} '); fireEvent.click(refresh); expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => finish(response(connectionGaps()))); expect(await screen.findByText('6 things need attention')).toBeVisible(); expect(refresh).toHaveFocus();
  });

  it.each([403, 503])('removes previous details after HTTP%s and does not display private error text', async status => {
    let fail = false; const fetch = vi.fn(async () => fail ? response({ detail: 'synthetic-private-error' }, status) : response(connectionStatus()));
    vi.stubGlobal('fetch', withLog(fetch)); render(); await screen.findByRole('region', { name: worker }); fail = true;
    await userEvent.click(screen.getByRole('button', { name: 'Refresh status' })); await screen.findByRole('status');
    expect(screen.queryByRole('region', { name: worker })).not.toBeInTheDocument(); expect(screen.queryByText('Atera')).not.toBeInTheDocument();
    expect(screen.queryByText(/synthetic-private/)).not.toBeInTheDocument(); expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['employee', 'permissions'] as const)('aborts and ignores a late reply after changing %s', async change => {
    let finish!: (r: Response) => void; let signal: AbortSignal | undefined; let reads = 0;
    vi.stubGlobal('fetch', withLog((_: string, init: RequestInit) => {
      if (++reads === 1) { signal = init.signal as AbortSignal; return new Promise<Response>(resolve => { finish = resolve; }); }
      return Promise.resolve(response(connectionStatus()));
    }));
    function ChangeAuthority() {
      const [user, setUser] = useState(testUser(permissions));
      return <CurrentUserContext.Provider value={user}><button onClick={() => setUser(change === 'employee'
        ? { ...testUser(permissions), id: 'other-employee' } : testUser(['customers.read']))}>Change authority</button><ConnectionReadinessPage /></CurrentUserContext.Provider>;
    }
    renderRoutes([page(<ChangeAuthority />)], '/connections', testUser(permissions)); await waitFor(() => expect(signal).toBeDefined());
    await userEvent.click(screen.getByRole('button', { name: 'Change authority' })); expect(signal!.aborted).toBe(true);
    if (change === 'employee') expect(await screen.findByText(/^Everything is up to date/)).toBeVisible();
    else expect(await screen.findByRole('heading', { name: 'No access' })).toBeVisible();
    await act(async () => finish(response(connectionGaps())));
    expect(screen.queryByText('6 things need attention')).not.toBeInTheDocument(); expect(reads).toBe(change === 'employee' ? 2 : 1);
  });
});
