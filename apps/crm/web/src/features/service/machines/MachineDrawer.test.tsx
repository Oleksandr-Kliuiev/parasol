import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../../test/renderWithProviders';
import type { MachineDetail, MachineDevice } from '../types';
import { MachineDrawer } from './MachineDrawer';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const agent = (overrides: Partial<MachineDevice> = {}): MachineDevice => ({
  id: 'dev-1', system: 'atera', externalId: '1201', machineName: 'PC-ALFA-02', type: 'Workstation', os: 'Microsoft Windows 11 Pro', online: true,
  lastSeenAt: '2026-10-21T07:30:00Z', firstSeenAt: '2026-10-01T07:30:00Z', removedAt: null,
  url: 'https://atera.example.invalid/Admin#/rmm/device/5369e175/agent',
  inventory: {
    vendor: 'Dell Inc.', model: 'Latitude 5440', serialNumber: '5CG1234ABC', motherboard: null, processor: 'Intel Core i5-1345U', processorCores: 10,
    processorClock: '1.6', memory: 16384, biosVersion: null, osVersion: '23H2', osBuild: '22631.4317', lastRebootAt: '2026-10-19T05:00:00Z',
    ipAddresses: ['10.0.0.21'], publicIp: '203.0.113.10', macAddresses: ['00:1A:2B:3C:4D:5E'], domainName: 'ALFA', loggedInUsers: 'ALFA\\testbruker',
    lastLoginUser: 'testbruker', disks: [{ drive: 'C:', free: 120, used: 360, total: 480 }], agentVersion: '1.8.7.4',
  },
  patches: {
    readAt: '2026-10-22T02:15:00Z', collectedAt: '2026-10-22T01:00:00Z', installedCount: 12,
    available: [{ kbId: 'KB5045993', name: '.NET 8.0.11 Security Update', class: 'Security Updates', installedAt: null, status: 'Pending' }],
    latestInstalled: [{ kbId: 'KB5044284', name: '2026-10 Cumulative Update', class: 'Security Updates', installedAt: '2026-10-16T03:00:00Z', status: null }],
  },
  ...overrides,
});

const card = (overrides: Partial<MachineDetail> = {}): MachineDetail => ({
  id: 'm1', organizationId: 'o1', organizationName: 'Fjord IT AS', name: 'PC-ALFA-02', type: 'Workstation', os: 'Microsoft Windows 11 Pro', online: true,
  lastSeenAt: '2026-10-21T07:30:00Z', removedAt: null, devices: [agent()], openAlerts: 1,
  proposals: [{ otherMachineId: 'm2', otherName: 'ACCOUNTS-7', evidence: ['name', 'serial'], foundAt: '2026-10-22T01:31:00Z' }],
  reads: [{ source: 'devices', system: 'atera', startedAt: '2026-10-22T01:30:00Z', complete: true, late: false }],
  etag: '"AAAAAAAAB9E="',
  ...overrides,
});

afterEach(() => vi.unstubAllGlobals());

function show(detail: MachineDetail, permissions = ['service.read', 'service.write'], answer?: (url: string, init?: RequestInit) => Response | undefined) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => answer?.(url, init) ?? json(detail));
  vi.stubGlobal('fetch', fetch);
  const changed = vi.fn();
  renderRoutes([page(<MachineDrawer machineId={detail.id} onClose={() => {}} onChanged={changed} />)], '/', testUser(permissions));
  return { fetch, changed };
}

describe('Device card (M40)', () => {
  it('shows what Atera says about the computer, names what it does not report and leads to Atera', async () => {
    show(card());
    const dialog = await screen.findByRole('dialog', { name: 'PC-ALFA-02' });
    const hardware = within(within(dialog).getByRole('region', { name: 'Hardware' }));
    expect(hardware.getByText('Dell Inc. Latitude 5440')).toBeVisible();
    expect(hardware.getByText('Intel Core i5-1345U · 10 cores')).toBeVisible();
    expect(hardware.getByText('16,384 MB')).toBeVisible();
    expect(hardware.getByText('C: 25 % free (120 of 480)')).toBeVisible();
    // The fields Atera did not report are named once, not shown as dashes.
    expect(hardware.getByText('Atera does not report: mainboard, bios.')).toBeVisible();
    const system = within(within(dialog).getByRole('region', { name: 'System' }));
    expect(system.getByText('Microsoft Windows 11 Pro · 23H2 · build 22631.4317')).toBeVisible();
    expect(within(within(dialog).getByRole('region', { name: 'Users' })).getByText('ALFA\\testbruker')).toBeVisible();
    const updates = within(within(dialog).getByRole('region', { name: 'Windows updates' }));
    expect(updates.getByText('1 update available')).toBeVisible();
    expect(updates.getByText('KB5045993')).toBeVisible();
    expect(updates.getByText('Waiting')).toBeVisible();
    expect(updates.getByText('12 updates installed')).toBeVisible();
    expect(updates.getByText('The latest 1 of 12.')).toBeVisible();
    // What Atera's API cannot do is done in Atera: one link there.
    const console = within(within(dialog).getByRole('region', { name: 'In Atera' }));
    expect(console.getByText(/Remote connection, scripts, installing updates and restarting are done in Atera/)).toBeVisible();
    expect(console.getByRole('link', { name: 'Open in Atera' })).toHaveAttribute('href', 'https://atera.example.invalid/Admin#/rmm/device/5369e175/agent');
  });

  it('joins a proposal on one click with the ETag of the card and moves to the machine the devices make', async () => {
    const user = userEvent.setup();
    const joined = card({ id: 'm2', name: 'ACCOUNTS-7', proposals: [], etag: '"AAAAAAAAB9F="' });
    const { fetch, changed } = show(card(), undefined, (_, init) => (init?.method === 'POST' ? json(joined) : undefined));
    const proposals = within(await screen.findByRole('region', { name: 'May be the same device' }));
    expect(proposals.getByText('May be ACCOUNTS-7')).toBeVisible();
    expect(proposals.getByText('same serial number · the same name')).toBeVisible();

    await user.click(proposals.getByRole('button', { name: 'Same device' }));

    await waitFor(() => expect(changed).toHaveBeenCalledWith('m2'));
    // The button that decided is gone: the result is said, and focus stays in the panel, on the devices the machine has now.
    expect(await screen.findByText('The two are one device now.')).toBeVisible();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Sources' })).toHaveFocus());
    const [url, init] = fetch.mock.calls.find(([, i]) => i?.method === 'POST')!;
    expect(url).toBe('/api/v1/service/machines/m1/join');
    expect(new Headers(init!.headers).get('If-Match')).toBe('"AAAAAAAAB9E="');
    expect(JSON.parse(String(init!.body))).toEqual({ otherMachineId: 'm2' });
  });

  it('asks before keeping two machines apart for good, and before taking a device off its machine', async () => {
    const user = userEvent.setup();
    const two = card({ devices: [agent(), agent({ id: 'dev-2', machineName: 'PC-ALFA-02-OLD', online: false })] });
    const { fetch } = show(two, undefined, (_, init) => (init?.method === 'POST' ? json({ ...two, proposals: [] }) : undefined));
    await user.click(await screen.findByRole('button', { name: 'Different devices' }));
    const ask = await screen.findByRole('dialog', { name: 'Keep PC-ALFA-02 and ACCOUNTS-7 apart?' });
    expect(within(ask).getByText(/will not suggest joining them again/)).toBeVisible();
    await user.click(within(ask).getByRole('button', { name: 'Different devices' }));
    await waitFor(() => expect(fetch.mock.calls.some(([u]) => u === '/api/v1/service/machines/m1/keep-apart')).toBe(true));

    const sources = within(screen.getByRole('region', { name: 'Sources' }));
    await user.click(sources.getAllByRole('button', { name: 'Not this device' })[1]!);
    const detach = await screen.findByRole('dialog', { name: 'Take PC-ALFA-02-OLD (Atera) off this device?' });
    await user.click(within(detach).getByRole('button', { name: 'Not this device' }));
    await waitFor(() => expect(fetch.mock.calls.some(([u]) => u === '/api/v1/service/machines/m1/detach')).toBe(true));
    const [, init] = fetch.mock.calls.findLast(([u]) => u === '/api/v1/service/machines/m1/detach')!;
    expect(JSON.parse(String(init!.body))).toEqual({ deviceId: 'dev-2' });
  });

  it('reads the card again when it changed since the person read it, and decides nothing', async () => {
    const user = userEvent.setup();
    const { fetch, changed } = show(card(), undefined, (_, init) => (init?.method === 'POST'
      ? json({ title: 'CONCURRENCY_CONFLICT', status: 412, code: 'CONCURRENCY_CONFLICT' }, 412) : undefined));
    await user.click(await screen.findByRole('button', { name: 'Same device' }));
    expect(await screen.findByText('The device changed while you looked at it. Here it is as it is now: decide again.')).toBeVisible();
    expect(changed).not.toHaveBeenCalled();
    await waitFor(() => expect(fetch.mock.calls.filter(([u, i]) => u === '/api/v1/service/machines/m1' && (i?.method ?? 'GET') === 'GET')).toHaveLength(2));
  });

  it('offers no decision to a person who may only read, and says that only Windows agents report updates', async () => {
    show(card({ devices: [agent({ os: 'macOS 15.1' })], os: 'macOS 15.1' }), ['service.read']);
    const dialog = await screen.findByRole('dialog', { name: 'PC-ALFA-02' });
    expect(within(dialog).getByText('May be ACCOUNTS-7')).toBeVisible();
    expect(within(dialog).queryByRole('button', { name: 'Same device' })).not.toBeInTheDocument();
    expect(within(dialog).getByText('Atera reports Windows updates only.')).toBeVisible();
  });
});
