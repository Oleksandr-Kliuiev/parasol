import { expect, test, type Locator, type Page } from '@playwright/test';
import { ateraAgent, searchAlerts, storedMachines } from './atera';
import {
  changeHuntressIncident, huntressAgent, huntressAlerts, huntressEscalation, huntressEscalationState, huntressIncident, huntressIncidentState,
  linkedHuntressCustomer, syncHuntress, type HuntressCustomer,
} from './huntress';
import { api, signIn, toast } from './support';

// M41: Huntress in Parasoll through the stand-in and the real worker: incidents, escalations and platform actions are alerts with
// their detail in the panel, every answer goes through the one action confirmation, a machine Atera and Huntress both watch is one
// row, and the Drift tab shows what Huntress counts. Each test makes its own Huntress organization, linked as a person links it.
const SENT = 30_000;
const followUp = (dialog: Locator) => dialog.getByRole('status');

/** Reads the customer's Huntress alerts until `count` are open. */
async function syncIncidents(page: Page, customer: HuntressCustomer, count: number) {
  await syncHuntress(page, ['huntress-alerts'], async () => (await huntressAlerts(page, customer.organizationId)).length === count,
    `${count} Huntress alerts of ${customer.name}`);
}

/** Confirms an action in its dialog and waits for the worker's outcome, then closes the dialog. */
async function confirm(page: Page, title: string, button: string, reason?: string) {
  const dialog = page.getByRole('dialog', { name: title, exact: true });
  if (reason) await dialog.getByRole('textbox', { name: 'Reason' }).fill(reason);
  await dialog.getByRole('button', { name: button, exact: true }).click();
  await expect(followUp(dialog)).toContainText('Done', { timeout: SENT });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
}

test('an incident is answered from its alert: the plan approved, the manual step marked, the incident resolved', { tag: '@critical' }, async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page, 'Crm.Admin');
  const customer = await linkedHuntressCustomer(page, 'Inc');
  const m = customer.marker;
  const agent = await huntressAgent(page, customer, { hostname: `${m}-PC` });
  const incident = await huntressIncident(page, customer, {
    agent_id: agent.id, subject: `LOW - Incident on ${m}-PC`, summary: `${m}: a scheduled task starts an unknown program.`,
    remediations: [{ type: 'assisted', action: 'Delete scheduled task' }, { type: 'manual', action: 'Reset the password of the affected account' }],
  });
  await syncHuntress(page, ['huntress-agents'], async () => (await storedMachines(page, customer.organizationId)).length === 1, `the agent of ${customer.name}`);
  await syncIncidents(page, customer, 1);

  await page.goto('/alerts');
  await searchAlerts(page, m);
  const row = page.getByRole('row').filter({ has: page.getByRole('button', { name: `LOW - Incident on ${m}-PC`, exact: true }) });
  await expect(row).toContainText('Source: Huntress');
  await expect(row).toContainText('Warning');
  await page.getByRole('button', { name: `LOW - Incident on ${m}-PC`, exact: true }).click();
  const panel = page.getByRole('dialog', { name: `LOW - Incident on ${m}-PC`, exact: true });
  const incidentSection = panel.getByRole('region', { name: 'Security incident', exact: true });
  await expect(incidentSection.getByText('Waiting for you', { exact: true })).toBeVisible();
  await expect(incidentSection.getByText(`${m}: a scheduled task starts an unknown program.`)).toBeVisible();
  await expect(incidentSection.getByText('Footholds')).toBeVisible();

  // The plan: approve it, then mark the manual step done, then resolve the incident.
  await incidentSection.getByRole('button', { name: 'Approve plan', exact: true }).click();
  await confirm(page, 'Approve the remediation plan in Huntress', 'Approve plan');
  const manual = incidentSection.getByRole('listitem').filter({ hasText: 'Reset the password of the affected account' });
  await expect(manual.getByText('Approved', { exact: true })).toBeVisible();
  await manual.getByRole('button', { name: 'Mark as done', exact: true }).click();
  await confirm(page, 'Mark the step as done in Huntress', 'Mark as done');
  await expect(manual.getByText('Done', { exact: true })).toBeVisible();
  await incidentSection.getByRole('button', { name: 'Close in Huntress', exact: true }).click();
  await confirm(page, 'Close the incident in Huntress', 'Close in Huntress');

  await expect(panel.getByText('Resolved', { exact: true }).first()).toBeVisible({ timeout: SENT });
  const state = await huntressIncidentState(page, incident.id);
  expect(state.status).toBe('closed');
  expect(state.remediations.map((r) => r.status)).toEqual(['approved', 'completed']);
  expect((await huntressAlerts(page, customer.organizationId)).length).toBe(0);
});

test('an urgent incident Huntress closed waits in Parasoll until someone confirms the closing', { tag: '@critical' }, async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page, 'Crm.Admin');
  const customer = await linkedHuntressCustomer(page, 'Urg');
  const m = customer.marker;
  const incident = await huntressIncident(page, customer, { severity: 'critical', subject: `CRITICAL - Incident ${m}`, remediations: [] });
  await syncIncidents(page, customer, 1);

  await changeHuntressIncident(page, incident.id, { status: 'closed' });
  await syncHuntress(page, ['huntress-alerts'], async () => (await huntressAlerts(page, customer.organizationId))[0]?.sourceClosedAt != null,
    `the closing of ${customer.name}'s incident`);

  await page.goto('/alerts');
  await searchAlerts(page, m);
  const title = page.getByRole('button', { name: `CRITICAL - Incident ${m}`, exact: true });
  const row = page.getByRole('row').filter({ has: title });
  await expect(row).toContainText('Critical');
  await expect(row).toContainText(/Closed in Huntress .* – needs confirming/);
  await title.click();
  const panel = page.getByRole('dialog', { name: `CRITICAL - Incident ${m}`, exact: true });
  const own = panel.getByRole('region', { name: 'In Parasoll', exact: true });
  await expect(own.getByText(/^Huntress closed it .*\. Because it is urgent, it stays open in Parasoll until someone confirms it is dealt with\.$/)).toBeVisible();
  await own.getByRole('button', { name: 'Confirm closing', exact: true }).click();
  await expect(toast(page, 'The closing is confirmed')).toBeVisible();
  await expect.poll(async () => (await huntressAlerts(page, customer.organizationId, 'Resolved')).length).toBe(1);
  expect((await huntressAlerts(page, customer.organizationId)).length).toBe(0);
});

test('a computer Atera and Huntress both watch is one machine whose card shows Defender and isolates it', async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page, 'Crm.Admin');
  const customer = await linkedHuntressCustomer(page, 'Iso');
  const m = customer.marker;
  const keys = { serial: `SER-${m}`, mac: '00:1B:44:11:3A:B7' };
  await ateraAgent(page, customer, { MachineName: `${m}-PC`, OSType: 'Work Station', OS: 'Windows 11 Pro', VendorSerialNumber: keys.serial, MacAddresses: [keys.mac] });
  await huntressAgent(page, customer, {
    hostname: `${m}-PC`, serial_number: keys.serial, mac_addresses: [keys.mac], os: 'Windows 11 Pro', platform: 'windows',
    defender_status: 'Unhealthy', defender_substatus: 'Real-time protection off',
  });
  await syncHuntress(page, ['atera-agents', 'huntress-agents'], async () => {
    const machines = await storedMachines(page, customer.organizationId);
    return machines.length === 1 && machines[0]!.sources.length === 2;
  }, `one machine of ${customer.name} with both agents`);
  const [machine] = await storedMachines(page, customer.organizationId);

  await page.goto(`/organizations/${customer.organizationId}?tab=drift&device=${machine!.id}`);
  const card = page.getByRole('dialog', { name: `${m}-PC`, exact: true });
  const huntress = card.getByRole('listitem').filter({ hasText: 'Huntress' }).filter({ hasText: 'Defender' });
  await expect(huntress.getByText('Defender: Unhealthy · Real-time protection off')).toBeVisible();
  await expect(huntress.getByText('Not isolated', { exact: true })).toBeVisible();
  // Atera still describes the hardware and keeps the console section.
  await expect(card.getByRole('region', { name: 'In Atera', exact: true })).toBeVisible();

  await huntress.getByRole('button', { name: 'Isolate device…', exact: true }).click();
  await confirm(page, `Isolate ${m}-PC from the network`, 'Isolate', 'Ransomware suspected on the machine');
  await expect(card.getByText('Isolated from the network', { exact: true })).toBeVisible({ timeout: SENT });
  await card.getByRole('button', { name: 'Lift isolation…', exact: true }).click();
  await confirm(page, `Lift the isolation of ${m}-PC`, 'Lift isolation', 'The machine was cleaned and checked');
  await expect(card.getByText('Not isolated', { exact: true })).toBeVisible({ timeout: SENT });

  // The read of Huntress's agents also found Defender off: a coverage gap of Parasoll, in the reader's language.
  await page.goto('/alerts');
  await searchAlerts(page, m);
  await expect(page.getByRole('button', { name: `Microsoft Defender does not protect ${m}-PC: Unhealthy`, exact: true })).toBeVisible();
});

test('an access escalation is closed with its answer from the alert panel', async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page, 'Crm.Admin');
  const customer = await linkedHuntressCustomer(page, 'Esc');
  const m = customer.marker;
  const escalation = await huntressEscalation(page, customer, {
    subject: `${m} login from an unexpected country`, type_code: 'unexpected_country_access',
    entities: [{ id: 'identity-1', type: 'Identity', details: { display_name: 'kari@example.invalid' } }],
  });
  await syncIncidents(page, customer, 1);

  await page.goto('/alerts');
  await searchAlerts(page, m);
  await page.getByRole('button', { name: `${m} login from an unexpected country`, exact: true }).click();
  const panel = page.getByRole('dialog', { name: `${m} login from an unexpected country`, exact: true });
  const section = panel.getByRole('region', { name: 'Escalation', exact: true });
  await expect(section.getByText('kari@example.invalid')).toBeVisible();
  // No answer is chosen for the person: closing asks for one first.
  await expect(section.getByRole('radio', { name: 'The access was expected' })).not.toBeChecked();
  await section.getByRole('button', { name: 'Close the escalation', exact: true }).click();
  await expect(section.getByText('Choose an answer first.', { exact: true })).toBeVisible();
  await section.getByRole('radio', { name: 'The access was expected' }).check();
  await section.getByRole('button', { name: 'Close as expected', exact: true }).click();
  await confirm(page, 'Close the escalation in Huntress', 'Close as expected');

  await expect.poll(async () => (await huntressAlerts(page, customer.organizationId)).length, { timeout: SENT }).toBe(0);
  const state = await huntressEscalationState(page, escalation.id);
  expect(state.status).toBe('resolved');
  // Huntress takes the revoke flag only beside "unauthorized" (its stand-in refuses it otherwise).
  expect(state.posted?.resolution).toEqual({ determination: 'expected', scope: 'identity' });
});

test('the Drift tab shows what Huntress counts for the customer and its monthly reports', async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page, 'Crm.Admin');
  const customer = await linkedHuntressCustomer(page, 'Use');
  const m = customer.marker;
  await huntressAgent(page, customer, { hostname: `${m}-PC1` });
  await huntressAgent(page, customer, { hostname: `${m}-PC2`, last_callback_at: new Date(Date.now() - 10 * 86_400_000).toISOString() });
  const response = await page.request.post('http://localhost:5299/_mock/huntress/reports', { data: { organization_id: customer.huntressId, incidents_reported: 2, incidents_resolved: 1 } });
  expect(response.status()).toBe(201);
  await syncHuntress(page, ['huntress-organizations', 'huntress-reports'], async () => {
    const overview = await api.get<{ usage: unknown[]; reports: unknown[] }>(page, `/api/v1/security/organizations/${customer.organizationId}/overview`);
    return overview.usage.length === 1 && overview.reports.length === 1;
  }, `the usage and reports of ${customer.name}`);

  await page.goto(`/organizations/${customer.organizationId}?tab=drift`);
  const security = page.getByRole('region', { name: 'Security', exact: true });
  await expect(security.getByRole('heading', { name: `${m} Vern AS (Huntress)` })).toBeVisible();
  await expect(security.getByText('Agents billed')).toBeVisible();
  await expect(security.getByText('2 agents in all')).toBeVisible();
  const report = security.getByRole('row').filter({ hasText: '2 reported, 1 closed' });
  await expect(report.getByRole('link', { name: /^Open the report for .* in Huntress$/ })).toHaveAttribute('target', '_blank');
});
