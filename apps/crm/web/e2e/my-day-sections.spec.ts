import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { atlasAttention } from '../src/test/atlasAttention';
import { api, createOrganization, marker, signIn } from './support';

test('My day shortcuts reach assigned work and return by keyboard without rereading panels', { tag: '@critical' }, async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await signIn(page, 'Crm.Admin', '/organizations');
  const customer = await createOrganization(page, { name: marker('Day sections ') });
  const employee = await api.get<{ id: string }>(page, '/bff/user');
  const subject = marker('Synthetic direct day task ');
  // Without a due date: the shared employee collects open tasks from other specs, tasks without a due date come first and
  // the newest of them leads, so this task stays on the first page of ten. It is closed at the end, adding none to the pile.
  const task = await api.post<{ id: string; etag: string }>(page, '/api/v1/activities/', { type: 'Task', organizationId: customer.id, subject,
    body: null, priority: 'Normal', assigneeId: employee.id, dueAt: null, addToCalendar: false });
  const attention = atlasAttention(customer.id); attention.customers![0]!.customerName = customer.name;
  const reads = { tasks: 0, attention: 0 };
  page.on('request', request => {
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/api/v1/activities/' && url.searchParams.get('mine') === 'true') reads.tasks++;
  });
  await page.route('**/api/v1/parasol/my-day/atlas-attention', route => {
    reads.attention++; return route.fulfill({ json: attention });
  });
  try {
    for (const width of [1440, 768, 390, 320]) for (const colorScheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme }); await page.goto('/');
      const navigation = page.getByRole('navigation', { name: 'My day sections', exact: true });
      const tasksLink = navigation.getByRole('link', { name: 'My tasks', exact: true });
      const attentionLink = navigation.getByRole('link', { name: 'Technical attention · Atlas', exact: true });
      const tasks = page.locator('#my-day-tasks'); const taskHeading = tasks.getByRole('heading', { name: 'My tasks', exact: true });
      await expect(tasks.getByText(subject, { exact: true })).toBeVisible();
      await expect(page.getByText('Customers read successfully: 1 of 2 selected', { exact: true })).toBeVisible();
      await expect(tasksLink).toBeInViewport({ ratio: 1 }); await expect(attentionLink).toBeInViewport({ ratio: 1 });
      // Two columns (from 1101 px) put the personal task list beside the overview, on the first screen (UX 2026 §4.1);
      // in one column the fixture must still put assigned work below the long overview, so the jump is exercised.
      if (width > 1100) expect((await taskHeading.boundingBox())!.y, 'Assigned work is on the first screen beside the overview').toBeLessThan(900);
      else expect((await taskHeading.boundingBox())!.y, 'The fixture must actually put assigned work below the long overview').toBeGreaterThan(900);
      const before = { ...reads };
      await page.keyboard.press('Tab'); await expect(page.getByRole('link', { name: 'Skip to content', exact: true })).toBeFocused();
      // The day's own action and its key figures come first; the section links follow them.
      await page.keyboard.press('Enter');
      for (let stop = 0; stop < 6 && !(await tasksLink.evaluate(el => el === document.activeElement)); stop++) await page.keyboard.press('Tab');
      await expect(tasksLink).toBeFocused();
      await page.keyboard.press('Enter'); await expect(tasks).toBeFocused(); await expect(taskHeading).toBeInViewport({ ratio: 1 });
      expect(await taskHeading.evaluate(el => el.getBoundingClientRect().top)).toBeGreaterThanOrEqual(53);
      await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => undefined))); });
      const a11y = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).exclude('[data-tabster-dummy]').analyze();
      expect(a11y.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`tasks-${width}-${colorScheme}.png`) });
      await page.goBack(); await expect(navigation).toBeFocused();
      await page.keyboard.press('Tab'); await expect(tasksLink).toBeFocused();
      await page.keyboard.press('Tab'); await expect(attentionLink).toBeFocused();
      await page.keyboard.press('Enter'); await expect(page.locator('#my-day-attention')).toBeFocused();
      await expect(page.getByRole('heading', { name: 'Technical attention · Atlas', exact: true })).toBeInViewport({ ratio: 1 });
      await page.goBack(); await expect(navigation).toBeFocused(); await page.waitForLoadState('networkidle');
      expect(reads, 'Section navigation must not create extra data reads').toEqual(before);
      if (width === 1440 && colorScheme === 'light') await signIn(page, 'Crm.Admin', '/?section=tasks');
      else await page.goto('/?section=tasks');
      await expect(tasks).toBeFocused();
      await expect(tasks.getByText(subject, { exact: true })).toBeVisible(); await expect(taskHeading).toBeInViewport({ ratio: 1 });
    }
  } finally {
    await page.request.post(`/api/v1/activities/${task.id}/complete`, { headers: { 'X-CSRF': '1', 'If-Match': task.etag } });
  }
});
