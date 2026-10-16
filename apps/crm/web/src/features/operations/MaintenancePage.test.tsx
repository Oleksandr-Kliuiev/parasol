import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toaster } from '@fluentui/react-components';
import { TOASTER_ID } from '../../app/toaster';
import { renderRoutes, testUser } from '../../test/renderWithProviders';
import { MaintenanceBanner } from './MaintenanceBanner';
import { MaintenancePage } from './MaintenancePage';
import type { MaintenanceStatus, RestoreReport } from './api';

const readOnly: MaintenanceStatus = {
  mode: 'ReadOnly',
  reason: 'Restore drill of the billing database',
  reference: 'CHG-42',
  setBy: 'Kari Nordmann (u1)',
  since: '2026-10-04T08:00:00Z',
  key: 'operations/maintenance/20261004T080000Z-a.json',
  forced: false,
  inFlight: [
    { area: 'outbox', count: 0 },
    { area: 'integrations', count: 2 },
  ],
};

const report = (applied: boolean): RestoreReport => ({
  id: applied ? 'r2' : 'r1',
  at: '2026-10-04T08:30:00Z',
  restorePoint: '2026-10-04T06:30:00Z',
  applied,
  by: 'Kari Nordmann (u1)',
  maintenanceKey: readOnly.key,
  effects: 4,
  checks: [{ area: 'database', subject: 'schema', finding: 'Every module schema matches this build.', action: null, needsPerson: false }],
  reconciliation: [
    {
      area: 'billing',
      subject: 'basis b1',
      finding: 'PowerOffice created order 88301 for this basis; the restored copy still has it waiting to be sent.',
      action: applied ? 'Held for reconciliation: Finance confirms the order in PowerOffice.' : 'Would be held for reconciliation.',
      needsPerson: true,
    },
  ],
});

function stubFetch(status: MaintenanceStatus) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    if (url === '/api/v1/operations/maintenance' && method === 'PUT') {
      return new Response(JSON.stringify({ ...status, mode: body.mode, reason: body.reason, key: 'operations/maintenance/next.json' }), { status: 200 });
    }
    if (url === '/api/v1/operations/maintenance') return new Response(JSON.stringify(status), { status: 200 });
    if (url === '/api/v1/operations/restore/reconcile') return new Response(JSON.stringify(report(body.apply)), { status: 200 });
    if (url === '/api/v1/operations/restore/reports') return new Response(JSON.stringify([]), { status: 200 });
    if (url === '/bff/maintenance') return new Response(JSON.stringify({ mode: status.mode, since: status.since, reason: status.reason }), { status: 200 });
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetch);
  return calls;
}

function render() {
  renderRoutes(
    [{ path: '/admin/maintenance', element: <><Toaster toasterId={TOASTER_ID} /><MaintenanceBanner /><MaintenancePage /></> }],
    '/admin/maintenance',
    testUser(['operations.maintenance']),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('MaintenancePage (DEV-13)', () => {
  it('shows the decision, what is still under way, and the banner everyone sees', async () => {
    stubFetch(readOnly);
    render();

    expect(await screen.findByText('Read-only maintenance')).toBeInTheDocument();
    expect(screen.getByText('Reason: Restore drill of the billing database')).toBeInTheDocument();
    expect(screen.getByText('Read-only')).toBeInTheDocument();
    expect(screen.getByText('CHG-42')).toBeInTheDocument();
    expect(screen.getByText('Integrations')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('returns to normal operation only after a reason and a confirmation, naming the decision it replaces', async () => {
    const calls = stubFetch(readOnly);
    const user = userEvent.setup();
    render();

    const button = await screen.findByRole('button', { name: 'Return to normal operation' });
    expect(button).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: /^Reason/ }), 'Restore verified by Finance');
    await user.click(button);
    await user.click(await screen.findByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
      mode: 'Normal',
      reason: 'Restore verified by Finance',
      reference: null,
      expectedKey: readOnly.key,
    });
  });

  it('applies a reconciliation only after a dry run for the same restore point', async () => {
    const calls = stubFetch(readOnly);
    const user = userEvent.setup();
    render();

    const apply = await screen.findByRole('button', { name: 'Apply' });
    expect(apply).toBeDisabled();
    await user.type(screen.getByLabelText(/Restore point \(UTC\)/), '2026-10-04T06:30:00');
    await user.click(screen.getByRole('button', { name: 'Dry run' }));

    expect(await screen.findByText(/PowerOffice created order 88301/)).toBeInTheDocument();
    expect(screen.getByText('Would be held for reconciliation.')).toBeInTheDocument();
    expect(calls.find((c) => c.url === '/api/v1/operations/restore/reconcile')!.body).toEqual({
      restorePoint: '2026-10-04T06:30:00.000Z',
      apply: false,
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    const confirm = await screen.findAllByRole('button', { name: 'Apply' });
    await user.click(confirm[confirm.length - 1]!);

    expect(await screen.findByText('Held for reconciliation: Finance confirms the order in PowerOffice.')).toBeInTheDocument();
    expect(calls.filter((c) => c.url === '/api/v1/operations/restore/reconcile').map((c) => (c.body as { apply: boolean }).apply)).toEqual([false, true]);
  });

  it('does not reconcile in normal operation', async () => {
    stubFetch({ ...readOnly, mode: 'Normal', reason: null, since: null, key: null, inFlight: [{ area: 'outbox', count: 0 }] });
    const user = userEvent.setup();
    render();

    expect(await screen.findByText('Switch to read-only first: reconciling while the worker sends would race with it.')).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Restore point \(UTC\)/), '2026-10-04T06:30:00');
    expect(screen.getByRole('button', { name: 'Dry run' })).toBeDisabled();
    expect(screen.queryByText('Read-only maintenance')).not.toBeInTheDocument();
    expect(screen.getByText('Nothing is under way.')).toBeInTheDocument();
  });
});
