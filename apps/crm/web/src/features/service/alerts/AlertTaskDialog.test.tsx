import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../../test/renderWithProviders';
import { AlertTaskDialog } from './AlertTaskDialog';
import type { AlertTask, AlertTaskPreview } from './alertTasks';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const fingerprint = 'a'.repeat(64);
const preview = (overrides: Partial<AlertTaskPreview> = {}): AlertTaskPreview => ({
  alert: { id: 'a1', organizationId: 'o1', organizationName: 'Fjord IT AS', system: 'atera', kind: 'Monitoring', title: 'Disk almost full on SRV-01',
    severity: 'Critical', state: 'Open', deviceName: 'SRV-01', deviceId: null, createdAt: '2026-10-21T06:00:00Z', url: null, resolvedAt: null },
  fingerprint, subject: 'Disk almost full on SRV-01', priority: 'High', task: null, canCreate: true, ...overrides,
});
const made: AlertTask = { id: 't1', organizationId: 'o1', subject: 'Free disk space', status: 'Open', assignee: { id: 'u1', name: 'Kari Nordmann' },
  dueAt: null, isAvailable: true };
const writer = ['customers.read', 'service.read', 'activities.read', 'activities.write'];

function stub(answers: { preview?: () => Response; create?: () => Response } = {}) {
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'https://parasoll.invalid');
    if (url.pathname === '/api/v1/activities/source-tasks/preview') return answers.preview?.() ?? json(preview());
    if (url.pathname === '/api/v1/activities/source-tasks' && init?.method === 'POST') return answers.create?.() ?? json({ status: 'CREATED', task: made });
    if (url.pathname === '/api/v1/identity/users') return json({ items: [], nextCursor: null, totalCount: 0 });
    return json({}, 404);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const posts = (fetch: ReturnType<typeof stub>) => fetch.mock.calls.filter(([url, init]) => String(url) === '/api/v1/activities/source-tasks' && init?.method === 'POST');
function render(permissions = writer, onTask = vi.fn(), onClose = vi.fn()) {
  renderRoutes([page(<AlertTaskDialog alertId="a1" onClose={onClose} onTask={onTask} />)], '/', testUser(permissions));
  return { onTask, onClose };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('assign an alert as a task', () => {
  it('offers the alert title as the subject, me as the assignee and says what the button makes, then shows the task', async () => {
    const fetch = stub(); const { onTask } = render();
    const dialog = await screen.findByRole('dialog', { name: 'Assign alert' });
    expect(await within(dialog).findByText('Fjord IT AS · SRV-01 · Source: Atera', { exact: false })).toBeVisible();
    const subject = within(dialog).getByRole('textbox', { name: 'Task subject' });
    expect(subject).toHaveValue('Disk almost full on SRV-01');
    expect(within(dialog).getByRole('combobox', { name: 'Assignee' })).toHaveValue('Kari Nordmann');
    expect(within(dialog).getByRole('button', { name: 'Me' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(dialog).getByText('Priority: High, as the alert is critical.')).toBeVisible();
    expect(within(dialog).getByText('Creates a task for Kari Nordmann with no due date.')).toBeVisible();
    await userEvent.clear(subject); await userEvent.type(subject, 'Free disk space');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Tomorrow 16:00' }));
    expect(within(dialog).getByText(/^Creates a task for Kari Nordmann, due /)).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create task' }));
    expect(await within(dialog).findByText('Task created.')).toBeVisible();
    const init = posts(fetch)[0]?.[1];
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({ alertId: 'a1', assigneeId: 'u1', subject: 'Free disk space', expectedFingerprint: fingerprint });
    expect(new Date(body.dueAt).getHours()).toBe(16);
    expect(init!.headers).toMatchObject({ 'X-CSRF': '1' });
    expect(onTask).toHaveBeenCalledWith(made);
    expect(within(dialog).getByRole('link', { name: 'Open task' })).toHaveAttribute('href', '/organizations/o1?tab=activities&activityId=t1');
    expect(within(dialog).queryByRole('button', { name: 'Create task' })).not.toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus());
  });

  it('shows a colleague’s task instead of offering a second one', async () => {
    const fetch = stub({ preview: () => json(preview({ canCreate: false,
      task: { ...made, assignee: { id: 'u2', name: 'Ola Tekniker' }, dueAt: '2026-10-22T14:00:00Z' } })) });
    render();
    const dialog = await screen.findByRole('dialog', { name: 'Assign alert' });
    expect(await within(dialog).findByText('This alert already has a task.')).toBeVisible();
    expect(within(dialog).getByText(/Ola Tekniker · due/)).toBeVisible();
    expect(within(dialog).queryByRole('textbox', { name: 'Task subject' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Create task' })).not.toBeInTheDocument();
    expect(posts(fetch)).toHaveLength(0);
  });

  it('says so when the server finds a task made meanwhile, and makes no second one', async () => {
    stub({ create: () => json({ status: 'EXISTING', task: { ...made, assignee: { id: 'u2', name: 'Ola Tekniker' } } }) });
    render();
    const dialog = await screen.findByRole('dialog', { name: 'Assign alert' });
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Create task' }));
    expect(await within(dialog).findByText('This alert already had a task, so no new task was created.')).toBeVisible();
    expect(within(dialog).getByText(/^Ola Tekniker/)).toBeVisible();
  });

  it('reads the alert again when it changed since the dialog read it, and keeps the typed subject', async () => {
    let reads = 0;
    const fetch = stub({
      preview: () => json(preview(++reads > 1 ? { fingerprint: 'b'.repeat(64), alert: { ...preview().alert, title: 'Disk full on SRV-01' }, subject: 'Disk full on SRV-01' } : {})),
      create: () => json({ code: 'ACT_SOURCE_ALERT_CHANGED', status: 409 }, 409),
    });
    render();
    const dialog = await screen.findByRole('dialog', { name: 'Assign alert' });
    const subject = await within(dialog).findByRole('textbox', { name: 'Task subject' });
    await userEvent.clear(subject); await userEvent.type(subject, 'My own words');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create task' }));
    expect(await within(dialog).findByText('The alert changed after you opened it. Check it, then create the task.')).toBeVisible();
    expect(await within(dialog).findByText('Disk full on SRV-01')).toBeVisible();
    expect(within(dialog).getByRole('textbox', { name: 'Task subject' })).toHaveValue('My own words');
    expect(reads).toBe(2); expect(posts(fetch)).toHaveLength(1);
  });

  it('refuses an empty subject before asking the server', async () => {
    const fetch = stub(); render();
    const dialog = await screen.findByRole('dialog', { name: 'Assign alert' });
    await userEvent.clear(await within(dialog).findByRole('textbox', { name: 'Task subject' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create task' }));
    expect(await within(dialog).findByText('Write a subject.')).toBeVisible();
    expect(posts(fetch)).toHaveLength(0);
  });

  it('names an assignee the server refused at the field and keeps the form', async () => {
    stub({ create: () => json({ code: 'ACT_SOURCE_TASK_ASSIGNEE_INVALID', status: 400 }, 400) }); render();
    const dialog = await screen.findByRole('dialog', { name: 'Assign alert' });
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Create task' }));
    expect(await within(dialog).findByText('This person cannot get tasks from alerts. Choose someone else.')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Create task' })).toBeVisible();
  });

  it('never offers the button again after an answer that did not come, until the alert is read again', async () => {
    let reads = 0;
    stub({ preview: () => json(preview(++reads > 1 ? { canCreate: false, task: made } : {})), create: () => json({}, 503) });
    render();
    const dialog = await screen.findByRole('dialog', { name: 'Assign alert' });
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Create task' }));
    expect(await within(dialog).findByText(/Parasoll could not confirm whether the task was created/)).toBeVisible();
    // The fresh read finds the task the lost answer made.
    expect(await within(dialog).findByText('This alert already has a task.')).toBeVisible();
    expect(within(dialog).queryByRole('button', { name: 'Create task' })).not.toBeInTheDocument();
  });

  it('shows a resolved alert without a form', async () => {
    stub({ preview: () => json(preview({ canCreate: false, alert: { ...preview().alert, state: 'Resolved', resolvedAt: '2026-10-21T09:00:00Z' } })) });
    render();
    const dialog = await screen.findByRole('dialog', { name: 'Assign alert' });
    expect(await within(dialog).findByText('The alert is resolved, so no task can be created from it.')).toBeVisible();
    expect(within(dialog).queryByRole('button', { name: 'Create task' })).not.toBeInTheDocument();
  });

  it('turns Today 16:00 off once the day has passed it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 9, 21, 17, 30));
    stub(); render();
    const dialog = await screen.findByRole('dialog', { name: 'Assign alert' });
    expect(await within(dialog).findByRole('button', { name: 'Today 16:00' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Tomorrow 16:00' })).toBeEnabled();
  });
});
