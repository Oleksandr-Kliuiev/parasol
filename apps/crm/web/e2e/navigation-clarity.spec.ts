import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { atlasWorkspace } from '../src/test/atlasWorkspace';
import { createOrganization, marker, signIn } from './support';

async function accessible(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .exclude('[data-tabster-dummy]').analyze();
  expect(result.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => v.id)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

async function customer(page: Page) {
  await signIn(page, 'Crm.Admin', '/organizations');
  const organization = await createOrganization(page, { name: marker('Navigation ') });
  const workspace = atlasWorkspace(organization.id);
  await page.route(`**/api/v1/parasol/customers/${organization.id}/workspace`, route => route.fulfill({ json: workspace }));
  return organization;
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

test('technical lists retain every loaded row, scroll by keyboard and do not stretch the client details', { tag: '@critical' }, async ({ page }) => {
  test.setTimeout(180_000);
  const organization = await customer(page);
  for (const width of [1440, 768, 390, 320]) for (const colorScheme of ['light', 'dark'] as const) {
    await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme });
    await page.goto(`/organizations/${organization.id}`);
    const workspace = page.getByRole('region', { name: 'Technical workspace · Atlas' });
    const contact = page.getByRole('region', { name: 'Contact information', exact: true });
    const records = workspace.getByRole('list', { name: 'Active Atlas observations', exact: true });
    await expect(records.getByRole('listitem')).toHaveCount(3);
    if (width === 1440) {
      // The client details move beside the workspace once it has read its data (`:has([data-technical-layout])`); a slower
      // engine can be measured a moment before that, so wait for the settled layout instead of one snapshot.
      await expect.poll(async () => {
        const [l, r] = [await workspace.boundingBox(), await contact.boundingBox()];
        return l && r && r.x > l.x + l.width ? Math.abs(r.y - l.y) : Number.POSITIVE_INFINITY;
      }, { message: 'The client details stand beside the workspace, tops aligned' }).toBeLessThan(2);
      const left = await workspace.boundingBox(), right = await contact.boundingBox();
      expect(right!.x).toBeGreaterThan(left!.x + left!.width);
      expect(Math.abs(right!.y - left!.y)).toBeLessThan(2);
      const company = await page.getByRole('region', { name: 'Company', exact: true }).boundingBox();
      expect(company!.x).toBeGreaterThan(left!.x + left!.width);
      expect(company!.y - right!.y, 'Client records must not wait for the whole observation list row').toBeLessThan(400);
    }
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
    }
    await workspace.getByRole('tab', { name: 'Atlas devices', exact: true }).click();
    const devices = workspace.getByRole('list', { name: 'Atlas devices', exact: true });
    await expect(devices.getByRole('listitem')).toHaveCount(25);
    const size = await devices.evaluate(el => ({ box: el.clientHeight, all: el.scrollHeight }));
    expect(size.box).toBeLessThanOrEqual(480); expect(size.all).toBeGreaterThan(size.box);
    await devices.focus(); await page.keyboard.press('End');
    await expect.poll(() => devices.evaluate(el => el.scrollTop + el.clientHeight >= el.scrollHeight - 2)).toBe(true);
    await workspace.getByRole('button', { name: 'Show more loaded devices', exact: true }).click();
    await expect(devices.getByRole('listitem')).toHaveCount(42);
    // On a phone the client cards stack under the workspace (about 4 000 px at 320 px); the 42 devices stacked
    // instead of scrolled in their box would add some 6 000 px on their own.
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThan(4500);
    await devices.focus(); await page.keyboard.press('End');
    await expect.poll(() => devices.evaluate(el => el.scrollTop + el.clientHeight >= el.scrollHeight - 2)).toBe(true);
    await workspace.getByRole('searchbox', { name: 'Search loaded devices', exact: true }).fill('device-41');
    await expect(workspace.getByRole('list', { name: 'Atlas devices', exact: true }).getByRole('listitem')).toHaveCount(1);
    await accessible(page);
    expect(await page.evaluate(() => document.documentElement.scrollHeight), 'The overview must not become a many-screen observation column').toBeLessThan(4500);
  }
  await page.setViewportSize({ width: 768, height: 900 }); await page.goto('/organizations');
  const table = page.getByRole('region', { name: 'Scrollable organizations table', exact: true });
  await expect(table).not.toHaveCSS('mask-image', 'none'); await table.focus(); await page.keyboard.press('ArrowRight');
  await expect.poll(() => table.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => table.evaluate(el => el.scrollLeft)).toBe(0);
});
