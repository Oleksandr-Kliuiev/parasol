import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CurrentUserContext } from '../../auth/CurrentUserContext';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { atlasTaskPreview, syntheticTask } from '../../test/atlasTask';
import { ObservationRows } from './ObservationRows';

const read = ['parasol.atlas.read', 'activities.read'];
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
// The one read a list makes on its own (UX 2026, В3): the work its shown observations already have, never a preview.
const lookupPath = '/api/v1/parasol/customers/customer-one/observation-tasks?ids=critical-one';
const isLookup = (url: string) => url.startsWith('/api/v1/parasol/customers/customer-one/observation-tasks?');
const lookup = (items: unknown[] = []) => response({ customerId: 'customer-one', status: 'READY', items });
const rows = () => {
  const p = atlasTaskPreview();
  return <ObservationRows items={[p.observation!]} devices={p.devices!} customerId="customer-one" />;
};
afterEach(() => vi.unstubAllGlobals());

describe('reading work from active observations', () => {
  it.each([
    ['OPEN', read, 'View work'], ['ACKNOWLEDGED', read, 'View work'],
    ['OPEN', [...read, 'activities.write'], 'Assign work'],
    ['RESOLVED', read, 'View linked work'], ['SUPPRESSED', read, 'View linked work'],
    ['OPEN', ['parasol.atlas.read', 'activities.write'], null],
    ['OPEN', ['activities.read', 'activities.write'], null],
    ['OPEN', ['parasol.atlas.read'], null], ['OPEN', ['activities.read'], null],
  ] as const)('offers the appropriate action for %s and %j', async (status, allowed, label) => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => lookup()); vi.stubGlobal('fetch', fetch);
    const p = atlasTaskPreview(); p.observation!.status = status;
    renderRoutes([page(<ObservationRows items={[p.observation!]} devices={p.devices!} customerId="customer-one" />)], '/', testUser([...allowed]));
    expect(screen.queryAllByRole('button').map(b => b.textContent)).toEqual(label ? [label] : []);
    // With both read permissions the page reads its tasks once; without them it reads nothing. Never a source preview.
    const both = allowed.includes('parasol.atlas.read' as never) && allowed.includes('activities.read' as never);
    await waitFor(() => expect(fetch.mock.calls.map(([url]) => url)).toEqual(both ? [lookupPath] : []));
  });

  it('says in the row that the observation already has a task, and opens it to look instead of to assign', async () => {
    const task = { ...syntheticTask, created: false, dueAt: '2026-10-24T14:00:00Z' };
    const fetch = vi.fn(async (url: string) => isLookup(url) ? lookup([{ observationId: 'critical-one', task, assigneeName: 'Synthetic technician' }])
      : response({ ...atlasTaskPreview(), canCreate: false, task }));
    vi.stubGlobal('fetch', fetch);
    renderRoutes([page(rows())], '/', testUser([...read, 'activities.write']));
    expect(await screen.findByText(/^Task open · Synthetic technician · due 24\/10\/2026, 16:00$/)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'View linked work' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'View observation work' }));
    expect(await dialog.findByRole('link', { name: 'Open task' })).toBeVisible();
    expect(dialog.queryByRole('button', { name: 'Create task' })).not.toBeInTheDocument();
  });

  it('keeps the plain action when the lookup answers for another customer', async () => {
    const task = { ...syntheticTask, organizationId: 'customer-two', created: false };
    vi.stubGlobal('fetch', vi.fn(async () => lookup([{ observationId: 'critical-one', task, assigneeName: 'Synthetic technician' }])));
    renderRoutes([page(rows())], '/', testUser([...read, 'activities.write']));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Assign work' })).toBeVisible());
    expect(screen.queryByText(/^Task open/)).not.toBeInTheDocument();
  });

  it.each([true, false])('opens a fresh read without assignment controls (linked=%s)', async linked => {
    const p = atlasTaskPreview(); p.canCreate = false; p.task = linked ? syntheticTask : null;
    const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async (url) => isLookup(url) ? lookup() : response(p)); vi.stubGlobal('fetch', fetch);
    renderRoutes([page(rows())], '/', testUser(read));
    const previews = () => fetch.mock.calls.filter(([url]) => !isLookup(url));
    expect(previews()).toHaveLength(0);
    const trigger = screen.getByRole('button', { name: 'View work' });
    await userEvent.click(trigger);
    const dialog = within(await screen.findByRole('dialog', { name: 'View observation work' }));
    await dialog.findByText(p.observation!.summary);
    expect(dialog.queryByRole('combobox')).not.toBeInTheDocument();
    expect(dialog.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(dialog.queryByRole('button', { name: 'Create task' })).not.toBeInTheDocument();
    expect(dialog.queryByText('No new task can be created from this observation.')).not.toBeInTheDocument();
    if (linked) expect(dialog.getByRole('link', { name: 'Open task' })).toHaveAttribute('href', '/organizations/customer-one?tab=activities&activityId=task-one');
    else expect(dialog.getByText('No CRM task is linked to this observation.')).toBeVisible();
    await userEvent.click(dialog.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(trigger).toBeEnabled());
    expect(previews()).toHaveLength(1);
    expect(previews()[0]![0]).toBe('/api/v1/parasol/customers/customer-one/observations/critical-one/task-preview');
  });

  it('does not offer assignment even if the read response wrongly advertises canCreate', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => isLookup(url) ? lookup() : response(atlasTaskPreview())));
    renderRoutes([page(rows())], '/', testUser(read));
    await userEvent.click(screen.getByRole('button', { name: 'View work' }));
    await screen.findByText('No CRM task is linked to this observation.');
    expect(screen.queryByRole('button', { name: 'Create task' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('drops the writer form and old preview on a permission change for the same employee', async () => {
    const p = atlasTaskPreview(); let finish!: (r: Response) => void, previews = 0;
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith('/api/v1/identity/users')) return response({ items: [], nextCursor: null, totalCount: 0 });
      if (isLookup(url)) return lookup();
      previews++;
      return previews === 1 ? response(p) : new Promise<Response>(resolve => { finish = resolve; });
    });
    vi.stubGlobal('fetch', fetch);
    let demote!: () => void;
    function Staff() {
      const [writer, setWriter] = useState(true);
      demote = () => setWriter(false);
      return <CurrentUserContext.Provider value={testUser(writer ? [...read, 'activities.write'] : read)}>
        {rows()}
      </CurrentUserContext.Provider>;
    }
    renderRoutes([page(<Staff />)], '/');
    await userEvent.click(screen.getByRole('button', { name: 'Assign work' }));
    await screen.findByRole('combobox');
    act(() => demote());
    await waitFor(() => expect(previews).toBe(2));
    expect(within(screen.getByRole('dialog')).queryByText(p.observation!.summary)).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    p.canCreate = false;
    finish(response(p));
    await screen.findByText('No CRM task is linked to this observation.');
    expect(screen.queryByRole('button', { name: 'Create task' })).not.toBeInTheDocument();
  });
});
