import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { atlasAttention } from '../src/test/atlasAttention';
import { createOrganization, marker, signIn } from './support';

test('customer attention supports keyboard use and a narrow viewport without losing coverage warnings', async ({ page }) => {
  await signIn(page, 'Crm.Admin', '/organizations');
  const customer = await createOrganization(page, { name: marker('Accessible attention ') });
  const data = atlasAttention(customer.id); data.customers![0]!.customerName = customer.name;
  await page.route('**/api/v1/parasol/my-day/atlas-attention', route => route.fulfill({ json: data }));
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  const panel = page.getByRole('region', { name: 'Technical attention · Atlas', exact: true });
  await expect(panel.getByText(/Coverage is incomplete/)).toBeVisible();
  const sources = panel.getByText('Source coverage and freshness', { exact: true });
  await sources.focus(); await page.keyboard.press('Enter'); await expect(panel.getByText('Outdated snapshot', { exact: true })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => undefined))); });
  const headingId = await panel.getAttribute('aria-labelledby'); expect(headingId).toBeTruthy();
  const result = await new AxeBuilder({ page }).include(`section[aria-labelledby="${headingId}"]`)
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).exclude('[data-tabster-dummy]').analyze();
  expect(result.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const refresh = panel.getByRole('button', { name: 'Refresh technical attention', exact: true });
  await refresh.focus(); await page.keyboard.press('Enter');
  await expect(panel.getByText('Customers read successfully: 1 of 2 selected', { exact: true })).toBeVisible(); await expect(refresh).toBeFocused();
});
