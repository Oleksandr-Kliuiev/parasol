import { afterEach, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { syntheticActivity } from '../../test/activities';
import { MyTasksPanel } from './MyTasksPanel';
import { ActivityTimeline } from './ActivityTimeline';
import { association, json, pageOf, ticket } from './taskTicketTestFixture';

const original = syntheticActivity();
const current = { ...original, subject: 'Reviewed current task', etag: '"full-activity-version"', priority: 'High' as const };
const permissions = ['activities.read', 'activities.write', 'service.read', 'time.own'];
const list = (items = [original]) => json({ items, nextCursor: null, totalCount: items.length });
const open = async () => userEvent.click(await screen.findByRole('button', { name: `Service ticket for ${original.subject}` }));
async function choose() {
  await userEvent.click(await screen.findByRole('button', { name: 'Choose saved ticket' }));
  await userEvent.click(await screen.findByRole('radio', { name: /#701/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Link selected ticket' }));
}
afterEach(() => vi.unstubAllGlobals());

it.each(['personal', 'selected', 'timeline'] as const)('rereads the full %s Activity after closing a saved association and completes only its displayed version', async kind => {
  let reads = 0; let linked = false; let completed = false; let finish!: (value: Response) => void;
  const commands: RequestInit[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/outlook/status')) return json({ calendar: false, mail: false });
    if (url.startsWith('/api/v1/activities/?')) {
      reads++;
      if (reads === 2) return new Promise<Response>(resolve => { finish = resolve; });
      return list(completed ? kind === 'personal' ? [] : [{ ...current, status: 'Done', etag: '"done-version"' }] : [original]);
    }
    if (url.endsWith('/ticket') && init.method === 'PUT') {
      linked = true;
      expect(init.headers).toMatchObject({ 'If-Match': '"association-read-version"' });
      return json(association(ticket, { etag: '"saved-link-version"' }));
    }
    if (url.includes('/ticket?')) return json(association(linked ? ticket : null, { etag: linked ? '"saved-link-version"' : '"association-read-version"' }));
    if (url.startsWith('/api/v1/service/work-tickets')) return pageOf();
    if (url.endsWith('/complete')) { commands.push(init); completed = true; return json({ ...current, status: 'Done' }); }
    throw new Error('Unexpected Task review request.');
  });
  vi.stubGlobal('fetch', fetch);
  renderRoutes([page(kind === 'personal' ? <MyTasksPanel /> : <ActivityTimeline organizationId={original.organizationId}
    selection={kind === 'selected' ? { kind: 'selected', activityId: original.id } : { kind: 'all' }} />)], '/', testUser(permissions));
  await screen.findByText(original.subject); await open(); await choose();
  expect(await screen.findByRole('button', { name: 'Register hours' })).toBeEnabled();
  expect(reads, 'Saving the link must preserve the open ticket/time flow').toBe(1);
  await userEvent.click(screen.getByRole('button', { name: /^Close$/ }));
  await waitFor(() => expect(reads).toBe(2));
  expect(screen.queryByText(original.subject)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^Mark .* as done$/ })).not.toBeInTheDocument();
  expect(commands).toHaveLength(0);
  const focusLabel = kind === 'personal' ? 'Refresh my tasks' : kind === 'selected' ? 'Refresh activity' : 'Log activity';
  await waitFor(() => expect(screen.getByRole('button', { name: focusLabel })).toHaveFocus());
  await act(async () => finish(list([current])));
  expect(await screen.findByText(current.subject)).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: `Mark ${current.subject} as done` }));
  await waitFor(() => expect(commands).toHaveLength(1));
  expect(commands[0]!.headers).toMatchObject({ 'If-Match': current.etag });
});

it('does not reread the personal list or retry a failed association write when closing', async () => {
  let reads = 0; let writes = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url.startsWith('/api/v1/activities/?')) { reads++; return list(); }
    if (init.method === 'PUT') { writes++; return json({ code: 'CONCURRENCY_CONFLICT' }, 412); }
    return url.includes('/ticket?') ? json(association()) : pageOf();
  }));
  renderRoutes([page(<MyTasksPanel />)], '/', testUser(permissions));
  await screen.findByText(original.subject); await open(); await choose();
  expect(await screen.findByText(/This task changed or the ticket is no longer available/)).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(reads).toBe(1); expect(writes).toBe(1);
});
