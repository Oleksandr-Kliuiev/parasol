import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { atlasWorkspace } from '../src/test/atlasWorkspace';
import { createOrganization, marker, signIn } from './support';

test('observation work dialog supports keyboard focus and a narrow viewport', async ({ page }) => {
  await signIn(page, 'Crm.Admin', '/organizations');
  const customer = await createOrganization(page, { name: marker('Accessible observation work ') });
  const overview = atlasWorkspace(customer.id); const summary = overview.summary!; const observation = summary.observationPage.items[0]!;
  await page.route(`**/api/v1/parasol/customers/${customer.id}/workspace`, route => route.fulfill({ json: overview }));
  await page.route(`**/api/v1/parasol/customers/${customer.id}/observations/${observation.id}/task-preview`, route => route.fulfill({ json: {
    customerId: customer.id, status: 'READY', mode: 'fixture', observation, devices: summary.devices,
    sha256: 'a'.repeat(64), task: null, canCreate: true,
  } }));
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`/organizations/${customer.id}`);
  const button = page.getByRole('listitem').filter({ hasText: observation.summary }).getByRole('button', { name: 'Assign work', exact: true });
  await button.focus(); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Assign observation work' });
  await expect(dialog.getByText(observation.summary, { exact: true })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => undefined))); });
  const result = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .exclude('[data-tabster-dummy]').analyze();
  expect(result.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(button).toBeFocused();
});
