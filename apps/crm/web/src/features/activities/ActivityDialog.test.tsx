import { useState, type ReactElement } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { ActivityDialog } from './ActivityDialog';
import type { Activity } from './types';

const activity = (dueAt: string | null): Activity => ({
  id: 'synthetic-task', type: 'Task', organizationId: 'synthetic-customer', organizationName: 'Synthetic customer',
  opportunityId: null, contractId: null, contactId: null, contactName: null, subject: 'Review technical observation', body: 'Local work notes',
  dueAt, durationMinutes: null, location: null, priority: 'High', assignee: { id: 'u1', name: 'Kari Nordmann' }, status: 'Open',
  completedAt: null, isOverdue: false, inCalendar: false, calendarSyncedAt: null, webLink: null, fromAddress: null,
  createdAt: '2025-01-01T10:00:00Z', createdBy: null, etag: '"original-version"', hasTechnicalSource: true,
});
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
function setup(dueAt: string | null, failure?: { status: number; code: string; errors?: Record<string, string[]> },
  host?: (original: Activity, onClose: () => void) => ReactElement, save?: () => Promise<Response>) {
  const onClose = vi.fn();
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url.startsWith('/api/v1/identity/users')) return response({ items: [
      { id: 'u1', displayName: 'Kari Nordmann', email: null, isActive: true },
      { id: 'u2', displayName: 'Ola Engineer', email: null, isActive: true },
    ], nextCursor: null });
    if (url.endsWith('/outlook/status')) return response({ calendar: false, mail: false });
    if (init.method === 'PUT') return save ? save() : failure ? response({ ...failure, detail: 'synthetic-server-detail' }, failure.status) : response(activity(dueAt));
    throw new Error('Unexpected synthetic activity request.');
  });
  vi.stubGlobal('fetch', fetch);
  renderRoutes([page(host ? host(activity(dueAt), onClose)
    : <ActivityDialog open onClose={onClose} organizationId="synthetic-customer" activity={activity(dueAt)} />)], '/', testUser(['activities.read', 'activities.write']));
  return { fetch, onClose, writes: () => fetch.mock.calls.filter(([, init]) => init.method === 'PUT') };
}
async function chooseAssignee(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('combobox', { name: 'Assignee' }));
  await user.keyboard('{ArrowDown}');
  await user.click(await screen.findByRole('option', { name: 'Ola Engineer' }));
}
afterEach(() => vi.unstubAllGlobals());

it.each([
  ['winter', 'subject', '2025-01-15T09:15:23.456Z'],
  ['summer', 'assignee', '2025-07-15T09:15:23.456Z'],
  ['first repeated hour', 'subject', '2025-10-26T00:30:45.678Z'],
  ['second repeated hour', 'assignee', '2025-10-26T02:30:12.345+01:00'],
])('preserves the exact %s due instant when editing only %s', async (_, edit, due) => {
  const state = setup(due!); const user = userEvent.setup(); await screen.findByRole('dialog');
  const instant = new Date(due!);
  const localInput = new Date(instant.valueOf() - instant.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  expect(screen.getByLabelText('Due')).toHaveValue(localInput);
  if (edit === 'subject') await user.type(screen.getByRole('textbox', { name: 'Subject' }), ' reviewed');
  else await chooseAssignee(user);
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(state.onClose).toHaveBeenCalledOnce());
  expect(state.writes()).toHaveLength(1);
  const request = state.writes()[0]![1];
  expect(JSON.parse(String(request.body))).toMatchObject({ dueAt: due, assigneeId: edit === 'assignee' ? 'u2' : 'u1' });
  expect(request.headers).toMatchObject({ 'If-Match': '"original-version"' });
});

it.each(['2025-08-20T13:45', ''])('sends an explicitly changed due value %s as an instant or null', async value => {
  const state = setup('2025-01-15T09:15:23.456Z'); await screen.findByRole('dialog');
  fireEvent.change(screen.getByLabelText('Due'), { target: { value } });
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(state.onClose).toHaveBeenCalledOnce());
  expect(JSON.parse(String(state.writes()[0]![1].body)).dueAt).toBe(value ? new Date(value).toISOString() : null);
});

it.each([
  [400, 'ACT_SOURCE_TASK_ASSIGNEE_INVALID', 'This employee cannot be assigned to a technical task.'],
  [409, 'ACT_SOURCE_TASK_IDENTITY_LOCKED', 'This activity changed or can no longer be edited as requested.'],
  [412, 'CONCURRENCY_CONFLICT', 'This activity changed or can no longer be edited as requested.'],
] as const)('shows HTTP%s refusal, keeps the draft and never retries the write automatically', async (status, code, message) => {
  const state = setup('2025-01-15T09:15:23.456Z', { status, code }); const user = userEvent.setup(); await screen.findByRole('dialog');
  await user.type(screen.getByRole('textbox', { name: 'Subject' }), ' draft');
  fireEvent.change(screen.getByLabelText('Due'), { target: { value: '2025-08-20T13:45' } });
  await chooseAssignee(user); await user.click(screen.getByRole('button', { name: 'Save' }));
  const failure = await screen.findByText(text => text.startsWith(message)); expect(failure).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'Subject' })).toHaveValue('Review technical observation draft');
  expect(screen.getByLabelText('Due')).toHaveValue('2025-08-20T13:45');
  expect(screen.getByRole('combobox', { name: 'Assignee' })).toHaveValue('Ola Engineer');
  expect(screen.queryByText('synthetic-server-detail')).not.toBeInTheDocument();
  expect(state.onClose).not.toHaveBeenCalled(); expect(state.writes()).toHaveLength(1);
  await user.type(screen.getByRole('textbox', { name: 'Subject' }), ' edited');
  expect(failure).not.toBeInTheDocument(); expect(state.writes()).toHaveLength(1);
});

it('retains ordinary field validation and does not replace it with a generic form error', async () => {
  const state = setup(null, { status: 400, code: 'VALIDATION', errors: { Subject: ['Synthetic subject validation'] } });
  await screen.findByRole('dialog'); await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('Synthetic subject validation')).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'Subject' })).toHaveAttribute('aria-invalid', 'true');
  expect(screen.queryByText('Saving was not confirmed. Your draft has been kept.')).not.toBeInTheDocument();
  expect(state.writes()).toHaveLength(1); expect(state.onClose).not.toHaveBeenCalled();
});

it('keeps the original draft version and exact due instant when fresh props arrive for the same record', async () => {
  let replace!: (value: Activity) => void;
  function Editor({ original, onClose }: { original: Activity; onClose: () => void }) {
    const [current, setCurrent] = useState(original); replace = setCurrent;
    return <ActivityDialog open onClose={onClose} organizationId={current.organizationId} activity={current} />;
  }
  const original = activity('2025-10-26T02:30:12.345+01:00');
  const state = setup(original.dueAt, undefined, (value, onClose) => <Editor original={value} onClose={onClose} />);
  await screen.findByRole('dialog'); await userEvent.type(screen.getByRole('textbox', { name: 'Subject' }), ' draft');
  await act(async () => replace({ ...original, subject: 'Changed elsewhere', dueAt: '2025-11-01T09:00:00Z', etag: '"newer-version"' }));
  expect(screen.getByRole('textbox', { name: 'Subject' })).toHaveValue('Review technical observation draft');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(state.writes()).toHaveLength(1));
  const request = state.writes()[0]![1];
  expect(request.headers).toMatchObject({ 'If-Match': '"original-version"' });
  expect(JSON.parse(String(request.body)).dueAt).toBe(original.dueAt);
});

it('resets the draft and refusal when switching to a different activity', async () => {
  let replace!: (value: Activity) => void;
  function Editor({ original, onClose }: { original: Activity; onClose: () => void }) {
    const [current, setCurrent] = useState(original); replace = setCurrent;
    return <ActivityDialog open onClose={onClose} organizationId={current.organizationId} activity={current} />;
  }
  const state = setup(null, { status: 400, code: 'ACT_SOURCE_TASK_ASSIGNEE_INVALID' }, (value, onClose) => <Editor original={value} onClose={onClose} />);
  await screen.findByRole('dialog'); await userEvent.type(screen.getByRole('textbox', { name: 'Subject' }), ' old draft');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  const refusal = await screen.findByText(/^This employee cannot be assigned/);
  const next = { ...activity('2025-07-15T09:15:23.456Z'), id: 'another-task', subject: 'Another task', etag: '"another-version"' };
  await act(async () => replace(next));
  expect(refusal).not.toBeInTheDocument(); expect(screen.getByRole('textbox', { name: 'Subject' })).toHaveValue('Another task');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(state.writes()).toHaveLength(2));
  expect(state.writes()[1]![0]).toBe('/api/v1/activities/another-task');
  expect(state.writes()[1]![1].headers).toMatchObject({ 'If-Match': '"another-version"' });
  expect(JSON.parse(String(state.writes()[1]![1].body))).toMatchObject({ subject: 'Another task', dueAt: next.dueAt });
});

it.each(['success', 'failure'])('ignores late %s UI effects after saving A, closing it and opening a B draft', async outcome => {
  let finish!: (value: Response) => void;
  function Editor({ original, onClose }: { original: Activity; onClose: () => void }) {
    const [current, setCurrent] = useState<Activity | null>(original);
    return <>
      {!current && <button onClick={() => setCurrent({ ...activity(null), id: 'another-task', subject: 'Another task' })}>Open B</button>}
      <ActivityDialog open={current !== null} activity={current ?? undefined} organizationId="synthetic-customer"
        onClose={() => { onClose(); setCurrent(null); }} />
    </>;
  }
  const state = setup(null, undefined, (value, onClose) => <Editor original={value} onClose={onClose} />,
    () => new Promise<Response>(resolve => { finish = resolve; }));
  await screen.findByRole('dialog'); await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(state.writes()).toHaveLength(1));
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Open B' }));
  await userEvent.type(await screen.findByRole('textbox', { name: 'Subject' }), ' B draft');
  await act(async () => finish(outcome === 'success' ? response(activity(null)) : response({ code: 'ACT_SOURCE_TASK_ASSIGNEE_INVALID' }, 400)));
  expect(state.onClose).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('dialog')).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'Subject' })).toHaveValue('Another task B draft');
  expect(screen.queryByText(/^This employee cannot be assigned/)).not.toBeInTheDocument();
  expect(state.writes()).toHaveLength(1);
});

it('locks all editable task controls during a save, keeps Cancel available and closes on normal success', async () => {
  let finish!: (value: Response) => void;
  const state = setup('2025-07-15T09:15:23.456Z', undefined,
    (original, onClose) => <ActivityDialog open onClose={onClose} organizationId={original.organizationId} activity={{ ...original, hasTechnicalSource: false }} />,
    () => new Promise<Response>(resolve => { finish = resolve; }));
  const user = userEvent.setup(); await screen.findByRole('dialog');
  const subject = screen.getByRole('textbox', { name: 'Subject' }); const due = screen.getByLabelText('Due');
  const assignee = screen.getByRole('combobox', { name: 'Assignee' }); const type = screen.getByRole('combobox', { name: 'Type' });
  const priority = screen.getByRole('combobox', { name: 'Priority' }); const body = screen.getByRole('textbox', { name: 'Details' });
  expect(type).toBeEnabled(); const initialDue = (due as HTMLInputElement).value;
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(state.writes()).toHaveLength(1));
  for (const control of [subject, due, assignee, type, priority, body]) expect(control).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  await user.type(subject, ' discarded edit'); await user.type(due, '2025-08-20T13:45');
  await user.type(assignee, 'Ola'); await user.type(body, ' discarded notes');
  await user.click(type); await user.keyboard('{ArrowDown}');
  expect(screen.queryByRole('option', { name: 'Meeting' })).not.toBeInTheDocument();
  await user.click(priority); await user.keyboard('{ArrowDown}');
  expect(screen.queryByRole('option', { name: 'Low' })).not.toBeInTheDocument();
  expect(subject).toHaveValue('Review technical observation'); expect(due).toHaveValue(initialDue);
  expect(assignee).toHaveValue('Kari Nordmann'); expect(body).toHaveValue('Local work notes');
  await act(async () => finish(response(activity('2025-07-15T09:15:23.456Z'))));
  await waitFor(() => expect(state.onClose).toHaveBeenCalledOnce()); expect(state.writes()).toHaveLength(1);
});
