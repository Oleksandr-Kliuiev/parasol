import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Activity } from '../src/features/activities/types';
import { atlasWorkspace } from '../src/test/atlasWorkspace';
import { api, createOrganization, marker, signIn } from './support';

// The real ReadOnly CRM session must retain its write denial. Atlas data is a controlled BFF fixture here.
test('a reader can discover linked work from an active observation without assignment access', { tag: '@critical' }, async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await signIn(page, 'Crm.Admin', '/organizations');
  const customer = await createOrganization(page, { name: marker('Read-only work ') });
  const employee = await api.get<{ id: string }>(page, '/bff/user');
  const activity = await api.post<Activity>(page, '/api/v1/activities/', {
    type: 'Task', organizationId: customer.id, subject: marker('Saved review task '), body: null,
    priority: 'Normal', assigneeId: employee.id, dueAt: null, addToCalendar: false,
  });
  const overview = atlasWorkspace(customer.id), summary = overview.summary!, observation = summary.observationPage.items[0]!;
  const task = { activityId: activity.id, organizationId: customer.id, status: 'Open', assigneeId: employee.id,
    dueAt: null, created: false, isAvailable: true };
  let linked = false, reads = 0;
  await page.route(`**/api/v1/parasol/customers/${customer.id}/workspace`, route => route.fulfill({ json: overview }));
  const path = `/api/v1/parasol/customers/${customer.id}/observations/${observation.id}`;
  await page.route(`**${path}/task-preview`, route => {
    reads++;
    return route.fulfill({ json: { customerId: customer.id, status: 'READY', mode: 'db', observation,
      devices: summary.devices, sha256: 'a'.repeat(64), task: linked ? task : null, canCreate: false } });
  });
  await signIn(page, 'Crm.ReadOnly', `/organizations/${customer.id}`);
  const reader = await api.get<{ permissions: string[] }>(page, '/bff/user');
  expect(reader.permissions).toContain('activities.read'); expect(reader.permissions).toContain('parasol.atlas.read');
  expect(reader.permissions).not.toContain('activities.write'); expect(reads).toBe(0);
  const denied = await page.request.post(`${path}/task`, { headers: { 'X-CSRF': '1' }, data: {
    assigneeId: employee.id, dueAt: null, expectedSha256: 'a'.repeat(64),
  } });
  expect(denied.status(), 'The real server must still deny task creation by a reader').toBe(403);
  const writes: string[] = [];
  page.on('request', request => { if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/')) writes.push(request.method()); });
  for (const width of [1440, 768, 390, 320]) for (const colorScheme of ['light', 'dark'] as const) {
    await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme });
    for (linked of [false, true]) {
      const trigger = page.getByRole('listitem').filter({ hasText: observation.summary }).getByRole('button', { name: 'View work', exact: true });
      const before = reads; await trigger.focus(); await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'View observation work', exact: true });
      await expect(dialog.getByText(observation.summary, { exact: true })).toBeVisible();
      expect(reads).toBe(before + 1);
      await expect(dialog.getByRole('button', { name: 'Create task', exact: true })).toHaveCount(0);
      await expect(dialog.getByRole('combobox')).toHaveCount(0);
      await expect(dialog.getByRole('checkbox')).toHaveCount(0);
      if (linked) await expect(dialog.getByRole('link', { name: 'Open task', exact: true })).toHaveAttribute('href', `/organizations/${customer.id}?tab=activities&activityId=${activity.id}`);
      else await expect(dialog.getByText('No CRM task is linked to this observation.', { exact: true })).toBeVisible();
      await page.evaluate(async () => {
        await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => undefined)));
      });
      const a11y = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).exclude('[data-tabster-dummy]').analyze();
      expect(a11y.violations.filter(v => v.impact === 'serious' || v.impact === 'critical')
        .map(v => ({ id: v.id, nodes: v.nodes.map(n => ({ target: n.target, reason: n.failureSummary })) }))).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`reader-${linked ? 'linked' : 'empty'}-${width}-${colorScheme}.png`) });
      await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
    }
  }
  const trigger = page.getByRole('listitem').filter({ hasText: observation.summary }).getByRole('button', { name: 'View work', exact: true });
  await trigger.click();
  await page.getByRole('dialog', { name: 'View observation work' }).getByRole('link', { name: 'Open task', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Selected activity', exact: true })).toBeFocused();
  await expect(page.getByRole('region', { name: 'Activities', exact: true }).getByText(activity.subject, { exact: true })).toBeVisible();
  expect(writes).toEqual([]);
});
