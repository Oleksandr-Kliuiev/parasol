import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoutes, testUser } from '../../test/renderWithProviders';
import { alertPage, syntheticAlert } from '../../test/alerts';
import { OperationsTab } from './OperationsTab';
import type { Device } from './types';

const device = (n: number): Device => ({
  id: `d${n}`, machineName: `PC-${String(n).padStart(4, '0')}`, type: 'Workstation', os: 'Windows 11', online: true, lastSeenAt: null, url: null, removedAt: null, openAlerts: 0,
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const empty = { items: [], nextCursor: null, totalCount: 0 };

afterEach(() => vi.unstubAllGlobals());

describe('Customer Drift tab (DEV-12)', () => {
  it('lists the devices a page at a time and says how many of all are shown', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.includes('/summary')) {
        return json({ openTickets: 0, ticketsLast90Days: 0, devices: { Workstation: 1100 }, devicesOnline: 1100, criticalAlerts: 0, warningAlerts: 0, lastSyncedAt: null });
      }
      if (url.includes('/devices')) {
        const second = url.includes('cursor=c1');
        return json({ items: Array.from({ length: 25 }, (_, i) => device((second ? 25 : 0) + i)), nextCursor: second ? 'c2' : 'c1', totalCount: 1100 });
      }
      return json(empty);
    });
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();
    renderRoutes([{ path: '*', element: <OperationsTab organizationId="o1" /> }], '/', testUser(['service.read']));

    expect(await screen.findByText('Showing 25 of 1100')).toBeInTheDocument();
    expect(fetch.mock.calls.map(([url]) => url)).toContain('/api/v1/service/devices?organizationId=o1&limit=25');
    // The old list said "and 1075 more" and stopped there; now the next page comes with the cursor.
    await user.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('Showing 50 of 1100')).toBeInTheDocument();
    expect(fetch.mock.calls.at(-1)![0]).toBe('/api/v1/service/devices?organizationId=o1&limit=25&cursor=c1');
    expect(screen.getAllByRole('listitem').filter((item) => /PC-\d{4}/.test(item.textContent ?? ''))).toHaveLength(50);
    expect(screen.getByText('PC-0049')).toBeInTheDocument();
  });

  it('shows the sections in the order of the work: summary, alerts, devices, tickets, requests', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.includes('/summary')
      ? json({ openTickets: 0, ticketsLast90Days: 0, devices: {}, devicesOnline: 0, criticalAlerts: 0, warningAlerts: 0, lastSyncedAt: null })
      : json(empty))));
    renderRoutes([{ path: '*', element: <OperationsTab organizationId="o1" /> }], '/', testUser(['service.read']));
    await screen.findByText('No open tickets.');
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent))
      .toEqual(['Saved service data', 'Open alerts', 'Devices', 'Tickets', 'Ticket requests']);
  });

  it('lists open alerts with severity, device, age and task, asks one task lookup per page and counts alerts per device', async () => {
    const alerts = [syntheticAlert({ id: 'a1' }), syntheticAlert({ id: 'a2', severity: 'Warning', title: 'Backup is late', deviceName: null })];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/summary')) return json({ openTickets: 0, ticketsLast90Days: 0, devices: { Server: 1 }, devicesOnline: 1, criticalAlerts: 1, warningAlerts: 1, lastSyncedAt: '2026-10-21T08:00:00Z' });
      if (url.includes('/service/alerts')) return json(alertPage(alerts));
      if (url.includes('/service/devices')) return json({ items: [{ ...device(1), machineName: 'SRV-01', type: 'Server', openAlerts: 2 }, device(2)], nextCursor: null, totalCount: 2 });
      if (url.endsWith('/source-tasks/lookup') && init?.method === 'POST') return json({ items: [{ alertId: 'a1', task: {
        id: 't1', organizationId: 'o1', subject: 'Free disk space', status: 'Open', assignee: { id: 'u2', name: 'Ola Tekniker' }, dueAt: null, isAvailable: true } }] });
      return json(empty);
    });
    vi.stubGlobal('fetch', fetch);
    renderRoutes([{ path: '*', element: <OperationsTab organizationId="o1" /> }], '/',
      testUser(['service.read', 'activities.read', 'activities.write']));
    const panel = within(await screen.findByRole('region', { name: 'Open alerts' }));
    const rows = await panel.findAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining('Disk almost full on SRV-01'), expect.stringContaining('Backup is late')]);
    expect(within(rows[0]!).getByText('Critical')).toBeVisible();
    expect(within(rows[0]!).getByText(/^SRV-01/)).toBeVisible();
    expect(rows[0]!.querySelector('time')).toHaveAttribute('dateTime', '2026-10-21T06:00:00Z');
    expect(await within(rows[0]!).findByRole('link', { name: /^Ola Tekniker · no due date: task Free disk space/ })).toBeVisible();
    expect(within(rows[1]!).getByRole('button', { name: 'Assign Backup is late' })).toBeVisible();
    expect(fetch.mock.calls.map(([url]) => url)).toContain('/api/v1/service/alerts?organizationId=o1&limit=25');
    await waitFor(() => expect(fetch.mock.calls.filter(([url]) => url.endsWith('/source-tasks/lookup'))).toHaveLength(1));
    const devices = within(screen.getByRole('region', { name: 'Devices' }));
    expect(devices.getByText('2 open alerts')).toBeVisible();
    // A device without open alerts says nothing about them.
    expect(devices.getAllByText(/open alert/)).toHaveLength(1);
  });
});
