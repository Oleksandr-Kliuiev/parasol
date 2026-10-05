import { afterEach, describe, expect, it, vi } from 'vitest';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderRoutes, testUser } from '../../test/renderWithProviders';
import { MonitoringPanel } from './MonitoringPanel';
import { OutboundPanel } from './SystemsPanels';
import type { MonitoringOverview } from './monitoringApi';

configure({ defaultHidden: true });
const base = '/api/v1/integrations/monitoring';
const overview: MonitoringOverview = {
  recoveredTotalCount: 0,
  checkedAt: '2026-10-04T12:00:00Z',
  systems: [{ system: 'atera', job: 'atera-tickets', enabled: true, paused: false,
    lastRunAt: '2026-10-04T11:59:00Z', lastRunStatus: 'Failed', lastSucceededAt: '2026-10-04T10:00:00Z',
    ageMinutes: 120, thresholdMinutes: 15, freshness: 'Stale', failedOutbound: 0, unmapped: 0 }],
  exceptions: [{ active: true, key: 'sync-stale:atera:atera-tickets', category: 'Integration', source: 'atera', kind: 'SyncStale',
    detectedAt: '2026-10-04T10:00:00Z', lastSucceededAt: '2026-10-04T10:00:00Z', ageMinutes: 120, thresholdMinutes: 15,
    count: 1, impact: 'SyncStale', runbook: 'docs/runbooks/15-monitoring.md',
    triage: { ownerId: null, ownerName: null, status: 'Open', comment: null, etag: '"new"' } }],
};
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
function renderMonitoring(permissions = ['integrations.manage']) {
  return renderRoutes([{ path: '/admin', element: <MonitoringPanel /> }], '/admin', testUser(permissions));
}

describe('Monitoring workbench', () => {
  it('shows success-based freshness, filters and a saved view without putting case notes in browser storage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(overview))));
    const user = userEvent.setup();
    renderMonitoring();
    expect(await screen.findByText('Age: 120 min · limit: 15 min')).toBeInTheDocument();
    expect(screen.getByText('Stale')).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Category' }), 'Financial');
    expect(screen.getByText('No exceptions match these filters.')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'View name' }), 'Finance review');
    await user.click(screen.getByRole('button', { name: 'Save current view' }));
    expect(JSON.parse(localStorage.getItem('crm.monitoring.views.u1')!)).toEqual([{ name: 'Finance review', filters: { category: 'Financial', source: '', status: '', owner: '' } }]);
    await user.click(screen.getByRole('button', { name: 'Reset filters' }));
    expect(screen.getByText('Stale source data')).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Saved views' }), 'Finance review');
    expect(screen.getByText('No exceptions match these filters.')).toBeInTheDocument();
  }, 20_000);

  it('assigns a case with its etag and keeps the comment visible when another operator changed it', async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') return new Response(JSON.stringify({ code: 'MONITORING_TRIAGE_STALE', status: 412 }), { status: 412 });
      if (url.startsWith('/api/v1/identity/users')) return new Response(JSON.stringify({ items: [], nextCursor: null, totalCount: 0 }));
      return new Response(JSON.stringify(overview));
    });
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();
    renderMonitoring();
    await user.click(await screen.findByRole('button', { name: 'Review exception' }));
    const dialog = (await screen.findByText('Review: Atera')).closest<HTMLElement>('[role="dialog"]')!;
    await user.click(within(dialog).getByRole('button', { name: 'Assign to me' }));
    expect(within(dialog).getByRole('combobox', { name: 'Owner' })).toHaveValue('Kari Nordmann');
    expect(within(dialog).getByRole('option', { name: 'Resolved' })).toBeDisabled();
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Review status' }), 'InProgress');
    await user.click(within(dialog).getByRole('textbox', { name: 'Comment' }));
    await user.paste('Worker restart verified');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true));
    const sent = fetch.mock.calls.find(([, init]) => init?.method === 'PUT')![1]!;
    expect(JSON.parse(String(sent.body))).toEqual({ key: overview.exceptions[0]!.key, ownerId: 'u1', status: 'InProgress', comment: 'Worker restart verified' });
    expect(sent.headers).toMatchObject({ 'If-Match': '"new"', 'X-CSRF': '1' });
    expect(within(dialog).getByRole('textbox', { name: 'Comment' })).toHaveValue('Worker restart verified');
  }, 20_000);

  it('keeps a recovered exception available until its review is resolved', async () => {
    const recovered = { ...overview, recoveredTotalCount: 1, exceptions: overview.exceptions.map((e) => ({ ...e, active: false, triage: { ...e.triage, status: 'InProgress', etag: '"v2"' } })) };
    let resolved = false;
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        resolved = true;
        return new Response(JSON.stringify({ ...recovered.exceptions[0]!.triage, status: 'Resolved', etag: '"v3"' }));
      }
      if (url.startsWith('/api/v1/identity/users')) return new Response(JSON.stringify({ items: [], nextCursor: null, totalCount: 0 }));
      return new Response(JSON.stringify(resolved ? { ...overview, exceptions: [] } : recovered));
    });
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();
    renderMonitoring();
    expect(await screen.findByText('Source recovered — review pending')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Review exception' }));
    const dialog = (await screen.findByText('Review: Atera')).closest<HTMLElement>('[role="dialog"]')!;
    expect(within(dialog).getByRole('option', { name: 'Resolved' })).toBeEnabled();
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Review status' }), 'Resolved');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('No exceptions match these filters.')).toBeInTheDocument();
    const sent = fetch.mock.calls.find(([, init]) => init?.method === 'PUT')![1]!;
    expect(JSON.parse(String(sent.body))).toMatchObject({ status: 'Resolved' });
    expect(sent.headers).toMatchObject({ 'If-Match': '"v2"' });
  }, 20_000);

  it('discloses the full count when recovered exceptions are bounded by the server', async () => {
    const limited = { ...overview, recoveredTotalCount: 250, exceptions: [{ ...overview.exceptions[0]!, active: false }] };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(limited))));
    renderMonitoring();
    expect(await screen.findByText('1 of 250 exceptions shown')).toBeInTheDocument();
    expect(screen.getByText(/The list includes the 1 most recently reviewed recovered exceptions out of 250/)).toBeInTheDocument();
  });

  it('does not request monitoring for a user without permission', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    renderMonitoring([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByText('Monitoring and exception review')).not.toBeInTheDocument();
  });

  it('confirms the exact outbound selection and sends a reason with bounded bulk retry', async () => {
    let body: unknown;
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === `${base}/outbound/retry` && init?.method === 'POST') {
        body = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ items: [{ id: 'o1', status: 'Requested' }] }), { status: 202 });
      }
      return new Response(JSON.stringify({ items: [{ id: 'o1', etag: '"v1"', system: 'poweroffice', operation: 'update-customer', entityType: 'Organization', entityId: 'org1', status: 'DeadLetter', attempts: 10, createdAt: '2026-10-04T10:00:00Z', nextAttemptAt: '2026-10-04T11:00:00Z', completedAt: null, lastError: null, result: null }], nextCursor: null, totalCount: 1 }));
    });
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();
    renderRoutes([{ path: '/admin', element: <OutboundPanel /> }], '/admin', testUser(['integrations.manage']));
    await user.click(await screen.findByRole('checkbox', { name: 'Select operation o1' }));
    await user.click(screen.getByRole('button', { name: 'Retry selected (1)' }));
    const dialog = (await screen.findByText('Retry 1 operations?')).closest<HTMLElement>('[role="dialog"]')!;
    expect(within(dialog).getByRole('list', { name: 'Exact selection' })).toHaveTextContent('o1');
    expect(within(dialog).getByRole('button', { name: 'Retry 1 operations' })).toBeDisabled();
    await user.click(within(dialog).getByRole('textbox', { name: /Reason/ }));
    await user.paste('External outcome verified');
    await user.click(within(dialog).getByRole('button', { name: 'Retry 1 operations' }));
    await waitFor(() => expect(body).toEqual({ messages: [{ id: 'o1', etag: '"v1"' }], expected: 1, reason: 'External outcome verified' }));
    expect(await screen.findByText('o1: Requested')).toBeInTheDocument();
  }, 20_000);
});

it('shows stale outbound results inside the open confirmation dialog', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === `${base}/outbound/retry` && init?.method === 'POST') return new Response(JSON.stringify({ code: 'MONITORING_RETRY_STALE', items: [{ id: 'o1', status: 'Stale' }] }), { status: 409 });
    return new Response(JSON.stringify({ items: [{ id: 'o1', etag: '"v1"', system: 'poweroffice', operation: 'update-customer', status: 'DeadLetter', createdAt: '2026-10-04T10:00:00Z' }], nextCursor: null, totalCount: 1 }));
  }));
  const user = userEvent.setup();
  renderRoutes([{ path: '/admin', element: <OutboundPanel /> }], '/admin', testUser(['integrations.manage']));
  await user.click(await screen.findByRole('button', { name: 'Retry' }));
  const dialog = (await screen.findByText('Retry 1 operations?')).closest<HTMLElement>('[role="dialog"]')!;
  await user.click(within(dialog).getByRole('textbox', { name: /Reason/ }));
  await user.paste('External outcome verified');
  await user.click(within(dialog).getByRole('button', { name: 'Retry 1 operations' }));
  expect(await within(dialog).findByRole('list', { name: 'Results by operation' })).toHaveTextContent('o1: Changed since selection');
  expect(within(dialog).getByRole('textbox', { name: /Reason/ })).toHaveValue('External outcome verified');
}, 20_000);
