import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { atlasQueue } from '../src/test/atlasAttention';
import { createOrganization, marker, signIn } from './support';

// Controlled BFF projection checks (UX 2026, В1). The composition gate reads the real employee-scoped Atlas data.
test('the observation queue lists urgent work across customers, moves by keyboard and opens a fresh M12 preview', async ({ page }) => {
  await signIn(page, 'Crm.Admin', '/organizations');
  const customer = await createOrganization(page, { name: marker('Queue customer ') });
  const data = atlasQueue(customer.id); const group = data.customers![0]!; group.customerName = customer.name;
  let reads = 0; let previews = 0;
  await page.route('**/api/v1/parasol/observations/urgent', route => { reads++; return route.fulfill({ json: data }); });
  await page.route(`**/api/v1/parasol/customers/${customer.id}/observations/*/task-preview`, route => {
    previews++;
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/observations/')[1]!.split('/')[0]!);
    const observation = group.preview.find(o => o.id === id)!;
    return route.fulfill({ json: { customerId: customer.id, status: 'READY', mode: 'db', observation,
      devices: group.devices.filter(d => d.id === observation.deviceId), sha256: 'a'.repeat(64), task: null, canCreate: true } });
  });
  await page.goto('/');
  await page.getByRole('navigation').getByRole('link', { name: 'Observations', exact: true }).first().click();
  await expect(page).toHaveURL(/\/observations$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Urgent observations' })).toBeVisible();
  await expect(page.getByText('Customers read successfully: 1 of 2 selected', { exact: true })).toBeVisible();
  // The chip's name is its word and its count (Chromium joins the hidden comma with a space).
  await expect(page.getByRole('group', { name: 'Show' }).getByRole('button', { name: /^Without task\s*, 6$/ })).toHaveAttribute('aria-pressed', 'true');
  const rows = page.getByRole('list', { name: 'Urgent observations' }).getByRole('listitem');
  await expect(rows).toHaveCount(6); expect(reads).toBe(1); expect(previews).toBe(0);
  await expect(page.getByRole('link', { name: 'Synthetic unavailable customer', exact: true })).toBeVisible();

  // The keys work on a row; the letters can be turned off and the arrows still move.
  await rows.first().focus(); await page.keyboard.press('j'); await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press('ArrowDown'); await expect(rows.nth(2)).toBeFocused();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Assign observation work', exact: true });
  await expect(dialog.getByText('Synthetic high observation 0', { exact: true })).toBeVisible(); expect(previews).toBe(1);
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(rows.nth(2)).toBeFocused();
  await page.getByRole('switch', { name: 'Single-key shortcuts' }).click();
  await rows.nth(2).focus(); await page.keyboard.press('j'); await expect(rows.nth(2)).toBeFocused();

  await page.waitForLoadState('networkidle');
  await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => undefined))); });
  const result = await new AxeBuilder({ page }).include('main').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .exclude('[data-tabster-dummy]').analyze();
  expect(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(rows.first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
