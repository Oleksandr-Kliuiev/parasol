import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { ateraAlert, linkedAteraCustomer, syncAlerts } from './atera';
import { api, createOrganization, marker, showInMyTasks, signIn } from './support';

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
  const reads = { tasks: 0 };
  page.on('request', request => {
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/api/v1/activities/' && url.searchParams.get('mine') === 'true') reads.tasks++;
  });
  try {
    for (const width of [1440, 768, 390, 320]) for (const colorScheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme }); await page.goto('/');
      const navigation = page.getByRole('navigation', { name: 'My day sections', exact: true });
      const tasksLink = navigation.getByRole('link', { name: 'My tasks', exact: true });
      const tasks = page.locator('#my-day-tasks'); const taskHeading = tasks.getByRole('heading', { name: 'My tasks', exact: true });
      await expect(tasks.getByText(subject, { exact: true })).toBeVisible();
      await expect(tasksLink).toBeInViewport({ ratio: 1 });
      // Two columns (from 1101 px) put the personal task list beside the overview, on the first screen (UX 2026 §4.1).
      if (width > 1100) expect((await taskHeading.boundingBox())!.y, 'Assigned work is on the first screen beside the overview').toBeLessThan(900);
      const before = { ...reads };
      await page.keyboard.press('Tab'); await expect(page.getByRole('link', { name: 'Skip to content', exact: true })).toBeFocused();
      // The day's own action and its key figures come first; the section links follow them (urgent alerts, then tasks).
      await page.keyboard.press('Enter');
      for (let stop = 0; stop < 9 && !(await tasksLink.evaluate(el => el === document.activeElement)); stop++) await page.keyboard.press('Tab');
      await expect(tasksLink).toBeFocused();
      await page.keyboard.press('Enter'); await expect(tasks).toBeFocused(); await expect(taskHeading).toBeInViewport({ ratio: 1 });
      expect(await taskHeading.evaluate(el => el.getBoundingClientRect().top)).toBeGreaterThanOrEqual(53);
      await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => undefined))); });
      const a11y = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).exclude('[data-tabster-dummy]').analyze();
      expect(a11y.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`tasks-${width}-${colorScheme}.png`) });
      await page.goBack(); await expect(navigation).toBeFocused();
      // Back returns to the section links, which start with urgent alerts; the tasks link is the next stop.
      await page.keyboard.press('Tab'); await expect(navigation.getByRole('link', { name: 'Urgent alerts', exact: true })).toBeFocused();
      await page.keyboard.press('Tab'); await expect(tasksLink).toBeFocused(); await page.waitForLoadState('networkidle');
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

test('urgent alerts are reached from their key figure and their jump link, and come back by keyboard', async ({ page }) => {
  await signIn(page, 'Crm.Admin', '/organizations');
  let reads = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/v1/service/alerts/urgent') reads++; });
  await page.goto('/');
  const alerts = page.locator('#my-day-alerts');
  const heading = alerts.getByRole('heading', { name: 'Urgent alerts', exact: true });
  await expect(heading).toBeVisible();
  // The figure and the panel share one read.
  await expect(page.getByRole('link', { name: /^Critical alerts/ }).getByText(/warnings?|Not read yet|Could not be read/)).toBeVisible();
  await page.waitForLoadState('networkidle'); expect(reads).toBe(1);
  const navigation = page.getByRole('navigation', { name: 'My day sections', exact: true });
  await navigation.getByRole('link', { name: 'Urgent alerts', exact: true }).click();
  await expect(alerts).toBeFocused(); await expect(heading).toBeInViewport({ ratio: 1 });
  await expect(page).toHaveURL(/\?section=alerts#my-day-alerts$/);
  await page.goBack(); await expect(navigation).toBeFocused();
  await page.getByRole('link', { name: /^Critical alerts/ }).click();
  await expect(alerts).toBeFocused();
});

// M40 (M38's deferred hand-over): an urgent alert is assigned from My day itself, in the dialog the queue uses, and its row then
// says who has the task. The alert is a year old, so it is among the oldest critical ones the panel shows first.
test('an urgent alert is handed over from My day without going to the queue', { tag: '@critical' }, async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page, 'Crm.Admin');
  const customer = await linkedAteraCustomer(page, 'Day');
  const m = customer.marker;
  await ateraAlert(page, customer, { Title: `${m} firewall down`, Severity: 'Critical', hoursAgo: 24 * 365 });
  await syncAlerts(page, customer, 1);
  const me = await api.get<{ displayName: string }>(page, '/bff/user');

  await page.goto('/');
  const row = page.locator('#my-day-alerts').getByRole('listitem').filter({ hasText: `${m} firewall down` });
  const assign = row.getByRole('button', { name: `Assign ${m} firewall down`, exact: true });
  await assign.focus(); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Assign alert', exact: true });
  await expect(dialog.getByRole('textbox', { name: 'Task subject' })).toHaveValue(`${m} firewall down`);
  await expect(dialog.getByRole('combobox', { name: 'Assignee' })).toHaveValue(me.displayName);
  await dialog.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(dialog.getByText('Task created.', { exact: true })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
  // The row names the task in place of Assign, and focus moved to it.
  const taskLink = row.getByRole('link', { name: new RegExp(`^${me.displayName}.*: task ${m} firewall down`) });
  await expect(taskLink).toBeVisible(); await expect(taskLink).toBeFocused();

  // The shared sign-in users collect open tasks from every run: this one is done before the test ends.
  const mine = page.getByRole('region', { name: 'My tasks', exact: true }).getByRole('listitem').filter({ hasText: `${m} firewall down` });
  await (await showInMyTasks(page, mine.getByRole('button', { name: `Mark ${m} firewall down as done`, exact: true }))).click();
  await expect(mine).toHaveCount(0);
});

test('My day keeps the layout each person chooses and the arrow keys change it', async ({ page }) => {
  // A role of its own: the choice is stored with the person, and the shared administrator's My day must not change under
  // the other specs.
  await signIn(page, 'Crm.ServiceLead', '/');
  const layouts = page.getByRole('radiogroup', { name: 'Show first', exact: true });
  const billing = layouts.getByRole('radio', { name: 'Billing', exact: true });
  try {
    await expect(layouts.getByRole('radio', { name: 'Alerts and tasks', exact: true })).toBeChecked();
    await billing.check();
    await expect(page.getByText('Billing, overdue invoices and what needs attention.', { exact: true })).toBeVisible();
    await expect.poll(async () => (await api.get<{ myDayLayout: string | null }>(page, '/bff/user')).myDayLayout).toBe('finance');
    await page.reload();
    await expect(billing).toBeChecked();
    await billing.focus(); await page.keyboard.press('ArrowLeft');
    await expect(layouts.getByRole('radio', { name: 'Hours to approve', exact: true })).toBeChecked();
    await expect(page.getByRole('heading', { name: 'Hours to review', exact: true })).toBeVisible();
    // What the choice says comes first: the hours to approve lead the panels (the main column is read first).
    await expect(page.getByRole('main').getByRole('heading', { level: 2 }).first()).toHaveText('Hours to review');
    await expect.poll(async () => (await api.get<{ myDayLayout: string | null }>(page, '/bff/user')).myDayLayout).toBe('lead');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    await api.put(page, '/api/v1/identity/me/my-day-layout', { layout: 'work' });
  }
});
