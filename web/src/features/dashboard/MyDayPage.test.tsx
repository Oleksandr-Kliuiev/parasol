import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderRoutes, testUser } from '../../test/renderWithProviders';
import { MyDayPage } from './MyDayPage';
import type { RunListItem } from '../billing/types';

const run: RunListItem = {
  id: 'r1', periodStart: '2026-07-01', periodEnd: '2026-07-31', kind: 'Regular', status: 'InReview', organizations: 12, withAnomalies: 0,
  requiresSecondApproval: false, collectedAt: '2026-08-01T08:00:00Z', approvedAt: null, exportedAt: null, closedAt: null,
};

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('My day — billing (DEV-12)', () => {
  it('asks for the open runs of any period and says how many more are open', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith('/api/v1/billing/runs')) return json({ items: [run], nextCursor: 'c1', totalCount: 3 });
      if (url.startsWith('/api/v1/billing/invoices')) return json({ count: 0, invoices: [], nextCursor: null, asOf: '2026-10-04' });
      return json({ items: [], nextCursor: null, totalCount: 0 });
    });
    vi.stubGlobal('fetch', fetch);
    renderRoutes([{ path: '*', element: <MyDayPage /> }], '/', testUser(['billing.read']));

    expect(await screen.findByRole('link', { name: '2 more open runs' })).toHaveAttribute('href', '/billing');
    expect(screen.getByRole('link', { name: /July 2026/i })).toHaveAttribute('href', '/billing/runs/r1');
    // Not "whatever the newest six runs hold": an open run of an older period is found too.
    expect(fetch.mock.calls.map(([url]) => url)).toContain('/api/v1/billing/runs?openOnly=true&limit=1');
  });
});
