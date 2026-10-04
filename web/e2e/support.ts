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
  /** Collect and both approvals carry the ETag of the run they are about, as the run page sends it (ADR-012). */
  runCommand: async <T>(page: Page, runId: string, command: 'collect' | 'approve' | 'second-approve') => {
    const read = await page.request.get(`/api/v1/billing/runs/${runId}`);
    expect(read.ok(), `${read.url()} → ${read.status()}`).toBeTruthy();
    const etag = read.headers()['etag'];
    expect(etag, 'the run answers with its ETag').toBeTruthy();
    return json<T>(await page.request.post(`/api/v1/billing/runs/${runId}/${command}`, { data: {}, headers: { 'X-CSRF': '1', 'If-Match': etag! } }));
  },
};

export async function createOrganization(page: Page, body: Record<string, unknown>) {
  return api.post<{ id: string; name: string }>(page, '/api/v1/customers/organizations', { status: 'Prospect', ...body });
}

export async function createContact(page: Page, organizationId: string, body: Record<string, unknown>) {
  return api.post<{ contactId: string }>(page, `/api/v1/customers/organizations/${organizationId}/contacts`, { roles: [], isPrimary: false, ...body });
}

/** API-created runs claim months from here on; later months belong to the test that creates its run through the dialog. */
export const API_RUNS_FROM_YEAR = 2040;
export const DIALOG_RUNS_FROM_YEAR = 2080;
/** The run request accepts years up to 2100 (CreateRunRequestValidator). */
const LAST_RUN_YEAR = 2100;

export type BillingPeriod = { year: number; month: number; start: string };

const periodOf = (year: number, month: number): BillingPeriod => ({ year, month, start: `${year}-${String(month).padStart(2, '0')}-01` });

/** The last day of the period's month, so a test contract covers that month only and no other test's run bills it. */
export const periodEnd = (period: BillingPeriod) => new Date(Date.UTC(period.year, period.month, 0)).toISOString().slice(0, 10);

/**
 * Months from {@link fromYear} on that have no run in the database yet, earliest first. Only a hint: another worker or
 * another test run on the same database can still take a month before this one creates its run.
 */
export async function* candidatePeriods(page: Page, fromYear: number, toYear = LAST_RUN_YEAR): AsyncGenerator<BillingPeriod> {
  for (let year = fromYear; year <= toYear; year++) {
    const runs = await api.get<Array<{ periodStart: string }>>(page, `/api/v1/billing/runs?year=${year}&limit=120`);
    const taken = new Set(runs.map((run) => run.periodStart.slice(0, 7)));
    for (let month = 1; month <= 12; month++) {
      const period = periodOf(year, month);
      if (!taken.has(period.start.slice(0, 7))) yield period;
    }
  }
}

/**
 * Claims a billing period by creating a draft run in it. Only one open run may exist per period (BR-BIL-01, a unique
 * index), so creating the run is the reservation itself: a month that a parallel worker or another run on the same
 * database claimed first answers BIL_PERIOD_BUSY, and the next month is tried. No month is read and then used later.
 */
export async function reserveBillingRun(page: Page, notes: string, fromYear = API_RUNS_FROM_YEAR): Promise<BillingPeriod & { id: string }> {
  for await (const period of candidatePeriods(page, fromYear, DIALOG_RUNS_FROM_YEAR - 1)) {
    const response = await page.request.post('/api/v1/billing/runs', {
      data: { year: period.year, month: period.month, notes },
      headers: { 'X-CSRF': '1' },
    });
    const text = await response.text();
    if (response.status() === 201) return { ...period, id: (JSON.parse(text) as { id: string }).id };
    // Taken: BIL_PERIOD_BUSY when the other run already existed; DUPLICATE when both requests passed the service's check at
    // the same moment and the unique index rejected this insert (the only unique index of a run is its open period).
    if (response.status() === 409 && /"code":"(BIL_PERIOD_BUSY|DUPLICATE)"/.test(text)) continue;
    throw new Error(`Creating a billing run for ${period.start} failed: ${response.status()} ${text}`);
  }

  throw new Error('No free billing period left in the test database.');
}

/** A collected run of this test's own; runs of other tests are never reused, as they may change state meanwhile. */
export async function collectedBillingRun(page: Page, notes: string): Promise<{ id: string }> {
  const run = await reserveBillingRun(page, notes);
  await api.runCommand(page, run.id, 'collect');
  return run;
}
