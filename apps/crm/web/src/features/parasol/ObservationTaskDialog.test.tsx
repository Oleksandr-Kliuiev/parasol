import { afterEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { atlasTaskPreview, syntheticTask } from '../../test/atlasTask';
import { atlasWorkspace } from '../../test/atlasWorkspace';
import { CustomerWorkspacePanel } from './CustomerWorkspacePanel';
import { ObservationRows } from './ObservationRows';
import { ObservationTaskDialog } from './ObservationTaskDialog';
import { AtlasTaskSourceButton } from './AtlasTaskSourceButton';
import { invalidTaskPreview, parseTaskOutcome, parseTaskPreview, type ObservationTaskPreview } from './observationTaskContract';

const permissions = ['activities.write', 'activities.read', 'parasol.atlas.read', 'users.read'];
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const users = { items: [{ id: 'u2', displayName: 'Synthetic technician', email: null, isActive: true }], nextCursor: null, totalCount: 1 };
function setup(preview = atlasTaskPreview(), post: unknown = { customerId: 'customer-one', status: 'CREATED', task: { ...syntheticTask, created: true } }) {
  const fetch = vi.fn(async (url: string, init: RequestInit) => response(url.startsWith('/api/v1/identity/users') ? users : init.method === 'POST' ? post : preview));
  vi.stubGlobal('fetch', fetch);
  renderRoutes([page(<StrictMode><ObservationTaskDialog customerId="customer-one" observationId="critical-one" allowCreate onClose={vi.fn()} /></StrictMode>)], '/', testUser(permissions));
  return fetch;
}
async function selectAndConfirm() {
  const dialog = within(await screen.findByRole('dialog', { name: 'Assign observation work' }));
  await userEvent.click(await dialog.findByRole('combobox'));
  await userEvent.click(await screen.findByRole('option', { name: 'Synthetic technician' }));
}
afterEach(() => vi.unstubAllGlobals());

describe('assigning local CRM work from an Atlas observation', () => {
  it.each([
    [['activities.write'], false], [['parasol.atlas.read'], false], [permissions, true],
  ])('offers active assignment only with both technical and write permissions (%j)', async (allowed, shown) => {
    const fetch = vi.fn<(url: string) => Promise<Response>>(async () => response({ customerId: 'customer-one', status: 'READY', items: [] }));
    vi.stubGlobal('fetch', fetch); const p = atlasTaskPreview();
    renderRoutes([page(<ObservationRows items={[p.observation!]} devices={p.devices!} customerId="customer-one" />)], '/', testUser(allowed));
    expect(screen.queryByRole('button', { name: 'Assign work' }) !== null).toBe(shown);
    // Showing the row reads at most the page's task links, never the source preview.
    await waitFor(() => expect(fetch.mock.calls.map(([url]) => String(url)).every(url => url.includes('/observation-tasks?'))).toBe(true));
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/task-preview'))).toBe(false);
  });

  it('reads an exact preview before writing, names what it creates and sends only assignment, due and hash', async () => {
    const fetch = setup(); await screen.findByText('Synthetic disk capacity used: 97%');
    expect(screen.getByRole('button', { name: 'Create task' })).toBeDisabled();
    expect(screen.getByText('Task subject: Review technical observation')).toBeVisible(); expect(screen.getByText('Task priority: High')).toBeVisible();
    // No check box: the dialog and one sentence beside the button say exactly what will be created.
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    await selectAndConfirm(); expect(screen.getByRole('button', { name: 'Create task' })).toBeEnabled();
    expect(screen.getByText('Creates a task for Synthetic technician with no due date, priority high.')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Due date (optional)'), { target: { value: '2026-10-18T10:30' } });
    const summary = screen.getByText(/^Creates a task for Synthetic technician, due 18\/10\/2026, 10:30, priority high\.$/);
    expect(screen.getByRole('button', { name: 'Create task' })).toHaveAttribute('aria-describedby', summary.id);
    await userEvent.click(screen.getByRole('button', { name: 'Create task' }));
    expect(await screen.findByText('Task created.')).toBeVisible();
    const writes = fetch.mock.calls.filter(([, init]) => init.method === 'POST'); expect(writes).toHaveLength(1);
    expect(writes[0]![0]).toBe('/api/v1/parasol/customers/customer-one/observations/critical-one/task');
    expect(JSON.parse(writes[0]![1].body as string)).toEqual({ assigneeId: 'u2', dueAt: new Date('2026-10-18T10:30').toISOString(), expectedSha256: 'a'.repeat(64) });
    expect(writes[0]![1].body).not.toMatch(/summary|hostname|source|priority|subject|device/);
    expect(screen.getByRole('link', { name: 'Open task' })).toHaveAttribute('href', '/organizations/customer-one?tab=activities&activityId=task-one');
  });

  it('returns existing work without replacing its assignment, due date or completed state', async () => {
    const old = { ...syntheticTask, status: 'Done' as const, assigneeId: 'another-employee', dueAt: '2026-10-12T08:00:00Z' };
    const fetch = setup(atlasTaskPreview(), { customerId: 'customer-one', status: 'EXISTING', task: old });
    await selectAndConfirm(); await userEvent.click(screen.getByRole('button', { name: 'Create task' }));
    expect(await screen.findByText('Existing linked task returned; no assignment or due date was changed.')).toBeVisible();
    expect(screen.getByText('Task state: Done')).toBeVisible(); expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  });

  it('shows terminal linked work without offering task creation', async () => {
    const p = atlasTaskPreview(); p.observation!.status = 'RESOLVED'; p.canCreate = false; p.task = syntheticTask;
    vi.stubGlobal('fetch', vi.fn(async () => response(p)));
    renderRoutes([page(<ObservationRows items={[p.observation!]} devices={p.devices!} customerId="customer-one" />)], '/', testUser(['activities.read', 'parasol.atlas.read']));
    expect(screen.queryByRole('button', { name: 'Assign work' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'View linked work' }));
    expect(await screen.findByText('Task state: Open')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Create task' })).not.toBeInTheDocument(); expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('does not navigate to an unavailable task or create a replacement', async () => {
    const p = atlasTaskPreview(); p.canCreate = false; p.task = { ...syntheticTask, isAvailable: false, assigneeId: null, dueAt: null };
    setup(p); expect(await screen.findByText(/The linked task is no longer available/)).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Open task' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create task' })).not.toBeInTheDocument();
  });

  it('requires fresh preview after a lost write response and discovers the existing task without resubmission', async () => {
    let attempts = 0;
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url.startsWith('/api/v1/identity/users')) return response(users);
      if (init.method === 'POST') { attempts++; throw new TypeError('synthetic-private-upstream-message'); }
      const p = atlasTaskPreview(); if (attempts) { p.task = syntheticTask; p.canCreate = false; } return response(p);
    });
    vi.stubGlobal('fetch', fetch); renderRoutes([page(<ObservationTaskDialog customerId="customer-one" observationId="critical-one" allowCreate onClose={vi.fn()} />)], '/', testUser(permissions));
    await selectAndConfirm(); await userEvent.click(screen.getByRole('button', { name: 'Create task' }));
    expect(await screen.findByText(/The task outcome is uncertain/)).toBeVisible();
    expect(screen.queryByText('Synthetic disk capacity used: 97%')).not.toBeInTheDocument();
    expect(screen.queryByText(/synthetic-private/)).not.toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Create task' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Read fresh preview' }));
    expect(await screen.findByText('Task state: Open')).toBeVisible(); expect(attempts).toBe(1);
    expect(screen.queryByRole('button', { name: 'Create task' })).not.toBeInTheDocument();
  });

  it('offers no creation after a fresh preview finds the source terminal', async () => {
    let terminal = false;
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith('/api/v1/identity/users')) return response(users);
      const p = atlasTaskPreview(); if (terminal) { p.observation!.status = 'RESOLVED'; p.canCreate = false; p.sha256 = 'b'.repeat(64); } return response(p);
    });
    vi.stubGlobal('fetch', fetch); renderRoutes([page(<ObservationTaskDialog customerId="customer-one" observationId="critical-one" allowCreate onClose={vi.fn()} />)], '/', testUser(permissions));
    await selectAndConfirm(); expect(screen.getByRole('button', { name: 'Create task' })).toBeEnabled();
    terminal = true; await userEvent.click(screen.getByRole('button', { name: 'Read fresh preview' }));
    expect(await screen.findByText(/No new task can be created from this observation/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Create task' })).toBeDisabled();
    expect(screen.queryByRole('group', { name: 'Quick due dates' })).not.toBeInTheDocument();
    expect(fetch.mock.calls.map(([url]) => url).filter(url => url.endsWith('/task'))).toHaveLength(0);
  });

  it('assigns to the signed-in employee in one step when the server would accept them', async () => {
    const fetch = setup(); await screen.findByText('Synthetic disk capacity used: 97%');
    await userEvent.click(screen.getByRole('button', { name: 'Assign to me' }));
    expect(screen.getByRole('button', { name: 'Assign to me' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('combobox')).toHaveValue('Kari Nordmann');
    expect(screen.getByText('Creates a task for Kari Nordmann with no due date, priority high.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Create task' }));
    expect(await screen.findByText('Task created.')).toBeVisible();
    const write = fetch.mock.calls.find(([, init]) => init.method === 'POST')!;
    expect(JSON.parse(write[1].body as string).assigneeId).toBe('u1');
  });

  it('fills the due date from a shortcut at the end of the working day and clears it again', async () => {
    setup(); await screen.findByText('Synthetic disk capacity used: 97%');
    const shortcuts = within(screen.getByRole('group', { name: 'Quick due dates' }));
    await userEvent.click(shortcuts.getByRole('button', { name: 'Tomorrow 16:00' }));
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    const pad = (n: number) => String(n).padStart(2, '0');
    expect(screen.getByLabelText('Due date (optional)')).toHaveValue(`${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}T16:00`);
    expect(shortcuts.getByRole('button', { name: 'Tomorrow 16:00' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(shortcuts.getByRole('button', { name: 'No due date' }));
    expect(screen.getByLabelText('Due date (optional)')).toHaveValue('');
  });

  it('treats an invalid write response as uncertain and prevents repeated creation', async () => {
    const fetch = setup(atlasTaskPreview(), { customerId: 'customer-one', status: 'CREATED', task: { ...syntheticTask, created: true }, token: 'synthetic-private' });
    await selectAndConfirm(); await userEvent.click(screen.getByRole('button', { name: 'Create task' }));
    expect(await screen.findByText(/The task outcome is uncertain/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Create task' })).toBeDisabled();
    expect(screen.queryByRole('link', { name: 'Open task' })).not.toBeInTheDocument();
    expect(screen.queryByText(/synthetic-private/)).not.toBeInTheDocument(); expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  });

  it.each(['PARASOL_TASK_SOURCE_CHANGED', 'PARASOL_TASK_SOURCE_TERMINAL', 'ACT_SOURCE_TASK_ASSIGNEE_INVALID'])('clears preview after %s without retrying the write', async code => {
    const fetch = vi.fn(async (url: string, init: RequestInit) => response(url.startsWith('/api/v1/identity/users') ? users
      : init.method === 'POST' ? { code, detail: 'synthetic-private-error' } : atlasTaskPreview(), init.method === 'POST' ? 409 : 200));
    vi.stubGlobal('fetch', fetch); renderRoutes([page(<ObservationTaskDialog customerId="customer-one" observationId="critical-one" allowCreate onClose={vi.fn()} />)], '/', testUser(permissions));
    await selectAndConfirm(); await userEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(screen.queryByText('Synthetic disk capacity used: 97%')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Create task' })).toBeDisabled(); expect(screen.queryByText(/synthetic-private/)).not.toBeInTheDocument();
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  });

  it('cancels preview on close and ignores the late reply after reopening', async () => {
    let signal: AbortSignal | undefined; let finish!: (r: Response) => void; let reads = 0;
    const fetch = vi.fn((url: string, init: RequestInit) => {
      if (url.startsWith('/api/v1/identity/users')) return Promise.resolve(response(users));
      if (url.includes('/observation-tasks?')) return Promise.resolve(response({ customerId: 'customer-one', status: 'READY', items: [] }));
      if (++reads === 1) { signal = init.signal as AbortSignal; return new Promise<Response>(resolve => { finish = resolve; }); }
      const p = invalidTaskPreview('customer-one'); p.status = 'ACCESS_DENIED'; return Promise.resolve(response(p));
    });
    vi.stubGlobal('fetch', fetch); const p = atlasTaskPreview();
    renderRoutes([page(<ObservationRows items={[p.observation!]} devices={p.devices!} customerId="customer-one" />)], '/', testUser(permissions));
    await userEvent.click(screen.getByRole('button', { name: 'Assign work' })); await waitFor(() => expect(signal).toBeDefined());
    await userEvent.click(screen.getByRole('button', { name: 'Close' })); expect(signal!.aborted).toBe(true);
    await act(async () => finish(response(atlasTaskPreview())));
    await userEvent.click(screen.getByRole('button', { name: 'Assign work' }));
    expect(await screen.findByText('Your access does not permit reading this Atlas source.')).toBeVisible();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument(); expect(reads).toBe(2);
  });

  it('invalidates the parent when the exact source read denies access', async () => {
    const callback = vi.fn(); const p = invalidTaskPreview('customer-one'); p.status = 'IDENTITY_CHANGED';
    vi.stubGlobal('fetch', vi.fn(async () => response(p)));
    renderRoutes([page(<ObservationTaskDialog customerId="customer-one" observationId="critical-one" allowCreate onClose={vi.fn()} onSourceInvalidated={callback} />)], '/', testUser(permissions));
    await waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('rechecks the whole workspace after a write cannot verify source access and removes its old devices', async () => {
    let revoked = false;
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url.startsWith('/api/v1/identity/users')) return response(users);
      if (init.method === 'POST') { revoked = true; return response({ code: 'PARASOL_TASK_SOURCE_UNAVAILABLE', status: 409 }, 409); }
      if (url.endsWith('/workspace')) return response(revoked ? { customerId: 'customer-one', status: 'ACCESS_DENIED', summary: null } : atlasWorkspace());
      return response(atlasTaskPreview());
    });
    vi.stubGlobal('fetch', fetch); renderRoutes([page(<CustomerWorkspacePanel customerId="customer-one" />)], '/', testUser(permissions));
    await screen.findByText('42'); await userEvent.click(screen.getAllByRole('button', { name: 'Assign work' })[0]!);
    await selectAndConfirm(); await userEvent.click(screen.getByRole('button', { name: 'Create task' }));
    expect(await screen.findByText('Your Atlas access does not permit reading this customer.')).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Assign observation work' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Atlas devices' })).not.toBeInTheDocument();
    expect(screen.queryByText('42')).not.toBeInTheDocument(); expect(screen.queryByText('Synthetic disk capacity used: 97%')).not.toBeInTheDocument();
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/workspace'))).toHaveLength(2);
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  });

  it.each(['PARASOL_CUSTOMER_NOT_FOUND', 'PARASOL_IDENTITY_INCONSISTENT'])('invalidates the parent after a preview reports %s', async code => {
    const callback = vi.fn(); vi.stubGlobal('fetch', vi.fn(async () => response({ code }, code === 'PARASOL_CUSTOMER_NOT_FOUND' ? 404 : 409)));
    renderRoutes([page(<ObservationTaskDialog customerId="customer-one" observationId="critical-one" allowCreate onClose={vi.fn()} onSourceInvalidated={callback} />)], '/', testUser(permissions));
    expect(await screen.findByText('The customer link changed. Read the current source before assigning work.')).toBeVisible();
    await waitFor(() => expect(callback).toHaveBeenCalledTimes(1)); expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('keeps the parent when just this observation no longer exists', async () => {
    const callback = vi.fn(); const p = invalidTaskPreview('customer-one'); p.status = 'OBSERVATION_NOT_FOUND';
    vi.stubGlobal('fetch', vi.fn(async () => response(p)));
    renderRoutes([page(<ObservationTaskDialog customerId="customer-one" observationId="critical-one" allowCreate onClose={vi.fn()} onSourceInvalidated={callback} />)], '/', testUser(permissions));
    expect(await screen.findByText('This observation was not found in the current Atlas customer.')).toBeVisible();
    expect(callback).not.toHaveBeenCalled(); expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });
});

describe('personal read-only source viewing from CRM tasks', () => {
  it.each(['activities.read', 'parasol.atlas.read'])('hides the source action without both permissions (%j)', permission => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    renderRoutes([page(<AtlasTaskSourceButton activityId="task-one" />)], '/', testUser([permission]));
    expect(screen.queryByRole('button', { name: 'View Atlas source' })).not.toBeInTheDocument(); expect(fetch).not.toHaveBeenCalled();
  });
  it('reads source only after clicking, labels fixtures, renders plain text, and never offers a write', async () => {
    const p = atlasTaskPreview(); p.task = syntheticTask; p.canCreate = false; p.mode = 'fixture';
    p.observation!.summary = '<img src=x onerror=alert(1)>';
    const fetch = vi.fn(async (url: string) => { expect(url).toBe('/api/v1/parasol/activities/task-one/atlas-observation'); return response(p); }); vi.stubGlobal('fetch', fetch);
    renderRoutes([page(<AtlasTaskSourceButton activityId="task-one" />)], '/', testUser(['activities.read', 'parasol.atlas.read']));
    expect(fetch).not.toHaveBeenCalled(); await userEvent.click(screen.getByRole('button', { name: 'View Atlas source' }));
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeVisible(); expect(screen.getByText(/Synthetic demonstration data/)).toBeVisible();
    expect(screen.queryByRole('img')).not.toBeInTheDocument(); expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create task' })).not.toBeInTheDocument();
    expect(fetch.mock.calls[0]![0]).toBe('/api/v1/parasol/activities/task-one/atlas-observation');
  });
  it('removes previous source context after access is revoked, keeping no stored-text fallback', async () => {
    const p = atlasTaskPreview(); p.task = syntheticTask; p.canCreate = false; let denied = false;
    vi.stubGlobal('fetch', vi.fn(async () => { const failed = invalidTaskPreview('customer-one'); failed.status = 'ACCESS_DENIED'; return response(denied ? failed : p); }));
    renderRoutes([page(<AtlasTaskSourceButton activityId="task-one" />)], '/', testUser(['activities.read', 'parasol.atlas.read']));
    await userEvent.click(screen.getByRole('button', { name: 'View Atlas source' })); await screen.findByText('Synthetic disk capacity used: 97%');
    denied = true; await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Your access does not permit reading this Atlas source.')).toBeVisible();
    expect(screen.queryByText('Synthetic disk capacity used: 97%')).not.toBeInTheDocument(); expect(screen.queryByText(/Confirmed device:/)).not.toBeInTheDocument();
  });
});

describe('the closed personal task handoff contract', () => {
  it.each([
    ['unknown metadata', (p: ObservationTaskPreview) => { Object.assign(p.observation!, { rawPayload: 'synthetic-private' }); }],
    ['wrong observation', (p: ObservationTaskPreview) => { p.observation!.id = 'another'; }],
    ['missing fixture marker', (p: ObservationTaskPreview) => { p.mode = null; }],
    ['invalid digest', (p: ObservationTaskPreview) => { p.sha256 = 'bad'; }],
    ['terminal creation', (p: ObservationTaskPreview) => { p.observation!.status = 'RESOLVED'; }],
    ['existing creation', (p: ObservationTaskPreview) => { p.task = syntheticTask; }],
    ['foreign task', (p: ObservationTaskPreview) => { p.task = { ...syntheticTask, organizationId: 'other' }; p.canCreate = false; }],
    ['unverified device', (p: ObservationTaskPreview) => { p.observation!.deviceId = 'device-1'; }],
  ])('refuses %s before showing source or confirmation', (_name, change) => {
    const p = atlasTaskPreview(); change(p);
    expect(parseTaskPreview(p, { customerId: 'customer-one', observationId: 'critical-one' })).toEqual(invalidTaskPreview('customer-one'));
  });
  it('binds activity source reads to the clicked task and refuses unknown write fields', () => {
    const p = atlasTaskPreview(); p.task = syntheticTask; p.canCreate = false;
    expect(parseTaskPreview(p, { activityId: 'other-task' }).status).toBe('INVALID_RESPONSE');
    expect(parseTaskOutcome({ customerId: 'customer-one', status: 'CREATED', task: { ...syntheticTask, created: true }, payload: 'synthetic-private' }, 'customer-one').status).toBe('INVALID_RESPONSE');
    expect(parseTaskOutcome({ customerId: 'customer-one', status: 'CREATED', task: syntheticTask }, 'customer-one').status).toBe('INVALID_RESPONSE');
  });
});
