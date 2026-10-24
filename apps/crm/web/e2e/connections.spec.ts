import { expect, test } from '@playwright/test';
import { connectionGaps, connectionStatus } from '../src/test/connectionStatus';
import { signIn } from './support';

// The page against a closed synthetic reply; the SQL integration tests cover the saved state the server reads.
test('an integration manager sees the CRM\'s own integration state, its gaps in one box, and keeps focus through a refresh', { tag: '@critical' }, async ({ page }) => {
  let gaps = false; let reads = 0;
  await page.route('**/api/v1/integrations/connections', route => { reads++; return route.fulfill({ json: gaps ? connectionGaps() : connectionStatus() }); });
  await signIn(page, 'Crm.Admin', '/connections');
  await expect(page.getByRole('heading', { name: 'Connection status', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Connections', exact: true })).toBeVisible();
  await expect(page.getByText(/^Everything is up to date/)).toBeVisible();
  await expect(page.getByText(/The systems themselves are not contacted/)).toBeVisible();
  const atera = page.getByRole('region', { name: 'Atera', exact: true });
  await expect(atera.getByText('Alerts (Atera)', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Background service', exact: true }).getByText('Running')).toHaveCount(3);
  await expect(page.getByRole('button', { name: /Test connection|Run now|Sync|Pause|Edit/i })).toHaveCount(0);
  expect(reads).toBe(1);
  gaps = true; const refresh = page.getByRole('button', { name: 'Refresh status', exact: true });
  await refresh.focus(); await page.keyboard.press('Enter');
  await expect(page.getByText('6 things need attention', { exact: true })).toBeVisible();
  await expect(page.getByText('Customers (Atera): no complete read yet', { exact: true })).toBeVisible();
  await expect(atera.getByText('Needs attention', { exact: true })).toBeVisible();
  await expect(page.getByText(/^Everything is up to date/)).toHaveCount(0); await expect(refresh).toBeFocused();
  expect(reads).toBe(2);
});

test('roles without integration administration can neither find nor read Connections', async ({ page }) => {
  let reads = 0;
  await page.route('**/api/v1/integrations/connections', route => { reads++; return route.fulfill({ json: connectionStatus() }); });
  for (const role of ['Crm.Technician', 'Crm.Finance'] as const) {
    await signIn(page, role, '/connections');
    await expect(page.getByRole('heading', { name: 'No access', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Connections', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Connection status', exact: true })).toHaveCount(0);
    expect(reads).toBe(0);
    expect((await page.request.get('/api/v1/integrations/connections')).status()).toBe(403);
  }
});
