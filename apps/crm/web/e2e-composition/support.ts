import { readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type APIResponse, type Browser, type Page } from '@playwright/test';
import { parseWorkspace } from '../src/features/parasol/workspaceContract';
import { parseTaskPreview } from '../src/features/parasol/observationTaskContract';

export type StaffRole = 'Crm.Admin' | 'Crm.Technician' | 'Crm.ServiceLead';
export type Role = StaffRole | 'Crm.Finance' | 'Crm.ReadOnly';
export interface Fixture {
  format?: number;
  runId: string;
  baseUrl: string;
  atlasUrl: string;
  workspaceId: string;
  collisionWorkspaceId: string;
  employees: { id: string; role: StaffRole; displayName: string; visibleClientIds: string[] }[];
  clients: { crmCustomerId: string; atlasClientId: string; name: string; deviceIds: string[] }[];
  target: {
    customerId: string; atlasClientId: string; activeTotal: number;
    severityCounts: { INFO: number; LOW: number; MEDIUM: number; HIGH: number; CRITICAL: number };
    criticalObservationId: string; criticalSummary: string;
    observationIdOutsideFirst100: string; observationSummaryOutsideFirst100: string;
    resolvedObservationId: string; resolvedSummary: string; suppressedObservationId: string; suppressedSummary: string;
    duplicateHostname: string; confirmedDeviceId: string; unconfirmedDeviceId: string;
    unconfirmedObservationId: string; unconfirmedSummary: string;
  };
  restrictedClient: { customerId: string; atlasClientId: string };
  counts: { clients: number; devices: number; employees: number };
  ticketWork: { customerId: string; ticketId: string; externalId: number; title: string; importedAt: string };
}

function loopback(value: string, https = false): URL {
  const url = new URL(value);
  if (!(https ? url.protocol === 'https:' : ['http:', 'https:'].includes(url.protocol))
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error('Composition endpoints must be credential-free loopback URLs.');
  }
  return url;
}

function noSecrets(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(noSecrets);
  if (!value || typeof value !== 'object') return true;
  return Object.entries(value).every(([key, child]) => !/token|bearer|password|secret|credential|connectionstring|databaseurl|ownerurl|runtimeurl/i.test(key) && noSecrets(child));
}

export function fixture(): Fixture {
  const path = process.env.PARASOL_COMPOSITION_FIXTURE;
  if (!path || !isAbsolute(path) || statSync(path).size > 1_048_576) throw new Error('An owned, bounded composition manifest is required.');
  let value: Fixture;
  try { value = JSON.parse(readFileSync(path, 'utf8')) as Fixture; }
  catch { throw new Error('The synthetic composition manifest is invalid.'); }
  if (!noSecrets(value) || value.clients?.length !== 40 || value.employees?.length !== 3
    || value.counts?.clients !== 40 || value.counts.devices !== 400 || value.counts.employees !== 3
    || value.target?.activeTotal !== 126 || value.clients.some(c => !c.crmCustomerId || c.deviceIds.length !== 10)
    || !value.target.customerId || !value.workspaceId || !value.collisionWorkspaceId) {
    throw new Error('The synthetic composition fixture contract is invalid or contains forbidden credential fields.');
  }
  loopback(value.baseUrl, true); loopback(value.atlasUrl);
  return value;
}

export function employee(role: StaffRole) {
  const value = fixture().employees.find(e => e.role === role);
  if (!value) throw new Error('A required synthetic employee was not bootstrapped.');
  return value;
}

export async function json(response: APIResponse, label: string, expectedStatus = 200): Promise<unknown> {
  expect(response.status(), label).toBe(expectedStatus);
  // Never print a complete response, request headers, credentials or private state on an assertion failure.
  try { return await response.json() as unknown; }
  catch { throw new Error(`${label}: JSON response required.`); }
}

export async function signIn(page: Page, role: Role, returnUrl = '/') {
  await page.goto(`/bff/dev-login?role=${encodeURIComponent(role)}&returnUrl=${encodeURIComponent(returnUrl)}`);
  await expect(page.getByRole('main')).toBeVisible();
  const user = await json(await page.request.get('/bff/user'), 'Real Development BFF provisioning') as { id: string };
  if (role !== 'Crm.Finance' && role !== 'Crm.ReadOnly') expect(user.id, 'Provisioned employee identity remains stable across restart').toBe(employee(role).id);
  return user.id;
}

export async function staffContext(browser: Browser, role: Role, returnUrl = '/') {
  const context = await browser.newContext({ baseURL: fixture().baseUrl, ignoreHTTPSErrors: true, locale: 'en-GB', timezoneId: 'Europe/Oslo', serviceWorkers: 'block' });
  const page = await context.newPage();
  try { await signIn(page, role, returnUrl); return { context, page }; }
  catch (error) { await context.close(); throw error; }
}

export function taskPath(customerId: string, observationId: string) {
  return `/api/v1/parasol/customers/${encodeURIComponent(customerId)}/observations/${encodeURIComponent(observationId)}`;
}

export async function workspace(page: Page, customerId: string) {
  return parseWorkspace(await json(await page.request.get(`/api/v1/parasol/customers/${customerId}/workspace`), 'Real scoped Atlas workspace'), customerId);
}

export async function taskPreview(page: Page, observationId = fixture().target.observationIdOutsideFirst100) {
  const { customerId } = fixture().target;
  return parseTaskPreview(await json(await page.request.get(`${taskPath(customerId, observationId)}/task-preview`), 'Real exact Atlas observation read'), { customerId, observationId });
}

export async function openQueue(page: Page) {
  const panel = page.getByRole('region', { name: 'Technical workspace · Atlas' });
  await panel.getByRole('tab', { name: 'Observation queue and history', exact: true }).click();
  const queue = panel.getByRole('region', { name: 'Observation queue and history', exact: true });
  await expect(queue.getByText('Page 1 · 25 records loaded', { exact: true })).toBeVisible();
  return queue;
}

/**
 * Opens the target observation's work from the customer's queue. Once the observation has a task, its row says so (UX 2026,
 * В3: "Task done · <assignee> · due …", read for the page from CRM tasks) and the button opens the task to look at it.
 */
export async function openTargetAssignment(page: Page, linked?: { state: 'Task open' | 'Task done'; assignee: string }) {
  const f = fixture(); await page.goto(`/organizations/${f.target.customerId}`);
  const queue = await openQueue(page); await queue.getByLabel('Queue severity', { exact: true }).selectOption('LOW');
  const row = queue.getByRole('listitem').filter({ hasText: f.target.observationSummaryOutsideFirst100 });
  await expect(row).toHaveCount(1);
  const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (linked) await expect(row.getByText(new RegExp(`^${linked.state} · ${literal(linked.assignee)} · due `))).toBeVisible();
  await row.getByRole('button', { name: linked ? 'View linked work' : 'Assign work', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: linked ? 'View observation work' : 'Assign observation work', exact: true });
  await expect(dialog.getByText(f.target.observationSummaryOutsideFirst100, { exact: true })).toBeVisible();
  return dialog;
}

export type Operation = 'revokeTechnicianMembership' | 'restoreTechnicianMembership' | 'revokeTechnicianToken' | 'restoreTechnicianToken' | 'countsTaskEvidence';
export interface TaskEvidence {
  taskCount: number; receiptCount: number; createAuditCount: number; totalActivityLoggedCount: number;
  bodyIsNull: boolean; genericSubject: boolean; sourceTextAbsentFromTask: boolean; sourceTextAbsentFromAudit: boolean;
  providerWrites: number; atlasRequests: number;
  actualScale: { clients: number; devices: number; employees: number };
  privileges: { crmWebRestricted: boolean; crmWorkerRestricted: boolean; atlasRuntimeRestricted: boolean };
  ticketWork: { timeCount: number; matchingTimeCount: number; timeCreateAuditCount: number; receiptCount: number; taskPreserved: boolean };
}

/** Owner-only fixture control is a local process. It accepts no arbitrary SQL or browser input and returns no private rows. */
export function control(operation: Operation): TaskEvidence {
  const state = process.env.PARASOL_COMPOSITION_STATE;
  if (!state || !isAbsolute(state)) throw new Error('Owned composition state is required for fixture control.');
  const executable = fileURLToPath(new URL('../../../../tools/composition/control.mjs', import.meta.url));
  let result: unknown;
  try {
    result = JSON.parse(execFileSync(process.execPath, [executable, '--state', state, '--operation', operation], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 16_384, stdio: ['ignore', 'pipe', 'pipe'],
    }));
  } catch { throw new Error('The owned composition fixture operation failed; private diagnostics are not included.'); }
  if (!noSecrets(result) || !result || typeof result !== 'object') throw new Error('Fixture control returned an invalid public result.');
  return result as TaskEvidence;
}

export function assertTaskEvidence(value: TaskEvidence, expectedTasks: number, expectedEvents = expectedTasks) {
  expect(value.taskCount, 'One SQL Task per exact Atlas observation').toBe(expectedTasks);
  expect(value.receiptCount, 'One permanent source receipt').toBe(expectedTasks);
  expect(value.createAuditCount, 'One create audit').toBe(expectedTasks);
  expect(value.totalActivityLoggedCount, 'Exact ActivityLogged count: one creation plus explicit completion').toBe(expectedEvents);
  expect(value.providerWrites, 'No mutating Atlas/provider request').toBe(0);
  if (expectedTasks) {
    expect(value.bodyIsNull && value.genericSubject && value.sourceTextAbsentFromTask && value.sourceTextAbsentFromAudit,
      'Generic Task and audit contain no copied source text').toBe(true);
  }
  expect(value.actualScale.clients).toBe(40); expect(value.actualScale.devices).toBe(400); expect(value.actualScale.employees).toBe(3);
  expect(value.privileges.crmWebRestricted && value.privileges.crmWorkerRestricted && value.privileges.atlasRuntimeRestricted,
    'Application runtimes use restricted database roles').toBe(true);
}
