import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { atlasWorkspace } from '../src/test/atlasWorkspace';
import { createOrganization, marker, signIn } from './support';

async function accessible(page: Page) {
  await page.waitForLoadState('networkidle');
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity)
      .map(a => a.finished.catch(() => undefined)));
  });
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .exclude('[data-tabster-dummy]').analyze();
  expect(result.violations.filter(v => v.impact === 'serious' || v.impact === 'critical')
    .map(v => ({ id: v.id, nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })) }))).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test('queue history filters and pagination remain accessible on a phone', async ({ page }, testInfo) => {
  await signIn(page, 'Crm.Admin', '/organizations');
  const customer = await createOrganization(page, { name: marker('Accessible queue ') });
  const overview = atlasWorkspace(customer.id); const s = overview.summary!;
  s.devices[0]!.hostname = 'SYNTHETIC-'.repeat(25);
  await page.route(`**/api/v1/parasol/customers/${customer.id}/workspace`, route => route.fulfill({ json: overview }));
  await page.route(`**/api/v1/parasol/customers/${customer.id}/observations?*`, route => {
    const url = new URL(route.request().url());
    const severity = url.searchParams.get('severity') ?? 'ALL'; const status = url.searchParams.get('status') ?? 'ACTIVE';
    const items = status === 'ACKNOWLEDGED' ? [] : [{ ...s.observationPage.items[0]!, summary: 'SyntheticLongQueueSummary'.repeat(12),
      status: status === 'RESOLVED' ? 'RESOLVED' : 'OPEN' }];
    return route.fulfill({ json: { customerId: customer.id, status: 'READY', queue: {
      mode: 'db', generatedAt: s.generatedAt, retrievedAt: '2026-10-16T16:00:00Z', severity, status,
      total: items.length, severityCounts: { INFO: 0, LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: items.length },
      items, devices: s.devices, resources: s.resources, nextCursor: null,
    } } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/organizations/${customer.id}`);
  const panel = page.getByRole('region', { name: 'Technical workspace · Atlas' });
  await panel.getByRole('tab', { name: 'Observation queue and history', exact: true }).focus();
  await page.keyboard.press('Enter');
  const queue = panel.getByRole('region', { name: 'Observation queue and history' });
  await expect(queue.getByRole('listitem')).toHaveCount(1);
  await accessible(page);
  await page.screenshot({ path: testInfo.outputPath('queue-mobile.png'), fullPage: true });
  await queue.getByLabel('Queue state').selectOption('RESOLVED');
  await expect(queue.getByRole('listitem')).toHaveCount(1);
  await accessible(page);
  await queue.getByLabel('Queue state').selectOption('ACKNOWLEDGED');
  await expect(queue.getByRole('listitem')).toHaveCount(0);
  await accessible(page);
});
