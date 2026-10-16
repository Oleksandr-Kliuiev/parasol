import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoutes, testUser } from '../../test/renderWithProviders';
import { OrganizationServiceTab } from './OrganizationServiceTab';
import type { Device } from './types';

const device = (n: number): Device => ({
  id: `d${n}`, machineName: `PC-${String(n).padStart(4, '0')}`, type: 'Workstation', os: 'Windows 11', online: true, lastSeenAt: null, url: null, removedAt: null,
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const empty = { items: [], nextCursor: null, totalCount: 0 };

afterEach(() => vi.unstubAllGlobals());

describe('Organization service tab (DEV-12)', () => {
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
    renderRoutes([{ path: '*', element: <OrganizationServiceTab organizationId="o1" /> }], '/', testUser(['service.read']));

    expect(await screen.findByText('Showing 25 of 1100')).toBeInTheDocument();
    expect(fetch.mock.calls.map(([url]) => url)).toContain('/api/v1/service/devices?organizationId=o1&limit=25');
    // The old list said "and 1075 more" and stopped there; now the next page comes with the cursor.
    await user.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('Showing 50 of 1100')).toBeInTheDocument();
    expect(fetch.mock.calls.at(-1)![0]).toBe('/api/v1/service/devices?organizationId=o1&limit=25&cursor=c1');
    expect(screen.getAllByRole('listitem').filter((item) => /PC-\d{4}/.test(item.textContent ?? ''))).toHaveLength(50);
    expect(screen.getByText('PC-0049')).toBeInTheDocument();
  });
});
