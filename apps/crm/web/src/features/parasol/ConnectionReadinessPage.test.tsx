import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { localReadiness } from '../../test/localReadiness';
import { CurrentUserContext } from '../../auth/CurrentUserContext';
import { ConnectionReadinessPage } from './ConnectionReadinessPage';

const permissions = ['parasol.atlas.read', 'integrations.manage', 'customers.read'];
const personal = { atlasRead: true, integrationsManage: false, customersRead: true };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const render = (allowed = permissions) => renderRoutes([page(<ConnectionReadinessPage />)], '/connections', testUser(allowed));
afterEach(() => vi.unstubAllGlobals());

describe('read-only Connections page', () => {
  it('does not request readiness without either permitted role', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); render(['customers.read']);
    expect(screen.queryByRole('heading', { name: 'Connection readiness' })).not.toBeInTheDocument(); expect(fetch).not.toHaveBeenCalled();
  });
  it('gives a technician only personal configuration presence and an explicit unverified boundary', async () => {
    const fetch = vi.fn(async () => response(localReadiness(personal))); vi.stubGlobal('fetch', fetch); render(['parasol.atlas.read', 'customers.read']);
    expect(await screen.findByText('Personal entry present')).toBeVisible();
    expect(screen.getByText('Connections and credentials have not been checked.')).toBeVisible();
    expect(screen.getByText(/Atlas was not contacted/)).toBeVisible(); expect(screen.queryByRole('region', { name: 'Saved administrative configuration' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open integration administration' })).not.toBeInTheDocument();
    fireEvent(document, new Event('visibilitychange')); fireEvent(window, new Event('online')); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['DISABLED', 'PERSONAL_ENTRY_MISSING'] as const)('renders the personal %s state without implying invalid credentials', async status => {
    const value = localReadiness(personal); value.personalAtlas!.status = status;
    vi.stubGlobal('fetch', vi.fn(async () => response(value))); render(['parasol.atlas.read', 'customers.read']);
    expect(await screen.findByText(status === 'DISABLED' ? 'Atlas disabled locally' : 'Personal entry missing')).toBeVisible();
    expect(screen.getByText(/does not confirm credential validity/)).toBeVisible();
  });
  it('separates administrative flags, historical Graph records and Worker credentials from connectivity', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(localReadiness()))); render();
    expect(await screen.findByRole('region', { name: 'Saved administrative configuration' })).toBeVisible();
    expect(screen.getByText(/held by the background service, so this page cannot see whether they are set/)).toBeVisible();
    expect(screen.getByText(/Signing in through Microsoft 365 or Entra does not establish technical tenant monitoring/)).toBeVisible();
    expect(within(screen.getByRole('region', { name: 'Microsoft Graph' })).getByText(/may be historical/)).toBeVisible();
    expect(screen.getByText('Configuration unknown here')).toBeVisible(); expect(screen.getByText(/Huntress is managed in Atlas/)).toBeVisible();
    const mapping = within(screen.getByRole('region', { name: 'Stored Atlas mappings' }));
    expect(mapping.getByText('Stored links examined: 2 of 2 (limit 500)')).toBeVisible();
    expect(mapping.getByText(/Source validity has not been checked/)).toBeVisible();
    expect(screen.getAllByRole('button')).toHaveLength(1); expect(screen.getByRole('button', { name: 'Refresh local readiness' })).toBeVisible();
  });
  it('does not salvage unexpected administrative data in a personal response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(localReadiness()))); render(['parasol.atlas.read', 'customers.read']);
    expect(await screen.findByText('The local readiness response was invalid. No unverified details are shown.')).toBeVisible();
    expect(screen.queryByText('Personal entry present')).not.toBeInTheDocument(); expect(screen.queryByText('Atera')).not.toBeInTheDocument();
  });
  it('labels bounded mapping coverage and unavailable saved metadata without substituting healthy zeroes', async () => {
    const value = localReadiness(); value.status = 'PARTIAL'; value.admin!.atera.stored = null; const m = value.admin!.atlasMappings!;
    m.status = 'INCOMPLETE'; m.reviewStatus = 'REQUIRED'; m.coverage = { storedLinks: 501, examinedLinks: 500, omittedLinks: 1, unlinkedStoredReferences: 2 }; m.counts!.validLinks = 500;
    vi.stubGlobal('fetch', vi.fn(async () => response(value))); render();
    expect(await screen.findByText('Stored links examined: 500 of 501 (limit 500)')).toBeVisible();
    expect(screen.getByText('Local review incomplete')).toBeVisible(); expect(screen.getByText(/not a connection-health result/)).toBeVisible();
    expect(within(screen.getByRole('region', { name: 'Atera' })).getByText(/Saved local state could not be read/)).toBeVisible();
  });
  it.each(['CHANGED', 'UNAVAILABLE'] as const)('clears previous mapping counts when the registry becomes %s', async status => {
    let changed = false;
    vi.stubGlobal('fetch', vi.fn(async () => {
      const value = localReadiness(); if (changed) { value.status = 'PARTIAL'; const m = value.admin!.atlasMappings!; m.status = status; m.reviewStatus = 'UNKNOWN'; m.coverage = null; m.counts = null; } return response(value);
    }));
    render(); await screen.findByText('Stored links examined: 2 of 2 (limit 500)'); changed = true;
    await userEvent.click(screen.getByRole('button', { name: 'Refresh local readiness' }));
    expect(await screen.findByText('Mapping review is unknown. No previous counts are shown.')).toBeVisible();
    expect(screen.queryByText('Stored links examined: 2 of 2 (limit 500)')).not.toBeInTheDocument();
  });
  it('hides old details during a keyboard refresh, keeps focus, and refuses repeated activation', async () => {
    let finish!: (r: Response) => void; let reads = 0;
    const fetch = vi.fn(async () => ++reads === 1 ? response(localReadiness()) : new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal('fetch', fetch); render(); await screen.findByText('Personal entry present');
    const refresh = screen.getByRole('button', { name: 'Refresh local readiness' }); refresh.focus(); await userEvent.keyboard('{Enter}');
    expect(refresh).toHaveFocus(); expect(refresh).toHaveAttribute('aria-disabled', 'true'); expect(screen.queryByText('Personal entry present')).not.toBeInTheDocument();
    await userEvent.keyboard('{Enter} '); fireEvent.click(refresh); expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => finish(response(localReadiness()))); expect(await screen.findByText('Personal entry present')).toBeVisible(); expect(refresh).toHaveFocus();
  });
  it.each([403, 503])('removes previous details after HTTP%s and does not display private error text', async status => {
    let fail = false; const fetch = vi.fn(async () => fail ? response({ detail: 'synthetic-private-error' }, status) : response(localReadiness()));
    vi.stubGlobal('fetch', fetch); render(); await screen.findByText('Personal entry present'); fail = true;
    await userEvent.click(screen.getByRole('button', { name: 'Refresh local readiness' })); await screen.findByRole('status');
    expect(screen.queryByText('Personal entry present')).not.toBeInTheDocument(); expect(screen.queryByText('Atera')).not.toBeInTheDocument();
    expect(screen.queryByText(/synthetic-private/)).not.toBeInTheDocument(); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each(['employee', 'permissions'] as const)('aborts and ignores a late administrative reply after changing %s', async change => {
    let finish!: (r: Response) => void; let signal: AbortSignal | undefined; let reads = 0;
    vi.stubGlobal('fetch', vi.fn((_: string, init: RequestInit) => {
      if (++reads === 1) { signal = init.signal as AbortSignal; return new Promise<Response>(resolve => { finish = resolve; }); }
      return Promise.resolve(response(localReadiness(personal)));
    }));
    function ChangeAuthority() {
      const [user, setUser] = useState(testUser(permissions));
      return <CurrentUserContext.Provider value={user}><button onClick={() => setUser(change === 'employee'
        ? { ...testUser(['parasol.atlas.read', 'customers.read']), id: 'other-employee' } : testUser(['parasol.atlas.read', 'customers.read']))}>Change authority</button><ConnectionReadinessPage /></CurrentUserContext.Provider>;
    }
    renderRoutes([page(<ChangeAuthority />)], '/connections', testUser(permissions)); await waitFor(() => expect(signal).toBeDefined());
    await userEvent.click(screen.getByRole('button', { name: 'Change authority' })); expect(signal!.aborted).toBe(true);
    expect(await screen.findByText('Personal entry present')).toBeVisible(); await act(async () => finish(response(localReadiness())));
    expect(screen.queryByText('Atera')).not.toBeInTheDocument(); expect(screen.queryByRole('region', { name: 'Saved administrative configuration' })).not.toBeInTheDocument(); expect(reads).toBe(2);
  });
});
