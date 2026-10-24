import { afterEach, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { CustomerIdentityPanel } from './CustomerIdentityPanel';

const identity = { customerId: 'customer', atlas: { workspaceId: 'synthetic', clientId: 'atlas-one' }, linkId: 'reviewed-link' };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const render = (permissions = ['integrations.manage']) => renderRoutes([page(<CustomerIdentityPanel customerId="customer" />)], '/', testUser(permissions));
afterEach(() => vi.unstubAllGlobals());

it('does not request or offer identity management without permission', () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); render([]);
  expect(screen.queryByText('Customer link · Atlas')).not.toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
});

it('requires confirmation and sends the displayed link ID, then refreshes its state', async () => {
  let linked = true;
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') { linked = false; return new Response(null, { status: 204 }); }
    return response(linked ? identity : { customerId: 'customer', atlas: null, linkId: null });
  });
  vi.stubGlobal('fetch', fetch); render(); const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Remove Atlas link' }));
  expect(fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText('atlas-one')).toBeVisible();
  await user.click(within(dialog).getByRole('button', { name: 'Remove Atlas link' }));
  expect(await screen.findByText('This customer has not been linked to Atlas.')).toBeVisible();
  const write = fetch.mock.calls.find(([, init]) => init?.method === 'DELETE');
  expect(write?.[0]).toBe('/api/v1/integrations/links/reviewed-link');
  expect(write?.[1]?.headers).toMatchObject({ 'X-CSRF': '1' });
});

it('does not delete a replacement link when the confirmed selection is stale', async () => {
  let stale = false;
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') { stale = true; return response({}, 404); }
    return response(stale ? { ...identity, linkId: 'replacement', atlas: { ...identity.atlas, clientId: 'atlas-new' } } : identity);
  });
  vi.stubGlobal('fetch', fetch); render(); const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Remove Atlas link' }));
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove Atlas link' }));
  expect(await screen.findByText(/Removal could not be confirmed/)).toBeVisible();
  expect(await screen.findByText('atlas-new')).toBeVisible();
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'DELETE').map(([url]) => url)).toEqual(['/api/v1/integrations/links/reviewed-link']);
});
