import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { CustomerIdentityImportPage } from './CustomerIdentityImportPage';

const snapshot = { schemaVersion: 1, source: 'atlas', workspaceId: 'synthetic', clients: [{ clientId: 'a-1', name: 'Synthetic Atlas' }, { clientId: 'a-2', name: 'Leave unchanged' }] };
const customer = { id: '11111111-1111-4111-8111-111111111111', title: 'Synthetic CRM', subtitle: null };
const basePlan = { sha256: 'a'.repeat(64), dryRun: true, canApply: true, unmappedClients: 1,
  rows: [{ atlasClientId: 'a-1', customerId: customer.id, outcome: 'READY' }] };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const render = (permissions = ['integrations.manage']) => renderRoutes([page(<CustomerIdentityImportPage />)], '/', testUser(permissions));
afterEach(() => vi.unstubAllGlobals());

async function choose(user: ReturnType<typeof userEvent.setup>) {
  await user.upload(screen.getByLabelText('Atlas export (JSON)'), new File([JSON.stringify(snapshot)], 'identity.json', { type: 'application/json' }));
  await user.click((await screen.findAllByRole('button', { name: 'Choose CRM customer' }))[0]!);
  const dialog = await screen.findByRole('dialog');
  await user.click(await within(dialog).findByRole('button', { name: 'Link' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
}
const mock = (handler: (url: string, init?: RequestInit) => Response | Promise<Response> = () => response(basePlan)) => {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => url.startsWith('/api/v1/search')
    ? response({ groups: [{ group: 'organizations', items: [customer] }] }) : handler(url, init));
  vi.stubGlobal('fetch', fetch); return fetch;
};

describe('customer identity workflow', () => {
  it('hides all import controls and makes no requests without the management permission', () => {
    const fetch = mock(); render([]);
    expect(screen.queryByLabelText('Atlas export (JSON)')).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects extra source fields locally before any request', async () => {
    const fetch = mock(); render(); const user = userEvent.setup();
    await user.upload(screen.getByLabelText('Atlas export (JSON)'), new File([JSON.stringify({ ...snapshot, token: 'private-sentinel' })], 'invalid.json', { type: 'application/json' }));
    expect(await screen.findByText(/not a valid version 1/)).toBeVisible();
    expect(screen.queryByText(/private-sentinel/)).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps selection local, invalidates confirmation on edits and applies the exact reviewed body once', async () => {
    const fetch = mock(url => response(url.includes('dryRun=false') ? { ...basePlan, dryRun: false, rows: [{ ...basePlan.rows[0], outcome: 'APPLIED' }] } : basePlan));
    render(); const user = userEvent.setup(); await choose(user);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Preview mappings' }));
    const apply = await screen.findByRole('button', { name: 'Apply reviewed mappings' });
    expect(apply).toBeDisabled();
    await user.click(screen.getByRole('checkbox'));
    expect(apply).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Edit selection' }));
    expect(screen.queryByRole('button', { name: 'Apply reviewed mappings' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Preview mappings' }));
    expect(await screen.findByRole('button', { name: 'Apply reviewed mappings' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Apply reviewed mappings' }));
    expect(await screen.findByText('Links saved: 1 new, 0 already present.')).toBeVisible();
    const posts = fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(3);
    expect(posts[2]![0]).toContain(`dryRun=false&expectedSha256=${basePlan.sha256}`);
    expect(posts[2]![1]?.body).toBe(posts[1]![1]?.body);
    expect(posts[2]![1]?.headers).toMatchObject({ 'X-CSRF': '1' });
    expect(JSON.parse(String(posts[2]![1]?.body)).mappings).toHaveLength(1);
  });

  it('blocks the entire batch on a conflicting row', async () => {
    mock(() => response({ ...basePlan, canApply: false, rows: [{ ...basePlan.rows[0], outcome: 'ATLAS_ALREADY_LINKED' }] }));
    render(); const user = userEvent.setup(); await choose(user);
    await user.click(screen.getByRole('button', { name: 'Preview mappings' }));
    expect(await screen.findByText('Conflict: Atlas client is linked to another CRM customer')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Apply reviewed mappings' })).toBeDisabled();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('requires a new preview after an ambiguous apply failure without automatically retrying the write', async () => {
    const fetch = mock(url => { if (url.includes('dryRun=false')) throw new TypeError('network failed'); return response(basePlan); });
    render(); const user = userEvent.setup(); await choose(user);
    await user.click(screen.getByRole('button', { name: 'Preview mappings' }));
    await user.click(await screen.findByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Apply reviewed mappings' }));
    expect(await screen.findByText(/The result could not be confirmed/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Apply reviewed mappings' })).not.toBeInTheDocument();
    expect(fetch.mock.calls.filter(([url]) => url.includes('dryRun=false'))).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Preview mappings' })).toBeEnabled();
  });
});
