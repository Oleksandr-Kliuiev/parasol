import { expect, type Page } from '@playwright/test';
import { api, marker } from './support';

// M42: backups come from the CloudAlly stand-in (tools/dev-mocks/cloudally.mjs, partner API v2) through the real worker read. Its
// test-only control routes give a test a CloudAlly account of its own with users in the states it needs; the read runs on request
// only (its cron is set far in the future in playwright.config.ts), started as an operator does.

const control = 'http://localhost:5299/_mock/cloudally';

export type BackupUserState = 'ok' | 'failed' | 'late' | 'paused' | 'notactive';

export interface CloudAllyEntity { id: string; entity: string; fullName: string | null; status: string }
export interface CloudAllyTask { id: string; source: string; status: string; entities: CloudAllyEntity[] }
export interface CloudAllyAccount { id: string; name: string; tasks: CloudAllyTask[] }
export interface BackupCustomer { organizationId: string; name: string; marker: string; domain: string; account: CloudAllyAccount }
export interface CloudAllyCall { method: string; path: string; body: Record<string, unknown> }

/**
 * A customer of this test in the CRM and in CloudAlly, linked as the mapping screen links them. `users` are local parts of addresses in
 * the customer's own domain, each with the state of its mailbox backup (OneDrive is backed up, unless the user is not in the backup).
 */
export async function linkedCloudAllyCustomer(page: Page, prefix: string, spec: {
  users: Array<{ name: string; fullName?: string; state?: BackupUserState; error?: string }>; pausedServices?: string[];
}): Promise<BackupCustomer> {
  const m = marker(prefix);
  const domain = `${m.toLowerCase()}.example`;
  const name = `${m} Backup AS`;
  const organization = await api.post<{ id: string }>(page, '/api/v1/customers/organizations', { name, status: 'Customer' });
  const created = await page.request.post(`${control}/accounts`, { data: {
    name, domain, pausedServices: spec.pausedServices ?? [],
    users: spec.users.map((user) => ({ email: `${user.name}@${domain}`, fullName: user.fullName, state: user.state ?? 'ok', error: user.error })),
  } });
  expect(created.status(), await created.text()).toBe(201);
  const account = (await created.json()) as CloudAllyAccount;
  await api.post(page, '/api/v1/integrations/links', { system: 'cloudally', externalType: 'Customer', externalId: account.id, entityId: organization.id });
  return { organizationId: organization.id, name, marker: m, domain, account };
}

/**
 * Starts the CloudAlly read until `done` holds. A trigger can find a read of another test under way (the job runs once at a time),
 * so it is started again a few times before the test gives up.
 */
export async function syncBackups(page: Page, done: () => Promise<boolean>, what: string) {
  for (let round = 0; round < 4; round++) {
    await api.post(page, '/api/v1/integrations/jobs/cloudally-backups/trigger');
    for (const deadline = Date.now() + 25_000; Date.now() < deadline; await page.waitForTimeout(1_000)) {
      if (await done()) return;
    }
  }
  throw new Error(`The CloudAlly read did not bring ${what}`);
}

interface Overview { accounts: unknown[]; services: Array<{ service: string; total: number }> }

/** Reads CloudAlly until the customer's backups are stored, with `entities` users and sites in the backup. */
export const syncCustomer = (page: Page, customer: BackupCustomer, entities: number) => syncBackups(page, async () => {
  const overview = await api.get<Overview>(page, `/api/v1/backup/organizations/${customer.organizationId}`);
  return overview.accounts.length === 1 && overview.services.reduce((sum, s) => sum + s.total, 0) === entities;
}, `the backups of ${customer.name}`);

/** What the CRM asked of the stand-in so far for one account (changes only). */
export async function cloudAllyCalls(page: Page, customer: BackupCustomer): Promise<CloudAllyCall[]> {
  const response = await page.request.get(`${control}/log`);
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as CloudAllyCall[]).filter((call) => call.path.includes(customer.account.id));
}

/** The task of one source (MS365, ONEDRIVE, SHAREPOINT_MULTI, MS365GROUPS) of the customer's account. */
export const taskOf = (customer: BackupCustomer, source: string) => customer.account.tasks.find((task) => task.source === source)!;
