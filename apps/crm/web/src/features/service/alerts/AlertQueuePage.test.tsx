import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../../test/renderWithProviders';
import { alertPage, syntheticAlert } from '../../../test/alerts';
import { AlertQueuePage } from './AlertQueuePage';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const all = ['customers.read', 'service.read', 'activities.read', 'activities.write'];
const critical = syntheticAlert({ id: 'a1', title: 'Disk almost full on SRV-01', organizationName: 'Fjord IT AS' });
const warning = syntheticAlert({ id: 'a2', severity: 'Warning', title: 'Backup is late', organizationId: 'o2', organizationName: 'Vik Regnskap AS',
  deviceName: null, createdAt: '2026-10-20T06:00:00Z' });

function stub(answer: (url: URL, init?: RequestInit) => Response | undefined = () => undefined) {
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'https://parasoll.invalid');
    const own = answer(url, init);
    if (own) return own;
    if (url.pathname === '/api/v1/service/alerts') return json(alertPage([critical, warning], 'next', 30));
    if (url.pathname === '/api/v1/service/alerts/a2') return json(warning);
    return json({}, 404);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const render = (path = '/alerts', permissions = all) =>
  renderRoutes([page(<AlertQueuePage />, '/alerts')], path, testUser(permissions));
const narrow = () => vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(max-width: 600px)', media: query,
  addEventListener: () => {}, removeEventListener: () => {} }));

afterEach(() => vi.unstubAllGlobals());

describe('alert queue', () => {
  it('lists open alerts in the server order with honest totals, the source and the age', async () => {
    const fetch = stub(); render();
    const table = await screen.findByRole('table', { name: 'Alerts' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => within(row).getAllByRole('cell')[1]!.textContent)).toEqual([
      expect.stringContaining('Disk almost full on SRV-01'), expect.stringContaining('Backup is late')]);
    expect(within(rows[0]!).getByText('Critical')).toBeVisible();
    expect(within(rows[0]!).getByText('Source: Atera')).toBeVisible();
    expect(within(rows[0]!).getAllByRole('cell')[1]).toHaveTextContent('SRV-01 · Source: Atera');
    expect(within(rows[0]!).getByRole('link', { name: 'Fjord IT AS' })).toHaveAttribute('href', '/organizations/o1?tab=drift');
    const age = rows[0]!.querySelector('time')!;
    expect(age).toHaveAttribute('dateTime', '2026-10-21T06:00:00Z');
    expect(age).toHaveAttribute('title');
    expect(screen.getByRole('status')).toHaveTextContent('30 alerts: 1 critical, 1 warnings');
    expect(screen.getByText('Showing 2 of 30')).toBeVisible();
    // Open alerts by default, a page of 25.
    const urls = fetch.mock.calls.map(([url]) => String(url));
    expect(urls).toContain('/api/v1/service/alerts?limit=25');
  });

  it('narrows by state, severity and search, and offers to clear what hid every alert', async () => {
    const fetch = stub((url) => url.pathname === '/api/v1/service/alerts' && url.searchParams.get('q') === 'nothing'
      ? json(alertPage([])) : undefined);
    const { router } = render();
    await screen.findByRole('table', { name: 'Alerts' });
    await userEvent.click(screen.getByRole('button', { name: 'Resolved' }));
    await waitFor(() => expect(router.state.location.search).toBe('?state=resolved'));
    expect(screen.getByRole('columnheader', { name: 'Resolved' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: /^Warning/ }));
    await waitFor(() => expect(router.state.location.search).toBe('?state=resolved&severity=warning'));
    await waitFor(() => expect(fetch.mock.calls.map(([url]) => String(url))).toContain('/api/v1/service/alerts?state=Resolved&severity=Warning&limit=25'));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search title or device' }), 'nothing');
    expect(await screen.findByText('No alerts match these filters.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(router.state.location.search).toBe('?state=resolved'));
    expect(screen.getByRole('searchbox', { name: 'Search title or device' })).toHaveValue('');
  });

  it('opens the alert named by the address in a side panel with its fields and its source', async () => {
    stub((url) => url.pathname === '/api/v1/service/alerts/a2'
      ? json({ ...warning, url: 'https://app.atera.com/new/alert/920030' }) : undefined);
    render('/alerts?alert=a2');
    const panel = await screen.findByRole('dialog', { name: 'Backup is late' });
    expect(within(panel).getByText('Warning')).toBeVisible();
    expect(within(panel).getByRole('link', { name: 'Vik Regnskap AS' })).toHaveAttribute('href', '/organizations/o2?tab=drift');
    expect(within(panel).getByRole('link', { name: 'Open in Atera' })).toHaveAttribute('href', 'https://app.atera.com/new/alert/920030');
    expect(within(panel).getByRole('link', { name: 'Open in Atera' })).toHaveAttribute('rel', 'noopener noreferrer');
    expect(within(panel).getByText('Open')).toBeVisible();
  });

  it('says an alert without a configured link has none', async () => {
    stub(); render('/alerts?alert=a2');
    const panel = await screen.findByRole('dialog', { name: 'Backup is late' });
    expect(within(panel).getByText('No link to alerts in Atera is set up.')).toBeVisible();
    expect(within(panel).queryByRole('link', { name: 'Open in Atera' })).not.toBeInTheDocument();
  });

  it('says an alert that is no longer stored is gone, without a retry that would find nothing', async () => {
    stub((url) => url.pathname === '/api/v1/service/alerts/gone' ? json({ code: 'SRV_ALERT_NOT_FOUND', status: 404 }, 404) : undefined);
    render('/alerts?alert=gone');
    const panel = await screen.findByRole('dialog', { name: 'Alert' });
    expect(await within(panel).findByText('This alert is not stored in Parasoll.')).toBeVisible();
    expect(within(panel).queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('shows cards on a phone, with the same facts', async () => {
    narrow(); stub(); render();
    const list = await screen.findByRole('list', { name: 'Alerts' });
    const cards = within(list).getAllByRole('listitem');
    expect(cards).toHaveLength(2);
    expect(within(cards[0]!).getByText('Critical')).toBeVisible();
    expect(within(cards[0]!).getByRole('link', { name: 'Fjord IT AS' })).toBeVisible();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('closes to No access for someone who cannot read service data', () => {
    const fetch = stub(); render('/alerts', ['customers.read']);
    expect(screen.getByRole('heading', { name: 'No access' })).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
  });
});
