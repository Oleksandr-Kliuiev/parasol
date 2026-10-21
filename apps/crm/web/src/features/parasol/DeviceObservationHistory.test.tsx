import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { atlasWorkspace } from '../../test/atlasWorkspace';
import { atlasQueue } from '../../test/atlasQueue';
import { CustomerWorkspacePanel } from './CustomerWorkspacePanel';
import { ObservationQueue } from './ObservationQueue';
import { parseObservationQueue, type QueueSeverity, type QueueState } from './observationQueueContract';

const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
beforeEach(() => Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() }));
afterEach(() => {
  if (originalScroll) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScroll);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  vi.unstubAllGlobals();
});
const response = (value: unknown) => new Response(JSON.stringify(value));
const selection = { severity: 'ALL', status: 'ACTIVE', cursor: null, deviceId: 'device-0' } as const;
const queue = (url: URL) => {
  const offset = url.searchParams.has('cursor') ? 25 : 0;
  const result = atlasQueue({ deviceId: url.searchParams.get('deviceId'),
    severity: (url.searchParams.get('severity') ?? 'ALL') as QueueSeverity,
    status: (url.searchParams.get('status') ?? 'ACTIVE') as QueueState,
    offset, count: offset ? 2 : 25, total: 27, nextCursor: offset ? null : 'next-device-page' });
  for (const item of result.queue!.items) item.summary = `${result.queue!.deviceId ?? 'all'} record ${item.id}`;
  return result;
};
function setup(overview = atlasWorkspace()) {
  const requests: URL[] = [];
  const fetch = vi.fn(async (value: string) => {
    const url = new URL(value, 'https://synthetic.invalid');
    if (url.pathname.endsWith('/workspace')) return response(overview);
    requests.push(url); return response(queue(url));
  });
  vi.stubGlobal('fetch', fetch);
  renderRoutes([page(<CustomerWorkspacePanel customerId="customer-one" />)], '/', testUser(['parasol.atlas.read']));
  return { requests, fetch };
}
const region = () => within(screen.getByRole('region', { name: 'Observation queue and history' }));

describe('device investigation through the complete queue', () => {
  it('uses the clicked ID despite identical names and returns to the same loaded row, search and keyboard focus', async () => {
    const overview = atlasWorkspace(); overview.summary!.devices[40]!.hostname = overview.summary!.devices[0]!.hostname;
    const { requests } = setup(overview);
    await userEvent.click(await screen.findByRole('tab', { name: 'Atlas devices' }));
    const devices = within(screen.getByRole('region', { name: 'Atlas devices' }));
    await userEvent.type(devices.getByRole('searchbox'), 'synthetic');
    await userEvent.click(devices.getByRole('button', { name: 'Show more loaded devices' }));
    const row = devices.getByText(/device-40$/).closest('li')!;
    await userEvent.click(within(row).getByRole('button', { name: 'View observations for SYNTHETIC-LT-01' }));
    await screen.findByText('device-40 record queue-1');
    expect(requests[0]!.searchParams.get('deviceId')).toBe('device-40');
    expect(screen.getByRole('tab', { name: 'Observation queue and history' })).toHaveFocus();
    await userEvent.click(region().getByRole('button', { name: 'Back to device' }));
    const returned = within(screen.getByRole('region', { name: 'Atlas devices' }));
    expect(returned.getByRole('searchbox')).toHaveValue('synthetic');
    expect(returned.getAllByRole('listitem')).toHaveLength(42);
    expect(within(returned.getByText(/device-40$/).closest('li')!).getByRole('button')).toHaveFocus();
    expect(requests).toHaveLength(1);
  }, 15_000); // A long keyboard journey: under load it needs more than the default 5 s, never a retry.

  it('keeps device scope across pages and preserves severity/state when clearing just the device', async () => {
    const { requests } = setup();
    await userEvent.click(await screen.findByRole('tab', { name: 'Atlas devices' }));
    await userEvent.click(screen.getByRole('button', { name: 'View observations for SYNTHETIC-LT-01' }));
    await screen.findByText('device-0 record queue-1');
    await userEvent.click(region().getByRole('button', { name: 'Next page' }));
    await screen.findByText('device-0 record queue-26');
    expect(requests.at(-1)!.searchParams.get('deviceId')).toBe('device-0');
    expect(requests.at(-1)!.searchParams.get('cursor')).toBe('next-device-page');
    await userEvent.selectOptions(region().getByLabelText('Queue severity'), 'LOW');
    await userEvent.selectOptions(region().getByLabelText('Queue state'), 'RESOLVED');
    await screen.findByText('device-0 record queue-1');
    await userEvent.click(region().getByRole('button', { name: 'All devices · keep other filters' }));
    await screen.findByText('all record queue-1');
    expect(requests.at(-1)!.searchParams.get('deviceId')).toBeNull();
    expect(requests.at(-1)!.searchParams.get('cursor')).toBeNull();
    expect(requests.at(-1)!.searchParams.get('severity')).toBe('LOW');
    expect(requests.at(-1)!.searchParams.get('status')).toBe('RESOLVED');
    expect(region().getByRole('heading', { name: 'Observation queue and history' })).toHaveFocus();
    expect(screen.queryByText('device-0 record queue-1')).not.toBeInTheDocument();
  });

  it('cancels a pending continuation on scope change and ignores its late reply, including a return to the original device', async () => {
    let oldSignal: AbortSignal | undefined; let finish!: (value: Response) => void;
    const requests: URL[] = [];
    vi.stubGlobal('fetch', vi.fn((value: string, init: RequestInit) => {
      const url = new URL(value, 'https://synthetic.invalid'); requests.push(url);
      if (url.searchParams.get('deviceId') === 'device-0' && url.searchParams.has('cursor')) {
        oldSignal = init.signal as AbortSignal; return new Promise<Response>(resolve => { finish = resolve; });
      }
      return Promise.resolve(response(queue(url)));
    }));
    function Journey() {
      const [deviceId, setDeviceId] = useState('device-0');
      return <><button onClick={() => setDeviceId('device-0')}>Device one</button><button onClick={() => setDeviceId('device-1')}>Device two</button>
        <ObservationQueue customerId="customer-one" deviceId={deviceId} onSourceInvalidated={() => undefined} /></>;
    }
    renderRoutes([page(<Journey />)], '/', testUser(['parasol.atlas.read']));
    await screen.findByText('device-0 record queue-1');
    await userEvent.click(region().getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(oldSignal).toBeDefined());
    await userEvent.click(screen.getByRole('button', { name: 'Device two' }));
    await screen.findByText('device-1 record queue-1'); expect(oldSignal!.aborted).toBe(true);
    expect(requests.at(-1)!.searchParams.get('cursor')).toBeNull();
    await act(() => { finish(response(queue(requests[1]!))); });
    expect(screen.queryByText('device-0 record queue-26')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Device one' }));
    await screen.findByText('device-0 record queue-1');
    expect(requests.at(-1)!.searchParams.get('cursor')).toBeNull();
    expect(requests).toHaveLength(4);
  });
});

describe('filtered page admission', () => {
  it.each(['missing-echo', 'different-echo', 'missing-device', 'unresolved-row'])('rejects %s as a whole result', change => {
    const value = atlasQueue({ deviceId: 'device-0', count: 1, total: 1, nextCursor: null });
    if (change === 'missing-echo') Reflect.deleteProperty(value.queue!, 'deviceId');
    if (change === 'different-echo') value.queue!.deviceId = null;
    if (change === 'missing-device') value.queue!.devices = value.queue!.devices.filter(d => d.id !== 'device-0');
    if (change === 'unresolved-row') { value.queue!.items[0]!.deviceStatus = 'UNRESOLVED'; value.queue!.items[0]!.deviceId = null; }
    expect(parseObservationQueue(value, 'customer-one', selection).status).toBe('INVALID_RESPONSE');
  });

  it('keeps a historical row whose current source association is unavailable', () => {
    const value = atlasQueue({ deviceId: 'device-0', count: 1, total: 1, nextCursor: null });
    value.queue!.items[0]!.deviceStatus = 'UNAVAILABLE'; value.queue!.items[0]!.deviceId = null;
    expect(parseObservationQueue(value, 'customer-one', selection).status).toBe('READY');
  });
});
