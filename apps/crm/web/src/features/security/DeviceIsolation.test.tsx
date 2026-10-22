import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import type { MachineDetail, MachineDevice } from '../service/types';
import { DeviceIsolation } from './DeviceIsolation';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const empty = { items: [], nextCursor: null, totalCount: 0 };

const huntress = (isolation: string | null, overrides: Partial<MachineDevice> = {}): MachineDevice => ({
  id: 'dev-h', system: 'huntress', externalId: '4711', machineName: 'PC-17', type: 'Workstation', os: 'Windows 11 Pro', online: true,
  lastSeenAt: '2026-10-22T07:55:00Z', firstSeenAt: '2026-09-01T08:00:00Z', removedAt: null, url: null,
  inventory: {
    vendor: null, model: null, serialNumber: null, motherboard: null, processor: null, processorCores: null, processorClock: null, memory: null,
    biosVersion: null, osVersion: null, osBuild: null, lastRebootAt: null, ipAddresses: [], publicIp: null, macAddresses: [], domainName: null,
    loggedInUsers: null, lastLoginUser: null, disks: [], agentVersion: '0.13.140',
  },
  patches: { readAt: null, collectedAt: null, installedCount: 0, available: [], latestInstalled: [] },
  protection: { platform: 'windows', antivirusStatus: 'Healthy', antivirusSubstatus: null, antivirusPolicyStatus: null, antivirusReportedAt: null, isolation,
    agentVersionSince: null },
  ...overrides,
});

const machine = (devices: MachineDevice[]): MachineDetail => ({
  id: 'm1', organizationId: 'o1', organizationName: 'Fjord IT AS', name: 'PC-17', type: 'Workstation', os: 'Windows 11 Pro', online: true,
  lastSeenAt: '2026-10-22T07:55:00Z', removedAt: null, devices, proposals: [], openAlerts: 1, reads: [], etag: '"AAAAAAAAM1E="',
});

afterEach(() => vi.unstubAllGlobals());

function show(detail: MachineDetail, kinds: string[], permissions = ['service.read', 'service.write'], agent: string | null = '4711') {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/v1/actions/kinds')) return json(kinds.map((kind) => ({ system: 'huntress', kind, targetType: 'device',
      level: kind === 'agent.uninstall' ? 'Destructive' : 'Disruptive', simulated: false, limitedToCustomers: false })));
    if (url === '/api/v1/actions/preview' && init?.method === 'POST') return json({ title: 'synthetic stop', status: 409, code: 'VND_KIND_DISABLED' }, 409);
    if (url.startsWith('/api/v1/actions?')) return json({ ...empty, uncertain: 0, waiting: 0 });
    if (url === '/api/v1/service/machines/m1') return json(detail);
    return json(empty);
  });
  vi.stubGlobal('fetch', fetch);
  renderRoutes([page(<DeviceIsolation machineId="m1" agentExternalId={agent} deviceId={null} />)], '/', testUser(permissions));
  return fetch;
}

describe('The machine of an incident (M41)', () => {
  it('says the machine is not isolated and offers isolating it, through the one confirmation with the agent as the target', async () => {
    const user = userEvent.setup();
    const fetch = show(machine([huntress('Disabled')]), ['agent.isolate', 'agent.release', 'agent.uninstall']);
    const section = within(await screen.findByRole('region', { name: 'Device PC-17' }));
    expect(section.getByText('Not isolated')).toBeVisible();
    const isolate = await section.findByRole('button', { name: 'Isolate device…' });
    expect(section.queryByRole('button', { name: 'Lift isolation…' })).not.toBeInTheDocument();
    // Uninstalling belongs to the machine's card, never to an incident.
    expect(section.queryByRole('button', { name: 'Remove Huntress agent…' })).not.toBeInTheDocument();
    expect(await section.findByText('Nothing asked of Huntress for this device yet.')).toBeVisible();

    await user.click(isolate);
    expect(await screen.findByRole('dialog', { name: 'Isolate PC-17 from the network' })).toBeVisible();
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url === '/api/v1/actions/preview')).toBe(true));
    const [, init] = fetch.mock.calls.find(([url]) => url === '/api/v1/actions/preview')!;
    expect(JSON.parse(String(init!.body))).toEqual({ system: 'huntress', kind: 'agent.isolate', targetType: 'device', targetId: '4711', parameters: {} });
    // The log of the actions on this agent is asked for by the agent's own id.
    expect(fetch.mock.calls.map(([url]) => String(url))).toContain('/api/v1/actions?targetType=device&targetId=4711&limit=3');
  });

  it('offers lifting the isolation of an isolated machine, or one being isolated or released, and never isolating it again', async () => {
    const states: [string, string][] = [['Isolated', 'Isolated from the network'], ['Pending Isolation', 'Being isolated'], ['Pending Release', 'Isolation being lifted']];
    for (const [isolation, badge] of states) {
      show(machine([huntress(isolation)]), ['agent.isolate', 'agent.release']);
      const section = within(await screen.findByRole('region', { name: 'Device PC-17' }));
      expect(section.getByText(badge)).toBeVisible();
      expect(await section.findByRole('button', { name: 'Lift isolation…' })).toBeVisible();
      expect(section.queryByRole('button', { name: 'Isolate device…' })).not.toBeInTheDocument();
      document.body.innerHTML = '';
      vi.unstubAllGlobals();
    }
  });

  it('offers nothing while the kinds are off or to a person who may only read, and stays away from a machine Huntress does not watch', async () => {
    show(machine([huntress('Disabled')]), []);
    let section = within(await screen.findByRole('region', { name: 'Device PC-17' }));
    await section.findByText('Nothing asked of Huntress for this device yet.');
    expect(section.queryByRole('button', { name: 'Isolate device…' })).not.toBeInTheDocument();
    document.body.innerHTML = '';

    show(machine([huntress('Disabled')]), ['agent.isolate'], ['service.read']);
    section = within(await screen.findByRole('region', { name: 'Device PC-17' }));
    await section.findByText('Nothing asked of Huntress for this device yet.');
    expect(section.queryByRole('button', { name: 'Isolate device…' })).not.toBeInTheDocument();
    document.body.innerHTML = '';

    // A machine with only an Atera agent, or a Huntress agent no longer reported, has no isolation to show.
    const fetch = show(machine([huntress('Disabled', { system: 'atera', protection: null }), huntress('Disabled', { id: 'dev-old', removedAt: '2026-10-20T00:00:00Z' })]),
      ['agent.isolate']);
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url === '/api/v1/service/machines/m1')).toBe(true));
    await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());
    expect(screen.queryByRole('region', { name: 'Device PC-17' })).not.toBeInTheDocument();
  });

  it('acts on the incident’s own agent, never on an older one a reinstalled computer still has', async () => {
    const user = userEvent.setup();
    // The old agent (silent since the reinstall) came first; the incident names the new one.
    const old = huntress('Disabled', { id: 'dev-old', externalId: '4700', online: false, firstSeenAt: '2025-01-01T08:00:00Z' });
    const fetch = show(machine([old, huntress('Isolated')]), ['agent.isolate', 'agent.release']);
    const section = within(await screen.findByRole('region', { name: 'Device PC-17' }));
    expect(section.getByText('Isolated from the network')).toBeVisible();
    await user.click(await section.findByRole('button', { name: 'Lift isolation…' }));
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url === '/api/v1/actions/preview')).toBe(true));
    const [, init] = fetch.mock.calls.find(([url]) => url === '/api/v1/actions/preview')!;
    expect(JSON.parse(String(init!.body))).toMatchObject({ kind: 'agent.release', targetId: '4711' });
  });

  it('says nothing about an isolation Huntress did not report, rather than "not isolated"', async () => {
    show(machine([huntress(null)]), ['agent.isolate']);
    const section = within(await screen.findByRole('region', { name: 'Device PC-17' }));
    expect(await section.findByRole('button', { name: 'Isolate device…' })).toBeVisible();
    expect(section.queryByText('Not isolated')).not.toBeInTheDocument();
    expect(section.queryByText('Not isolated (firewall on)')).not.toBeInTheDocument();
  });
});
