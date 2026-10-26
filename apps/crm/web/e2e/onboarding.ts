import { expect, type Page } from '@playwright/test';
import { api, createOrganization, marker, orgNumber } from './support';

// M43: "Connect services" creates a customer in the Atera, Huntress and CloudAlly stand-ins (tools/dev-mocks) on the vendor action
// path, and the contracts tab counts what those services count. These helpers give a test a customer of its own to connect, read
// back what each stand-in got, and start the reads that bring the counts.

const mock = 'http://localhost:5299/_mock';

export interface Product { id: string; name: string; sku: string }
export interface ContractLineView { quantityModel: string; quantity: number; isCurrent: boolean; productId: string; validFrom: string }
export interface ContractView { id: string; number: string; status: string; lines: ContractLineView[] }

export interface CustomerToConnect {
  id: string;
  name: string;
  marker: string;
  /** The organization key the wizard proposes for Huntress: the name without its company form. */
  key: string;
  agent: Product;
  seat: Product;
  contract: ContractView;
}

const day = (date: Date) => date.toISOString().slice(0, 10);

/** The first day of this month and the last day of the next, so a test contract is in force now and no test's billing run bills it. */
export function currentTerm() {
  const now = new Date();
  return { start: day(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))), end: day(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 0))) };
}

/** Two products billed per unit, one for Huntress's agents and one for CloudAlly's users, named after the test's marker. */
export async function servicesProducts(page: Page, m: string): Promise<{ agent: Product; seat: Product }> {
  const product = (sku: string, name: string) => api.post<Product>(page, '/api/v1/catalog/products', {
    sku: `${m}-${sku}`, name: `${m} ${name}`, type: 'ManagedService', businessLine: 'Other', unit: 'Device', billingPeriod: 'Monthly', vatRate: 25,
    listPrice: 60, unitCost: 30,
  });
  return { agent: await product('HNT', 'Huntress agent'), seat: await product('BKP', 'Backup user') };
}

/** A draft contract of the customer for the current term, without lines. */
export async function draftContract(page: Page, organizationId: string, title: string) {
  const term = currentTerm();
  return api.post<ContractView>(page, '/api/v1/contracts', {
    organizationId, title, type: 'Msp', startDate: term.start, endDate: term.end, autoRenew: false, renewalTermMonths: 0, noticePeriodDays: 30,
    invoiceFrequency: 'Monthly', invoiceTiming: 'InAdvance', indexation: false,
  });
}

/** A customer with an organization number and a draft contract, linked to nothing yet. */
export async function customerToConnect(page: Page, prefix: string): Promise<CustomerToConnect> {
  const m = marker(prefix);
  const name = `${m} Kobling AS`;
  const organization = await createOrganization(page, { name, orgNumber: orgNumber(), status: 'Customer' });
  const products = await servicesProducts(page, m);
  const contract = await draftContract(page, organization.id, `${m} Drift`);
  return { id: organization.id, name, marker: m, key: `${m.toLowerCase()}-kobling`, ...products, contract };
}

export const contractOf = (page: Page, id: string) => api.get<ContractView>(page, `/api/v1/contracts/${id}`);

export interface EntityLink { system: string; externalType: string; externalId: string; displayName: string | null; method: string }

export const linksOf = (page: Page, organizationId: string) =>
  api.get<EntityLink[]>(page, `/api/v1/integrations/links?entityType=Organization&entityId=${organizationId}`);

/** The Huntress organizations with this key, with what the CRM sent to create them. */
export async function huntressOrganizations(page: Page, key: string) {
  const response = await page.request.get(`${mock}/huntress/organizations?key=${encodeURIComponent(key)}`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Array<{ id: number; name: string; key: string; posted: { created?: { name: string; key: string } } }>;
}

/** The account creations CloudAlly got for an address (the stand-in logs that a password came, never the password). */
export async function cloudAllyCreations(page: Page, email: string) {
  const response = await page.request.get(`${mock}/cloudally/log`);
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as Array<{ method: string; path: string; body: Record<string, unknown> }>)
    .filter((call) => call.method === 'POST' && call.path === 'v2/resellers/accounts' && call.body.email === email);
}

/** A Huntress organization of the test with `agents` agents, linked to the customer as a person links it on the mapping screen. */
export async function linkedHuntressOrganization(page: Page, organizationId: string, name: string, agents: number) {
  const created = await page.request.post(`${mock}/huntress/organizations`, { data: { name } });
  expect(created.status(), await created.text()).toBe(201);
  const organization = (await created.json()) as { id: number };
  for (let i = 0; i < agents; i++) {
    const agent = await page.request.post(`${mock}/huntress/agents`, { data: { organization_id: organization.id } });
    expect(agent.status(), await agent.text()).toBe(201);
  }
  await api.post(page, '/api/v1/integrations/links', {
    system: 'huntress', externalType: 'Organization', externalId: String(organization.id), entityId: organizationId,
  });
  return organization.id;
}

export interface ServiceQuantityView { model: string; count: number | null; status: string; billLines: unknown[] }

export const serviceQuantities = async (page: Page, organizationId: string) =>
  (await api.get<{ services: ServiceQuantityView[] }>(page, `/api/v1/billing/organizations/${organizationId}/service-quantities`)).services;

/** Starts `jobs` until `done` holds; a job can be busy with another test's read, so it is started again a few times. */
export async function syncUntil(page: Page, jobs: string[], done: () => Promise<boolean>, what: string) {
  for (let round = 0; round < 4; round++) {
    for (const job of jobs) await api.post(page, `/api/v1/integrations/jobs/${job}/trigger`);
    for (const deadline = Date.now() + 25_000; Date.now() < deadline; await page.waitForTimeout(1_000)) {
      if (await done()) return;
    }
  }
  throw new Error(`The reads did not bring ${what}`);
}
