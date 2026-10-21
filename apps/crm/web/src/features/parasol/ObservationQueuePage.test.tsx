import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { atlasQueue, attentionCustomerId } from '../../test/atlasAttention';
import { atlasTaskPreview, syntheticTask } from '../../test/atlasTask';
import { ObservationQueuePage } from './ObservationQueuePage';

const permissions = ['customers.read', 'parasol.atlas.read', 'activities.read', 'activities.write', 'users.read'];
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const users = { items: [{ id: 'u1', displayName: 'Kari Nordmann', email: null, isActive: true }], nextCursor: null, totalCount: 1 };

const render = (allowed = permissions) => renderRoutes([page(<ObservationQueuePage />, '/observations')], '/observations', testUser(allowed));
const list = () => within(screen.getByRole('list', { name: 'Urgent observations' }));
const rowNames = () => list().getAllByRole('listitem').map((row) => row.getAttribute('aria-label'));

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe('the observation queue', () => {
  it('shows the urgent rows without a task by default, critical first and the longest waiting next, across customers', async () => {
    const value = atlasQueue(); const c = value.customers![0]!;
    c.tasks = [{ observationId: 'high-1', task: { ...syntheticTask, organizationId: attentionCustomerId }, assigneeName: 'Synthetic technician' }];
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => response(value)); vi.stubGlobal('fetch', fetch); render();
    await screen.findByText('Synthetic disk capacity used: 97%');
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/v1/parasol/observations/urgent']);
    const chips = within(screen.getByRole('group', { name: 'Show' }));
    expect(chips.getByRole('button', { name: 'Without task, 5' })).toHaveAttribute('aria-pressed', 'true');
    expect(chips.getByRole('button', { name: 'With task, 1' })).toBeVisible();
    expect(rowNames()).toEqual([
      'Synthetic attention customer: Synthetic disk capacity used: 97%', 'Synthetic attention customer: Synthetic second critical observation',
      'Synthetic attention customer: Synthetic high observation 0', 'Synthetic attention customer: Synthetic high observation 2',
      'Synthetic attention customer: Synthetic high observation 3',
    ]);
    await userEvent.click(chips.getByRole('button', { name: 'With task, 1' }));
    expect(rowNames()).toEqual(['Synthetic attention customer: Synthetic high observation 1']);
    expect(list().getByText(/^Task open · Synthetic technician/)).toBeVisible();
    expect(list().getByRole('button', { name: 'View linked work' })).toBeVisible();
    // The unread customer is named, not left out silently.
    expect(screen.getByRole('link', { name: 'Synthetic unavailable customer' })).toBeVisible();
  });

  it('says which customers have more urgent observations than the queue shows', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(atlasQueue(attentionCustomerId, { high: 14, shown: 8 })))); render();
    expect(await screen.findByText(/showing 10 of 16 urgent observations; the customer's own queue has the rest\./)).toBeVisible();
  });

  it('moves with the keys on a row, opens with Enter, and keeps letters off when the person turns them off', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/task-preview')
      ? response({ ...atlasTaskPreview(), customerId: attentionCustomerId }) : url.startsWith('/api/v1/identity/users') ? response(users) : response(atlasQueue())));
    render(); await screen.findByText('Synthetic disk capacity used: 97%');
    const rows = () => list().getAllByRole('listitem');
    expect(rows()[0]).toHaveAttribute('tabindex', '0'); expect(rows()[1]).toHaveAttribute('tabindex', '-1');
    rows()[0]!.focus(); await userEvent.keyboard('j'); expect(rows()[1]).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}'); expect(rows()[2]).toHaveFocus();
    await userEvent.keyboard('k'); expect(rows()[1]).toHaveFocus();
    await userEvent.click(screen.getByRole('switch', { name: 'Single-key shortcuts' }));
    expect(screen.getByText('On a row: the arrows move and Enter opens.')).toBeVisible();
    rows()[1]!.focus(); await userEvent.keyboard('j'); expect(rows()[1]).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}'); expect(rows()[0]).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: 'Assign observation work' })).toBeVisible();
  });

  it('opens a row with A already assigned to the person, who still confirms the task', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/task-preview')
      ? response({ ...atlasTaskPreview(), customerId: attentionCustomerId }) : url.startsWith('/api/v1/identity/users') ? response(users) : response(atlasQueue())));
    render(); await screen.findByText('Synthetic disk capacity used: 97%');
    list().getAllByRole('listitem')[0]!.focus(); await userEvent.keyboard('a');
    const dialog = within(await screen.findByRole('dialog', { name: 'Assign observation work' }));
    expect(await dialog.findByRole('button', { name: 'Assign to me', pressed: true })).toBeVisible();
    expect(await dialog.findByText(/^Creates a task for Kari Nordmann/)).toBeVisible();
  });

  it('assigns the chosen rows to the person one by one, each after its own fresh read', async () => {
    const posts: string[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/observations/urgent')) return response(atlasQueue());
      const observation = decodeURIComponent(url.split('/observations/')[1]!.split('/')[0]!);
      if (url.endsWith('/task-preview')) return response({ ...atlasTaskPreview(), customerId: attentionCustomerId,
        observation: { ...atlasTaskPreview().observation!, id: observation }, sha256: observation === 'high-2' ? null : 'a'.repeat(64), canCreate: observation !== 'high-2' });
      if (init?.method === 'POST') { posts.push(observation); return response({ customerId: attentionCustomerId, status: 'CREATED',
        task: { ...syntheticTask, organizationId: attentionCustomerId, assigneeId: 'u1', created: true } }); }
      return response({});
    });
    vi.stubGlobal('fetch', fetch); render(); await screen.findByText('Synthetic disk capacity used: 97%');
    await userEvent.click(list().getByRole('checkbox', { name: 'Select Synthetic high observation 0' }));
    // X selects the row it is pressed on.
    list().getByRole('listitem', { name: /Synthetic high observation 2$/ }).focus(); await userEvent.keyboard('x');
    await userEvent.click(screen.getByRole('button', { name: 'Assign to me (2)' }));
    const confirm = within(screen.getByRole('dialog', { name: 'Assign 2 observations to you?' }));
    await userEvent.click(confirm.getByRole('button', { name: 'Assign to me' }));
    expect(await screen.findByText('1 task created for you. 1 could not be assigned: open it to see why.')).toBeVisible();
    expect(posts).toEqual(['high-0']);
    const bodies = fetch.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(init!.body as string));
    expect(bodies).toEqual([{ assigneeId: 'u1', dueAt: null, expectedSha256: 'a'.repeat(64) }]);
    // The new task moves its row out of "Without task" at once.
    await waitFor(() => expect(rowNames()).not.toContain('Synthetic attention customer: Synthetic high observation 0'));
    await userEvent.click(within(screen.getByRole('group', { name: 'Show' })).getByRole('button', { name: 'With task, 1' }));
    expect(list().getByText(/^Task open · Kari Nordmann/)).toBeVisible();
  });

  it('is not there for a role without customer and Atlas access', () => {
    vi.stubGlobal('fetch', vi.fn()); render(['customers.read']);
    expect(screen.getByRole('heading', { level: 1, name: 'No access' })).toBeVisible();
  });
});
