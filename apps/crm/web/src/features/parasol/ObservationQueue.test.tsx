import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, useParams } from 'react-router';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { atlasWorkspace } from '../../test/atlasWorkspace';
import { atlasQueue } from '../../test/atlasQueue';
import { CurrentUserContext } from '../../auth/CurrentUserContext';
import { CustomerWorkspacePanel } from './CustomerWorkspacePanel';
import { ObservationQueue } from './ObservationQueue';
import { parseObservationQueue, type ObservationQueue as QueueView } from './observationQueueContract';

const first = { severity: 'ALL', status: 'ACTIVE', cursor: null } as const;
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const renderQueue = (onSourceInvalidated = vi.fn()) => renderRoutes([page(<ObservationQueue customerId="customer-one" onSourceInvalidated={onSourceInvalidated} />)],
  '/', testUser(['parasol.atlas.read']));
const queueRegion = () => within(screen.getByRole('region', { name: 'Observation queue and history' }));
afterEach(() => vi.unstubAllGlobals());

describe('the Atlas observation queue', () => {
  it('loads only when selected, including the partial active-list action', async () => {
    const workspace = atlasWorkspace(); workspace.summary!.activeObservations = 4;
    workspace.summary!.severityCounts.CRITICAL = 2; workspace.summary!.observationPage.truncated = true;
    const fetch = vi.fn(async (url: string) => response(url.includes('/observations?') ? atlasQueue() : workspace));
    vi.stubGlobal('fetch', fetch);
    renderRoutes([page(<CustomerWorkspacePanel customerId="customer-one" />)], '/', testUser(['parasol.atlas.read']));
    await screen.findByRole('region', { name: 'Active Atlas observations' }); expect(fetch).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('tab', { name: 'Atlas devices' })); expect(fetch).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('tab', { name: 'Active Atlas observations' }));
    await userEvent.click(screen.getByRole('button', { name: 'Open full observation queue' }));
    expect(await screen.findByText('Queue record 1')).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Observation queue and history' })).toHaveFocus();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]![0]).toBe('/api/v1/parasol/customers/customer-one/observations?severity=ALL&status=ACTIVE');
  });

  it('replaces pages using opaque cursors, searches only this page, and reloads previous pages', async () => {
    const fetch = vi.fn(async (url: string) => response(new URL(url, 'https://local.test').searchParams.has('cursor')
      ? atlasQueue({ offset: 25, count: 2, nextCursor: null }) : atlasQueue()));
    vi.stubGlobal('fetch', fetch); renderQueue();
    await screen.findByText('Queue record 1'); const region = queueRegion();
    expect(region.getByText('Matches across pages: 27')).toBeVisible();
    expect(region.getByText('Page 1 · 25 records loaded')).toBeVisible();
    expect(region.getAllByRole('listitem')).toHaveLength(27); // 25 observations plus two collapsed provenance rows.
    await userEvent.type(region.getByRole('searchbox'), 'record 1');
    expect(region.getByText('This page: 11 of 25 shown')).toBeVisible();
    expect(fetch).toHaveBeenCalledTimes(1);
    await userEvent.click(region.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('Queue record 26')).toBeVisible();
    expect(screen.queryByText('Queue record 1')).not.toBeInTheDocument();
    expect(region.getByRole('searchbox')).toHaveValue('');
    expect(region.getByText('Page 2 · 2 records loaded')).toBeVisible();
    expect(region.getByRole('button', { name: 'Next page' })).toBeDisabled();
    expect(new URL(fetch.mock.calls[1]![0], 'https://local.test').searchParams.get('cursor')).toBe('opaque+first/with=value?');
    await userEvent.click(region.getByRole('button', { name: 'Previous page' }));
    expect(await screen.findByText('Queue record 1')).toBeVisible(); expect(fetch).toHaveBeenCalledTimes(3);
    expect(region.getByRole('button', { name: 'First page' })).toBeDisabled();
    expect(region.getByText('Data details')).toBeVisible();
    await userEvent.click(region.getByText('Data details'));
    expect(region.getByText('Source coverage and freshness for this read')).toBeVisible();
    expect(region.getByText(/Counts reflect this page request and can change/)).toBeVisible();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('resets cursor and search when server filters change, includes terminal history and retains urgency', async () => {
    const fetch = vi.fn(async (url: string) => {
      const p = new URL(url, 'https://local.test').searchParams;
      return response(atlasQueue({ severity: p.get('severity') as 'ALL' | 'URGENT', status: p.get('status') as 'ACTIVE' | 'RESOLVED' | 'SUPPRESSED',
        count: p.has('cursor') ? 2 : 25, offset: p.has('cursor') ? 25 : 0, nextCursor: p.has('cursor') ? null : 'next' }));
    });
    vi.stubGlobal('fetch', fetch); renderQueue(); await screen.findByText('Queue record 1'); const region = queueRegion();
    await userEvent.click(region.getByRole('button', { name: 'Next page' })); await screen.findByText('Queue record 26');
    await userEvent.type(region.getByRole('searchbox'), 'record 26');
    await userEvent.selectOptions(region.getByLabelText('Queue severity'), 'URGENT'); await screen.findByText('Queue record 1');
    expect(region.getByRole('searchbox')).toHaveValue('');
    expect(fetch.mock.calls.at(-1)![0]).toContain('severity=URGENT&status=ACTIVE'); expect(fetch.mock.calls.at(-1)![0]).not.toContain('cursor');
    await userEvent.selectOptions(region.getByLabelText('Queue state'), 'RESOLVED');
    await waitFor(() => expect(region.getAllByText('Resolved')).toHaveLength(26)); // option + rows
    const resolvedRows = within(region.getByText('Queue record 1').closest('ul')!).getAllByRole('listitem');
    expect(resolvedRows).toHaveLength(25);
    for (const row of resolvedRows) expect(within(row).getByText(/^(High|Critical)$/)).toBeVisible();
    expect(region.getAllByText('Atlas recommendation: Monitor')).toHaveLength(25);
    await userEvent.selectOptions(region.getByLabelText('Queue state'), 'SUPPRESSED');
    await waitFor(() => expect(region.getAllByText('Suppressed')).toHaveLength(26));
    await userEvent.click(region.getByRole('button', { name: 'Next page' })); await screen.findByText('Queue record 26');
    await userEvent.click(region.getByRole('button', { name: 'Refresh queue' })); await screen.findByText('Queue record 1');
    expect(region.getByLabelText('Queue state')).toHaveValue('SUPPRESSED');
    expect(fetch.mock.calls.at(-1)![0]).not.toContain('cursor');
    await userEvent.click(region.getByRole('button', { name: 'Reset filters' }));
    await waitFor(() => expect(region.getByLabelText('Queue severity')).toHaveValue('ALL'));
    expect(region.getByLabelText('Queue state')).toHaveValue('ACTIVE');
  });

  it('clears the old page during loading and after failure, without retrying or exposing error details', async () => {
    let finish!: (r: Response) => void;
    const fetch = vi.fn().mockResolvedValueOnce(response(atlasQueue())).mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal('fetch', fetch); renderQueue(); await screen.findByText('Queue record 1');
    await userEvent.click(screen.getByRole('button', { name: 'Refresh queue' }));
    expect(screen.queryByText('Queue record 1')).not.toBeInTheDocument();
    await act(async () => finish(response({ detail: 'synthetic-private-upstream-secret' }, 503)));
    expect(await screen.findByText(/The queue could not be read/)).toBeVisible();
    expect(screen.queryByText(/synthetic-private/)).not.toBeInTheDocument(); expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['ACCESS_DENIED', 'IDENTITY_CHANGED', 'NOT_LINKED', 'SOURCE_NOT_FOUND'] as const)('invalidates the parent after %s and hides its old devices', async status => {
    let denied = false;
    const fetch = vi.fn(async (url: string) => {
      if (url.includes('/observations?')) { denied = true; return response({ customerId: 'customer-one', status, queue: null }); }
      return response(denied ? { customerId: 'customer-one', status: 'ACCESS_DENIED', summary: null } : atlasWorkspace());
    });
    vi.stubGlobal('fetch', fetch);
    renderRoutes([page(<CustomerWorkspacePanel customerId="customer-one" />)], '/', testUser(['parasol.atlas.read']));
    await screen.findByText('42'); await userEvent.click(screen.getByRole('tab', { name: 'Observation queue and history' }));
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'Atlas devices' })).not.toBeInTheDocument());
    expect(await screen.findByText('Your Atlas access does not permit reading this customer.')).toBeVisible();
    expect(screen.queryByText('42')).not.toBeInTheDocument(); expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each(['immediate', 'pending'] as const)('replaces the entire workspace after a link changes before Next and leaves the old queue closed (%s read)', async read => {
    const previous = atlasWorkspace(); const current = atlasWorkspace();
    previous.summary!.devices[0]!.hostname = 'OLD-X-DEVICE';
    previous.summary!.observationPage.items[0]!.summary = 'OLD-X-OBSERVATION';
    current.summary!.devices[0]!.id = 'current-y-device'; current.summary!.devices[0]!.hostname = 'CURRENT-Y-DEVICE';
    current.summary!.observationPage.items[0]!.deviceId = 'current-y-device';
    current.summary!.observationPage.items[0]!.summary = 'CURRENT-Y-OBSERVATION';
    const oldQueue = atlasQueue(); oldQueue.queue!.devices = previous.summary!.devices;
    oldQueue.queue!.items[0]!.summary = 'OLD-X-QUEUE';
    let rebound = false; let finishRebind: ((value: Response) => void) | undefined;
    const fetch = vi.fn(async (url: string) => {
      if (!url.includes('/observations?')) {
        if (rebound && read === 'pending') return new Promise<Response>(resolve => { finishRebind = resolve; });
        return response(rebound ? current : previous);
      }
      if (!new URL(url, 'https://local.test').searchParams.has('cursor')) return response(oldQueue);
      rebound = true; return response({ customerId: 'customer-one', status: 'IDENTITY_CHANGED', queue: null });
    });
    vi.stubGlobal('fetch', fetch);
    renderRoutes([page(<CustomerWorkspacePanel customerId="customer-one" />)], '/', testUser(['parasol.atlas.read']));
    await screen.findByText('OLD-X-OBSERVATION');
    await userEvent.click(screen.getByRole('tab', { name: 'Atlas devices' })); expect(screen.getByText('OLD-X-DEVICE')).toBeVisible();
    await userEvent.click(screen.getByRole('tab', { name: 'Observation queue and history' })); await screen.findByText('OLD-X-QUEUE');
    await userEvent.click(queueRegion().getByRole('button', { name: 'Next page' }));
    if (read === 'pending') {
      await waitFor(() => expect(finishRebind).toBeDefined());
      expect(screen.queryByRole('tab', { name: 'Atlas devices' })).not.toBeInTheDocument();
      expect(screen.queryByText('OLD-X-QUEUE')).not.toBeInTheDocument();
      expect(screen.queryByText('42')).not.toBeInTheDocument();
      await act(async () => finishRebind!(response(current)));
    }
    expect(await screen.findByText('CURRENT-Y-OBSERVATION')).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Active Atlas observations' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Observation queue and history' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.queryByRole('button', { name: 'Next page' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Observation queue and history' })).not.toBeInTheDocument();
    expect(screen.queryByText('OLD-X-OBSERVATION')).not.toBeInTheDocument(); expect(screen.queryByText('OLD-X-QUEUE')).not.toBeInTheDocument();
    expect(screen.queryByText(/OLD-X-DEVICE/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Atlas devices' })); expect(screen.getByText('CURRENT-Y-DEVICE')).toBeVisible();
    expect(screen.queryByText('OLD-X-DEVICE')).not.toBeInTheDocument();
    expect(fetch.mock.calls.filter(([url]) => url.includes('/observations?'))).toHaveLength(2);
    expect(fetch.mock.calls.at(-1)![0]).toBe('/api/v1/parasol/customers/customer-one/workspace');
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('invalidates the parent on HTTP 403, while unsupported queues and invalid cursors stay local', async () => {
    const invalidated = vi.fn(); let status: string | number = 'QUEUE_NOT_SUPPORTED';
    const fetch = vi.fn(async () => typeof status === 'number' ? response({}, status) : response({ customerId: 'customer-one', status, queue: null }));
    vi.stubGlobal('fetch', fetch); renderQueue(invalidated);
    expect(await screen.findByText(/Queue and history are not available/)).toBeVisible(); expect(invalidated).not.toHaveBeenCalled();
    status = 'INVALID_CURSOR'; await userEvent.click(screen.getByRole('button', { name: 'Refresh queue' }));
    expect(await screen.findByText(/This page reference is no longer valid/)).toBeVisible(); expect(invalidated).not.toHaveBeenCalled();
    status = 403; await userEvent.click(screen.getByRole('button', { name: 'First page' }));
    await waitFor(() => expect(invalidated).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Queue record 1')).not.toBeInTheDocument(); expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('cancels a queue request on tab change and ignores the late reply when the tab is reopened', async () => {
    let finish!: (r: Response) => void; let oldSignal: AbortSignal | undefined; let reads = 0;
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
      if (!url.includes('/observations?')) return Promise.resolve(response(atlasWorkspace()));
      if (++reads === 1) { oldSignal = init.signal as AbortSignal; return new Promise<Response>(resolve => { finish = resolve; }); }
      return Promise.resolve(response(atlasQueue({ count: 0, total: 0, nextCursor: null })));
    }));
    renderRoutes([page(<CustomerWorkspacePanel customerId="customer-one" />)], '/', testUser(['parasol.atlas.read']));
    await userEvent.click(await screen.findByRole('tab', { name: 'Observation queue and history' }));
    await waitFor(() => expect(oldSignal).toBeDefined()); await userEvent.click(screen.getByRole('tab', { name: 'Atlas devices' }));
    expect(oldSignal!.aborted).toBe(true); await act(async () => finish(response(atlasQueue())));
    await userEvent.click(screen.getByRole('tab', { name: 'Observation queue and history' }));
    expect(await screen.findByText(/No observations on this page for the selected filters/)).toBeVisible();
    expect(screen.queryByText('Queue record 1')).not.toBeInTheDocument(); expect(reads).toBe(2);
  });

  it('cancels a former customer request and refuses its late reply after customer navigation', async () => {
    let finish!: (r: Response) => void; let oldSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
      if (url.includes('/customer-one/')) { oldSignal = init.signal as AbortSignal; return new Promise<Response>(resolve => { finish = resolve; }); }
      const q = atlasQueue({ customerId: 'customer-two', count: 1, total: 1, nextCursor: null }); q.queue!.items[0]!.summary = 'Customer two queue';
      return Promise.resolve(response(q));
    }));
    function Journey() { const { id } = useParams(); return <><Link to="/customer-two">Next customer</Link><ObservationQueue customerId={id!} onSourceInvalidated={vi.fn()} /></>; }
    renderRoutes([{ path: '/:id', element: <Journey /> }], '/customer-one', testUser(['parasol.atlas.read']));
    await waitFor(() => expect(oldSignal).toBeDefined()); await userEvent.click(screen.getByRole('link', { name: 'Next customer' }));
    expect(await screen.findByText('Customer two queue')).toBeVisible(); expect(oldSignal!.aborted).toBe(true);
    await act(async () => finish(response(atlasQueue())));
    expect(screen.getByText('Customer two queue')).toBeVisible(); expect(screen.queryByText('Queue record 1')).not.toBeInTheDocument();
  });

  it('resets filters and cancels the former employee read when the signed-in employee changes', async () => {
    let finish!: (r: Response) => void; let oldSignal: AbortSignal | undefined; let reads = 0;
    const fetch = vi.fn((_url: string, init: RequestInit) => {
      if (++reads === 2) { oldSignal = init.signal as AbortSignal; return new Promise<Response>(resolve => { finish = resolve; }); }
      const q = atlasQueue({ count: 1, total: 1, nextCursor: null }); q.queue!.items[0]!.summary = 'New employee queue';
      return Promise.resolve(response(q));
    });
    vi.stubGlobal('fetch', fetch);
    function Session() {
      const [employee, setEmployee] = useState('u1');
      return <CurrentUserContext.Provider value={{ ...testUser(['parasol.atlas.read']), id: employee }}>
        <button onClick={() => setEmployee('u2')}>Switch employee</button>
        <ObservationQueue customerId="customer-one" onSourceInvalidated={vi.fn()} />
      </CurrentUserContext.Provider>;
    }
    renderRoutes([page(<Session />)], '/');
    await screen.findByText('New employee queue'); await userEvent.selectOptions(screen.getByLabelText('Queue severity'), 'URGENT');
    await waitFor(() => expect(oldSignal).toBeDefined()); await userEvent.click(screen.getByRole('button', { name: 'Switch employee' }));
    expect(await screen.findByText('New employee queue')).toBeVisible(); expect(oldSignal!.aborted).toBe(true);
    expect(screen.getByLabelText('Queue severity')).toHaveValue('ALL');
    await act(async () => finish(response(atlasQueue())));
    expect(screen.getByText('New employee queue')).toBeVisible(); expect(screen.queryByText('Queue record 1')).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('renders summaries and hostnames as text in history and keeps recommendations separate from urgency', async () => {
    const q = atlasQueue({ status: 'RESOLVED', count: 1, total: 1, nextCursor: null }); const markup = '<img src=x onerror=alert(1)>';
    q.queue!.items[0]!.summary = markup; q.queue!.devices[0]!.hostname = markup;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url.includes('status=RESOLVED') ? q : atlasQueue()))); renderQueue();
    await screen.findByText('Queue record 1'); await userEvent.selectOptions(screen.getByLabelText('Queue state'), 'RESOLVED');
    expect(await screen.findByText(markup)).toBeVisible(); expect(screen.getByText(`Confirmed device: ${markup} (device-0)`)).toBeVisible();
    expect(screen.queryByRole('img')).not.toBeInTheDocument(); expect(screen.queryByRole('link', { name: markup })).not.toBeInTheDocument();
  });
});

describe('the closed observation queue response', () => {
  it.each([
    ['wrong customer', (v: QueueView) => { v.customerId = 'other'; }],
    ['unknown field', (v: QueueView) => { Object.assign(v.queue!.items[0]!, { token: 'synthetic-private' }); }],
    ['wrong echoed severity', (v: QueueView) => { v.queue!.severity = 'HIGH'; }],
    ['wrong echoed state', (v: QueueView) => { v.queue!.status = 'RESOLVED'; }],
    ['terminal state in active page', (v: QueueView) => { v.queue!.items[0]!.status = 'RESOLVED'; }],
    ['bad date', (v: QueueView) => { v.queue!.retrievedAt = 'bad'; }],
    ['weakened urgent severity', (v: QueueView) => { v.queue!.items[0]!.priority = 'NORMAL'; }],
    ['unknown device', (v: QueueView) => { v.queue!.items[0]!.deviceId = 'other'; }],
    ['duplicate ID', (v: QueueView) => { v.queue!.items[1]!.id = v.queue!.items[0]!.id; }],
    ['invalid source count', (v: QueueView) => { v.queue!.resources[0]!.returnedItems = null; }],
    ['inconsistent total', (v: QueueView) => { v.queue!.total = 30; }],
    ['overfull page', (v: QueueView) => { v.queue!.items.push({ ...v.queue!.items[0]!, id: 'extra' }); }],
    ['short page with cursor', (v: QueueView) => { v.queue!.items.pop(); }],
    ['missing first-page cursor', (v: QueueView) => { v.queue!.nextCursor = null; }],
    ['oversized cursor', (v: QueueView) => { v.queue!.nextCursor = 'a'.repeat(2049); }],
    ['fixture queue', (v: QueueView) => { Object.assign(v.queue!, { mode: 'fixture' }); }],
    ['data on denied reply', (v: QueueView) => { v.status = 'ACCESS_DENIED'; }],
  ])('refuses %s before rendering any rows', (_name, mutate) => {
    const q = atlasQueue(); mutate(q);
    expect(parseObservationQueue(q, 'customer-one', first)).toEqual({ customerId: 'customer-one', status: 'INVALID_RESPONSE', queue: null });
  });

  it('accepts terminal history, later-page empty results and filter-scoped totals, but refuses cursor loops', () => {
    const q = atlasQueue({ severity: 'URGENT', status: 'RESOLVED', count: 0, nextCursor: null });
    const selection = { severity: 'URGENT', status: 'RESOLVED', cursor: 'old-cursor' } as const;
    expect(parseObservationQueue(q, 'customer-one', selection).status).toBe('READY');
    const loop = atlasQueue({ nextCursor: 'old-cursor' });
    expect(parseObservationQueue(loop, 'customer-one', { ...first, cursor: 'old-cursor' }).status).toBe('INVALID_RESPONSE');
    q.queue!.severityCounts.LOW = 1; q.queue!.total++;
    expect(parseObservationQueue(q, 'customer-one', selection).status).toBe('INVALID_RESPONSE');
  });
});
