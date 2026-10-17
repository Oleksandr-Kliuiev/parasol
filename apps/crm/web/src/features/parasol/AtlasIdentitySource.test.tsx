import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { CustomerIdentityImportPage } from './CustomerIdentityImportPage';

const source = '/api/v1/parasol/customer-identities/atlas-export';
const snapshot = { schemaVersion: 1, source: 'atlas', workspaceId: 'synthetic-workspace', clients: [{ clientId: 'client-one', name: 'Synthetic Atlas' }] };
const ready = { status: 'READY', snapshot, retrievedAt: '2026-10-16T13:00:00Z' };
const customer = { id: '11111111-1111-4111-8111-111111111111', title: 'Synthetic CRM' };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const render = () => renderRoutes([page(<CustomerIdentityImportPage />)], '/', testUser(['integrations.manage']));
afterEach(() => vi.unstubAllGlobals());

describe('loading the Atlas directory in the mapping screen', () => {
  it('loads only on request and uses the returned snapshot in the reviewed import', async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === source) return response(ready);
      if (url.startsWith('/api/v1/search')) return response({ groups: [{ group: 'organizations', items: [customer] }] });
      const plan = { sha256: 'b'.repeat(64), dryRun: !url.includes('dryRun=false'), canApply: true, unmappedClients: 0,
        rows: [{ atlasClientId: 'client-one', customerId: customer.id, outcome: url.includes('dryRun=false') ? 'APPLIED' : 'READY' }] };
      expect(init?.method).toBe('POST'); return response(plan);
    });
    vi.stubGlobal('fetch', fetch); render(); const user = userEvent.setup();
    expect(fetch).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Load from Atlas' }));
    expect(await screen.findByText(/Loaded from Atlas at/)).toBeVisible();
    expect(screen.getByText(/may not contain every company customer/)).toBeVisible();
    expect(screen.getByText('Synthetic Atlas')).toBeVisible();
    expect(fetch).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Choose CRM customer' }));
    await user.click(await within(await screen.findByRole('dialog')).findByRole('button', { name: 'Link' }));
    await user.click(await screen.findByRole('button', { name: 'Preview mappings' }));
    await user.click(await screen.findByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Apply reviewed mappings' }));
    expect(await screen.findByText('Links saved: 1 new, 0 already present.')).toBeVisible();
    const writes = fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(writes).toHaveLength(2);
    expect(JSON.parse(String(writes[1]![1]?.body))).toEqual({ snapshot, mappings: [{ atlasClientId: 'client-one', customerId: customer.id }] });
    expect(writes[0]![1]?.body).toBe(writes[1]![1]?.body);
  });

  it.each([
    ['NOT_CONFIGURED', /connection has not been configured/], ['ACCESS_DENIED', /personal Atlas access is missing/],
    ['SOURCE_NOT_FOUND', /does not provide the identity export/], ['UNAVAILABLE', /Atlas could not be reached/],
    ['INVALID_RESPONSE', /invalid or incompatible customer list/],
  ])('explains %s and keeps the file option available', async (status, message) => {
    const fetch = vi.fn(async () => response({ status, snapshot: null, retrievedAt: null }));
    vi.stubGlobal('fetch', fetch); render();
    await userEvent.click(screen.getByRole('button', { name: 'Load from Atlas' }));
    expect(await screen.findByText(message)).toBeVisible();
    expect(screen.getByLabelText('Atlas export (JSON)')).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Preview mappings' })).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('distinguishes an empty visible directory from an unavailable one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ ...ready, snapshot: { ...snapshot, clients: [] } })));
    render(); await userEvent.click(screen.getByRole('button', { name: 'Load from Atlas' }));
    expect(await screen.findByText('The export contains no clients.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Preview mappings' })).toBeDisabled();
    expect(screen.getByText(/Loaded from Atlas at/)).toBeVisible();
  });

  it.each([
    { ...ready, snapshot: { ...snapshot, token: 'synthetic-private' } },
    { ...ready, retrievedAt: 'invalid' }, { status: 'NEW_UNKNOWN', snapshot, retrievedAt: null },
  ])('does not display or import an invalid source response', async body => {
    vi.stubGlobal('fetch', vi.fn(async () => response(body))); render();
    await userEvent.click(screen.getByRole('button', { name: 'Load from Atlas' }));
    expect(await screen.findByText(/invalid or incompatible customer list/)).toBeVisible();
    expect(screen.queryByText('Synthetic Atlas')).not.toBeInTheDocument();
    expect(screen.queryByText(/synthetic-private/)).not.toBeInTheDocument();
  });

  it('discards the previous selection before a failed new source read', async () => {
    let revoked = false;
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith('/api/v1/search')) return response({ groups: [{ group: 'organizations', items: [customer] }] });
      return response(revoked ? { status: 'ACCESS_DENIED', snapshot: null, retrievedAt: null } : ready);
    });
    vi.stubGlobal('fetch', fetch); render(); const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Load from Atlas' }));
    await user.click(await screen.findByRole('button', { name: 'Choose CRM customer' }));
    await user.click(await within(await screen.findByRole('dialog')).findByRole('button', { name: 'Link' }));
    await user.click(await screen.findByRole('button', { name: 'Choose another source' })); revoked = true;
    await user.click(screen.getByRole('button', { name: 'Load from Atlas' }));
    expect(await screen.findByText(/personal Atlas access is missing/)).toBeVisible();
    expect(screen.queryByText('Synthetic Atlas')).not.toBeInTheDocument();
    expect(screen.queryByText('Synthetic CRM')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Preview mappings' })).not.toBeInTheDocument();
  });

  it('reports rate limiting without automatically retrying', async () => {
    const fetch = vi.fn(async () => response({ code: 'RATE_LIMITED' }, 429));
    vi.stubGlobal('fetch', fetch); render();
    await userEvent.click(screen.getByRole('button', { name: 'Load from Atlas' }));
    expect(await screen.findByText(/export limit has been reached/)).toBeVisible();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('aborts an in-flight source read when the employee leaves the page', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      signal = init.signal as AbortSignal;
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })));
    const view = render(); await userEvent.click(screen.getByRole('button', { name: 'Load from Atlas' }));
    view.unmount(); await waitFor(() => expect(signal?.aborted).toBe(true));
  });
});
