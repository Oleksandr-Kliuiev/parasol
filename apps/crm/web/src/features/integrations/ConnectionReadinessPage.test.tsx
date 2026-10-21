import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { localReadiness } from '../../test/localReadiness';
import { CurrentUserContext } from '../../auth/CurrentUserContext';
import { ConnectionReadinessPage } from './ConnectionReadinessPage';

const permissions = ['integrations.manage'];
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const render = (allowed = permissions) => renderRoutes([page(<ConnectionReadinessPage />)], '/connections', testUser(allowed));
const admin = 'Saved administrative configuration';
afterEach(() => vi.unstubAllGlobals());

describe('read-only Connections page', () => {
  it.each([[['customers.read']], [['customers.read', 'service.read', 'activities.read']]])(
    'does not request readiness without integration administration (%j)', async allowed => {
      const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); render(allowed);
      expect(await screen.findByRole('heading', { name: 'No access' })).toBeVisible();
      expect(screen.queryByRole('heading', { name: 'Connection readiness' })).not.toBeInTheDocument(); expect(fetch).not.toHaveBeenCalled();
    });
  it('separates administrative flags, historical Graph records and Worker credentials from connectivity', async () => {
    const fetch = vi.fn(async () => response(localReadiness())); vi.stubGlobal('fetch', fetch); render();
    expect(await screen.findByRole('region', { name: admin })).toBeVisible();
    expect(screen.getByText('Connections and credentials have not been checked.')).toBeVisible();
    expect(screen.getByText(/held by the background service, so this page cannot see whether they are set/)).toBeVisible();
    expect(screen.getByText(/Signing in through Microsoft 365 or Entra does not establish technical tenant monitoring/)).toBeVisible();
    expect(within(screen.getByRole('region', { name: 'Microsoft Graph' })).getByText(/may be historical/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open integration administration' })).toHaveAttribute('href', '/admin/integrations');
    // The four local cards and nothing else: no section about a system this page does not read.
    expect(screen.getAllByRole('region')).toHaveLength(4);
    for (const name of [admin, 'Atera', 'PowerOffice', 'Microsoft Graph']) expect(screen.getByRole('region', { name })).toBeVisible();
    expect(screen.getAllByRole('button')).toHaveLength(1); expect(screen.getByRole('button', { name: 'Refresh local readiness' })).toBeVisible();
    fireEvent(document, new Event('visibilitychange')); fireEvent(window, new Event('online')); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('labels unavailable saved metadata without substituting healthy zeroes', async () => {
    const value = localReadiness(); value.status = 'PARTIAL';
    value.admin.atera.stored = null; value.admin.powerOffice.stored = null; value.admin.microsoftGraph.stored = null;
    vi.stubGlobal('fetch', vi.fn(async () => response(value))); render();
    expect(await screen.findByText(/not a connection-health result/)).toBeVisible();
    for (const name of ['Atera', 'PowerOffice', 'Microsoft Graph'])
      expect(within(screen.getByRole('region', { name })).getByText(/Saved local state could not be read/)).toBeVisible();
    expect(screen.queryByText('Stored external records')).not.toBeInTheDocument();
  });
  it('does not salvage a response with an unexpected section', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ ...localReadiness(), personal: { status: 'PRESENT' } }))); render();
    expect(await screen.findByText('The local readiness response was invalid. No unverified details are shown.')).toBeVisible();
    expect(screen.queryByRole('region', { name: admin })).not.toBeInTheDocument(); expect(screen.queryByText('Atera')).not.toBeInTheDocument();
  });
  it('hides old details during a keyboard refresh, keeps focus, and refuses repeated activation', async () => {
    let finish!: (r: Response) => void; let reads = 0;
    const fetch = vi.fn(async () => ++reads === 1 ? response(localReadiness()) : new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal('fetch', fetch); render(); await screen.findByRole('region', { name: admin });
    const refresh = screen.getByRole('button', { name: 'Refresh local readiness' }); refresh.focus(); await userEvent.keyboard('{Enter}');
    expect(refresh).toHaveFocus(); expect(refresh).toHaveAttribute('aria-disabled', 'true'); expect(screen.queryByRole('region', { name: admin })).not.toBeInTheDocument();
    await userEvent.keyboard('{Enter} '); fireEvent.click(refresh); expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => finish(response(localReadiness()))); expect(await screen.findByRole('region', { name: admin })).toBeVisible(); expect(refresh).toHaveFocus();
  });
  it.each([403, 503])('removes previous details after HTTP%s and does not display private error text', async status => {
    let fail = false; const fetch = vi.fn(async () => fail ? response({ detail: 'synthetic-private-error' }, status) : response(localReadiness()));
    vi.stubGlobal('fetch', fetch); render(); await screen.findByRole('region', { name: admin }); fail = true;
    await userEvent.click(screen.getByRole('button', { name: 'Refresh local readiness' })); await screen.findByRole('status');
    expect(screen.queryByRole('region', { name: admin })).not.toBeInTheDocument(); expect(screen.queryByText('Atera')).not.toBeInTheDocument();
    expect(screen.queryByText(/synthetic-private/)).not.toBeInTheDocument(); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each(['employee', 'permissions'] as const)('aborts and ignores a late reply after changing %s', async change => {
    let finish!: (r: Response) => void; let signal: AbortSignal | undefined; let reads = 0;
    const current = localReadiness(); current.admin.authMode = 'DEVELOPMENT';
    vi.stubGlobal('fetch', vi.fn((_: string, init: RequestInit) => {
      if (++reads === 1) { signal = init.signal as AbortSignal; return new Promise<Response>(resolve => { finish = resolve; }); }
      return Promise.resolve(response(current));
    }));
    function ChangeAuthority() {
      const [user, setUser] = useState(testUser(permissions));
      return <CurrentUserContext.Provider value={user}><button onClick={() => setUser(change === 'employee'
        ? { ...testUser(permissions), id: 'other-employee' } : testUser(['customers.read']))}>Change authority</button><ConnectionReadinessPage /></CurrentUserContext.Provider>;
    }
    renderRoutes([page(<ChangeAuthority />)], '/connections', testUser(permissions)); await waitFor(() => expect(signal).toBeDefined());
    await userEvent.click(screen.getByRole('button', { name: 'Change authority' })); expect(signal!.aborted).toBe(true);
    if (change === 'employee') expect(await screen.findByText('Local development sign-in')).toBeVisible();
    else expect(await screen.findByRole('heading', { name: 'No access' })).toBeVisible();
    await act(async () => finish(response(localReadiness())));
    expect(screen.queryByText('Microsoft Entra')).not.toBeInTheDocument(); expect(reads).toBe(change === 'employee' ? 2 : 1);
  });
});
