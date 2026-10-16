import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { createOrganization, marker, signIn } from './support';

async function accessible(page: Page) {
  // Network idle may already hold when a modal opens. Wait for its finite entrance animation too:
  // axe otherwise samples intermediate opacity and reports the backdrop as the text's foreground colour.
  await page.waitForLoadState('networkidle');
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity)
      .map(a => a.finished.catch(() => undefined)));
  });
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .exclude('[data-tabster-dummy]').analyze();
  expect(result.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => ({ id: v.id, nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })) }))).toEqual([]);
}

test('identity upload is accessible and long IDs stay within a phone viewport', async ({ page }, testInfo) => {
  await signIn(page, 'Crm.Admin', '/admin/mappings/atlas');
  await accessible(page);
  await page.getByLabel('Atlas export (JSON)').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{invalid') });
  await expect(page.getByText(/not a valid version 1/)).toBeVisible();
  await accessible(page);
  const snapshot = { schemaVersion: 1, source: 'atlas', workspaceId: 'workspace-'.repeat(12),
    clients: Array.from({ length: 51 }, (_, i) => ({ clientId: `client-${i}-` + 'x'.repeat(110), name: `Synthetic ${i}` })) };
  await page.getByLabel('Atlas export (JSON)').setInputFiles({ name: 'synthetic.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(snapshot)) });
  await expect(page.getByText('Showing 50 of 51 rows')).toBeVisible();
  await page.getByRole('button', { name: 'Load more', exact: true }).click();
  await expect(page.getByText('Showing 51 of 51 rows')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await accessible(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Choose another source' }).click();
  await expect(page.getByLabel('Atlas export (JSON)')).toBeVisible();
  const customer = await createOrganization(page, { name: marker('Mobile identity ') });
  await page.getByLabel('Atlas export (JSON)').setInputFiles({ name: 'synthetic.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
    schemaVersion: 1, source: 'atlas', workspaceId: marker('mobile-'), clients: [{ clientId: 'synthetic', name: 'Synthetic Atlas' }],
  })) });
  await page.getByRole('button', { name: 'Choose CRM customer' }).click();
  await page.getByRole('dialog').getByRole('searchbox').fill(customer.name);
  await page.getByRole('dialog').getByRole('button', { name: 'Link', exact: true }).click();
  await page.getByRole('button', { name: 'Preview mappings' }).click();
  await expect(page.getByText('Ready to link', { exact: true })).toBeVisible();
  await accessible(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('identity-mobile-preview.png'), fullPage: true });
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Apply reviewed mappings' }).click();
  await expect(page.getByText('Links saved: 1 new, 0 already present.')).toBeVisible();
  await page.getByRole('link', { name: customer.name }).click();
  await page.getByRole('region', { name: 'Customer link · Atlas' }).getByRole('button', { name: 'Remove Atlas link' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await accessible(page);
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
});
