import { expect, test } from '@playwright/test';
import { api, signIn, toast } from './support';

test('an administrator imports a PowerOffice customer from the mapping screen', async ({ page, request }) => {
  const { run } = (await (await request.get('http://localhost:5299/health')).json()) as { run: string };
  const customerName = `Fjordkraft Regnskap ${run}`;
  await signIn(page, 'Crm.Admin', '/admin/integrations');

  // The worker performs the synchronization, as in production.
  await api.post(page, '/api/v1/integrations/jobs/poweroffice-customers/trigger');
  await expect
    .poll(
      async () => (await api.get<{ items: unknown[] }>(page, `/api/v1/integrations/records?system=poweroffice&type=Customer&state=All&search=${run}`)).items.length,
      { timeout: 60_000, intervals: [1000] },
    )
    .toBe(3);

  await page.goto('/admin/mappings?system=poweroffice&type=Customer&state=Unlinked');
  await page.getByRole('searchbox', { name: 'Search name, number, e-mail' }).fill(run);
  // The search is debounced: wait until only this run's three customers are listed before clicking.
  await expect(page.locator('tbody tr')).toHaveCount(3);
  const row = page.getByRole('row').filter({ hasText: customerName });
  await row.getByRole('button', { name: 'Create in CRM' }).click();
  await expect(toast(page, 'Created in CRM')).toBeVisible();

  await page.goto(`/admin/mappings?system=poweroffice&type=Customer&state=Linked&search=${run}`);
  await page.getByRole('row').filter({ hasText: customerName }).getByRole('link', { name: customerName }).click();
  await expect(page.getByRole('heading', { level: 1, name: customerName })).toBeVisible();
  const linked = page.getByRole('region', { name: 'Linked systems' });
  await expect(linked.getByText('PowerOffice Go')).toBeVisible();

  await page.goto(`/admin/mappings?system=poweroffice&type=Customer&state=Unlinked&search=${run}`);
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await page.getByRole('button', { name: 'Import all not linked…' }).click();
  await expect(page.getByRole('dialog').getByText(/^Preview:/)).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
});
