import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { TaskSourceButton } from './TaskSourceButton';
import type { Activity } from './types';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const task: Activity = {
  id: 't1', type: 'Task', organizationId: 'o1', organizationName: 'Fjord IT AS', opportunityId: null, contractId: null, contactId: null,
  contactName: null, subject: 'Free disk space on SRV-01', body: null, dueAt: null, durationMinutes: null, location: null, priority: 'High',
  assignee: { id: 'u1', name: 'Kari Nordmann' }, status: 'Open', completedAt: null, isOverdue: false, inCalendar: false, calendarSyncedAt: null,
  webLink: null, fromAddress: null, createdAt: '2026-10-21T07:00:00Z', createdBy: null, etag: 'W/"1"', hasTechnicalSource: true,
};
const source = {
  task: { id: 't1', organizationId: 'o1', subject: 'Free disk space on SRV-01', status: 'Open', assignee: { id: 'u1', name: 'Kari Nordmann' },
    dueAt: null, isAvailable: true },
  alert: { id: 'a1', organizationId: 'o1', organizationName: 'Fjord IT AS', system: 'atera', kind: 'Monitoring', title: 'Disk almost full on SRV-01',
    severity: 'Critical', state: 'Resolved', deviceName: 'SRV-01', deviceId: null, createdAt: '2026-10-21T06:00:00Z',
    url: 'https://app.atera.com/new/alert/920029', resolvedAt: '2026-10-21T09:00:00Z' },
};
const readers = ['customers.read', 'service.read', 'activities.read'];

function stub(answer: () => Response = () => json(source)) {
  const fetch = vi.fn(async (input: string) => (String(input) === '/api/v1/activities/t1/source' ? answer() : json({}, 404)));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const render = (activity: Activity = task, permissions = readers) =>
  renderRoutes([page(<TaskSourceButton activity={activity} />)], '/', testUser(permissions));

afterEach(() => vi.unstubAllGlobals());

describe('task source', () => {
  it('reads the alert behind the task when asked, and shows it as it is now', async () => {
    const fetch = stub(); render();
    expect(fetch).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Source of Free disk space on SRV-01' }));
    const dialog = await screen.findByRole('dialog', { name: 'Source of the task' });
    expect(await within(dialog).findByText('Disk almost full on SRV-01')).toBeVisible();
    expect(within(dialog).getByText('Critical')).toBeVisible();
    // Resolved since the task was made: the read is fresh, not what the task was made from.
    expect(within(dialog).getAllByText('Resolved')[0]).toBeVisible();
    expect(within(dialog).getByRole('link', { name: 'Open in Atera' })).toHaveAttribute('href', 'https://app.atera.com/new/alert/920029');
    expect(within(dialog).getByRole('link', { name: 'Open in Alerts' })).toHaveAttribute('href', '/alerts?alert=a1');
    expect(fetch).toHaveBeenCalledTimes(1);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Refresh' }));
    expect(await within(dialog).findByText('Disk almost full on SRV-01')).toBeVisible();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('says the alert is no longer stored for the customer', async () => {
    stub(() => json({ ...source, alert: null })); render();
    await userEvent.click(screen.getByRole('button', { name: /^Source/ }));
    expect(await screen.findByText('The alert is no longer stored for this customer.')).toBeVisible();
  });

  it('says a task of a source no longer read has nothing to open', async () => {
    stub(() => json({ code: 'ACT_SOURCE_UNSUPPORTED', status: 404 }, 404)); render();
    await userEvent.click(screen.getByRole('button', { name: /^Source/ }));
    expect(await screen.findByText('This task was made from a source Parasoll no longer reads.')).toBeVisible();
  });

  it('shows no button for an ordinary task or for someone who cannot read both', () => {
    stub();
    const { unmount } = render({ ...task, hasTechnicalSource: false });
    expect(screen.queryByRole('button', { name: /^Source/ })).not.toBeInTheDocument();
    unmount();
    render(task, ['activities.read']);
    expect(screen.queryByRole('button', { name: /^Source/ })).not.toBeInTheDocument();
  });
});
