import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { atlasM365 } from '../../test/atlasM365';
import { atlasWorkspace } from '../../test/atlasWorkspace';
import { AtlasM365Panel } from './AtlasM365Panel';
import { CustomerWorkspacePanel } from './CustomerWorkspacePanel';

const permissions = ['customers.read', 'parasol.atlas.read'];
const reply = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
const render = (allowed = permissions, invalidated = vi.fn()) => renderRoutes(
  [page(<AtlasM365Panel customerId="customer-one" onSourceInvalidated={invalidated} />)], '/', testUser(allowed));
afterEach(() => vi.unstubAllGlobals());

it('does not read Microsoft 365 without both CRM permissions', () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); render(['parasol.atlas.read']);
  expect(screen.getByText('Your role does not include customer technical data.')).toBeVisible();
  expect(fetch).not.toHaveBeenCalled();
});

it('shows saved counts, stale directory data, UTC window and partial coverage with expandable native gaps', async () => {
  const fetch = vi.fn(async () => reply(atlasM365())); vi.stubGlobal('fetch', fetch); render();
  expect(await screen.findByText('14')).toBeVisible(); expect(screen.getByText('10')).toBeVisible();
  expect(screen.getByText('Partial traversal')).toBeVisible(); expect(screen.getByText('Fresh and outdated portions')).toBeVisible();
  expect(screen.getByText(/24 complete UTC hours/)).toBeVisible();
  expect(screen.getByText(/separate from machine inventory and licensed seats/)).toBeVisible();
  const details = screen.getByText('Intervals without coverage: 2');
  // jsdom does not implement native summary Enter activation; the real composition checks keyboard activation.
  expect(details.tagName).toBe('SUMMARY'); await userEvent.click(details);
  expect(details.closest('details')).toHaveAttribute('open');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('labels no active connection without pretending the tenant is healthy', async () => {
  const value = atlasM365(); value.summary!.connections = []; value.summary!.totalConnections = 0;
  vi.stubGlobal('fetch', vi.fn(async () => reply(value))); render();
  expect(await screen.findByText(/No active Microsoft 365 connection is available/)).toBeVisible();
  expect(screen.queryByText('14')).not.toBeInTheDocument();
});

it('hides old metadata throughout refresh and after domain denial, without retrying', async () => {
  let finish!: (value: Response) => void;
  const invalidated = vi.fn();
  const fetch = vi.fn().mockResolvedValueOnce(reply(atlasM365())).mockImplementationOnce(() => new Promise<Response>(r => { finish = r; }));
  vi.stubGlobal('fetch', fetch); render(permissions, invalidated);
  expect(await screen.findByText('14')).toBeVisible();
  const refresh = screen.getByRole('button', { name: 'Refresh Microsoft 365' }); await userEvent.click(refresh);
  expect(screen.queryByText('14')).not.toBeInTheDocument(); await userEvent.keyboard('{Enter}');
  expect(fetch).toHaveBeenCalledTimes(2);
  finish(reply({ customerId: 'customer-one', status: 'ACCESS_DENIED', summary: null }));
  expect(await screen.findByText(/does not permit reading this customer’s Microsoft 365 data/)).toBeVisible();
  expect(screen.queryByText('14')).not.toBeInTheDocument(); expect(invalidated).not.toHaveBeenCalled();
  expect(refresh).toHaveFocus(); expect(fetch).toHaveBeenCalledTimes(2);
});

it.each(['domain', 'HTTP 403'])('revalidates the whole context after %s denial and retains the active denial view when context access remains', async denial => {
  let workspace = 0, m365 = 0; let finish!: (value: Response) => void;
  const fetch = vi.fn((input: RequestInfo | URL) => {
    if (String(input).endsWith('/m365')) {
      m365++;
      return Promise.resolve(m365 === 1 ? reply(atlasM365()) : denial === 'HTTP 403' ? new Response('{}', { status: 403 })
        : reply({ customerId: 'customer-one', status: 'ACCESS_DENIED', summary: null }));
    }
    workspace++;
    return workspace === 1 ? Promise.resolve(reply(atlasWorkspace())) : new Promise<Response>(r => { finish = r; });
  });
  vi.stubGlobal('fetch', fetch);
  renderRoutes([page(<CustomerWorkspacePanel customerId="customer-one" />)], '/', testUser(permissions));
  expect(await screen.findByText('42')).toBeVisible();
  await userEvent.click(screen.getByRole('tab', { name: 'Microsoft 365' })); expect(await screen.findByText('14')).toBeVisible();
  const refresh = screen.getByRole('button', { name: 'Refresh Microsoft 365' }); await userEvent.click(refresh);
  expect(await screen.findByText(/does not permit reading this customer’s Microsoft 365 data/)).toBeVisible();
  await waitFor(() => expect(workspace).toBe(2));
  expect(screen.queryByText('42')).not.toBeInTheDocument(); expect(screen.queryByText('14')).not.toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'Atlas devices' })).toBeDisabled(); expect(refresh).toHaveAttribute('aria-disabled', 'true');
  expect(refresh).toHaveFocus(); await userEvent.keyboard('{Enter}'); expect(m365).toBe(2);
  const fresh = atlasWorkspace(); fresh.summary!.devices.pop(); fresh.summary!.knownDevices = 41;
  finish(reply(fresh));
  expect(await screen.findByText('41')).toBeVisible();
  expect(screen.getByRole('tab', { name: 'Microsoft 365' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByText(/does not permit reading this customer’s Microsoft 365 data/)).toBeVisible();
  expect(refresh).toHaveFocus(); expect(refresh).not.toHaveAttribute('aria-disabled', 'true');
  await userEvent.click(screen.getByRole('tab', { name: 'Atlas devices' }));
  expect(screen.getByText('Matching devices: 41 of 41 loaded')).toBeVisible(); expect(m365).toBe(2); expect(workspace).toBe(2);
});

it.each(['ACCESS_DENIED', 'HTTP failure'])('clears every technical panel and restores parent focus if the fresh context read returns %s', async status => {
  let workspace = 0, m365 = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/m365')) {
      m365++; return reply(m365 === 1 ? atlasM365() : { customerId: 'customer-one', status: 'ACCESS_DENIED', summary: null });
    }
    workspace++;
    return workspace === 1 ? reply(atlasWorkspace()) : status === 'HTTP failure' ? new Response('{}', { status: 503 })
      : reply({ customerId: 'customer-one', status, summary: null });
  }));
  renderRoutes([page(<CustomerWorkspacePanel customerId="customer-one" />)], '/', testUser(permissions));
  await userEvent.click(await screen.findByRole('tab', { name: 'Microsoft 365' })); expect(await screen.findByText('14')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Refresh Microsoft 365' }));
  await waitFor(() => expect(screen.queryByRole('tab', { name: 'Atlas devices' })).not.toBeInTheDocument());
  expect(screen.queryByText('42')).not.toBeInTheDocument(); expect(screen.queryByText('14')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Refresh' })).toHaveFocus(); expect(workspace).toBe(2); expect(m365).toBe(2);
});

it('loads lazily and clears the whole old workspace after a changed mapping, restoring focus to the parent Refresh', async () => {
  let workspace = 0, m365 = 0;
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/m365')) { m365++; return reply(m365 === 1 ? atlasM365() : { customerId: 'customer-one', status: 'IDENTITY_CHANGED', summary: null }); }
    workspace++; return reply(workspace === 1 ? atlasWorkspace() : { customerId: 'customer-one', status: 'IDENTITY_CHANGED', summary: null });
  });
  vi.stubGlobal('fetch', fetch);
  renderRoutes([page(<CustomerWorkspacePanel customerId="customer-one" />)], '/', testUser(permissions));
  expect(await screen.findByText('42')).toBeVisible(); expect(m365).toBe(0);
  await userEvent.click(screen.getByRole('tab', { name: 'Microsoft 365' })); expect(await screen.findByText('14')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Refresh Microsoft 365' }));
  expect(await screen.findByText('The customer link changed. Refresh to load current data.')).toBeVisible();
  expect(screen.queryByText('14')).not.toBeInTheDocument(); expect(screen.queryByText('42')).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toHaveFocus());
  expect(m365).toBe(2); expect(workspace).toBe(2);
});

it('cancels the previous customer and ignores a late reply after navigation', async () => {
  let finish!: (value: Response) => void; let previous: AbortSignal | null | undefined;
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('customer-one')) { previous = init?.signal; return new Promise<Response>(r => { finish = r; }); }
    const value = atlasM365('customer-two'); value.summary!.connections[0]!.directory[0]!.count = 3;
    return Promise.resolve(reply(value));
  }));
  function Customer() { const [id, setId] = useState('customer-one'); return <>
    <button onClick={() => setId('customer-two')}>Another customer</button><AtlasM365Panel customerId={id} onSourceInvalidated={vi.fn()} />
  </>; }
  renderRoutes([page(<Customer />)], '/', testUser(permissions));
  await userEvent.click(screen.getByRole('button', { name: 'Another customer' })); expect(await screen.findByText('3')).toBeVisible();
  expect(previous?.aborted).toBe(true); finish(reply(atlasM365()));
  await waitFor(() => expect(screen.queryByText('14')).not.toBeInTheDocument()); expect(screen.getByText('3')).toBeVisible();
});
