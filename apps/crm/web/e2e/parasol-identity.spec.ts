import { expect, test, type Page } from '@playwright/test';
import { api, createOrganization, marker, signIn } from './support';

const path = '/admin/mappings/atlas';
async function upload(page: Page, workspaceId: string, clients: { clientId: string; name: string }[]) {
  await page.getByLabel('Atlas export (JSON)').setInputFiles({ name: 'synthetic-identity.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ schemaVersion: 1, source: 'atlas', workspaceId, clients })) });
}
async function pick(page: Page, sourceName: string, customerName: string) {
  const row = page.getByRole('list', { name: 'Customer mappings' }).getByRole('listitem').filter({ hasText: sourceName });
  await row.getByRole('button', { name: 'Choose CRM customer' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('searchbox').fill(customerName);
  await dialog.getByRole('listitem').filter({ hasText: customerName }).getByRole('button', { name: 'Link', exact: true }).click();
  await expect(dialog).toBeHidden();
}
async function apply(page: Page) {
  await page.getByRole('checkbox', { name: /I have checked the selected customer pairs/ }).check();
  await page.getByRole('button', { name: 'Apply reviewed mappings' }).click();
}

test('an administrator reviews, applies, repeats and corrects Atlas links through the UI', { tag: '@critical' }, async ({ page }) => {
  await signIn(page, 'Crm.Admin', '/admin/mappings');
  const customer = await createOrganization(page, { name: marker('Identity customer ') });
  await page.getByRole('link', { name: 'Link Atlas customers', exact: true }).click();
  const workspace = marker('workspace-');
  await upload(page, workspace, [{ clientId: 'selected', name: 'Selected synthetic Atlas' }, { clientId: 'omitted', name: 'Omitted synthetic Atlas' }]);
  await pick(page, 'Selected synthetic Atlas', customer.name);
  await expect(page.getByText('Selected: 1 of 2. Left unchanged: 1.')).toBeVisible();
  await page.getByRole('button', { name: 'Preview mappings' }).click();
  await expect(page.getByText('Ready to link', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply reviewed mappings' })).toBeDisabled();
  expect((await api.get<{ atlas: unknown }>(page, `/api/v1/parasol/customers/${customer.id}/identity`)).atlas).toBeNull();
  await apply(page);
  await expect(page.getByText('Links saved: 1 new, 0 already present.')).toBeVisible();
  await page.getByRole('button', { name: 'Continue with this export' }).click();
  await page.getByRole('button', { name: 'Preview mappings' }).click();
  await expect(page.getByText('Already linked to this customer', { exact: true })).toBeVisible();
  await apply(page);
  await expect(page.getByText('Links saved: 0 new, 1 already present.')).toBeVisible();
  await page.getByRole('link', { name: customer.name, exact: true }).click();
  const panel = page.getByRole('region', { name: 'Customer link · Atlas' });
  await expect(panel.getByText(workspace, { exact: true })).toBeVisible();
  const before = await api.get<{ linkId: string }>(page, `/api/v1/parasol/customers/${customer.id}/identity`);
  await panel.getByRole('button', { name: 'Remove Atlas link' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await api.get<{ linkId: string }>(page, `/api/v1/parasol/customers/${customer.id}/identity`)).linkId).toBe(before.linkId);
  await panel.getByRole('button', { name: 'Remove Atlas link' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove Atlas link' }).click();
  await expect(panel.getByText('This customer has not been linked to Atlas.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Technical workspace · Atlas' }).getByText('This customer has not been linked to Atlas.')).toBeVisible();
  await panel.getByRole('link', { name: 'Link Atlas customers' }).click();
  await upload(page, workspace, [{ clientId: 'corrected', name: 'Corrected synthetic Atlas' }]);
  await pick(page, 'Corrected synthetic Atlas', customer.name);
  await page.getByRole('button', { name: 'Preview mappings' }).click();
  await apply(page);
  await expect(page.getByText('Links saved: 1 new, 0 already present.')).toBeVisible();
  const corrected = await api.get<{ atlas: { clientId: string }; linkId: string }>(page, `/api/v1/parasol/customers/${customer.id}/identity`);
  expect(corrected.atlas.clientId).toBe('corrected');
  expect(corrected.linkId).not.toBe(before.linkId);
  expect((await page.request.delete(`/api/v1/integrations/links/${before.linkId}`, { headers: { 'X-CSRF': '1' } })).status()).toBe(404);
});

test('a link changed after preview blocks the whole batch and a technician cannot manage it', { tag: '@critical' }, async ({ page }) => {
  await signIn(page, 'Crm.Admin', path);
  const selected = await createOrganization(page, { name: marker('Conflict selected ') });
  const other = await createOrganization(page, { name: marker('Conflict other ') });
  const untouched = await createOrganization(page, { name: marker('Conflict untouched ') });
  const workspaceId = marker('conflict-');
  const clients = [{ clientId: 'first', name: 'First synthetic Atlas' }, { clientId: 'second', name: 'Second synthetic Atlas' }];
  await upload(page, workspaceId, clients);
  await pick(page, clients[0]!.name, selected.name);
  await pick(page, clients[1]!.name, untouched.name);
  await page.getByRole('button', { name: 'Preview mappings' }).click();
  await expect(page.getByText('Ready to link', { exact: true })).toHaveCount(2);
  // A second operator commits a conflicting link after the first operator's preview.
  const input = { snapshot: { schemaVersion: 1, source: 'atlas', workspaceId, clients }, mappings: [{ atlasClientId: 'first', customerId: other.id }] };
  const preview = await api.post<{ sha256: string }>(page, '/api/v1/parasol/customer-identities/import', input);
  await api.post(page, `/api/v1/parasol/customer-identities/import?dryRun=false&expectedSha256=${preview.sha256}`, input);
  await apply(page);
  await expect(page.getByText(/The stored links changed/)).toBeVisible();
  expect((await api.get<{ atlas: unknown }>(page, `/api/v1/parasol/customers/${untouched.id}/identity`)).atlas).toBeNull();
  await page.getByRole('button', { name: 'Preview mappings' }).click();
  await expect(page.getByText('Conflict: Atlas client is linked to another CRM customer')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply reviewed mappings' })).toBeDisabled();
  await signIn(page, 'Crm.Technician', path);
  await expect(page.getByLabel('Atlas export (JSON)')).toHaveCount(0);
  expect((await page.request.post('/api/v1/parasol/customer-identities/import', { data: input, headers: { 'X-CSRF': '1' } })).status()).toBe(403);
  await page.goto(`/organizations/${other.id}`);
  await expect(page.getByRole('region', { name: 'Customer link · Atlas' })).toHaveCount(0);
});
