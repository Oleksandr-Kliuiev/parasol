import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { atlasWorkspace } from '../src/test/atlasWorkspace';
import { createOrganization, marker, signIn } from './support';
import { syntheticActivity } from '../src/test/activities';
import { computedTextContrast } from './computedTextContrast';

test('observation work dialog supports keyboard focus and a narrow viewport', async ({ page }) => {
  await signIn(page, 'Crm.Admin', '/organizations');
  const customer = await createOrganization(page, { name: marker('Accessible observation work ') });
  const overview = atlasWorkspace(customer.id); const summary = overview.summary!; const observation = summary.observationPage.items[0]!;
  await page.route(`**/api/v1/parasol/customers/${customer.id}/workspace`, route => route.fulfill({ json: overview }));
  await page.route(`**/api/v1/parasol/customers/${customer.id}/observations/${observation.id}/task-preview`, route => route.fulfill({ json: {
    customerId: customer.id, status: 'READY', mode: 'fixture', observation, devices: summary.devices,
    sha256: 'a'.repeat(64), task: null, canCreate: true,
  } }));
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`/organizations/${customer.id}`);
  const button = page.getByRole('listitem').filter({ hasText: observation.summary }).getByRole('button', { name: 'Assign work', exact: true });
  await button.focus(); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Assign observation work' });
  await expect(dialog.getByText(observation.summary, { exact: true })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => undefined))); });
  const result = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .exclude('[data-tabster-dummy]').analyze();
  expect(result.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(button).toBeFocused();
  const closedTasks = [syntheticActivity('done-task', { organizationId: customer.id, status: 'Done', completedAt: '2026-10-16T10:00:00Z', hasTechnicalSource: false }),
    syntheticActivity('cancelled-task', { organizationId: customer.id, status: 'Cancelled', hasTechnicalSource: false })];
  await page.route(/\/api\/v1\/activities\/\?/, route => route.fulfill({ json: { items: closedTasks, nextCursor: null, totalCount: 2 } }));
  await page.goto(`/organizations/${customer.id}?tab=activities`);
  const timeline = page.getByRole('region', { name: 'Activities', exact: true });
  await expect(timeline.getByRole('listitem')).toHaveCount(2);
  await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => undefined))); });
  for (const task of closedTasks) {
    const badge = timeline.getByRole('listitem').filter({ hasText: task.subject }).locator('.fui-Badge');
    await expect(badge).toHaveText('Task'); expect(await badge.ariaSnapshot()).toContain('Task');
    const contrast = await computedTextContrast(badge);
    expect(contrast.ratio, `${task.status} task type: ${JSON.stringify(contrast)}`).toBeGreaterThanOrEqual(4.5);
  }
});
