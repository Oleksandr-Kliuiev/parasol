import { expect, test } from '@playwright/test';
import { atlasAttention } from '../src/test/atlasAttention';
import { createOrganization, marker, signIn } from './support';

// Controlled BFF projection checks. The composition gate independently reads the real employee-scoped Atlas data.
test('My day distinguishes partial customer coverage, source freshness and a bounded urgent preview', async ({ page }) => {
  await signIn(page, 'Crm.Admin', '/organizations');
  const customer = await createOrganization(page, { name: marker('Attention customer ') });
  const data = atlasAttention(customer.id); data.customers![0]!.customerName = customer.name;
  let denied = false; let reads = 0;
  await page.route('**/api/v1/parasol/my-day/atlas-attention', route => {
    reads++; return route.fulfill({ json: denied ? { ...data, status: 'ACCESS_DENIED', customers: null, totals: null } : data });
  });
  await page.goto('/'); const panel = page.getByRole('region', { name: 'Technical attention · Atlas', exact: true });
  await expect(panel.getByText('Customers read successfully: 1 of 2 selected', { exact: true })).toBeVisible();
  await expect(panel.getByText('Active observations in successfully read customers: 9 · High: 4 · Critical: 2', { exact: true })).toBeVisible();
  await expect(panel.getByText(/Coverage is incomplete/)).toBeVisible();
  // Gaps stay in sight; how the read works is one step away, without a new request.
  await expect(panel.getByText(/^Check coverage: .*Selected customers not successfully read: 1/)).toBeVisible();
  await expect(panel.getByText(/At most three urgent observations per customer/)).toBeVisible();
  await expect(panel.getByText(/not a complete queue or a global ranking/)).toBeHidden();
  await panel.getByText('Coverage and how this view works', { exact: true }).click();
  await expect(panel.getByText(/not a complete queue or a global ranking/)).toBeVisible(); expect(reads).toBe(1);
  const group = panel.getByRole('region', { name: customer.name, exact: true });
  await expect(group.getByRole('listitem')).toHaveCount(3);
  await expect(group.getByText('Showing 3 of 6 urgent observations', { exact: true })).toBeVisible();
  await group.getByText('Source coverage and freshness', { exact: true }).click();
  await expect(group.getByText('Outdated snapshot', { exact: true })).toBeVisible(); await expect(group.getByText('No snapshot', { exact: true })).toBeVisible();
  await expect(panel.getByRole('region', { name: 'Synthetic unavailable customer', exact: true }).getByText(/excluded from the observation totals/)).toBeVisible();
  denied = true; await panel.getByRole('button', { name: 'Refresh technical attention', exact: true }).click();
  await expect(panel.getByText(/Previous customer details have been removed/)).toBeVisible();
  await expect(panel.getByText(customer.name, { exact: true })).toHaveCount(0);
  await expect(panel.getByRole('listitem')).toHaveCount(0); expect(reads).toBe(2);
});

test('My day opens a fresh exact M12 preview before offering assigned work', { tag: '@critical' }, async ({ page }) => {
  await signIn(page, 'Crm.Admin', '/organizations');
  const customer = await createOrganization(page, { name: marker('Attention handoff ') });
  const data = atlasAttention(customer.id); const group = data.customers![0]!; group.customerName = customer.name;
  const observation = group.preview[0]!; let previews = 0; let writes = 0;
  await page.route('**/api/v1/parasol/my-day/atlas-attention', route => route.fulfill({ json: data }));
  const path = `**/api/v1/parasol/customers/${customer.id}/observations/${observation.id}`;
  await page.route(`${path}/task-preview`, route => {
    previews++; return route.fulfill({ json: { customerId: customer.id, status: 'READY', mode: 'db', observation,
      devices: group.devices, sha256: 'a'.repeat(64), task: null, canCreate: true } });
  });
  await page.route(`${path}/task`, route => { writes++; return route.fulfill({ status: 400, json: { code: 'UNEXPECTED_TEST_WRITE' } }); });
  await page.goto('/'); const panel = page.getByRole('region', { name: 'Technical attention · Atlas', exact: true });
  await panel.getByRole('listitem').filter({ hasText: observation.summary }).getByRole('button', { name: 'Assign work', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Assign observation work', exact: true });
  await expect(dialog.getByText(observation.summary, { exact: true })).toBeVisible();
  await expect(dialog.getByText('Task priority: High', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Create task', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await expect(dialog.getByRole('group', { name: 'Quick due dates', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click(); expect(previews).toBe(1); expect(writes).toBe(0);
});

test('an exact source denial discards the whole attention read and closes its previous dialog', async ({ page }) => {
  await signIn(page, 'Crm.Admin', '/organizations');
  const customer = await createOrganization(page, { name: marker('Denied attention ') });
  const data = atlasAttention(customer.id); data.customers![0]!.customerName = customer.name; let denied = false; let reads = 0;
  await page.route('**/api/v1/parasol/my-day/atlas-attention', route => {
    reads++; return route.fulfill({ json: denied ? { ...data, status: 'ACCESS_DENIED', customers: null, totals: null } : data });
  });
  await page.route(`**/api/v1/parasol/customers/${customer.id}/observations/*/task-preview`, route => {
    denied = true; return route.fulfill({ json: { customerId: customer.id, status: 'ACCESS_DENIED', mode: null,
      observation: null, devices: null, sha256: null, task: null, canCreate: false } });
  });
  await page.goto('/'); const panel = page.getByRole('region', { name: 'Technical attention · Atlas', exact: true });
  await panel.getByRole('button', { name: 'Assign work', exact: true }).first().click();
  await expect(panel.getByText(/Previous customer details have been removed/)).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0); await expect(panel.getByRole('listitem')).toHaveCount(0);
  await expect(panel.getByText(/Active observations in successfully read customers/)).toHaveCount(0); expect(reads).toBe(2);
});
