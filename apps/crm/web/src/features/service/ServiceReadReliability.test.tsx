import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { answer, device, empty, failure, json, kindOf, kinds, names, pageResult, refreshName, renderService, request, summary } from './serviceReadTestFixture';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const region = (kind: typeof kinds[number]) => within(screen.getByRole('region', { name: names[kind] }));

it.each(kinds)('shows %s loading independently without claiming a zero or empty success', async kind => {
  let finish!: (value: Response) => void;
  const fetch = vi.fn(async (url: string) => kindOf(url) === kind ? new Promise<Response>(resolve => { finish = resolve; }) : answer(kindOf(url)!));
  vi.stubGlobal('fetch', fetch); renderService();
  expect(await region(kind).findByText('Loading saved data')).toBeVisible();
  expect(region(kind).queryByText(/^No /)).not.toBeInTheDocument(); expect(region(kind).queryByText('0')).not.toBeInTheDocument();
  if (kind === 'summary') { expect(await screen.findByText('Synthetic ticket one')).toBeVisible(); expect(screen.getByText(/Device totals are unavailable/)).toBeVisible(); }
  else expect(await screen.findByText('Open tickets', { exact: true })).toBeVisible();
  await act(async () => finish(answer(kind))); await waitFor(() => expect(region(kind).queryByText('Loading saved data')).not.toBeInTheDocument()); expect(fetch).toHaveBeenCalledTimes(5);
});

it.each(kinds)('shows a %s read error, leaves other resources usable and retries only that resource explicitly', async kind => {
  let failed = true; const fetch = vi.fn(async (url: string) => kindOf(url) === kind && failed ? json({}, 503) : answer(kindOf(url)!));
  vi.stubGlobal('fetch', fetch); renderService(); expect(await region(kind).findByText(failure)).toBeVisible();
  expect(region(kind).queryByText(/^No /)).not.toBeInTheDocument();
  if (kind !== 'devices') expect(await screen.findByText('Synthetic PC one')).toBeVisible();
  if (kind !== 'tickets') expect(await screen.findByText('Synthetic ticket one')).toBeVisible();
  fireEvent(window, new Event('focus')); fireEvent(window, new Event('online')); fireEvent(document, new Event('visibilitychange'));
  expect(fetch).toHaveBeenCalledTimes(5); failed = false;
  await userEvent.click(region(kind).getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(region(kind).queryByText(failure)).not.toBeInTheDocument());
  expect(fetch).toHaveBeenCalledTimes(6); expect(kindOf(fetch.mock.calls.at(-1)![0])).toBe(kind);
});

it('renders zero counts and empty states only after successful saved reads and says when each kind of data was read', async () => {
  const fetch = vi.fn(async (url: string) => kindOf(url) === 'summary' ? json({ ...summary, openTickets: 0, devices: {}, devicesOnline: 0, criticalAlerts: 0, warningAlerts: 0 }) : empty());
  vi.stubGlobal('fetch', fetch); renderService(); expect(await screen.findByText('No open tickets.')).toBeVisible();
  expect(region('summary').getAllByText('0')).toHaveLength(4); expect(screen.getByText('No devices from Atera yet.')).toBeVisible();
  expect(screen.getByText('No saved ticket requests need attention.')).toBeVisible();
  // M39.2: one read line names every source, never a single "last change" that says nothing about alerts or devices.
  expect(region('summary').getByText(/^Tickets \(Atera\) read at .* · Alerts \(Atera\) read at .* · Devices \(Atera\) read at /)).toBeVisible();
  expect(screen.queryByText(/^Last synced/)).not.toBeInTheDocument();
  expect(screen.getByText(/Refresh rereads this copy; it does not check Atera live/)).toBeVisible();
});

it('shows a kind of data that was never read as not read, never as a zero (M38 UX finding)', async () => {
  const reads = summary.reads.map((read) => read.source === 'tickets' ? { ...read, startedAt: null, complete: false } : read);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => kindOf(url) === 'summary' ? json({ ...summary, openTickets: 0, reads }) : empty()));
  renderService();
  expect(await region('summary').findByText(/Tickets \(Atera\) not read yet/)).toBeVisible();
  const tickets = region('summary').getByText('Open tickets').parentElement!;
  expect(within(tickets).getByText('—')).toBeVisible(); expect(within(tickets).getByText('Not read yet')).toBeVisible();
  expect(within(tickets).queryByText('0')).not.toBeInTheDocument();
  expect(screen.queryByText(/^Last synced/)).not.toBeInTheDocument();
});

it('refreshes all five first pages, cancels a held continuation, clears old rows and refuses duplicate keyboard activation', async () => {
  let finishPage!: (value: Response) => void; let pageSignal!: AbortSignal; let refreshing = false;
  const replies: { kind: typeof kinds[number]; finish: (value: Response) => void }[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url.includes('cursor=')) { pageSignal = init.signal!; return new Promise<Response>(resolve => { finishPage = resolve; }); }
    if (refreshing) return new Promise<Response>(resolve => { replies.push({ kind: kindOf(url)!, finish: resolve }); });
    return kindOf(url) === 'devices' ? pageResult([device()], 'old-page', 2) : answer(kindOf(url)!);
  });
  vi.stubGlobal('fetch', fetch); renderService(); await screen.findByText('Synthetic PC one');
  await userEvent.click(region('devices').getByRole('button', { name: 'Load more' })); expect(pageSignal.aborted).toBe(false);
  refreshing = true; const refresh = screen.getByRole('button', { name: refreshName }); refresh.focus(); await userEvent.keyboard('{Enter}');
  expect(pageSignal.aborted).toBe(true); expect(refresh).toHaveFocus(); expect(refresh).toHaveAttribute('aria-disabled', 'true');
  expect(screen.queryByText('Synthetic PC one')).not.toBeInTheDocument(); expect(screen.queryByText('Synthetic ticket one')).not.toBeInTheDocument();
  await userEvent.keyboard('{Enter} '); fireEvent.click(refresh); await waitFor(() => expect(replies).toHaveLength(5)); expect(fetch).toHaveBeenCalledTimes(11);
  expect(fetch.mock.calls.slice(-5).map(([url]) => kindOf(url)).sort()).toEqual([...kinds].sort());
  expect(fetch.mock.calls.slice(-5).every(([url, init]) => !url.includes('cursor=') && init.method === 'GET')).toBe(true);
  await act(async () => { replies.forEach(reply => reply.finish(reply.kind === 'summary' ? json(summary) : empty())); finishPage(pageResult([device('late')])); });
  expect(await screen.findByText('No open tickets.')).toBeVisible(); expect(screen.queryByText('Synthetic PC late')).not.toBeInTheDocument(); expect(refresh).toHaveFocus();
});

it('recovers from a failed continuation at page one and preserves the Open only filter on global refresh', async () => {
  const fetch = vi.fn(async (url: string) => url.includes('cursor=') ? json({}, 503)
    : kindOf(url) === 'devices' ? pageResult([device()], 'next', 2) : answer(kindOf(url)!));
  vi.stubGlobal('fetch', fetch); renderService(); await screen.findByText('Synthetic PC one');
  await userEvent.click(region('devices').getByRole('button', { name: 'Load more' })); expect(await region('devices').findByText(failure)).toBeVisible();
  expect(screen.queryByText('Synthetic PC one')).not.toBeInTheDocument(); expect(screen.getByText('Synthetic ticket one')).toBeVisible();
  await userEvent.click(region('devices').getByRole('button', { name: 'Try again' })); await screen.findByText('Synthetic PC one'); expect(fetch.mock.calls.at(-1)![0]).not.toContain('cursor=');
  await userEvent.click(screen.getByRole('switch', { name: 'Open only' })); await waitFor(() => expect(fetch.mock.calls.at(-1)![0]).toBe('/api/v1/service/tickets?organizationId=o1&limit=25'));
  await userEvent.click(screen.getByRole('button', { name: refreshName })); await screen.findByText('Synthetic ticket one');
  expect(screen.getByRole('switch', { name: 'Open only' })).not.toBeChecked(); expect(fetch.mock.calls.slice(-5).find(([url]) => kindOf(url) === 'tickets')![0]).not.toContain('openOnly=');
});

it('polls saved Pending requests every five seconds until Failed and does not poll other saved resources', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); let requests = 0;
  const fetch = vi.fn(async (url: string) => kindOf(url) === 'ticket-requests' ? pageResult([request(++requests === 1 ? 'Pending' : 'Failed')]) : answer(kindOf(url)!));
  vi.stubGlobal('fetch', fetch); renderService(); await screen.findByText(/Synthetic request one.*is being created/);
  await act(async () => { await vi.advanceTimersByTimeAsync(4_999); }); expect(requests).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); }); expect(await screen.findByText(/Synthetic request one.*was not created/)).toBeVisible();
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); }); expect(requests).toBe(2); expect(fetch).toHaveBeenCalledTimes(6);
});

it('stops after a failed Pending poll, hides stale Pending rows and resumes only after an explicit successful retry', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); let count = 0; let failed = true;
  const fetch = vi.fn(async (url: string) => kindOf(url) === 'ticket-requests'
    ? ++count > 1 && failed ? json({}, 503) : pageResult([request('Pending')]) : answer(kindOf(url)!));
  vi.stubGlobal('fetch', fetch); renderService(); await screen.findByText(/Synthetic request one.*is being created/);
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); }); expect(await region('ticket-requests').findByText(failure)).toBeVisible();
  expect(screen.queryByText(/Synthetic request one.*is being created/)).not.toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); }); expect(count).toBe(2); failed = false;
  await userEvent.click(region('ticket-requests').getByRole('button', { name: 'Try again' })); await screen.findByText(/Synthetic request one.*is being created/); expect(count).toBe(3);
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); }); await waitFor(() => expect(count).toBe(4));
});
