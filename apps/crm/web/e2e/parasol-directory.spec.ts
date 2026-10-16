import { expect, test } from '@playwright/test';
import { api, createOrganization, marker, signIn } from './support';

const endpoint = '/api/v1/parasol/customer-identities/atlas-export';

test('an unconfigured Atlas connection leaves the existing file import available', async ({ page }) => {
  await signIn(page, 'Crm.Admin', '/admin/mappings/atlas');
  const reply = page.waitForResponse(r => r.url().endsWith(endpoint));
  await page.getByRole('button', { name: 'Load from Atlas' }).click();
  expect((await reply).status()).toBe(200);
  await expect(page.getByText('The Atlas connection has not been configured. You can upload an identity export instead.')).toBeVisible();
  await expect(page.getByLabel('Atlas export (JSON)')).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Preview mappings' })).toHaveCount(0);
});

// The authenticated BFF -> Atlas HTTP journey is covered by AtlasIdentityApiTests with a local HTTP server and SQL.
// Here only its response is controlled; customer selection, preview, confirmation and persistence use the real CRM API.
test('the Atlas directory feeds the reviewed mapping workflow and a failed reload leaves no old selection', { tag: '@critical' }, async ({ page }) => {
  await signIn(page, 'Crm.Admin', '/admin/mappings/atlas');
  const customer = await createOrganization(page, { name: marker('Directory customer ') });
  const workspaceId = marker('directory-');
  let revoked = false;
  let reads = 0;
  const snapshot = { schemaVersion: 1, source: 'atlas', workspaceId, clients: [{ clientId: 'visible', name: 'Synthetic visible client' }] };
  await page.route(`**${endpoint}`, route => {
    reads++;
    return route.fulfill({ json: revoked ? { status: 'ACCESS_DENIED', snapshot: null, retrievedAt: null }
      : { status: 'READY', snapshot, retrievedAt: '2026-10-16T14:00:00Z' } });
  });
  expect(reads).toBe(0);
  await page.getByRole('button', { name: 'Load from Atlas' }).click();
  await expect(page.getByText(/Loaded from Atlas at/)).toBeVisible();
  await page.getByRole('button', { name: 'Choose CRM customer' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('searchbox').fill(customer.name);
  await dialog.getByRole('listitem').filter({ hasText: customer.name }).getByRole('button', { name: 'Link', exact: true }).click();
  await page.getByRole('button', { name: 'Preview mappings' }).click();
  await expect(page.getByText('Ready to link', { exact: true })).toBeVisible();
  expect((await api.get<{ atlas: unknown }>(page, `/api/v1/parasol/customers/${customer.id}/identity`)).atlas).toBeNull();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Apply reviewed mappings' }).click();
  await expect(page.getByText('Links saved: 1 new, 0 already present.')).toBeVisible();
  const saved = await api.get<{ atlas: { workspaceId: string; clientId: string } }>(page, `/api/v1/parasol/customers/${customer.id}/identity`);
  expect(saved.atlas).toEqual({ workspaceId, clientId: 'visible' });
  expect(reads).toBe(1);
  revoked = true;
  await page.getByRole('button', { name: 'Choose another source' }).click();
  await page.getByRole('button', { name: 'Load from Atlas' }).click();
  await expect(page.getByText('Your personal Atlas access is missing or does not permit reading the customer directory.')).toBeVisible();
  await expect(page.getByText('Synthetic visible client', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Apply reviewed mappings' })).toHaveCount(0);
  expect(reads).toBe(2);
});
