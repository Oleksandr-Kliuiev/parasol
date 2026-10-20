import { expect, test } from '@playwright/test';
import { api, createOrganization, marker, signIn } from './support';
import { atlasWorkspace } from '../src/test/atlasWorkspace';

test('one sign-in opens the customer workspace and respects employee roles', { tag: '@critical' }, async ({ page }) => {
  await signIn(page, 'Crm.Admin', '/organizations');
  const customer = await createOrganization(page, { name: marker('Parasol ') });
  await signIn(page, 'Crm.Technician', `/organizations/${customer.id}`);
  await expect(page).toHaveTitle(`${customer.name} · Parasoll`);
  const panel = page.getByRole('region', { name: 'Technical workspace · Atlas' });
  await expect(panel.getByText('This customer has not been linked to Atlas.')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Invoices', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: customer.name, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Dev Technician', exact: true }).click();
  await expect(page.getByText('Employee roles: Technician', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await signIn(page, 'Crm.Finance', `/organizations/${customer.id}`);
  await expect(panel.getByText('Your role does not include the technical workspace.')).toBeVisible();
  const denied = await page.request.get(`/api/v1/parasol/customers/${customer.id}/workspace`);
  expect(denied.status()).toBe(403);
  await expect(page.getByRole('tab', { name: 'Invoices', exact: true })).toBeVisible();
});

test('a linked customer explicitly says Atlas is not configured and CRM stays usable', async ({ page }) => {
  await signIn(page, 'Crm.Admin', '/organizations');
  const customer = await createOrganization(page, { name: marker('Linked Parasol ') });
  const clientId = marker('atlas-');
  const input = { snapshot: { schemaVersion: 1, source: 'atlas', workspaceId: 'e2e-synthetic', clients: [{ clientId, name: 'Synthetic' }] }, mappings: [{ atlasClientId: clientId, customerId: customer.id }] };
  const preview = await api.post<{ sha256: string }>(page, '/api/v1/parasol/customer-identities/import', input);
  await api.post(page, `/api/v1/parasol/customer-identities/import?dryRun=false&expectedSha256=${preview.sha256}`, input);
  await page.goto(`/organizations/${customer.id}`);
  await expect(page.getByText('The Atlas connection has not been configured.')).toBeVisible();
  await page.getByRole('tab', { name: 'Contacts', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add contact', exact: true })).toBeVisible();
});

// The backend HTTP bridge is tested against a local Atlas double in AtlasWorkspaceTests. This browser test controls the
// BFF response to exercise freshness, failure and viewport states; no live provider or production identity is involved.
test('technical snapshot renders on a phone and disappears after access is revoked', async ({ page }, testInfo) => {
  await signIn(page, 'Crm.Admin', '/organizations');
  const customer = await createOrganization(page, { name: marker('Snapshot Parasol ') });
  let denied = false;
  const ready = atlasWorkspace(customer.id);
  ready.summary!.mode = 'fixture'; ready.summary!.completeness = 'COMPLETE_FIXTURE';
  await page.route(`**/api/v1/parasol/customers/${customer.id}/workspace`, route => route.fulfill({ json:
    denied ? { customerId: customer.id, status: 'ACCESS_DENIED', summary: null } : ready,
  }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/organizations/${customer.id}`);
  const panel = page.getByRole('region', { name: 'Technical workspace · Atlas' });
  await expect(panel.getByText('42', { exact: true })).toBeVisible();
  await expect(panel.getByText('Outdated snapshot', { exact: true })).toBeVisible();
  await expect(panel.getByText(/Synthetic demonstration data/)).toBeVisible();
  await expect(panel.getByText('No snapshot', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('workspace-mobile.png'), fullPage: true });
  denied = true;
  await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(panel.getByText('Your Atlas access does not permit reading this customer.')).toBeVisible();
  await expect(panel.getByText('42', { exact: true })).toHaveCount(0);
});
