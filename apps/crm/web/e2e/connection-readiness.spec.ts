import { expect, test } from '@playwright/test';
import { localReadiness } from '../src/test/localReadiness';
import { signIn } from './support';

// Closed read-only projection checks; the SQL integration tests cover the saved state the server reads.
test('an integration manager sees saved state apart from local flags and keeps focus through a refresh', { tag: '@critical' }, async ({ page }) => {
  let unreadable = false; let reads = 0;
  await page.route('**/api/v1/parasol/local-readiness', route => {
    reads++; const value = localReadiness();
    if (unreadable) { value.status = 'PARTIAL'; value.admin.atera.stored = null; value.admin.powerOffice.stored = null; value.admin.microsoftGraph.stored = null; }
    return route.fulfill({ json: value });
  });
  await signIn(page, 'Crm.Admin', '/connections');
  await expect(page.getByRole('heading', { name: 'Connection readiness', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Connections', exact: true })).toBeVisible();
  await expect(page.getByText('Connections and credentials have not been checked.', { exact: true })).toBeVisible();
  const atera = page.getByRole('region', { name: 'Atera', exact: true });
  await expect(atera.getByText('Stored external records', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Microsoft Graph', exact: true }).getByText(/may be historical/)).toBeVisible();
  await expect(page.getByText(/held by the background service, so this page cannot see whether they are set/)).toBeVisible();
  await expect(page.getByText(/Signing in through Microsoft 365 or Entra does not establish technical tenant monitoring/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Test connection|Run now|Sync|Pause|Edit/i })).toHaveCount(0);
  expect(reads).toBe(1);
  unreadable = true; const refresh = page.getByRole('button', { name: 'Refresh local readiness', exact: true });
  await refresh.focus(); await page.keyboard.press('Enter');
  await expect(page.getByText(/not a connection-health result/)).toBeVisible();
  await expect(atera.getByText(/Saved local state could not be read/)).toBeVisible();
  await expect(atera.getByText('Stored external records', { exact: true })).toHaveCount(0); await expect(refresh).toBeFocused();
  expect(reads).toBe(2);
});

test('roles without integration administration cannot discover or fetch Connections', async ({ page }) => {
  let reads = 0;
  await page.route('**/api/v1/parasol/local-readiness', route => { reads++; return route.fulfill({ json: localReadiness() }); });
  for (const role of ['Crm.Technician', 'Crm.Finance'] as const) {
    await signIn(page, role, '/connections');
    await expect(page.getByRole('heading', { name: 'No access', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Connections', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Connection readiness', exact: true })).toHaveCount(0);
    expect(reads).toBe(0);
    expect((await page.request.get('/api/v1/parasol/local-readiness')).status()).toBe(403);
  }
});
