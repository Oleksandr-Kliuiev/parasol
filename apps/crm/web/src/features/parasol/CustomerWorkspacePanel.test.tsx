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

  it('labels synthetic data visibly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ ...ready, summary: { ...ready.summary!, mode: 'fixture', completeness: 'COMPLETE_FIXTURE' } })));
    render(); expect(await screen.findByText(/Synthetic demonstration data/)).toBeVisible();
  });
});
