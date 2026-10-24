import { afterEach, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { ActionLogPanel } from './ActionLog';
import type { VendorAction } from './types';

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const action = (n: number): VendorAction => ({
  id: `a${n}`, system: 'atera', kind: 'ticket.reply', level: 'Standard', targetType: 'ticket', targetId: String(4700 + n), targetName: `#${4700 + n} Ticket ${n}`,
  organizationId: 'o1', organizationName: 'Havbris AS', parameters: {}, reason: null, status: 'Succeeded', outcomeCode: 'VND_SENT', outcome: 'Sent',
  reference: null, attempts: 1, requestedBy: 'u1', requestedByName: 'Kari Nordmann', requestedAt: '2026-10-21T10:00:00Z', notBefore: '2026-10-21T10:00:00Z',
  startedAt: null, completedAt: null, closedBy: null, closedByName: null, closedAt: null, closeReason: null, etag: '"1"',
});

// M39: the filter counts read the log one row at a time; that page must never stand in for the list under All.
it('lists a whole page under All beside the counts that read one row', async () => {
  const fetch = vi.fn(async (url: string) => {
    const limit = Number(new URL(url, 'http://localhost').searchParams.get('limit') ?? 25);
    const items = [1, 2, 3].map(action).slice(0, limit);
    return json({ items, nextCursor: limit < 3 ? 'next' : null, totalCount: 3, uncertain: 0, waiting: 0 });
  });
  vi.stubGlobal('fetch', fetch);
  renderRoutes([page(<ActionLogPanel />)], '/', testUser(['integrations.manage']));

  const log = await screen.findByRole('region', { name: 'Actions at vendors' });
  expect(await within(log).findByText('Showing 3 of 3')).toBeVisible();
  expect(within(log).getAllByRole('listitem')).toHaveLength(3);
  expect(within(log).getByRole('button', { name: /^All/ })).toHaveTextContent('3');
});
