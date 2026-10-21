import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { atlasM365 } from '../src/test/atlasM365';
import { atlasWorkspace } from '../src/test/atlasWorkspace';
import { createOrganization, marker, signIn } from './support';

async function customer(page: Page) {
  await signIn(page, 'Crm.Admin', '/organizations');
  const value = await createOrganization(page, { name: marker('Synthetic M365 ') });
  return value.id;
}

test('Microsoft 365 clears changed-link metadata and restores the stable parent focus', { tag: '@critical' }, async ({ page }) => {
  const id = await customer(page); let changed = false, reads = 0;
  await page.route(`**/api/v1/parasol/customers/${id}/workspace`, route => route.fulfill({ json:
    changed ? { customerId: id, status: 'IDENTITY_CHANGED', summary: null } : atlasWorkspace(id),
  }));
  await page.route(`**/api/v1/parasol/customers/${id}/m365`, route => { reads++; return route.fulfill({ json:
    changed ? { customerId: id, status: 'IDENTITY_CHANGED', summary: null } : atlasM365(id),
  }); });
  await signIn(page, 'Crm.Technician', `/organizations/${id}`);
  const panel = page.getByRole('region', { name: 'Technical workspace · Atlas' });
  await expect(panel.getByText('42', { exact: true })).toBeVisible(); expect(reads).toBe(0);
  await panel.getByRole('tab', { name: 'Microsoft 365', exact: true }).click();
  await expect(panel.getByText('14', { exact: true })).toBeVisible();
  changed = true;
  await panel.getByRole('button', { name: 'Refresh Microsoft 365', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(panel.getByText('The customer link changed. Refresh to load current data.', { exact: true })).toBeVisible();
  await expect(panel.getByText('14', { exact: true })).toHaveCount(0); await expect(panel.getByText('42', { exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Refresh', exact: true })).toBeFocused(); expect(reads).toBe(2);
  await page.keyboard.press('Enter'); expect(reads).toBe(2);
});

test('Microsoft 365 metadata and native disclosures remain accessible on a phone in both themes', { tag: '@critical' }, async ({ page }, testInfo) => {
  const id = await customer(page), data = atlasM365(id); data.summary!.connections[0]!.connectionId = `synthetic-${'x'.repeat(110)}`;
  let denied = false, contextReads = 0;
  await page.route(`**/api/v1/parasol/customers/${id}/workspace`, route => {
    contextReads++; const workspace = atlasWorkspace(id);
    if (denied) { workspace.summary!.devices.pop(); workspace.summary!.knownDevices = 41; }
    return route.fulfill({ json: workspace });
  });
  await page.route(`**/api/v1/parasol/customers/${id}/m365`, route => route.fulfill({ json:
    denied ? { customerId: id, status: 'ACCESS_DENIED', summary: null } : data,
  }));
  await signIn(page, 'Crm.Technician', `/organizations/${id}`); await page.setViewportSize({ width: 390, height: 844 });
  const panel = page.getByRole('region', { name: 'Technical workspace · Atlas' });
  await panel.getByRole('tab', { name: 'Microsoft 365', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(panel.getByText('Partial traversal', { exact: true })).toBeVisible();
  const gaps = panel.locator('summary').filter({ hasText: 'Intervals without coverage: 2' });
  await gaps.focus(); await page.keyboard.press('Enter'); await expect(gaps.locator('..')).toHaveAttribute('open', '');
  const reference = panel.locator('summary').filter({ hasText: 'Atlas connection reference' });
  await reference.focus(); await page.keyboard.press('Enter'); await expect(reference.locator('..')).toHaveAttribute('open', '');
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await expect.poll(() => panel.evaluate(el => getComputedStyle(el).getPropertyValue('--colorNeutralBackground1').trim()))
      .toBe(colorScheme === 'dark' ? '#1E1B19' : '#FFFDFA');
    await page.waitForLoadState('networkidle');
    await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity)
      .map(a => a.finished.catch(() => undefined))); });
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).exclude('[data-tabster-dummy]').analyze();
    expect(result.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => v.id)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`m365-${colorScheme}-phone.png`), fullPage: true });
  }
  denied = true; await panel.getByRole('button', { name: 'Refresh Microsoft 365', exact: true }).click();
  await expect(panel.getByText('Your Atlas access does not permit reading this customer’s Microsoft 365 data.', { exact: true })).toBeVisible();
  await expect(panel.getByText('14', { exact: true })).toHaveCount(0);
  await expect(panel.getByText('41', { exact: true })).toBeVisible(); expect(contextReads).toBe(2);
  await expect(panel.getByRole('tab', { name: 'Microsoft 365', exact: true })).toHaveAttribute('aria-selected', 'true');
  await panel.getByRole('tab', { name: 'Atlas devices', exact: true }).click();
  await expect(panel.getByRole('region', { name: 'Atlas devices' }).getByRole('searchbox')).toBeVisible();
  await expect(panel.getByText('Matching devices: 41 of 41 loaded', { exact: true })).toBeVisible();
});

test('Microsoft 365 denial clears all technical data when the whole Atlas context was revoked', { tag: '@critical' }, async ({ page }) => {
  const id = await customer(page); let revoked = false, contextReads = 0, m365Reads = 0;
  await page.route(`**/api/v1/parasol/customers/${id}/workspace`, route => {
    contextReads++; return route.fulfill({ json: revoked ? { customerId: id, status: 'ACCESS_DENIED', summary: null } : atlasWorkspace(id) });
  });
  await page.route(`**/api/v1/parasol/customers/${id}/m365`, route => {
    m365Reads++; return route.fulfill({ json: revoked ? { customerId: id, status: 'ACCESS_DENIED', summary: null } : atlasM365(id) });
  });
  await signIn(page, 'Crm.Technician', `/organizations/${id}`);
  const panel = page.getByRole('region', { name: 'Technical workspace · Atlas' });
  await panel.getByRole('tab', { name: 'Microsoft 365', exact: true }).click(); await expect(panel.getByText('14', { exact: true })).toBeVisible();
  revoked = true;
  await panel.getByRole('button', { name: 'Refresh Microsoft 365', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(panel.getByText('Your Atlas access does not permit reading this customer.', { exact: true })).toBeVisible();
  await expect(panel.getByRole('tab')).toHaveCount(0);
  await expect(panel.getByText('14', { exact: true })).toHaveCount(0); await expect(panel.getByText('42', { exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Refresh', exact: true })).toBeFocused(); expect(contextReads).toBe(2); expect(m365Reads).toBe(2);
});
