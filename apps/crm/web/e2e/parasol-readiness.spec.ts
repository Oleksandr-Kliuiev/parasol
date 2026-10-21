import { expect, test } from '@playwright/test';
import { localReadiness } from '../src/test/localReadiness';
import { signIn } from './support';

// Closed read-only projection checks; real composition separately verifies saved state and zero Atlas calls.
test('a technician can open personal Connections without gaining administrative configuration', { tag: '@critical' }, async ({ page }) => {
  let reads = 0; const value = localReadiness({ atlasRead: true, integrationsManage: false, customersRead: true });
  await page.route('**/api/v1/parasol/local-readiness', route => { reads++; return route.fulfill({ json: value }); });
  await signIn(page, 'Crm.Technician', '/connections');
  await expect(page.getByRole('heading', { name: 'Connection readiness', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Connections', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Personal Atlas configuration', exact: true }).getByText('Personal entry present', { exact: true })).toBeVisible();
  await expect(page.getByText('Connections and credentials have not been checked.', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Saved administrative configuration', exact: true })).toHaveCount(0);
  await expect(page.getByRole('main').getByRole('button')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Refresh local readiness', exact: true })).toBeVisible();
  expect(reads).toBe(1);
});

test('admin Connections separates historical state from flags and replaces changed mapping counts on refresh', async ({ page }) => {
  let changed = false;
  await page.route('**/api/v1/parasol/local-readiness', route => {
    const value = localReadiness(); value.status = 'PARTIAL'; const m = value.admin!.atlasMappings!;
    if (changed) { m.status = 'CHANGED'; m.reviewStatus = 'UNKNOWN'; m.coverage = null; m.counts = null; }
    else { m.status = 'INCOMPLETE'; m.reviewStatus = 'REQUIRED'; m.coverage = { storedLinks: 501, examinedLinks: 500, omittedLinks: 1, unlinkedStoredReferences: 2 }; m.counts!.validLinks = 500; }
    return route.fulfill({ json: value });
  });
  await signIn(page, 'Crm.Admin', '/connections');
  const mapping = page.getByRole('region', { name: 'Stored Atlas mappings', exact: true });
  await expect(mapping.getByText('Stored links examined: 500 of 501 (limit 500)', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Microsoft Graph', exact: true }).getByText(/may be historical/)).toBeVisible();
  await expect(page.getByText(/held by the background service, so this page cannot see whether they are set/)).toBeVisible();
  await expect(page.getByText(/Signing in through Microsoft 365 or Entra does not establish technical tenant monitoring/)).toBeVisible();
  await expect(page.getByText('Configuration unknown here', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Test connection|Run now|Sync|Pause|Edit/i })).toHaveCount(0);
  changed = true; const refresh = page.getByRole('button', { name: 'Refresh local readiness', exact: true });
  await refresh.focus(); await page.keyboard.press('Enter');
  await expect(mapping.getByText('Mapping review is unknown. No previous counts are shown.', { exact: true })).toBeVisible();
  await expect(mapping.getByText(/Stored links examined/)).toHaveCount(0); await expect(refresh).toBeFocused();
});

test('Finance cannot discover or fetch technical Connections through navigation or a direct route', async ({ page }) => {
  let reads = 0;
  await page.route('**/api/v1/parasol/local-readiness', route => { reads++; return route.fulfill({ json: localReadiness() }); });
  await signIn(page, 'Crm.Finance', '/connections');
  await expect(page.getByRole('link', { name: 'Connections', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Connection readiness', exact: true })).toHaveCount(0);
  expect(reads).toBe(0);
  expect((await page.request.get('/api/v1/parasol/local-readiness')).status()).toBe(403);
});
