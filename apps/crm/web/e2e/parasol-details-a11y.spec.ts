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

test('technical detail tabs, filters and long source text remain accessible on a phone', async ({ page }, testInfo) => {
  await signIn(page, 'Crm.Admin', '/organizations');
  const customer = await createOrganization(page, { name: marker('Accessible technical ') });
  const ready = atlasWorkspace(customer.id); const s = ready.summary!;
  s.devices[0]!.hostname = 'SYNTHETIC-'.repeat(25);
  s.observationPage.items[0]!.summary = 'SyntheticLongSummary'.repeat(15);
  s.activeObservations = 4; s.severityCounts.CRITICAL = 2; s.observationPage.truncated = true;
  let empty = false;
  let heldRead: Promise<void> | undefined; let onHeldRead: (() => void) | undefined; let reads = 0;
  await page.route(`**/api/v1/parasol/customers/${customer.id}/workspace`, async route => {
    ++reads;
    if (heldRead) { onHeldRead?.(); await heldRead; }
    const reply = structuredClone(ready);
    if (empty) {
      reply.summary!.devices = []; reply.summary!.knownDevices = 0; reply.summary!.activeObservations = 0;
      reply.summary!.severityCounts = { INFO: 0, LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
      reply.summary!.observationPage = { items: [], truncated: false };
    }
    return route.fulfill({ json: reply });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/organizations/${customer.id}`);
  const panel = page.getByRole('region', { name: 'Technical workspace · Atlas' });
  await expect(panel.getByText(s.observationPage.items[0]!.summary, { exact: true })).toBeVisible();
  await accessible(page);
  await page.screenshot({ path: testInfo.outputPath('atlas-observations-mobile.png'), fullPage: true });
  await panel.getByRole('tab', { name: 'Active Atlas observations', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(panel.getByRole('tab', { name: 'Atlas devices', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  const devices = panel.getByRole('region', { name: 'Atlas devices' });
  await expect(devices.getByText(s.devices[0]!.hostname, { exact: true })).toBeVisible();
  await devices.getByRole('searchbox').fill('lt-02');
  await expect(devices.getByRole('listitem')).toHaveCount(1);
  await accessible(page);
  await page.screenshot({ path: testInfo.outputPath('atlas-devices-mobile.png'), fullPage: true });
  empty = true;
  const refresh = panel.getByRole('button', { name: 'Refresh', exact: true });
  let release!: () => void; heldRead = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { onHeldRead = resolve; }); const before = reads;
  try {
    await refresh.focus(); await page.keyboard.press('Enter'); await started;
    await expect(refresh).toHaveAttribute('aria-disabled', 'true'); await expect(refresh).toBeFocused();
    await expect(devices).toHaveCount(0);
    await page.keyboard.press('Enter'); await page.keyboard.press('Space');
    expect(reads, 'Busy keyboard activation must not start another workspace read').toBe(before + 1);
  } finally { heldRead = undefined; onHeldRead = undefined; release(); }
  await expect(panel.getByText(/No active observations are recorded in Atlas/)).toBeVisible();
  await expect(refresh).not.toHaveAttribute('aria-disabled', 'true'); await expect(refresh).toBeFocused();
  await accessible(page);
  await panel.getByRole('tab', { name: 'Atlas devices', exact: true }).click();
  await expect(panel.getByText(/No devices are recorded in this Atlas registry/)).toBeVisible();
  await accessible(page);
});
