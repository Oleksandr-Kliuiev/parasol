import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, useParams } from 'react-router';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { atlasWorkspace } from '../../test/atlasWorkspace';
import { CustomerWorkspacePanel } from './CustomerWorkspacePanel';
import { parseWorkspace, type Workspace } from './workspaceContract';

const render = (data = atlasWorkspace()) => {
  const fetch = vi.fn(async () => new Response(JSON.stringify(data), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  const view = renderRoutes([page(<CustomerWorkspacePanel customerId="customer-one" />)], '/', testUser(['parasol.atlas.read']));
  return { ...view, fetch };
};
afterEach(() => vi.unstubAllGlobals());

describe('Atlas device and observation details', () => {
  it('searches the loaded device registry and reveals only a bounded batch of rows at a time', async () => {
    const { fetch } = render();
    await userEvent.click(await screen.findByRole('tab', { name: 'Atlas devices' }));
    const devices = within(screen.getByRole('region', { name: 'Atlas devices' }));
    expect(devices.getAllByRole('listitem')).toHaveLength(25);
    expect(devices.getByText('Confirmed sources: Atera, Huntress')).toBeVisible();
    expect(devices.getAllByText('No confirmed source link')).toHaveLength(24);
    await userEvent.click(devices.getByRole('button', { name: 'Show more loaded devices' }));
    expect(devices.getAllByRole('listitem')).toHaveLength(42);
    await userEvent.type(devices.getByRole('searchbox'), 'lt-01');
    expect(devices.getAllByRole('listitem')).toHaveLength(1);
    expect(devices.getByText('Matching devices: 1 of 42 loaded')).toBeVisible();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps high source severity urgent even when Atlas recommends monitoring, and resolves devices by ID', async () => {
    render(); const observations = within(await screen.findByRole('region', { name: 'Active Atlas observations' }));
    const rows = observations.getAllByRole('listitem');
    expect(within(rows[0]!).getByText('Urgent · HIGH / CRITICAL')).toBeVisible();
    expect(within(rows[0]!).getByText('Atlas recommendation: Monitor')).toBeVisible();
    expect(within(rows[0]!).getByText('Confirmed device: SYNTHETIC-LT-01 (device-0)')).toBeVisible();
    expect(within(rows[1]!).getByText('Device not resolved in Atlas')).toBeVisible();
    expect(within(rows[2]!).getByText('No confirmed device for this source in the current registry')).toBeVisible();
    await userEvent.selectOptions(observations.getByLabelText('Observation severity'), 'URGENT');
    expect(observations.getAllByRole('listitem')).toHaveLength(2);
    await userEvent.selectOptions(observations.getByLabelText('Observation state'), 'ACKNOWLEDGED');
    expect(observations.getAllByRole('listitem')).toHaveLength(1);
    expect(observations.getByText('Synthetic security incident awaiting review')).toBeVisible();
    await userEvent.type(observations.getByRole('searchbox'), 'does not exist');
    expect(observations.queryAllByRole('listitem')).toHaveLength(0);
    expect(observations.getByText('No matching records in the loaded list.')).toBeVisible();
  });

  it('labels partial page filtering and retains full-source counts', async () => {
    const data = atlasWorkspace(); const s = data.summary!;
    s.activeObservations = 4; s.severityCounts.CRITICAL = 2; s.observationPage.truncated = true;
    render(data);
    expect(await screen.findByText(/Only the first 3 of 4 active observations are loaded/)).toBeVisible();
    const observations = within(screen.getByRole('region', { name: 'Active Atlas observations' }));
    await userEvent.selectOptions(observations.getByLabelText('Observation severity'), 'LOW');
    expect(observations.getByText(/Search and filters apply to this page only/)).toBeVisible();
    expect(observations.getByText('Matching observations: 0 of 3 loaded')).toBeVisible();
  });

  it('distinguishes empty registries and active queues from healthy sources', async () => {
    const data = atlasWorkspace(); const s = data.summary!;
    s.devices = []; s.knownDevices = 0; s.activeObservations = 0; s.observationPage.items = [];
    s.severityCounts = { INFO: 0, LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
    render(data);
    expect(await screen.findByText(/No active observations are recorded in Atlas/)).toBeVisible();
    await userEvent.click(screen.getByRole('tab', { name: 'Atlas devices' }));
    expect(screen.getByText(/No devices are recorded in this Atlas registry/)).toBeVisible();
    expect(screen.getByText('No snapshot')).toBeVisible();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });

  it('renders source summaries and hostnames as text, with no HTML or navigation', async () => {
    const data = atlasWorkspace(); const markup = '<img src=x onerror=alert(1)>';
    data.summary!.devices[0]!.hostname = markup;
    data.summary!.observationPage.items[0]!.summary = markup;
    render(data); await screen.findByRole('region', { name: 'Active Atlas observations' });
    expect(screen.getByText(markup)).toBeVisible();
    await userEvent.click(screen.getByRole('tab', { name: 'Atlas devices' }));
    expect(screen.getByText(markup)).toBeVisible();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: markup })).not.toBeInTheDocument();
  });

  it('removes all details while refreshing and after an access failure', async () => {
    let reply = atlasWorkspace();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(reply))));
    renderRoutes([page(<CustomerWorkspacePanel customerId="customer-one" />)], '/', testUser(['parasol.atlas.read']));
    await userEvent.click(await screen.findByRole('tab', { name: 'Atlas devices' }));
    reply = { customerId: 'customer-one', status: 'ACCESS_DENIED', summary: null };
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Atlas devices' })).not.toBeInTheDocument());
    expect(screen.queryByText('Synthetic disk capacity used: 97%')).not.toBeInTheDocument();
  });

  it('cancels the old customer read and ignores its late reply after navigation', async () => {
    let oldSignal: AbortSignal | undefined;
    let finishOld!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
      if (url.includes('/customer-one/')) {
        oldSignal = init.signal as AbortSignal;
        // A source can still complete after cancellation; React Query must not commit its old response to the new card.
        return new Promise<Response>(resolve => { finishOld = resolve; });
      }
      const data = atlasWorkspace('customer-two'); data.summary!.observationPage.items[0]!.summary = 'Synthetic customer two';
      return Promise.resolve(new Response(JSON.stringify(data)));
    }));
    function Journey() {
      const { id } = useParams();
      return <><Link to="/customer-two">Next customer</Link><CustomerWorkspacePanel customerId={id!} /></>;
    }
    renderRoutes([{ path: '/:id', element: <Journey /> }], '/customer-one', testUser(['parasol.atlas.read']));
    await waitFor(() => expect(oldSignal).toBeDefined());
    await userEvent.click(screen.getByRole('link', { name: 'Next customer' }));
    expect(await screen.findByText('Synthetic customer two')).toBeVisible();
    expect(oldSignal!.aborted).toBe(true);
    finishOld(new Response(JSON.stringify(atlasWorkspace())));
    await waitFor(() => expect(screen.getByText('Synthetic customer two')).toBeVisible());
    expect(screen.queryByText('Synthetic disk capacity used: 97%')).not.toBeInTheDocument();
  });
});

describe('the closed workspace response contract', () => {
  it.each([
    ['another customer', (v: Workspace) => { v.customerId = 'customer-two'; }],
    ['unknown field', (v: Workspace) => { Object.assign(v.summary!.devices[0]!, { token: 'synthetic-private' }); }],
    ['missing lists', (v: Workspace) => { delete (v.summary as unknown as Record<string, unknown>).devices; }],
    ['unknown severity', (v: Workspace) => { Object.assign(v.summary!.observationPage.items[0]!, { severity: 'OTHER' }); }],
    ['priority weakened', (v: Workspace) => { v.summary!.observationPage.items[0]!.priority = 'NORMAL'; }],
    ['invalid date', (v: Workspace) => { v.summary!.observationPage.items[0]!.updatedAt = 'bad'; }],
    ['unconfirmed device', (v: Workspace) => { v.summary!.observationPage.items[0]!.deviceId = 'device-1'; }],
    ['duplicate device', (v: Workspace) => { v.summary!.devices[1]!.id = 'device-0'; }],
    ['duplicate observation', (v: Workspace) => { v.summary!.observationPage.items[1]!.id = 'critical-one'; }],
    ['inconsistent count', (v: Workspace) => { v.summary!.knownDevices = 99; }],
    ['incomplete page hidden', (v: Workspace) => { v.summary!.activeObservations = 4; v.summary!.severityCounts.CRITICAL = 2; }],
  ])('refuses %s before rendering any list', async (_name, change) => {
    const data = atlasWorkspace(); change(data);
    expect(parseWorkspace(data, 'customer-one')).toEqual({ customerId: 'customer-one', status: 'INVALID_RESPONSE', summary: null });
    render(data);
    expect(await screen.findByText('Atlas returned an unexpected response. No technical data is shown.')).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Atlas devices' })).not.toBeInTheDocument();
  });
});
