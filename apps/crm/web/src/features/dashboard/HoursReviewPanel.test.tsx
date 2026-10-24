import { afterEach, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { todayIso } from '../../shared/utils/format';
import { HoursReviewPanel } from './MyDayPanels';

afterEach(() => vi.unstubAllGlobals());
const year = Number(todayIso().slice(0, 4));
const period = (month: number, newEntries: number, isClosed = false) =>
  ({ year, month, isClosed, closedAt: null, closedByName: null, reopenReason: null, newEntries, hours: newEntries * 2 });

it('links each open month with entries waiting for approval, newest first, and says when nothing waits', async () => {
  const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify([period(1, 2), period(3, 1), period(2, 0), period(4, 5, true)])));
  vi.stubGlobal('fetch', fetch);
  renderRoutes([page(<HoursReviewPanel />)], '/', testUser(['time.read', 'time.manage']));
  const links = await screen.findAllByRole('link', { name: /wait(s)? for approval$/ });
  expect(links.map((l) => l.textContent)).toEqual([`March ${year}: 1 entry waits for approval`, `January ${year}: 2 entries wait for approval`]);
  expect(links[0]).toHaveAttribute('href', `/time/entries?year=${year}&month=3&status=New`);
  expect(fetch.mock.calls[0]![0]).toBe(`/api/v1/time/periods?year=${year}`);
});

it('says nothing waits when every month is approved', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([period(1, 0)]))));
  renderRoutes([page(<HoursReviewPanel />)], '/', testUser(['time.read', 'time.manage']));
  expect(await screen.findByText(`Nothing waits for approval in ${year}.`)).toBeVisible();
});
