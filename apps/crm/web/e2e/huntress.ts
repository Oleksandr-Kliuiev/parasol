import { expect, type Page } from '@playwright/test';
import { linkedAteraCustomer, type AteraCustomer } from './atera';
import { api } from './support';

// M41: incidents, escalations, agents and reports come from the Huntress stand-in through the real worker syncs, as Atera's do.
// Its test-only control routes (tools/dev-mocks/README.md) give a test an organization, agents, incidents and notices of its own;
// the syncs run on request only (their crons are set far in the future in playwright.config.ts).

const control = 'http://localhost:5299/_mock/huntress';

/** A customer linked to Atera (by organization number) and to a Huntress organization of its own (by a person, on the mapping screen). */
export interface HuntressCustomer extends AteraCustomer { huntressId: number }

export interface HuntressRecord { id: number }

async function controlPost<T>(page: Page, path: string, data: unknown, status = 201): Promise<T> {
  const response = await page.request.post(`${control}/${path}`, { data });
  expect(response.status(), `${path}: ${await response.text()}`).toBe(status);
  return (await response.json()) as T;
}

/** Starts `jobs` in the worker until `done` holds; a trigger can find its job busy or paused, so it is started again a few times. */
export async function syncHuntress(page: Page, jobs: string[], done: () => Promise<boolean>, what: string) {
  for (let round = 0; round < 4; round++) {
    for (const job of jobs) await api.post(page, `/api/v1/integrations/jobs/${job}/trigger`);
    for (const deadline = Date.now() + 25_000; Date.now() < deadline; await page.waitForTimeout(1_000)) {
      if (await done()) return;
    }
  }
  throw new Error(`The Huntress sync did not bring ${what}`);
}

/** A customer of this test in the CRM, Atera and Huntress; the Huntress organization is linked as a person links it. */
export async function linkedHuntressCustomer(page: Page, prefix: string): Promise<HuntressCustomer> {
  const customer = await linkedAteraCustomer(page, prefix);
  const organization = await controlPost<HuntressRecord>(page, 'organizations', { name: `${customer.marker} Vern AS` });
  await api.post(page, '/api/v1/integrations/links', {
    system: 'huntress', externalType: 'Organization', externalId: String(organization.id), entityId: customer.organizationId,
  });
  return { ...customer, huntressId: organization.id };
}

export const huntressAgent = (page: Page, customer: HuntressCustomer, fields: Record<string, unknown>) =>
  controlPost<HuntressRecord & { hostname: string }>(page, 'agents', { organization_id: customer.huntressId, ...fields });

/**
 * An incident report of the customer, `sent` and waiting for the partner. A low one by default: an urgent one that Huntress closes
 * waits in Parasoll for a person, so a test that makes one also confirms it.
 */
export const huntressIncident = (page: Page, customer: HuntressCustomer, fields: Record<string, unknown>) =>
  controlPost<HuntressRecord>(page, 'incidents', { organization_id: customer.huntressId, severity: 'low', ...fields });

export const changeHuntressIncident = (page: Page, id: number, fields: Record<string, unknown>) =>
  controlPost<HuntressRecord>(page, `incidents/${id}`, fields, 200);

export const huntressEscalation = (page: Page, customer: HuntressCustomer, fields: Record<string, unknown>) =>
  controlPost<HuntressRecord>(page, 'escalations', { organization_ids: [customer.huntressId], severity: 'low', ...fields });

/** What "Huntress" holds of an incident now, with what the CRM sent it (`posted`). */
export async function huntressIncidentState(page: Page, id: number) {
  const response = await page.request.get(`${control}/incidents/${id}`);
  expect(response.status()).toBe(200);
  return (await response.json()) as { status: string; posted?: Record<string, unknown>; remediations: Array<{ type: string; status: string }> };
}

/** What "Huntress" holds of an escalation now, with the resolution the CRM sent (`posted`). */
export async function huntressEscalationState(page: Page, id: number) {
  const response = await page.request.get(`${control}/escalations/${id}`);
  expect(response.status()).toBe(200);
  return (await response.json()) as { status: string; posted?: { resolution?: Record<string, unknown> } };
}

export interface StoredSecurityAlert { id: string; title: string; severity: string; state: string; externalId: string; sourceClosedAt: string | null }

/** The customer's stored Huntress alerts in one state, as the queue reads them. */
export async function huntressAlerts(page: Page, organizationId: string, state: 'Open' | 'Resolved' = 'Open') {
  return (await api.get<{ items: Array<StoredSecurityAlert & { system: string }> }>(page,
    `/api/v1/service/alerts?organizationId=${organizationId}&state=${state}&limit=100`)).items.filter((alert) => alert.system === 'huntress');
}
