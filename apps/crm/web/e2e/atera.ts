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

/** Serious or critical axe findings under WCAG 2.2 AA; Tabster's focus sentinels are skipped (see a11y.spec.ts). */
export async function seriousViolations(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .exclude('[data-tabster-dummy]').analyze();
  return result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({ id: v.id, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
}

export const fitsWidth = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

/** The widths M38 is checked at: desktop, tablet, phone and the narrowest supported phone. */
export const widths = [[1440, 900], [768, 1024], [390, 844], [320, 640]] as const;
