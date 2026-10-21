import { expect, type APIResponse, type Locator, type Page } from '@playwright/test';

export type Role = 'Crm.Admin' | 'Crm.Management' | 'Crm.Sales' | 'Crm.Technician' | 'Crm.ServiceLead' | 'Crm.Finance' | 'Crm.ReadOnly';

/** Development sign-in (Auth:Mode=Development): one user per role. */
export async function signIn(page: Page, role: Role, returnUrl = '/') {
  await page.goto(`/bff/dev-login?role=${role}&returnUrl=${encodeURIComponent(returnUrl)}`);
  await expect(page.getByRole('main')).toBeVisible();
}

/**
 * Pages My tasks (Load more) until `target`, a control of this test's own task row, shows. The shared employees of the
 * development sign-in collect open tasks from every run, and tasks without a due date sort first, so a test's task is
 * not reliably on the first page of ten.
 */
export async function showInMyTasks(page: Page, target: Locator) {
  const personal = page.getByRole('region', { name: 'My tasks', exact: true });
  const rows = personal.getByRole('listitem');
  await expect(rows.first()).toBeVisible();
  for (let pages = 1; (await target.count()) === 0 && pages < 30; pages++) {
    const shown = await rows.count();
    await personal.getByRole('button', { name: 'Load more', exact: true }).click({ timeout: 10_000 });
    await expect(rows).not.toHaveCount(shown);
  }
  return target;
}

/**
 * Pages a list (Load more) until `row`, a row of this test's own record, shows. The e2e database is shared between runs, so a
 * month of time entries holds more than one page after a day of runs, and a new entry is not reliably on the first page.
 */
export async function showRow(page: Page, row: Locator) {
  const more = page.getByRole('button', { name: 'Load more', exact: true });
  await expect(row.or(more).first()).toBeVisible();
  for (let pages = 1; !(await row.isVisible()) && (await more.isVisible()) && pages < 30; pages++) {
    await more.click(); await page.waitForLoadState('networkidle');
  }
  await expect(row).toBeVisible();
  return row;
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
/** The run request accepts years from 2020 to 2100 (CreateRunRequestValidator). */
const FIRST_RUN_YEAR = 2020;
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
    const taken = new Set<string>();
    let cursor: string | null = null;
    do {
      const runs: { items: Array<{ periodStart: string }>; nextCursor: string | null } = await api.get(
        page,
        `/api/v1/billing/runs?year=${year}&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      for (const run of runs.items) taken.add(run.periodStart.slice(0, 7));
      cursor = runs.nextCursor;
    } while (cursor);
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
export async function reserveBillingRun(
  page: Page, notes: string, fromYear = API_RUNS_FROM_YEAR, toYear = DIALOG_RUNS_FROM_YEAR - 1,
): Promise<BillingPeriod & { id: string }> {
  for await (const period of candidatePeriods(page, fromYear, toYear)) {
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

  throw new Error(`No free billing period from ${fromYear} to ${toYear} is left in the test database.`);
}

/**
 * Claims a month two or more years back, for a run that must bill only its own test's work: other specs date hours,
 * contracts, prepaid hours and pending charges this year or last (time-periods.spec closes months of last year), and a
 * future month's run also collects all their pending charges. A month stays claimed: twelve per year from 2020 on.
 */
export const reservePastBillingRun = (page: Page, notes: string) =>
  reserveBillingRun(page, notes, FIRST_RUN_YEAR, new Date().getFullYear() - 2);

/** A collected run of this test's own; runs of other tests are never reused, as they may change state meanwhile. */
export async function collectedBillingRun(page: Page, notes: string): Promise<{ id: string }> {
  const run = await reserveBillingRun(page, notes);
  await api.runCommand(page, run.id, 'collect');
  return run;
}
