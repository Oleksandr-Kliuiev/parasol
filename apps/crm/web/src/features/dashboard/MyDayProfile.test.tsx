import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CurrentUser } from '../../api/types';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { MyDayPage } from './MyDayPage';
import { availableProfiles, myDayProfile } from './myDayProfile';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const layoutUrl = '/api/v1/identity/me/my-day-layout';
// The permissions the layouts depend on; full access (M38) holds all of them.
const everything = ['activities.read', 'customers.read', 'service.read', 'time.read', 'time.manage', 'billing.read', 'billing.manage', 'billing.approve.second',
  'finance.read'];
const user = (permissions: string[], myDayLayout: string | null = null): CurrentUser => ({ ...testUser(permissions), myDayLayout });

afterEach(() => vi.unstubAllGlobals());

function stubApi(save: (body: unknown) => Response | Promise<Response> = () => new Response(null, { status: 204 })) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === layoutUrl) return save(JSON.parse(String(init?.body)));
    if (url.startsWith('/api/v1/billing/runs')) {
      return json({
        items: [{ id: 'r1', periodStart: '2026-07-01', periodEnd: '2026-07-31', kind: 'Regular', status: 'InReview', organizations: 12, withAnomalies: 0,
          requiresSecondApproval: false, collectedAt: '2026-08-01T08:00:00Z', approvedAt: null, exportedAt: null, closedAt: null }],
        nextCursor: null, totalCount: 1,
      });
    }
    if (url.startsWith('/api/v1/billing/invoices')) return json({ count: 0, invoices: [], nextCursor: null, asOf: '2026-10-04' });
    if (url.startsWith('/api/v1/service/alerts/urgent')) return json({ items: [], totalCount: 0, critical: 0, warning: 0, reads: [] });
    if (url.startsWith('/api/v1/time/periods')) return json([]);
    if (url.startsWith('/api/v1/time/entries')) return json({ items: [], nextCursor: null, totalCount: 0, summary: { hours: 0, billableHours: 0, newHours: 0 } });
    return json({ items: [], nextCursor: null, totalCount: 0 });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const saves = (fetch: ReturnType<typeof stubApi>) => fetch.mock.calls.filter(([url]) => url === layoutUrl).map(([, init]) => JSON.parse(String(init?.body)));

describe('myDayProfile', () => {
  it.each([
    [null, [], 'work'],
    // Full access no longer means billing first: without a choice everybody starts with alerts and tasks.
    [null, everything, 'work'],
    ['lead', everything, 'lead'],
    ['finance', everything, 'finance'],
    ['Finance', everything, 'work'],
    ['unknown', everything, 'work'],
    // A layout whose first panel the person cannot see is not theirs to keep.
    ['finance', ['activities.read', 'time.manage'], 'work'],
    ['lead', ['billing.read'], 'work'],
  ])('a choice of %j with %j gets the %s layout', (chosen, permissions, profile) => {
    expect(myDayProfile(chosen, permissions)).toBe(profile);
  });

  it.each([
    [[], ['work']],
    [['time.manage'], ['work', 'lead']],
    [['billing.read'], ['work', 'finance']],
    [everything, ['work', 'lead', 'finance']],
  ])('offers %j the layouts %j', (permissions, offered) => {
    expect(availableProfiles(permissions)).toEqual(offered);
  });
});

describe('My day by the layout each person chooses', () => {
  const titles = () => screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
  const greeting = () => screen.findByRole('heading', { name: /^Good (morning|afternoon|evening), Kari$/ });
  const layouts = () => screen.getByRole('radiogroup', { name: 'Show first' });

  it('starts everybody with alerts and tasks, also with every permission', async () => {
    stubApi();
    renderRoutes([page(<MyDayPage />)], '/', user(everything));
    await greeting(); await screen.findByRole('link', { name: /July 2026/i });
    const list = titles();
    expect(list.indexOf('Urgent alerts')).toBeLessThan(list.indexOf('Billing'));
    expect(list.indexOf('My tasks')).toBeLessThan(list.indexOf('Billing'));
    expect(screen.queryByRole('heading', { name: 'Hours to review' })).toBeNull();
    expect(screen.getByText('Your organizations and what needs attention.')).toBeInTheDocument();
    expect(within(layouts()).getByRole('radio', { name: 'Alerts and tasks' })).toBeChecked();
  });

  it('puts billing first for someone who chose it', async () => {
    stubApi();
    renderRoutes([page(<MyDayPage />)], '/', user(everything, 'finance'));
    await greeting(); await screen.findByRole('link', { name: /July 2026/i });
    const list = titles();
    expect(list.indexOf('Billing')).toBeLessThan(list.indexOf('Urgent alerts'));
    expect(list.indexOf('Billing')).toBeLessThan(list.indexOf('My tasks'));
    expect(screen.getByText('Billing, overdue invoices and what needs attention.')).toBeInTheDocument();
    expect(within(layouts()).getByRole('radio', { name: 'Billing' })).toBeChecked();
  });

  it('adds the hours review on the side for someone who chose hours to approve', async () => {
    stubApi();
    renderRoutes([page(<MyDayPage />)], '/', user(everything, 'lead'));
    await greeting();
    expect(await screen.findByRole('heading', { name: 'Hours to review' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open time entries' })).toHaveAttribute('href', '/time/entries');
    expect(screen.getByText('Hours to approve, your team and what needs attention.')).toBeInTheDocument();
  });

  it('follows a new choice at once and saves it on its own request, one after another', async () => {
    const fetch = stubApi();
    renderRoutes([page(<MyDayPage />)], '/', user(everything));
    await greeting(); await screen.findByRole('link', { name: /July 2026/i });
    await userEvent.click(within(layouts()).getByRole('radio', { name: 'Billing' }));
    expect(within(layouts()).getByRole('radio', { name: 'Billing' })).toBeChecked();
    const list = titles();
    expect(list.indexOf('Billing')).toBeLessThan(list.indexOf('My tasks'));
    // The arrow keys move the choice, as in any group of radio buttons.
    await userEvent.keyboard('{ArrowLeft}');
    expect(within(layouts()).getByRole('radio', { name: 'Hours to approve' })).toBeChecked();
    expect(await screen.findByRole('heading', { name: 'Hours to review' })).toBeVisible();
    await waitFor(() => expect(saves(fetch)).toEqual([{ layout: 'finance' }, { layout: 'lead' }]));
    const [, init] = fetch.mock.calls.find(([url]) => url === layoutUrl)!;
    expect(init?.method).toBe('PUT');
    expect(screen.queryByText(/could not be saved/)).toBeNull();
  });

  it('puts back the layout saved before when the save fails, and says so', async () => {
    let fail!: () => void;
    stubApi(() => new Promise<Response>((resolve) => { fail = () => resolve(json({ detail: 'synthetic-private-error' }, 503)); }));
    renderRoutes([page(<MyDayPage />)], '/', user(everything, 'lead'));
    await greeting();
    await userEvent.click(within(layouts()).getByRole('radio', { name: 'Billing' }));
    expect(within(layouts()).getByRole('radio', { name: 'Billing' })).toBeChecked();
    await act(async () => fail());
    expect(await screen.findByText('Your choice could not be saved, so My day shows the previous layout. Try again.')).toBeVisible();
    expect(within(layouts()).getByRole('radio', { name: 'Hours to approve' })).toBeChecked();
    expect(screen.getByRole('heading', { name: 'Hours to review' })).toBeVisible();
    expect(screen.queryByText(/synthetic-private/)).toBeNull();
  });

  it('offers no choice to someone for whom every layout would look the same', async () => {
    stubApi();
    renderRoutes([page(<MyDayPage />)], '/', user(['activities.read', 'customers.read', 'service.read'], 'finance'));
    await greeting();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.getByText('Your organizations and what needs attention.')).toBeInTheDocument();
  });
});
