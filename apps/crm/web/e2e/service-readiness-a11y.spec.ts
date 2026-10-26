import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { createOrganization, marker, signIn } from './support';

async function settleMotion(page: import('@playwright/test').Page) {
  await page.waitForLoadState('networkidle');
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => undefined)));
  });
}
async function accessible(page: import('@playwright/test').Page) {
  await settleMotion(page);
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .exclude('[data-tabster-dummy]').analyze();
  expect(result.violations.filter(violation => violation.impact === 'serious' || violation.impact === 'critical')
    .map(violation => ({ id: violation.id, nodes: violation.nodes.map(node => node.target) }))).toEqual([]);
}

test('saved Service data and the existing ticket form work on a phone with a keyboard', async ({ page }, testInfo) => {
  await signIn(page, 'Crm.Sales'); const customer = await createOrganization(page, { name: marker('Accessible service ') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/organizations/${customer.id}?tab=service`);
  await expect(page.getByRole('tab', { name: 'Service', exact: true })).toBeInViewport({ ratio: 1 });
  const service = page.getByRole('region', { name: 'Saved service data', exact: true });
  await expect(service.getByText('Saved CRM data from Atera. Refresh rereads this copy; it does not check Atera live.', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Tickets', exact: true }).getByText('No open tickets.', { exact: true })).toBeVisible();
  const refresh = service.getByRole('button', { name: 'Refresh saved data', exact: true });
  await refresh.focus(); await page.keyboard.press('Enter');
  await expect(refresh).toBeEnabled(); await expect(refresh).toBeFocused();
  const ticketScroll = page.getByRole('group', { name: 'Tickets', exact: true });
  await ticketScroll.focus(); await expect(ticketScroll).toBeFocused();
  expect(await ticketScroll.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  const initialLeft = await ticketScroll.evaluate(element => element.scrollLeft);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => ticketScroll.evaluate(element => element.scrollLeft)).toBeGreaterThan(initialLeft);
  await expect(ticketScroll).toBeFocused();
  await accessible(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('saved-service-mobile-synthetic.png'), fullPage: true });
  const create = page.getByRole('button', { name: 'New ticket', exact: true });
  await create.focus(); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'New ticket', exact: true });
  await expect(dialog.getByRole('textbox', { name: 'Title', exact: true })).toBeVisible();
  await accessible(page);
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(create).toBeFocused();
});
