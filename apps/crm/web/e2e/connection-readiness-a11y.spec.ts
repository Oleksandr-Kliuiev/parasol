import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { localReadiness } from '../src/test/localReadiness';
import { signIn } from './support';
import { computedTextContrast } from './computedTextContrast';

test('local Connections is usable on a narrow screen and retains keyboard focus during refresh', async ({ page }, testInfo) => {
  await page.route('**/api/v1/parasol/local-readiness', route => route.fulfill({ json: localReadiness() }));
  await page.setViewportSize({ width: 390, height: 844 }); await signIn(page, 'Crm.Admin', '/connections');
  await expect(page.getByText('Connections and credentials have not been checked.', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Microsoft Graph', exact: true })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => undefined))); });
  const expectedStatuses = [
    ['Atera', ['Disabled locally', 'Disabled locally']],
    ['PowerOffice', ['Enabled locally', 'Disabled locally']],
    ['Microsoft Graph', ['Disabled locally', 'Disabled locally', 'Disabled locally', 'Disabled locally', 'Disabled locally']],
  ] as const;
  // Axe reports exactly 1:1 contrast as incomplete, so violation-only checks miss
  // white-on-white text. These assertions measure every status's rendered colors.
  for (const [regionName, labels] of expectedStatuses) {
    const badges = page.getByRole('region', { name: regionName, exact: true }).locator('.fui-Badge');
    await expect(badges).toHaveText([...labels]);
    for (let index = 0; index < labels.length; index++) {
      const badge = badges.nth(index); await expect(badge).toBeVisible();
      expect(await badge.ariaSnapshot(), `${regionName}: static status is exposed as accessible text`).toContain(labels[index]);
      const contrast = await computedTextContrast(badge);
      expect(contrast.ratio, `${regionName}: ${labels[index]} (${JSON.stringify(contrast)})`).toBeGreaterThanOrEqual(4.5);
    }
  }
  const result = await new AxeBuilder({ page }).include('main').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .exclude('[data-tabster-dummy]').analyze();
  expect(result.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const refresh = page.getByRole('button', { name: 'Refresh local readiness', exact: true }); await expect(refresh).toBeEnabled();
  const theme = testInfo.project.use.colorScheme; expect(['light', 'dark']).toContain(theme);
  await page.screenshot({ path: testInfo.outputPath(`local-readiness-${theme}-synthetic.png`), fullPage: true, animations: 'disabled' });
  await refresh.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Atera', exact: true })).toBeVisible(); await expect(refresh).toBeFocused();
});
