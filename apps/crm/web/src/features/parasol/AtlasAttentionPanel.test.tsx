import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { atlasAttention, attentionCustomerId } from '../../test/atlasAttention';
import { invalidTaskPreview } from './observationTaskContract';
import { CurrentUserContext } from '../../auth/CurrentUserContext';
import { MyDayPage } from '../dashboard/MyDayPage';
import { AtlasAttentionPanel } from './AtlasAttentionPanel';

const permissions = ['customers.read', 'parasol.atlas.read', 'activities.read', 'activities.write', 'users.read'];
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const render = (allowed = permissions) => renderRoutes([page(<AtlasAttentionPanel />)], '/', testUser(allowed));
const region = () => within(screen.getByRole('region', { name: 'Technical attention · Atlas' }));
afterEach(() => vi.unstubAllGlobals());

describe('personal Atlas attention in My day', () => {
  it.each([[], ['customers.read'], ['parasol.atlas.read'], ['activities.write']].map(allowed => ({ allowed })))('does not mount or read without both customer and Atlas permissions ($allowed)', ({ allowed }) => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); render(allowed);
    expect(screen.queryByRole('region', { name: 'Technical attention · Atlas' })).not.toBeInTheDocument(); expect(fetch).not.toHaveBeenCalled();
  });

  it('groups bounded urgent previews with full selected counts and explicit coverage gaps', async () => {
    const fetch = vi.fn(async () => response(atlasAttention())); vi.stubGlobal('fetch', fetch); render();
    expect(await screen.findByText('Customers read successfully: 1 of 2 selected')).toBeVisible();
    expect(region().getByText('Active observations in successfully read customers: 9 · High: 4 · Critical: 2')).toBeVisible();
    expect(region().getByText(/Coverage is incomplete/)).toBeVisible();
    expect(region().getByText(/not a complete queue or a global ranking/)).toBeVisible();
    const customer = within(region().getByRole('region', { name: 'Synthetic attention customer' }));
    expect(customer.getByText('Urgent preview: 3 of 6 active HIGH/CRITICAL observations')).toBeVisible();
    expect(customer.getAllByRole('listitem')).toHaveLength(3);
    expect(within(customer.getAllByRole('listitem')[0]!).getByText('Atlas recommendation: Monitor')).toBeVisible();
    expect(customer.getAllByText('Urgent · HIGH / CRITICAL')).toHaveLength(3);
    expect(customer.getByRole('link', { name: 'Open customer workspace' })).toHaveAttribute('href', `/organizations/${attentionCustomerId}`);
    await userEvent.click(customer.getByText('Source coverage and freshness', { exact: true }));
    expect(customer.getByText('Outdated snapshot')).toBeVisible(); expect(customer.getByText('No snapshot')).toBeVisible();
    const unavailable = within(region().getByRole('region', { name: 'Synthetic unavailable customer' }));
    expect(unavailable.getByText(/excluded from the observation totals/)).toBeVisible(); expect(unavailable.queryByRole('button', { name: 'Assign work' })).not.toBeInTheDocument();
    fireEvent(document, new Event('visibilitychange')); fireEvent(window, new Event('online'));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('renders zero urgent observations with stale sources without presenting a healthy customer', async () => {
    const value = atlasAttention(); const c = value.customers![0]!; c.high = 0; c.critical = 0; c.preview = []; c.devices = [];
    value.totals!.high = 0; value.totals!.critical = 0;
    vi.stubGlobal('fetch', vi.fn(async () => response(value))); render();
    expect(await screen.findByText(/Other observations or missing source data may still require attention/)).toBeVisible();
    expect(region().getByText('Active observations in successfully read customers: 9 · High: 0 · Critical: 0')).toBeVisible();
    expect(region().queryByRole('button', { name: 'Assign work' })).not.toBeInTheDocument();
  });

  it('allows read-only technical users to read attention without offering assignment', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(atlasAttention()))); render(['customers.read', 'parasol.atlas.read', 'activities.read']);
    expect(await screen.findByText('Synthetic disk capacity used: 97%')).toBeVisible();
    expect(region().queryByRole('button', { name: 'Assign work' })).not.toBeInTheDocument();
  });

  it('places technical attention above existing personal tasks in My day', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url.endsWith('/atlas-attention') ? atlasAttention() : { items: [], nextCursor: null, totalCount: 0 })));
    renderRoutes([page(<MyDayPage />)], '/', testUser(permissions));
    const attention = await screen.findByRole('region', { name: 'Technical attention · Atlas' });
    expect(attention.compareDocumentPosition(screen.getByRole('region', { name: 'My tasks' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('hides all previous rows immediately during refresh, then fails closed on source denial', async () => {
    let resolve!: (r: Response) => void; let reads = 0;
    const fetch = vi.fn(async () => ++reads === 1 ? response(atlasAttention()) : new Promise<Response>(r => { resolve = r; }));
    vi.stubGlobal('fetch', fetch); render(); await screen.findByText('Synthetic disk capacity used: 97%');
    await userEvent.click(region().getByRole('button', { name: 'Refresh technical attention' }));
    expect(screen.queryByText('Synthetic disk capacity used: 97%')).not.toBeInTheDocument();
    expect(screen.queryByText('Synthetic attention customer')).not.toBeInTheDocument();
    await act(async () => resolve(response({ ...atlasAttention(), status: 'ACCESS_DENIED', customers: null, totals: null })));
    expect(await screen.findByText(/Previous customer details have been removed/)).toBeVisible();
    expect(region().queryByText(/Active observations in successfully read customers/)).not.toBeInTheDocument(); expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retains keyboard focus while refresh is busy and ignores repeated activation until its response finishes', async () => {
    let finish!: (r: Response) => void; let reads = 0;
    const fetch = vi.fn(async () => ++reads === 1 ? response(atlasAttention()) : new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal('fetch', fetch); render(); await screen.findByText('Synthetic disk capacity used: 97%');
    const refresh = region().getByRole('button', { name: 'Refresh technical attention' }); refresh.focus();
    await userEvent.keyboard('{Enter}');
    expect(refresh).toHaveFocus(); expect(refresh).toHaveAttribute('aria-disabled', 'true'); expect(refresh).not.toBeDisabled();
    expect(screen.queryByText('Synthetic disk capacity used: 97%')).not.toBeInTheDocument();
    await userEvent.keyboard('{Enter} '); fireEvent.click(refresh);
    expect(fetch).toHaveBeenCalledTimes(2); expect(refresh).toHaveFocus();
    await act(async () => finish(response(atlasAttention())));
    expect(await screen.findByText('Synthetic disk capacity used: 97%')).toBeVisible();
    expect(refresh).not.toHaveAttribute('aria-disabled', 'true'); expect(refresh).toHaveFocus(); expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([403, 429, 503])('removes previous technical data after HTTP %s and never displays raw errors', async status => {
    let fail = false; const fetch = vi.fn(async () => fail ? response({ detail: 'synthetic-private-upstream-error' }, status) : response(atlasAttention()));
    vi.stubGlobal('fetch', fetch); render(); await screen.findByText('Synthetic disk capacity used: 97%'); fail = true;
    await userEvent.click(region().getByRole('button', { name: 'Refresh technical attention' }));
    await waitFor(() => expect(region().getByRole('status')).toBeVisible());
    expect(screen.queryByText('Synthetic disk capacity used: 97%')).not.toBeInTheDocument();
    expect(screen.queryByText(/synthetic-private/)).not.toBeInTheDocument(); expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects a changed response instead of retaining an earlier successful customer', async () => {
    let invalid = false; const fetch = vi.fn(async () => response(invalid ? { ...atlasAttention(), token: 'synthetic-private' } : atlasAttention()));
    vi.stubGlobal('fetch', fetch); render(); await screen.findByText('Synthetic disk capacity used: 97%'); invalid = true;
    await userEvent.click(region().getByRole('button', { name: 'Refresh technical attention' }));
    expect(await screen.findByText('The attention response was invalid. No unverified customer details are shown.')).toBeVisible();
    expect(screen.queryByText('Synthetic attention customer')).not.toBeInTheDocument(); expect(screen.queryByText(/synthetic-private/)).not.toBeInTheDocument();
  });

  it('aborts an old employee read and ignores its late response after the identity changes', async () => {
    let resolve!: (r: Response) => void; let firstSignal: AbortSignal | undefined; let reads = 0;
    vi.stubGlobal('fetch', vi.fn((_: string, init: RequestInit) => {
      if (++reads === 1) { firstSignal = init.signal as AbortSignal; return new Promise<Response>(r => { resolve = r; }); }
      return Promise.resolve(response({ ...atlasAttention(), status: 'ACCESS_DENIED', customers: null, totals: null }));
    }));
    function SwitchEmployee() {
      const [user, setUser] = useState(testUser(permissions));
      return <CurrentUserContext.Provider value={user}><button onClick={() => setUser({ ...user, id: 'another-employee' })}>Switch employee</button><AtlasAttentionPanel /></CurrentUserContext.Provider>;
    }
    renderRoutes([page(<SwitchEmployee />)], '/', testUser(permissions)); await waitFor(() => expect(firstSignal).toBeDefined());
    await userEvent.click(screen.getByRole('button', { name: 'Switch employee' })); expect(firstSignal!.aborted).toBe(true);
    expect(await screen.findByText(/Previous customer details have been removed/)).toBeVisible();
    await act(async () => resolve(response(atlasAttention())));
    expect(screen.queryByText('Synthetic disk capacity used: 97%')).not.toBeInTheDocument(); expect(reads).toBe(2);
  });

  it('cancels its read when permission is removed, even for the same employee', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_: string, init: RequestInit) => { signal = init.signal as AbortSignal; return new Promise<Response>(() => {}); }));
    function RevokePermission() {
      const [allowed, setAllowed] = useState(true);
      return <CurrentUserContext.Provider value={testUser(allowed ? permissions : ['customers.read'])}>
        <button onClick={() => setAllowed(false)}>Remove Atlas permission</button><AtlasAttentionPanel />
      </CurrentUserContext.Provider>;
    }
    renderRoutes([page(<RevokePermission />)] , '/', testUser(permissions)); await waitFor(() => expect(signal).toBeDefined());
    await userEvent.click(screen.getByRole('button', { name: 'Remove Atlas permission' })); expect(signal!.aborted).toBe(true);
    expect(screen.queryByRole('region', { name: 'Technical attention · Atlas' })).not.toBeInTheDocument();
  });

  it('starts a separate read when the same employee changes permissions but retains technical read access', async () => {
    let resolve!: (r: Response) => void; let oldSignal: AbortSignal | undefined; let reads = 0;
    vi.stubGlobal('fetch', vi.fn((_: string, init: RequestInit) => {
      if (++reads === 1) { oldSignal = init.signal as AbortSignal; return new Promise<Response>(r => { resolve = r; }); }
      return Promise.resolve(response({ ...atlasAttention(), status: 'ACCESS_DENIED', customers: null, totals: null }));
    }));
    function ChangePermissions() {
      const [allowed, setAllowed] = useState(permissions);
      return <CurrentUserContext.Provider value={testUser(allowed)}>
        <button onClick={() => setAllowed(['customers.read', 'parasol.atlas.read', 'activities.read'])}>Change employee permissions</button><AtlasAttentionPanel />
      </CurrentUserContext.Provider>;
    }
    renderRoutes([page(<ChangePermissions />)], '/', testUser(permissions)); await waitFor(() => expect(oldSignal).toBeDefined());
    await userEvent.click(screen.getByRole('button', { name: 'Change employee permissions' })); expect(oldSignal!.aborted).toBe(true);
    expect(await screen.findByText(/Previous customer details have been removed/)).toBeVisible();
    await act(async () => resolve(response(atlasAttention())));
    expect(screen.queryByText('Synthetic attention customer')).not.toBeInTheDocument(); expect(reads).toBe(2);
  });

  it('rechecks the whole aggregate after an M12 source denial, closing the old dialog even when refresh is fast', async () => {
    let attentionReads = 0;
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/atlas-attention')) {
        const value = atlasAttention(); if (++attentionReads > 1) value.customers![0]!.preview[0]!.summary = 'Synthetic replacement source'; return response(value);
      }
      const value = invalidTaskPreview(attentionCustomerId); value.status = 'ACCESS_DENIED'; return response(value);
    });
    vi.stubGlobal('fetch', fetch); render(); await screen.findByText('Synthetic disk capacity used: 97%');
    await userEvent.click(region().getAllByRole('button', { name: 'Assign work' })[0]!);
    expect(await screen.findByText('Synthetic replacement source')).toBeVisible();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(screen.queryByText('Synthetic disk capacity used: 97%')).not.toBeInTheDocument();
    expect(attentionReads).toBe(2); expect(fetch.mock.calls.map(([url]) => url).filter(url => url.endsWith('/task-preview'))).toHaveLength(1);
  });

  it('renders technical source text as literal text, without executing markup', async () => {
    const value = atlasAttention(); value.customers![0]!.preview[0]!.summary = '<img src=x onerror=alert(1)> synthetic';
    vi.stubGlobal('fetch', vi.fn(async () => response(value))); const view = render();
    expect(await screen.findByText('<img src=x onerror=alert(1)> synthetic')).toBeVisible(); expect(view.container.querySelector('img')).toBeNull();
  });
});
