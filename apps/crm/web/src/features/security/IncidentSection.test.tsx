import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { page, renderRoutes, testUser } from '../../test/renderWithProviders';
import { alertPage, alertRead, syntheticAlert } from '../../test/alerts';
import { AlertDetailDrawer } from '../service/alerts/AlertDetailDrawer';
import type { MachineDetail } from '../service/types';
import type { Incident, Remediation } from './types';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const empty = { items: [], nextCursor: null, totalCount: 0 };
const writer = ['service.read', 'service.write'];

/** A Huntress incident's alert of the synthetic customer, on PC-17 (M41). */
const alert = syntheticAlert({
  id: 'h1', system: 'huntress', kind: 'Security', externalId: 'incident:7001', title: 'HIGH - Incident on PC-17 (Fjord IT AS)', deviceName: 'PC-17',
  machineId: 'm1',
});

const step = (externalId: number, overrides: Partial<Remediation> = {}): Remediation => ({
  externalId, type: 'assisted', action: 'Delete scheduled task', details: [], status: 'unapproved', approvedAt: null, approvedBy: null, completedAt: null,
  ...overrides,
});

/** The incident as the security mirror has it: sent to the partner with one assisted and one manual step waiting. */
const incident = (overrides: Partial<Incident> = {}): Incident => ({
  id: 'i1', system: 'huntress', externalId: 7001, organizationId: 'o1', organizationName: 'Fjord IT AS', externalOrganizationId: 501,
  agentExternalId: '4711', deviceName: 'PC-17', status: 'sent', isOpen: true, severity: 'high', subject: 'HIGH - Incident on PC-17 (Fjord IT AS)',
  summary: 'Huntress detected a malicious scheduled task on PC-17.', body: 'Autorun found: C:\\Users\\Public\\synthetic.exe', platform: 'windows',
  indicators: [{ type: 'footholds', count: 2 }, { type: 'process_detections', count: 1 }],
  sentAt: '2026-10-21T06:00:00Z', closedAt: null, updatedAt: '2026-10-21T06:05:00Z', url: null, readAt: '2026-10-22T08:00:00Z',
  remediationsReadAt: '2026-10-22T08:00:00Z', commentsReadAt: '2026-10-22T08:00:00Z',
  remediations: [
    step(11, { details: [{ name: 'task', value: '\\Synthetic\\Updater' }] }),
    step(12, { type: 'manual', action: 'Reset the password of the user' }),
  ],
  comments: [{ externalId: 31, body: 'We are looking at it.', author: 'Huntress SOC', createdAt: '2026-10-21T07:00:00Z', updatedAt: null }],
  ...overrides,
});

/** PC-17 as its card has it: one Huntress agent, not isolated. */
const machine = (isolation = 'Disabled'): MachineDetail => ({
  id: 'm1', organizationId: 'o1', organizationName: 'Fjord IT AS', name: 'PC-17', type: 'Workstation', os: 'Windows 11 Pro', online: true,
  lastSeenAt: '2026-10-22T07:55:00Z', removedAt: null, openAlerts: 1, proposals: [], reads: [], etag: '"AAAAAAAAM1E="',
  devices: [{
    id: 'dev-h', system: 'huntress', externalId: '4711', machineName: 'PC-17', type: 'Workstation', os: 'Windows 11 Pro', online: true,
    lastSeenAt: '2026-10-22T07:55:00Z', firstSeenAt: '2026-09-01T08:00:00Z', removedAt: null, url: null,
    inventory: {
      vendor: null, model: null, serialNumber: null, motherboard: null, processor: null, processorCores: null, processorClock: null, memory: null,
      biosVersion: null, osVersion: null, osBuild: '22631', lastRebootAt: null, ipAddresses: ['10.0.0.17'], publicIp: null, macAddresses: [],
      domainName: null, loggedInUsers: null, lastLoginUser: null, disks: [], agentVersion: '0.13.140',
    },
    patches: { readAt: null, collectedAt: null, installedCount: 0, available: [], latestInstalled: [] },
    protection: {
      platform: 'windows', antivirusStatus: 'Healthy', antivirusSubstatus: null, antivirusPolicyStatus: null, antivirusReportedAt: null, isolation,
      agentVersionSince: '2026-10-01T08:00:00Z',
    },
  }],
});

const kindsOf = (enabled: string[]) => enabled.map((kind) => ({
  system: 'huntress', kind, targetType: kind.startsWith('agent.') ? 'device' : 'alert', level: 'Standard', simulated: false, limitedToCustomers: false,
}));

/** The server's preview of whatever the dialog asks: nothing blocks it, one button confirms it. */
const preview = (request: { kind: string; targetType: string; targetId: string }) => ({
  previewToken: 'signed-token', expiresAt: '2026-10-22T08:10:00Z', system: 'huntress', kind: request.kind, level: 'Standard',
  target: { type: request.targetType, id: request.targetId, name: 'HIGH - Incident on PC-17 (Fjord IT AS)', organizationId: 'o1', organizationName: 'Fjord IT AS',
    externalCustomerId: '501', url: null },
  effects: [], block: null, confirmation: { reason: false, typedName: false, freshSignIn: false, holdSeconds: 0 }, simulated: false, paused: false,
});

const action = (status: string) => ({
  id: 'act-1', system: 'huntress', kind: 'incident.comment', level: 'Standard', targetType: 'alert', targetId: 'incident:7001',
  targetName: 'HIGH - Incident on PC-17 (Fjord IT AS)', organizationId: 'o1', organizationName: 'Fjord IT AS', parameters: {}, reason: null, status,
  outcomeCode: status === 'Succeeded' ? 'VND_SENT' : null, outcome: null, reference: null, attempts: 0, requestedBy: 'u1', requestedByName: 'Kari Nordmann',
  requestedAt: '2026-10-22T08:00:00Z', notBefore: '2026-10-22T08:00:00Z', startedAt: null, completedAt: null, closedBy: null, closedByName: null,
  closedAt: null, closeReason: null, ticketId: null, vendorUrl: null, etag: '"v1"',
});

afterEach(() => vi.unstubAllGlobals());

function show(options: { incident?: Incident; kinds?: string[]; isolation?: string; permissions?: string[] } = {}) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/v1/actions/kinds')) return json(kindsOf(options.kinds ?? []));
    if (url === '/api/v1/actions/preview' && init?.method === 'POST') return json(preview(JSON.parse(String(init.body))));
    if (url === '/api/v1/actions' && init?.method === 'POST') return json(action('Queued'), 202);
    if (url === '/api/v1/actions/act-1') return json(action('Succeeded'));
    if (url.startsWith('/api/v1/actions?')) return json({ ...empty, uncertain: 0, waiting: 0 });
    if (url === '/api/v1/service/alerts/h1') return json({ ...alert, etag: '"AAAAAAAAH1E="' });
    if (url === '/api/v1/service/alerts?limit=1') return json(alertPage([], null, 0, [alertRead({ system: 'huntress' })]));
    if (url === '/api/v1/security/huntress/incidents/7001') return json(options.incident ?? incident());
    if (url === '/api/v1/service/machines/m1') return json(machine(options.isolation));
    return json(empty);
  });
  vi.stubGlobal('fetch', fetch);
  renderRoutes([page(<AlertDetailDrawer alertId="h1" onClose={() => {}} />)], '/', testUser(options.permissions ?? writer));
  return fetch;
}

const section = async () => within(await screen.findByRole('region', { name: 'Security incident' }));

/** The body of the one preview the dialog asked for. */
async function previewed(fetch: ReturnType<typeof show>) {
  await waitFor(() => expect(fetch.mock.calls.some(([url]) => url === '/api/v1/actions/preview')).toBe(true));
  const [, init] = fetch.mock.calls.findLast(([url]) => url === '/api/v1/actions/preview')!;
  return JSON.parse(String(init!.body)) as { system: string; kind: string; targetType: string; targetId: string; parameters: Record<string, unknown> };
}

describe('A Huntress incident in its alert’s panel (M41)', () => {
  it('shows what the SOC wrote, the indicators with their counts and the plan with who does each step and where it stands', async () => {
    show();
    const incidentSection = await section();
    expect(await incidentSection.findByText('Huntress detected a malicious scheduled task on PC-17.')).toBeVisible();
    expect(incidentSection.getByText('Waiting for you')).toBeVisible();
    const chips = within(incidentSection.getByRole('list', { name: 'Indicators' })).getAllByRole('listitem');
    expect(chips.map((chip) => chip.textContent)).toEqual(['Footholds 2', 'Process detections 1']);

    const steps = incidentSection.getAllByRole('listitem').filter((item) => item.querySelector('dl') || /Reset the password/.test(item.textContent ?? ''));
    const deleteTask = within(steps.find((item) => /Delete scheduled task/.test(item.textContent ?? ''))!);
    expect(deleteTask.getByText('Huntress does it')).toBeVisible();
    expect(deleteTask.getByText('Waiting for approval')).toBeVisible();
    expect(deleteTask.getByText('task')).toBeVisible();
    expect(deleteTask.getByText('\\Synthetic\\Updater')).toBeVisible();
    const reset = within(steps.find((item) => /Reset the password/.test(item.textContent ?? ''))!);
    expect(reset.getByText('You do it')).toBeVisible();
    // The comments as last read, the SOC's among them.
    expect(incidentSection.getByText('We are looking at it.')).toBeVisible();
    expect(incidentSection.getByText('Huntress SOC')).toBeVisible();
    // The machine's isolation is part of the incident: its card is read for it.
    expect(await incidentSection.findByRole('heading', { name: 'Device PC-17' })).toBeVisible();
  });

  it('offers approving and sending back only while Huntress waits for an answer to the plan and the kinds are switched on', async () => {
    show({ kinds: ['incident.approve', 'incident.reject', 'incident.resolve'] });
    let incidentSection = await section();
    expect(await incidentSection.findByRole('button', { name: 'Approve plan' })).toBeVisible();
    expect(incidentSection.getByRole('button', { name: 'Send plan back…' })).toBeVisible();
    // Something still waits for approval: Huntress resolves only an approved plan.
    expect(incidentSection.queryByRole('button', { name: 'Close in Huntress' })).not.toBeInTheDocument();
    document.body.innerHTML = '';

    show({ kinds: [] });
    incidentSection = await section();
    await incidentSection.findByText('Huntress detected a malicious scheduled task on PC-17.');
    expect(incidentSection.queryByRole('button', { name: 'Approve plan' })).not.toBeInTheDocument();
    expect(incidentSection.queryByRole('button', { name: 'Send plan back…' })).not.toBeInTheDocument();
  });

  it('offers nothing about the plan of a draft back at the SOC, and says so, nor of an incident Huntress closed', async () => {
    const all = ['incident.approve', 'incident.reject', 'incident.resolve', 'incident.step'];
    show({ kinds: all, incident: incident({ status: 'draft' }) });
    let incidentSection = await section();
    expect(await incidentSection.findByText(/Huntress’s SOC is revising the plan after it was sent back/)).toBeVisible();
    expect(incidentSection.getByText('Back with the SOC')).toBeVisible();
    expect(incidentSection.queryByRole('button', { name: 'Approve plan' })).not.toBeInTheDocument();
    expect(incidentSection.queryByRole('button', { name: 'Send plan back…' })).not.toBeInTheDocument();
    document.body.innerHTML = '';

    show({ kinds: all, incident: incident({ status: 'closed', isOpen: false, closedAt: '2026-10-22T07:00:00Z' }) });
    incidentSection = await section();
    expect(await incidentSection.findByText('Closed in Huntress')).toBeVisible();
    for (const name of ['Approve plan', 'Send plan back…', 'Close in Huntress', 'Mark as done']) {
      expect(incidentSection.queryByRole('button', { name })).not.toBeInTheDocument();
    }
  });

  it('offers resolving once nothing waits for approval, and asks for it through the one confirmation', async () => {
    const fetch = show({
      kinds: ['incident.approve', 'incident.resolve'],
      incident: incident({ remediations: [step(11, { status: 'completed', completedAt: '2026-10-21T09:00:00Z', approvedAt: '2026-10-21T08:00:00Z',
        approvedBy: 'Kari Nordmann' })] }),
    });
    const incidentSection = await section();
    expect(await incidentSection.findByText(/^Approved by Kari Nordmann .* · Done /)).toBeVisible();
    expect(incidentSection.queryByRole('button', { name: 'Approve plan' })).not.toBeInTheDocument();
    await userEvent.click(await incidentSection.findByRole('button', { name: 'Close in Huntress' }));
    expect(await screen.findByRole('dialog', { name: 'Close the incident in Huntress' })).toBeVisible();
    expect(await previewed(fetch)).toEqual({ system: 'huntress', kind: 'incident.resolve', targetType: 'alert', targetId: 'incident:7001', parameters: {} });
  });

  it('approves the plan as it stands, with the incident’s alert as the target', async () => {
    const fetch = show({ kinds: ['incident.approve'] });
    await userEvent.click(await (await section()).findByRole('button', { name: 'Approve plan' }));
    expect(await screen.findByRole('dialog', { name: 'Approve the remediation plan in Huntress' })).toBeVisible();
    expect(await previewed(fetch)).toEqual({ system: 'huntress', kind: 'incident.approve', targetType: 'alert', targetId: 'incident:7001', parameters: {} });
  });

  it('sends a plan back only with an explanation, a reason of Huntress’s list and whether it helped', async () => {
    const user = userEvent.setup();
    const fetch = show({ kinds: ['incident.reject'] });
    const toggle = await (await section()).findByRole('button', { name: 'Send plan back…' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    const form = within(screen.getByRole('group', { name: 'Send plan back…' }));
    const reasons = form.getByRole('combobox', { name: 'Why' });
    // A disclosure: it stays, says it is open, and focus moves into the form's first field.
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(reasons).toHaveFocus());
    // No reason is chosen for the person: the list starts with a prompt that cannot be sent.
    expect(within(reasons).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Choose a reason', 'The application is approved', 'Already fixed by hand', 'The device was reinstalled', 'We were testing the security controls', 'Something else']);
    expect(reasons).toHaveValue('');

    await user.click(form.getByRole('button', { name: 'Send back…' }));
    expect(await form.findByText('Choose why the plan goes back.')).toBeVisible();
    expect(form.getByText('Write what the SOC should know.')).toBeVisible();
    expect(fetch.mock.calls.some(([url]) => url === '/api/v1/actions/preview')).toBe(false);

    await user.selectOptions(reasons, 'Already fixed by hand');
    await user.type(form.getByRole('textbox', { name: /What should the SOC know\?/ }), 'The task was removed by hand yesterday.');
    await user.click(form.getByRole('checkbox', { name: 'The plan was useful' }));
    await user.click(form.getByRole('button', { name: 'Send back…' }));

    const dialog = await screen.findByRole('dialog', { name: 'Send the plan back to Huntress’s SOC' });
    expect(within(dialog).getByText(/Already fixed by hand\s+The task was removed by hand yesterday\./)).toBeVisible();
    expect(await previewed(fetch)).toEqual({
      system: 'huntress', kind: 'incident.reject', targetType: 'alert', targetId: 'incident:7001',
      parameters: { reason: 'manually_remediated', comment: 'The task was removed by hand yesterday.', useful: true },
    });
  });

  it('offers the Microsoft 365 reasons for an incident in Microsoft 365', async () => {
    const user = userEvent.setup();
    show({ kinds: ['incident.reject'], incident: incident({ platform: 'microsoft_365' }) });
    await user.click(await (await section()).findByRole('button', { name: 'Send plan back…' }));
    const reasons = within(screen.getByRole('group', { name: 'Send plan back…' })).getByRole('combobox', { name: 'Why' });
    expect(within(reasons).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Choose a reason', 'The login location is approved', 'The forwarding rule is approved', 'The application is approved', 'Already fixed by hand',
      'We were testing the security controls', 'The VPN or proxy is approved', 'Something else']);

    // Cancel closes the form and gives focus back to the button that opened it.
    await user.click(within(screen.getByRole('group', { name: 'Send plan back…' })).getByRole('button', { name: 'Cancel' }));
    const toggle = (await section()).getByRole('button', { name: 'Send plan back…' });
    expect(screen.queryByRole('group', { name: 'Send plan back…' })).not.toBeInTheDocument();
    await waitFor(() => expect(toggle).toHaveFocus());
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('marks a manual step done, or not done again, and offers no mark for a step Huntress carries out', async () => {
    const user = userEvent.setup();
    const fetch = show({ kinds: ['incident.step'] });
    const incidentSection = await section();
    const reset = (await incidentSection.findByText('Reset the password of the user')).closest('li')!;
    const assisted = incidentSection.getByText('Delete scheduled task').closest('li')!;
    expect(within(assisted).queryByRole('button', { name: 'Mark as done' })).not.toBeInTheDocument();
    await user.click(await within(reset).findByRole('button', { name: 'Mark as done' }));
    expect(await screen.findByRole('dialog', { name: 'Mark the step as done in Huntress' })).toBeVisible();
    expect(await previewed(fetch)).toEqual({
      system: 'huntress', kind: 'incident.step', targetType: 'alert', targetId: 'incident:7001', parameters: { remediation: 12, completed: true },
    });
    document.body.innerHTML = '';

    const again = show({ kinds: ['incident.step'], incident: incident({ remediations: [step(12, { type: 'manual', action: 'Reset the password of the user',
      status: 'completed', completedAt: '2026-10-21T09:00:00Z' })] }) });
    const done = (await (await section()).findByText('Reset the password of the user')).closest('li')!;
    expect(within(done).getByText('Done')).toBeVisible();
    await user.click(await within(done).findByRole('button', { name: 'Mark as not done' }));
    expect(await screen.findByRole('dialog', { name: 'Mark the step as not done in Huntress' })).toBeVisible();
    expect((await previewed(again)).parameters).toEqual({ remediation: 12, completed: false });
  });

  it('adds a comment through the confirmation and empties the box once the command is saved', async () => {
    const user = userEvent.setup();
    const fetch = show({ kinds: ['incident.comment'] });
    const incidentSection = await section();
    const box = await incidentSection.findByRole('textbox', { name: 'New comment' });
    expect(incidentSection.getByText(/Huntress’s SOC is not told\./)).toBeVisible();
    await user.type(box, '  We reinstalled PC-17.  ');
    await user.click(incidentSection.getByRole('button', { name: 'Add comment' }));

    const dialog = await screen.findByRole('dialog', { name: 'Add a comment to the incident in Huntress' });
    expect(await previewed(fetch)).toEqual({
      system: 'huntress', kind: 'incident.comment', targetType: 'alert', targetId: 'incident:7001', parameters: { text: 'We reinstalled PC-17.' },
    });
    expect(within(dialog).getByText('We reinstalled PC-17.')).toBeVisible();
    await user.click(await within(dialog).findByRole('button', { name: 'Add comment' }));
    await waitFor(() => expect(fetch.mock.calls.some(([url, init]) => url === '/api/v1/actions' && init?.method === 'POST')).toBe(true));
    await waitFor(() => expect(box).toHaveValue(''));
  });

  it('keeps Huntress’s own detail behind a button that says whether it is open', async () => {
    const user = userEvent.setup();
    show();
    const incidentSection = await section();
    const toggle = await incidentSection.findByRole('button', { name: 'Show Huntress’s details' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(incidentSection.queryByText(/Autorun found/)).not.toBeInTheDocument();
    await user.click(toggle);
    expect(incidentSection.getByRole('button', { name: 'Hide Huntress’s details' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(incidentSection.getByRole('region', { name: 'Huntress’s details of the incident' })).getByText(/Autorun found: C:\\Users\\Public\\synthetic\.exe/))
      .toBeVisible();
  });

  it('gives a person who may only read the incident without a single way to change it', async () => {
    show({ kinds: ['incident.approve', 'incident.reject', 'incident.step', 'incident.comment'], permissions: ['service.read'] });
    const incidentSection = await section();
    await incidentSection.findByText('Huntress detected a malicious scheduled task on PC-17.');
    expect(incidentSection.queryByRole('button', { name: 'Approve plan' })).not.toBeInTheDocument();
    expect(incidentSection.queryByRole('button', { name: 'Mark as done' })).not.toBeInTheDocument();
    expect(incidentSection.queryByRole('textbox', { name: 'New comment' })).not.toBeInTheDocument();
  });
});
