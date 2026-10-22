import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../../test/renderWithProviders';
import type { MachineDetail, MachineDevice } from '../types';
import { MachineDrawer } from './MachineDrawer';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const empty = { items: [], nextCursor: null, totalCount: 0 };

/** PC-17's Atera agent, with the hardware Atera reports; it last reported at night. */
const atera: MachineDevice = {
  id: 'dev-a', system: 'atera', externalId: '1201', machineName: 'PC-17', type: 'Workstation', os: 'Microsoft Windows 11 Pro', online: true,
  lastSeenAt: '2026-10-22T01:30:00Z', firstSeenAt: '2026-09-01T07:30:00Z', removedAt: null, url: 'https://atera.example.invalid/Admin#/rmm/device/5369e175/agent',
  inventory: {
    vendor: 'Dell Inc.', model: 'Latitude 5440', serialNumber: '5CG1234ABC', motherboard: null, processor: 'Intel Core i5-1345U', processorCores: 10,
    processorClock: '1.6', memory: 16384, biosVersion: null, osVersion: '23H2', osBuild: '22631.4317', lastRebootAt: null, ipAddresses: ['10.0.0.17'],
    publicIp: null, macAddresses: ['00:1A:2B:3C:4D:5E'], domainName: 'FJORD', loggedInUsers: null, lastLoginUser: null, disks: [], agentVersion: '1.8.7.4',
  },
  patches: { readAt: '2026-10-22T02:15:00Z', collectedAt: '2026-10-22T01:00:00Z', installedCount: 0, available: [], latestInstalled: [] },
};

/** PC-17's Huntress agent: in touch an hour ago, which is more recent than Atera's last report. */
const huntress = (overrides: Partial<MachineDevice> = {}, protection: Partial<NonNullable<MachineDevice['protection']>> = {}): MachineDevice => ({
  id: 'dev-h', system: 'huntress', externalId: '4711', machineName: 'PC-17', type: 'Workstation', os: 'Windows 11 Pro', online: true,
  lastSeenAt: '2026-10-22T07:55:00Z', firstSeenAt: '2026-09-02T08:00:00Z', removedAt: null, url: null,
  inventory: {
    vendor: null, model: null, serialNumber: '5CG1234ABC', motherboard: null, processor: null, processorCores: null, processorClock: null, memory: null,
    biosVersion: null, osVersion: null, osBuild: '22631', lastRebootAt: null, ipAddresses: ['10.0.0.17'], publicIp: null, macAddresses: [], domainName: null,
    loggedInUsers: null, lastLoginUser: null, disks: [], agentVersion: '0.13.140',
  },
  patches: { readAt: null, collectedAt: null, installedCount: 0, available: [], latestInstalled: [] },
  protection: {
    platform: 'windows', antivirusStatus: 'Unhealthy', antivirusSubstatus: 'Signatures out of date', antivirusPolicyStatus: 'Compliant',
    antivirusReportedAt: '2026-10-22T07:00:00Z', isolation: 'Disabled', agentVersionSince: '2026-10-01T08:00:00Z', ...protection,
  },
  ...overrides,
});

const card = (devices: MachineDevice[]): MachineDetail => ({
  id: 'm1', organizationId: 'o1', organizationName: 'Fjord IT AS', name: 'PC-17', type: 'Workstation', os: 'Windows 11 Pro', online: true,
  lastSeenAt: '2026-10-22T07:55:00Z', removedAt: null, devices, proposals: [], openAlerts: 0, etag: '"AAAAAAAAM2E="',
  reads: [{ source: 'devices', system: 'atera', startedAt: '2026-10-22T01:30:00Z', complete: true, late: false }],
});

afterEach(() => vi.unstubAllGlobals());

function show(detail: MachineDetail, kinds: string[] = [], permissions = ['service.read', 'service.write']) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/v1/actions/kinds')) return json(kinds.map((kind) => ({ system: 'huntress', kind, targetType: 'device',
      level: kind === 'agent.uninstall' ? 'Destructive' : 'Disruptive', simulated: false, limitedToCustomers: false })));
    if (url === '/api/v1/actions/preview' && init?.method === 'POST') return json({ title: 'synthetic stop', status: 409, code: 'VND_KIND_DISABLED' }, 409);
    if (url.startsWith('/api/v1/actions?')) return json({ ...empty, uncertain: 0, waiting: 0 });
    return json(detail);
  });
  vi.stubGlobal('fetch', fetch);
  renderRoutes([page(<MachineDrawer machineId="m1" onClose={() => {}} onChanged={() => {}} />)], '/', testUser(permissions));
  return fetch;
}

const huntressItem = async () => {
  const sources = within(await screen.findByRole('region', { name: 'Sources' }));
  return within(sources.getByText('Huntress').closest('li')!);
};

describe('Protection on the device card (M41)', () => {
  it('says what Huntress reports about Defender, isolation and its agent, in the reader’s words', async () => {
    show(card([atera, huntress()]));
    const item = await huntressItem();
    expect(item.getByText(/^Defender: Unhealthy · Signatures out of date · reported$/)).toBeVisible();
    expect(item.getByText('Not isolated')).toBeVisible();
    expect(item.getByText('Huntress agent 0.13.140')).toBeVisible();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();

    // A word of Huntress's the interface knows is said in the reader's language.
    show(card([huntress({}, { antivirusStatus: 'Unmanaged', antivirusSubstatus: null, isolation: 'Isolated' })]));
    const other = await huntressItem();
    expect(other.getByText(/^Defender: Another antivirus is in charge · reported$/)).toBeVisible();
    expect(other.getByText('Isolated from the network')).toBeVisible();
  });

  it('keeps describing the computer from Atera and keeps Atera’s console section when Huntress was in touch more recently', async () => {
    show(card([atera, huntress()]));
    const dialog = within(await screen.findByRole('dialog', { name: 'PC-17' }));
    const hardware = within(dialog.getByRole('region', { name: 'Hardware' }));
    expect(hardware.getByText('Dell Inc. Latitude 5440')).toBeVisible();
    const console = within(dialog.getByRole('region', { name: 'In Atera' }));
    expect(console.getByRole('link', { name: 'Open in Atera' })).toHaveAttribute('href', 'https://atera.example.invalid/Admin#/rmm/device/5369e175/agent');
    // Atera's device carries no protection: nothing is said about Defender beside it.
    const ateraItem = within(within(dialog.getByRole('region', { name: 'Sources' })).getByText('Atera').closest('li')!);
    expect(ateraItem.queryByText(/^Defender:/)).not.toBeInTheDocument();
  });

  it('has no console section for a machine only Huntress watches, and names its agent version once, in the inventory', async () => {
    show(card([huntress()]));
    const dialog = within(await screen.findByRole('dialog', { name: 'PC-17' }));
    await (await huntressItem()).findByText(/^Defender:/);
    // The inventory is Huntress's here and names the version; the protection facts beside the source do not say it again.
    expect(within(dialog.getByRole('region', { name: 'System' })).getByText('Huntress agent 0.13.140')).toBeVisible();
    expect(dialog.getAllByText('Huntress agent 0.13.140')).toHaveLength(1);
    expect(dialog.queryByRole('region', { name: 'In Atera' })).not.toBeInTheDocument();
    expect(dialog.queryByRole('region', { name: 'In Huntress' })).not.toBeInTheDocument();
  });

  it('offers isolating and removing the agent of a machine that is not isolated, as the kinds allow', async () => {
    const user = userEvent.setup();
    const fetch = show(card([atera, huntress()]), ['agent.isolate', 'agent.release', 'agent.uninstall']);
    const item = await huntressItem();
    expect(await item.findByRole('button', { name: 'Isolate machine…' })).toBeVisible();
    expect(item.getByRole('button', { name: 'Remove Huntress agent…' })).toBeVisible();
    expect(item.queryByRole('button', { name: 'Lift isolation…' })).not.toBeInTheDocument();

    await user.click(item.getByRole('button', { name: 'Remove Huntress agent…' }));
    expect(await screen.findByRole('dialog', { name: 'Remove the Huntress agent from PC-17' })).toBeVisible();
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url === '/api/v1/actions/preview')).toBe(true));
    const [, init] = fetch.mock.calls.find(([url]) => url === '/api/v1/actions/preview')!;
    expect(JSON.parse(String(init!.body))).toEqual({ system: 'huntress', kind: 'agent.uninstall', targetType: 'device', targetId: '4711', parameters: {} });
  });

  it('offers lifting the isolation of an isolated machine and nothing the kinds leave off', async () => {
    show(card([atera, huntress({}, { isolation: 'Isolated' })]), ['agent.release']);
    const item = await huntressItem();
    expect(await item.findByRole('button', { name: 'Lift isolation…' })).toBeVisible();
    expect(item.queryByRole('button', { name: 'Isolate machine…' })).not.toBeInTheDocument();
    expect(item.queryByRole('button', { name: 'Remove Huntress agent…' })).not.toBeInTheDocument();
  });

  it('offers no action on an agent Huntress no longer reports, nor to a person who may only read', async () => {
    show(card([atera, huntress({ removedAt: '2026-10-21T00:00:00Z' })]), ['agent.isolate', 'agent.uninstall']);
    let item = await huntressItem();
    await item.findByText('Huntress agent 0.13.140');
    expect(item.queryByRole('button', { name: 'Isolate machine…' })).not.toBeInTheDocument();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();

    show(card([atera, huntress()]), ['agent.isolate', 'agent.uninstall'], ['service.read']);
    item = await huntressItem();
    await item.findByText('Huntress agent 0.13.140');
    expect(item.queryByRole('button', { name: 'Isolate machine…' })).not.toBeInTheDocument();
    expect(item.queryByRole('button', { name: 'Remove Huntress agent…' })).not.toBeInTheDocument();
  });
});
