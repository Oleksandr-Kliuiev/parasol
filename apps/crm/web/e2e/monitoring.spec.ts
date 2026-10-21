import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { api, signIn } from './support';

test('an operator assigns and reviews an intentional pause and the signal recovers @critical', async ({ page }, testInfo) => {
  await signIn(page, 'Crm.Admin', '/admin/integrations');
  const me = await api.get<{ displayName: string }>(page, '/bff/user');
  await api.post(page, '/api/v1/integrations/poweroffice/pause', { paused: true, reason: 'DEV-17 synthetic monitoring acceptance' });
  try {
    await page.reload();
    const panel = page.getByRole('region', { name: 'Monitoring and exception review' });
    await expect(panel.getByRole('table', { name: 'Source freshness' })).toBeVisible();
    await panel.getByRole('combobox', { name: 'Category', exact: true }).selectOption('Pause');
    await panel.getByRole('combobox', { name: 'Source', exact: true }).selectOption('poweroffice');
    await expect(panel.getByText('Integration paused', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'Review exception' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Runbook reference: docs/runbooks/15-monitoring.md')).toBeVisible();
    await dialog.getByRole('button', { name: 'Assign to me' }).click();
    await expect(dialog.getByRole('combobox', { name: 'Owner', exact: true })).toHaveValue(me.displayName);
    await expect(dialog.getByRole('option', { name: 'Resolved', exact: true })).toBeDisabled();
    await dialog.getByRole('combobox', { name: 'Review status' }).selectOption('InProgress');
    await dialog.getByRole('textbox', { name: 'Comment' }).fill(`Synthetic recovery check ${testInfo.project.name}`);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(panel.getByText(`Synthetic recovery check ${testInfo.project.name}`)).toBeVisible();
    const violations = await new AxeBuilder({ page }).include('section:has(table[aria-label="Source freshness"])').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(violations.violations).toEqual([]);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.setViewportSize({ width: 360, height: 800 });
    // Fluent buttons animate their foreground/background when the OS theme changes. Check the settled dark theme: a
    // secondary button is the dark card surface (#1E1B19) with the dark theme's main text (#F2EDE6).
    await expect(panel.getByRole('button', { name: 'Refresh' })).toHaveCSS('background-color', 'rgb(30, 27, 25)');
    await expect(panel.getByRole('button', { name: 'Refresh' })).toHaveCSS('color', 'rgb(242, 237, 230)');
    const dark = await new AxeBuilder({ page }).include('section:has(table[aria-label="Source freshness"])').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(dark.violations).toEqual([]);
    const overflow = await page.evaluate(() => [...document.body.querySelectorAll('*')].filter(element => {
      const box = element.getBoundingClientRect();
      if (box.right <= innerWidth || box.width === 0) return false;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (['auto', 'scroll', 'hidden'].includes(getComputedStyle(parent).overflowX)) return false;
      }
      return true;
    }).map(element => ({ tag: element.tagName, text: element.textContent?.slice(0, 100), right: element.getBoundingClientRect().right })));
    expect(overflow).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('monitoring-dark-mobile.png'), fullPage: true });
  } finally {
    await api.post(page, '/api/v1/integrations/poweroffice/pause', { paused: false });
  }
  const panel = page.getByRole('region', { name: 'Monitoring and exception review' });
  await panel.getByRole('button', { name: 'Refresh' }).click();
  await expect(panel.getByText('Source recovered — review pending', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Review exception' }).click();
  const recovered = page.getByRole('dialog');
  await expect(recovered.getByRole('option', { name: 'Resolved', exact: true })).toBeEnabled();
  await recovered.getByRole('combobox', { name: 'Review status' }).selectOption('Resolved');
  await recovered.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(recovered).not.toBeVisible();
  await expect(panel.getByText('Integration paused', { exact: true })).not.toBeVisible();
});
