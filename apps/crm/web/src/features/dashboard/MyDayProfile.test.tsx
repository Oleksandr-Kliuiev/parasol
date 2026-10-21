import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { MyDayPage } from './MyDayPage';
import { myDayProfile } from './myDayProfile';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

function stubApi() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/v1/billing/runs')) {
      return json({
        items: [{ id: 'r1', periodStart: '2026-07-01', periodEnd: '2026-07-31', kind: 'Regular', status: 'InReview', organizations: 12, withAnomalies: 0,
          requiresSecondApproval: false, collectedAt: '2026-08-01T08:00:00Z', approvedAt: null, exportedAt: null, closedAt: null }],
        nextCursor: null, totalCount: 1,
      });
    }
    if (url.startsWith('/api/v1/billing/invoices')) return json({ count: 0, invoices: [], nextCursor: null, asOf: '2026-10-04' });
    return json({ items: [], nextCursor: null, totalCount: 0 });
  }));
}

describe('myDayProfile', () => {
  it.each([
    [[], 'work'],
    [['activities.read', 'time.own', 'service.read'], 'work'],
    [['billing.read', 'finance.read', 'sales.write'], 'work'],
    [['time.manage', 'time.read'], 'lead'],
    [['billing.manage'], 'finance'],
    [['billing.approve.second'], 'finance'],
    [['billing.manage', 'time.manage'], 'finance'],
  ])('%j gets the %s layout', (permissions, profile) => {
    expect(myDayProfile(permissions)).toBe(profile);
  });
});

describe('My day by role', () => {
  const titles = () => screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);

  it('puts billing before tasks for someone who runs billing', async () => {
    stubApi();
    renderRoutes([page(<MyDayPage />)], '/', testUser(['billing.read', 'billing.manage', 'finance.read', 'activities.read', 'customers.read']));
    await screen.findByRole('heading', { name: /^Good (morning|afternoon|evening), Kari$/ });
    await screen.findByRole('link', { name: /July 2026/i });
    const list = titles();
    expect(list.indexOf('Billing')).toBeGreaterThanOrEqual(0);
    expect(list.indexOf('Billing')).toBeLessThan(list.indexOf('My tasks'));
    expect(screen.getByText('Billing, overdue invoices and what needs attention.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Hours to review' })).toBeNull();
  });

  it('adds the hours review on the side for someone who approves hours', async () => {
    stubApi();
    renderRoutes([page(<MyDayPage />)], '/', testUser(['time.manage', 'time.read', 'activities.read', 'customers.read']));
    await screen.findByRole('heading', { name: /^Good (morning|afternoon|evening), Kari$/ });
    const list = titles();
    expect(list).toContain('My tasks');
    expect(list).toContain('Hours to review');
    expect(screen.getByRole('link', { name: 'Open time entries' })).toHaveAttribute('href', '/time/entries');
  });

  it('shows no hours review and the default subtitle to everybody else', async () => {
    stubApi();
    renderRoutes([page(<MyDayPage />)], '/', testUser(['activities.read', 'customers.read']));
    await screen.findByRole('heading', { name: /^Good (morning|afternoon|evening), Kari$/ });
    expect(screen.queryByRole('heading', { name: 'Hours to review' })).toBeNull();
    expect(screen.getByText('Your organizations and what needs attention.')).toBeInTheDocument();
  });
});
