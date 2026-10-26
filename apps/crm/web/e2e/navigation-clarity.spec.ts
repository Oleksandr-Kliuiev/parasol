import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { createOrganization, marker, signIn } from './support';

async function accessible(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .exclude('[data-tabster-dummy]').analyze();
  expect(result.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => v.id)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

async function customer(page: Page) {
  await signIn(page, 'Crm.Admin', '/organizations');
  return createOrganization(page, { name: marker('Navigation ') });
}

test('browser titles follow the page and the skip link remains readable above the sticky header', { tag: '@critical' }, async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const organization = await customer(page);
  await page.goto(`/organizations/${organization.id}`);
  await expect(page).toHaveTitle(`${organization.name} · Parasoll`);
  await page.getByRole('main').getByRole('link', { name: 'Organizations', exact: true }).click();
  await expect(page).toHaveTitle('Organizations · Parasoll');
  for (const width of [1440, 768, 390, 320]) for (const colorScheme of ['light', 'dark'] as const) {
    await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme }); await page.goto('/');
    await expect(page).toHaveTitle('My day · Parasoll'); await page.waitForLoadState('networkidle');
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content', exact: true });
    await expect(skip).toBeFocused(); await expect(skip).toBeInViewport(); await accessible(page);
    await page.screenshot({ path: testInfo.outputPath(`skip-${width}-${colorScheme}.png`) });
    await page.keyboard.press('Enter'); await expect(page.getByRole('main')).toBeFocused();
    const geometry = await page.getByRole('main').evaluate(main => ({
      heading: main.querySelector('h1')!.getBoundingClientRect().top,
      header: main.previousElementSibling!.getBoundingClientRect().bottom,
    }));
    expect(geometry.heading, 'Skipping must not put the page heading behind the sticky bar').toBeGreaterThanOrEqual(geometry.header);
  }
});

test('customer sections stay reachable on narrow screens, the overview stays accessible and wide tables scroll by keyboard', { tag: '@critical' }, async ({ page }) => {
  test.setTimeout(180_000);
  const organization = await customer(page);
  for (const width of [1440, 768, 390, 320]) for (const colorScheme of ['light', 'dark'] as const) {
    await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme });
    await page.goto(`/organizations/${organization.id}`);
    await expect(page.getByRole('region', { name: 'Contact information', exact: true })).toBeVisible();
    const tabs = page.getByRole('tablist', { name: 'Customer sections', exact: true });
    if (width < 1440) {
      // A phone still scrolls the shorter row, with a fading edge.
      if (width <= 390) await expect(tabs).not.toHaveCSS('mask-image', 'none');
      // Occasional sections are under "More"; the one opened joins the row, selected and revealed in it.
      await tabs.getByRole('tab', { name: /^More/ }).click();
      await page.getByRole('menuitem', { name: 'History', exact: true }).click();
      const history = tabs.getByRole('tab', { name: 'History', exact: true });
      await expect(history).toHaveAttribute('aria-selected', 'true'); await expect(history).toBeInViewport();
      await tabs.getByRole('tab', { name: 'Overview', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Contact information', exact: true })).toBeVisible();
    }
    await accessible(page);
  }
  await page.setViewportSize({ width: 768, height: 900 }); await page.goto('/organizations');
  const table = page.getByRole('region', { name: 'Scrollable organizations table', exact: true });
  await expect(table).not.toHaveCSS('mask-image', 'none'); await table.focus(); await page.keyboard.press('ArrowRight');
  await expect.poll(() => table.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => table.evaluate(el => el.scrollLeft)).toBe(0);
});
