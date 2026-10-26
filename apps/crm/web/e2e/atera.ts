import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { api, marker, orgNumber } from './support';

// M38: alerts and devices come from the Atera stand-in through the real worker syncs. Its test-only control routes (never part
// of Atera's API, tools/dev-mocks/README.md) give a test a customer, devices and alerts of its own; the syncs run on request only
// (their crons are set far in the future in playwright.config.ts), started like an operator does.

const control = 'http://localhost:5299/_mock/atera';

export interface AteraCustomer { organizationId: string; name: string; customerId: number; marker: string }
export interface AteraAlert { AlertID: number; Title: string; Severity: string }
export interface StoredAlert { id: string; title: string; severity: string; state: string; deviceName: string | null; organizationId: string }

async function controlPost<T>(page: Page, path: string, data: unknown): Promise<T> {
  const response = await page.request.post(`${control}/${path}`, { data });
  expect(response.status(), `${path}: ${await response.text()}`).toBe(201);
  return (await response.json()) as T;
}

/**
 * Starts `jobs` in the worker until `done` holds. A trigger can find its job skipped (another test paused Atera for a moment,
 * or a run of the same job was under way), so it is started again a few times before the test gives up.
 */
export async function syncAtera(page: Page, jobs: string[], done: () => Promise<boolean>, what: string) {
  for (let round = 0; round < 4; round++) {
    for (const job of jobs) await api.post(page, `/api/v1/integrations/jobs/${job}/trigger`);
    for (const deadline = Date.now() + 25_000; Date.now() < deadline; await page.waitForTimeout(1_000)) {
      if (await done()) return;
    }
  }
  throw new Error(`The Atera sync did not bring ${what}`);
}

/**
 * A customer of this test in the CRM and in Atera, linked by organization number through the customer sync. The e2e database
 * outlives the stand-in, so a number an earlier run already used is skipped. Needs an integration manager (Crm.Admin).
 */
export async function linkedAteraCustomer(page: Page, prefix: string): Promise<AteraCustomer> {
  const m = marker(prefix);
  const name = `${m} Drift AS`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const number = orgNumber();
    const created = await page.request.post('/api/v1/customers/organizations', {
      data: { name, orgNumber: number, status: 'Customer' }, headers: { 'X-CSRF': '1' },
    });
    if (!created.ok()) continue;
    const organizationId = ((await created.json()) as { id: string }).id;
    const customer = await controlPost<{ CustomerID: number }>(page, 'customers', { CustomerName: name, BusinessNumber: number });
    await syncAtera(page, ['atera-customers'], async () => {
      const links = await api.get<Array<{ system: string }>>(page, `/api/v1/integrations/links?entityType=Organization&entityId=${organizationId}`);
      return links.some((link) => link.system === 'atera');
    }, `the link of ${name}`);
    return { organizationId, name, customerId: customer.CustomerID, marker: m };
  }
  throw new Error('No free organization number for the Atera customer');
}

export const ateraAgent = (page: Page, customer: AteraCustomer, fields: Record<string, unknown>) =>
  controlPost<{ AgentID: string; MachineName: string }>(page, 'agents', { CustomerID: customer.customerId, ...fields });

/** An open alert in Atera; `hoursAgo` dates it, so the queue's oldest-first order can be checked. */
export const ateraAlert = (page: Page, customer: AteraCustomer, fields: { Title: string; Severity?: 'Critical' | 'Warning'; DeviceName?: string; hoursAgo?: number }) =>
  controlPost<AteraAlert>(page, 'alerts', {
    CustomerID: customer.customerId, Title: fields.Title, Severity: fields.Severity ?? 'Critical', DeviceName: fields.DeviceName,
    Created: new Date(Date.now() - (fields.hoursAgo ?? 1) * 3_600_000).toISOString(),
  });

/** Closes an alert in "Atera": the next complete alert read resolves it in the CRM. */
export async function closeAteraAlert(page: Page, alert: AteraAlert) {
  const response = await page.request.delete(`${control}/alerts/${alert.AlertID}`);
  expect(response.status()).toBe(204);
}

/** The customer's stored alerts in one state, as the queue reads them. */
export async function storedAlerts(page: Page, organizationId: string, state: 'Open' | 'Resolved' = 'Open') {
  return (await api.get<{ items: StoredAlert[] }>(page, `/api/v1/service/alerts?organizationId=${organizationId}&state=${state}&limit=100`)).items;
}

/** Reads the devices into the CRM until the customer has `count`; an alert read after it matches alerts to them by name. */
export async function syncDevices(page: Page, customer: AteraCustomer, count: number) {
  await syncAtera(page, ['atera-agents'], async () =>
    (await api.get<{ totalCount: number }>(page, `/api/v1/service/devices?organizationId=${customer.organizationId}`)).totalCount === count,
  `${count} devices of ${customer.name}`);
}

/** Narrows the queue to the test's own alerts and waits for that read: a row menu opened before it would close as the list redraws. */
export async function searchAlerts(page: Page, marker: string) {
  const read = page.waitForResponse((r) => r.url().includes('/api/v1/service/alerts?') && new URL(r.url()).searchParams.get('q') === marker);
  await page.getByRole('searchbox', { name: 'Search title or device' }).fill(marker);
  await read;
}

/** What "Atera" holds of an alert now (M40): archived after a resolve, null once deleted. */
export async function ateraAlertState(page: Page, alert: AteraAlert): Promise<{ Archived?: boolean } | null> {
  const response = await page.request.get(`${control}/alerts/${alert.AlertID}`);
  if (response.status() === 404) return null;
  expect(response.status()).toBe(200);
  return (await response.json()) as { Archived?: boolean };
}

/** Changes an agent in "Atera" (M40): it goes silent, is renamed, reports other keys; the next agent read sees it. */
export async function changeAteraAgent(page: Page, agentId: string, fields: Record<string, unknown>) {
  const response = await page.request.post(`${control}/agents/${encodeURIComponent(agentId)}`, { data: fields });
  expect(response.status(), await response.text()).toBe(200);
}

export interface StoredMachine { id: string; name: string; proposals: number; sources: Array<{ system: string }> }

/** The customer's machines as the Drift tab lists them (M40). */
export async function storedMachines(page: Page, organizationId: string) {
  return (await api.get<{ items: StoredMachine[] }>(page, `/api/v1/service/machines?organizationId=${organizationId}&limit=100`)).items;
}

/** Reads the Windows updates of every agent until the customer's first machine carries a complete read of them (M40). */
export async function syncPatches(page: Page, customer: AteraCustomer) {
  await syncAtera(page, ['atera-patches'], async () => {
    const [machine] = await storedMachines(page, customer.organizationId);
    if (!machine) return false;
    const card = await api.get<{ devices: Array<{ patches: { readAt: string | null } }> }>(page, `/api/v1/service/machines/${machine.id}`);
    return card.devices.every((device) => device.patches.readAt !== null);
  }, `the Windows updates of ${customer.name}`);
}

/** Reads the alerts into the CRM until the customer has `count` open alerts. */
export async function syncAlerts(page: Page, customer: AteraCustomer, count: number) {
  await syncAtera(page, ['atera-alerts'], async () => (await storedAlerts(page, customer.organizationId)).length === count,
    `${count} open alerts of ${customer.name}`);
}

/** The page after its entrances: audits measure the settled page, as someone with reduced motion sees it. */
export async function settled(page: Page) {
  await expect(page.locator('main')).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined)));
  });
}

/**
 * Serious or critical axe findings under WCAG 2.2 AA; Tabster's focus sentinels are skipped (see a11y.spec.ts). `include` narrows the
 * scan to a popup (an open menu): over the page, its layer would count as covering the controls under it.
 */
export async function seriousViolations(page: Page, include?: string) {
  const builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('[data-tabster-dummy]');
  const result = await (include ? builder.include(include) : builder).analyze();
  return result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({ id: v.id, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
}

export const fitsWidth = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

/** The widths M38 is checked at: desktop, tablet, phone and the narrowest supported phone. */
export const widths = [[1440, 900], [768, 1024], [390, 844], [320, 640]] as const;

// M39: tickets, their conversation and the actions asked of Atera. The stand-in's ticket routes (tools/dev-mocks/atera-tickets.mjs)
// keep what the CRM sent, so a test reads a ticket back with its comments and work hours, and can make the next request to a
// route fail.

/** The development sign-in's employee as Atera knows them: the ticket read maps this technician to them by e-mail. */
export const DEV_TECHNICIAN = 4003;

export interface AteraTicket { TicketID: number; TicketTitle: string; TicketStatus: string }
export interface AteraTicketState extends AteraTicket {
  Comments: Array<{ CommentText: string; IsInternal: boolean; TechnicianContactID?: number }>;
  WorkHours: Array<{ WorkHoursID: string; TechnicianContactID: number; TimeSpentInMinutes: number; Billable: boolean; Description: string | null }>;
}

/** A ticket of the customer in Atera, given to the development sign-in's technician unless the fields say otherwise. */
export const ateraTicket = (page: Page, customer: AteraCustomer, fields: {
  TicketTitle: string; TechnicianContactID?: number; EndUserFirstName?: string; EndUserLastName?: string; EndUserEmail?: string;
}) =>
  controlPost<AteraTicket>(page, 'tickets', { CustomerID: customer.customerId, TechnicianContactID: DEV_TECHNICIAN, ...fields });

/** A message from the customer's end user, as if written in Atera's portal or by e-mail. */
export const customerMessage = (page: Page, ticket: AteraTicket, text: string) =>
  controlPost<{ CommentID: number }>(page, `tickets/${ticket.TicketID}/comments`, { CommentText: text });

/** The ticket as Atera has it now, with every comment and work-hours row. */
export async function ateraTicketState(page: Page, ticket: AteraTicket): Promise<AteraTicketState> {
  const response = await page.request.get(`${control}/tickets/${ticket.TicketID}`);
  expect(response.status()).toBe(200);
  return (await response.json()) as AteraTicketState;
}

/** The next `count` requests with this method to this Atera path answer `status` and change nothing. */
export async function failAtera(page: Page, method: 'GET' | 'POST', path: string, status = 503, count = 1) {
  const response = await page.request.post(`${control}/faults`, { data: { method, path, status, count } });
  expect(response.status()).toBe(204);
}

/** Work hours someone recorded in Atera itself, through Atera's own API. */
export async function hoursInAtera(page: Page, ticket: AteraTicket, fields: { minutes: number; technician: number; comment: string }) {
  const start = new Date(Date.now() - 3 * 3_600_000);
  const response = await page.request.post(`http://localhost:5299/api/v3/tickets/${ticket.TicketID}/workhours`, {
    headers: { 'X-API-KEY': 'mock' },
    data: { StartWorkHour: start.toISOString(), EndWorkHour: new Date(start.getTime() + fields.minutes * 60_000).toISOString(),
      TechnicianContactID: fields.technician, Billiable: true, OnCustomerSite: false, Comments: fields.comment },
  });
  expect(response.status()).toBe(200);
}

/**
 * Reads the ticket and its conversation into the CRM until it is saved with at least `messages` messages, and returns its CRM id.
 * The conversation read also saves the ticket itself, so one job brings both.
 */
export async function syncTicket(page: Page, ticket: AteraTicket, messages: number): Promise<string> {
  let id: string | undefined;
  await syncAtera(page, ['atera-ticket-conversations'], async () => {
    const found = await api.get<{ items: Array<{ id: string; externalId: number }> }>(page,
      `/api/v1/service/tickets?search=${encodeURIComponent(ticket.TicketTitle)}&limit=5`);
    id = found.items.find((item) => item.externalId === ticket.TicketID)?.id;
    if (!id) return false;
    return (await api.get<{ totalCount: number }>(page, `/api/v1/service/tickets/${id}/comments?limit=1`)).totalCount >= messages;
  }, `ticket #${ticket.TicketID} with ${messages} messages`);
  return id!;
}

/**
 * Narrows the Tickets page to the one open ticket `term` finds and waits until the list shows that answer. The search is read after a
 * pause in typing and its answer redraws the list, so a click before it can land while the rows change and open nothing (Firefox,
 * 22.10.2026). The count alone is not enough: where this is the only open ticket, it says 1 before the search is read too.
 */
export async function searchTickets(page: Page, term: string) {
  const answered = page.waitForResponse((response) => response.url().includes('/api/v1/service/tickets?')
    && new URL(response.url()).searchParams.get('search') === term);
  await page.getByRole('searchbox', { name: 'Search title, number or contact' }).fill(term);
  await answered;
  await expect(page.getByRole('status').filter({ hasText: /open ticket/ })).toHaveText('1 open ticket');
}

/**
 * Makes sure the signed-in employee writes in Atera as `technician`. The ticket read maps the development technician by e-mail;
 * a mapping an earlier run of the shared database left without a person is set here, as an administrator does under Technicians.
 */
export async function writeAsTechnician(page: Page, technician = DEV_TECHNICIAN) {
  const me = await api.get<{ id: string }>(page, '/bff/user');
  type Mapping = { id: string; system: string; externalId: string; userId: string | null };
  let cursor: string | null = null;
  do {
    const listed: { items: Mapping[]; nextCursor: string | null } = await api.get(page, `/api/v1/identity/technicians?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    const mapping = listed.items.find((item) => item.system === 'atera' && item.externalId === String(technician));
    if (mapping) {
      if (mapping.userId !== me.id) await api.put(page, `/api/v1/identity/technicians/${mapping.id}`, { userId: me.id });
      return;
    }
    cursor = listed.nextCursor;
  } while (cursor);
  throw new Error(`Atera technician ${technician} has not been read yet`);
}

export interface StoredAction { id: string; status: string; outcomeCode: string | null; closeReason: string | null; ticketId: string | null; etag: string }

/** The actions asked of Atera for the ticket, newest first; `attention` narrows them to those waiting for a check. */
export async function ticketActions(page: Page, ticket: AteraTicket, attention = false) {
  return (await api.get<{ items: StoredAction[] }>(page,
    `/api/v1/actions?targetType=ticket&targetId=${ticket.TicketID}${attention ? '&state=attention' : ''}`)).items;
}

/**
 * Records what a person found at Atera for an action without a clear answer, as the action's card does. A test settles what it left
 * uncertain, so the shared database does not keep "check needed" gaps on Connections.
 */
export async function settleAction(page: Page, action: StoredAction, outcome: 'Succeeded' | 'Failed', reason: string) {
  const response = await page.request.post(`/api/v1/actions/${action.id}/settle`, {
    data: { outcome, reason }, headers: { 'X-CSRF': '1', 'If-Match': action.etag },
  });
  expect(response.status(), await response.text()).toBe(200);
}

