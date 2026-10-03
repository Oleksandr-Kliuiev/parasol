import { expect, type APIResponse, type Page } from '@playwright/test';

export type Role = 'Crm.Admin' | 'Crm.Management' | 'Crm.Sales' | 'Crm.Technician' | 'Crm.ServiceLead' | 'Crm.Finance' | 'Crm.ReadOnly';

/** Development sign-in (Auth:Mode=Development): one user per role. */
export async function signIn(page: Page, role: Role, returnUrl = '/') {
  await page.goto(`/bff/dev-login?role=${role}&returnUrl=${encodeURIComponent(returnUrl)}`);
  await expect(page.getByRole('main')).toBeVisible();
}

export function marker(prefix: string) {
  return `${prefix}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

/** Valid organization number starting with 8; the registry mock returns "TESTFIRMA <number> AS" for these. */
export function orgNumber() {
  const weights = [3, 2, 7, 6, 5, 4, 3, 2];
  for (;;) {
    const digits = [8, ...Array.from({ length: 7 }, () => Math.floor(Math.random() * 10))];
    let check = 11 - (digits.reduce((sum, d, i) => sum + d * weights[i]!, 0) % 11);
    if (check === 11) check = 0;
    if (check !== 10) return digits.join('') + check;
  }
}

export const formatOrgNumber = (value: string) => `${value.slice(0, 3)} ${value.slice(3, 6)} ${value.slice(6)}`;

async function json<T>(response: APIResponse): Promise<T> {
  const text = await response.text();
  expect(response.ok(), `${response.url()} → ${response.status()} ${text}`).toBeTruthy();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Toast text is also announced through an aria-live region, so the visible toast is matched by its title element. */
export const toast = (page: Page, text: string | RegExp) => page.locator('.fui-ToastTitle').filter({ hasText: text });

/** API calls with the page's session cookie, as the SPA makes them. */
export const api = {
  post: async <T>(page: Page, url: string, data?: unknown) => json<T>(await page.request.post(url, { data, headers: { 'X-CSRF': '1' } })),
  put: async <T>(page: Page, url: string, data?: unknown) => json<T>(await page.request.put(url, { data, headers: { 'X-CSRF': '1' } })),
  get: async <T>(page: Page, url: string) => json<T>(await page.request.get(url)),
  /** The CSV imports take the file as the request body. */
  postCsv: async <T>(page: Page, url: string, csv: string) =>
    json<T>(await page.request.post(url, { data: csv, headers: { 'X-CSRF': '1', 'Content-Type': 'text/csv' } })),
};

export async function createOrganization(page: Page, body: Record<string, unknown>) {
  return api.post<{ id: string; name: string }>(page, '/api/v1/customers/organizations', { status: 'Prospect', ...body });
}

export async function createContact(page: Page, organizationId: string, body: Record<string, unknown>) {
  return api.post<{ contactId: string }>(page, `/api/v1/customers/organizations/${organizationId}/contacts`, { roles: [], isPrimary: false, ...body });
}

/**
 * A billing period no run uses yet. The e2e database is shared between runs and only one run per period may be open
 * (BR-BIL-01), so every test bills a period of its own, far enough ahead that no other test's contract ends first.
 */
export async function freeBillingPeriod(page: Page): Promise<{ year: number; month: number; start: string }> {
  const runs = await api.get<Array<{ periodStart: string }>>(page, '/api/v1/billing/runs?limit=120');
  const used = new Set(runs.map((run) => run.periodStart.slice(0, 7)));
  for (let year = 2040; year < 2100; year++) {
    for (let month = 1; month <= 12; month++) {
      const key = `${year}-${String(month).padStart(2, '0')}`;
      if (!used.has(key)) return { year, month, start: `${key}-01` };
    }
  }

  throw new Error('No free billing period left in the test database.');
}

/** A collected run to look at; an existing one is reused, so parallel projects do not fight over a period. */
export async function collectedBillingRun(page: Page, notes: string): Promise<{ id: string }> {
  const runs = await api.get<Array<{ id: string; status: string }>>(page, '/api/v1/billing/runs?limit=60');
  const existing = runs.find((run) => run.status !== 'Draft');
  if (existing) return existing;

  const period = await freeBillingPeriod(page);
  const run = await api.post<{ id: string }>(page, '/api/v1/billing/runs', { year: period.year, month: period.month, notes });
  await api.post(page, `/api/v1/billing/runs/${run.id}/collect`);
  return run;
}
