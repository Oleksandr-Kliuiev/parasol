import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { CustomerWorkspacePanel, type Workspace } from './CustomerWorkspacePanel';
import { atlasWorkspace } from '../../test/atlasWorkspace';

const ready = atlasWorkspace();
const render = (permissions = ['parasol.atlas.read']) => renderRoutes(
  [page(<CustomerWorkspacePanel customerId="customer-one" />)], '/', testUser(permissions));
const response = (data: Workspace) => new Response(JSON.stringify(data), { status: 200 });

afterEach(() => vi.unstubAllGlobals());

describe('the unified customer workspace', () => {
  it('does not request Atlas data without the employee permission', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); render([]);
    expect(screen.getByText('Your role does not include the technical workspace.')).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows bounded counts, stale and missing sources without implying a complete fleet inventory', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(ready))); render();
    expect(await screen.findByText('42')).toBeVisible();
    expect(screen.getByText('Outdated snapshot')).toBeVisible();
    expect(screen.getByText('No snapshot')).toBeVisible();
    expect(screen.getByText('Records in snapshot: 25 (partial list)')).toBeVisible();
    expect(screen.getByText(/not a count of all customer machines/)).toBeVisible();
  });

  it('removes a previously successful snapshot when access is revoked', async () => {
    let allowed = true;
    vi.stubGlobal('fetch', vi.fn(async () => response(allowed ? ready : { customerId: 'customer-one', status: 'ACCESS_DENIED', summary: null })));
    render(); expect(await screen.findByText('42')).toBeVisible(); allowed = false;
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Your Atlas access does not permit reading this customer.')).toBeVisible();
    await waitFor(() => expect(screen.queryByText('42')).not.toBeInTheDocument());
  });

  it('does not leave cached technical data on screen after an HTTP failure', async () => {
    let failed = false;
    vi.stubGlobal('fetch', vi.fn(async () => failed ? new Response('{}', { status: 503 }) : response(ready)));
    render(); expect(await screen.findByText('42')).toBeVisible(); failed = true;
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.queryByText('42')).not.toBeInTheDocument());
  });

  it('clears the old registry on a changed link and requires an explicit fresh read', async () => {
    let finish!: (value: Response) => void;
    const fresh = atlasWorkspace();
    const device = fresh.summary!.devices[0];
    const observation = fresh.summary!.observationPage.items[0];
    if (!device || !observation) throw new Error('Synthetic workspace fixture must contain a device and observation.');
    device.hostname = 'SYNTHETIC-FRESH-LINK';
    observation.summary = 'Synthetic fresh source review';
    const fetch = vi.fn().mockResolvedValueOnce(response(ready))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }))
      .mockResolvedValueOnce(response(fresh));
    vi.stubGlobal('fetch', fetch); render();
    await userEvent.click(await screen.findByRole('tab', { name: 'Atlas devices' }));
    expect(screen.getByText('SYNTHETIC-LT-01')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(screen.queryByText('SYNTHETIC-LT-01')).not.toBeInTheDocument();
    finish(response({ customerId: 'customer-one', status: 'IDENTITY_CHANGED', summary: null }));
    expect(await screen.findByText('The customer link changed. Refresh to load current data.')).toBeVisible();
    expect(screen.queryByRole('tab', { name: 'Atlas devices' })).not.toBeInTheDocument();
    expect(screen.queryByText('42')).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Synthetic fresh source review')).toBeVisible();
    await userEvent.click(screen.getByRole('tab', { name: 'Atlas devices' }));
    expect(screen.getByText('SYNTHETIC-FRESH-LINK')).toBeVisible();
    expect(screen.queryByText('SYNTHETIC-LT-01')).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('labels synthetic data visibly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ ...ready, summary: { ...ready.summary!, mode: 'fixture', completeness: 'COMPLETE_FIXTURE' } })));
    render(); expect(await screen.findByText(/Synthetic demonstration data/)).toBeVisible();
  });
});
