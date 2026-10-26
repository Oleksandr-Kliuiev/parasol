import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { employee, fixture, json, staffContext } from './support';

async function accessible(page: Page) {
  await page.waitForLoadState('networkidle');
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => undefined)));
  });
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .exclude('[data-tabster-dummy]');
  // Check each active UI state. A modal's backdrop dims the inaccessible page; that page is checked before/after it.
  if (await page.getByRole('dialog').count()) {
    await expect(page.getByRole('dialog')).toHaveCount(1);
    builder = builder.include('[role="dialog"][aria-modal="true"]');
  }
  const scan = await builder.analyze();
  for (const issue of scan.violations.filter(item => item.impact === 'serious' || item.impact === 'critical')) {
    const context = await page.locator(String(issue.nodes[0]!.target[0])).evaluateAll(elements => ({
      active: { tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label'),
        inDialog: Boolean(document.activeElement?.closest('[role="dialog"]')) },
      nodes: elements.map(element => {
      const chain = []; let ancestor: Element | null = element;
      while (ancestor) { const style = getComputedStyle(ancestor); chain.push({ tag: ancestor.tagName,
        hidden: ancestor.getAttribute('aria-hidden'), inert: ancestor.hasAttribute('inert'), className: ancestor.className,
        color: style.color, background: style.backgroundColor, opacity: style.opacity }); ancestor = ancestor.parentElement; }
      return chain;
    }) }));
    await test.info().attach('accessibility-node-context', { body: JSON.stringify(context), contentType: 'application/json' });
  }
  expect(scan.violations.filter(item => item.impact === 'serious' || item.impact === 'critical')
    .map(item => ({ id: item.id, nodes: item.nodes.map(node => ({ target: node.target, html: node.html, summary: node.failureSummary })) }))).toEqual([]);
}

test('an Atlas observation Task links to a saved ticket and records the current employee’s explicit hours', async ({ browser }, testInfo) => {
  const f = fixture(); const saved = f.ticketWork;
  const session = await staffContext(browser, 'Crm.Admin'); const page = session.page;
  try {
    const sourceTasks = await json(await page.request.get(`/api/v1/activities/?organizationId=${saved.customerId}&type=Task&limit=200`),
      'The genuine Task handed off from an Atlas observation') as { items: { id: string; hasTechnicalSource: boolean; status: string; subject: string; dueAt: string }[] };
    expect(sourceTasks.items).toHaveLength(1);
    const task = sourceTasks.items[0]!;
    expect(task.hasTechnicalSource).toBe(true); expect(task.status).toBe('Done'); expect(task.subject).toBe('Review technical observation');
    const associationUrl = `/api/v1/activities/${task.id}/ticket?organizationId=${saved.customerId}`;
    const initial = await json(await page.request.get(associationUrl), 'Initially unlinked Task') as { ticketId: string | null; etag: string };
    expect(initial.ticketId).toBeNull();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/organizations/${saved.customerId}?tab=activities&activityId=${task.id}`);
    await accessible(page);
    const trigger = page.getByRole('button', { name: 'Service ticket for Review technical observation', exact: true });
    await trigger.focus(); await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Task service ticket', exact: true });
    const choose = dialog.getByRole('button', { name: 'Choose saved ticket', exact: true });
    await choose.focus(); await page.keyboard.press('Enter');
    const radio = dialog.getByRole('radio', { name: `#${saved.externalId} · ${saved.title}`, exact: true });
    await radio.focus(); await page.keyboard.press('Space'); await expect(radio).toBeChecked();
    await accessible(page);
    const linking = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/activities/${task.id}/ticket`
      && response.request().method() === 'PUT');
    await dialog.getByRole('button', { name: 'Link selected ticket', exact: true }).click();
    const linkedResponse = await linking;
    expect(linkedResponse.status()).toBe(200);
    expect(linkedResponse.request().headers()['if-match']).toBe(initial.etag);
    const linked = await linkedResponse.json() as { ticketId: string; available: boolean; etag: string; ticket: { id: string; title: string } };
    expect(linked.ticketId).toBe(saved.ticketId); expect(linked.available).toBe(true);
    expect(linked.ticket.id).toBe(saved.ticketId); expect(linked.ticket.title).toBe(saved.title);
    const register = dialog.getByRole('button', { name: 'Register hours', exact: true });
    await expect(register).toBeEnabled(); await register.focus(); await page.keyboard.press('Enter');
    const timeDialog = page.getByRole('dialog', { name: 'Register hours', exact: true });
    const hours = timeDialog.getByRole('textbox', { name: 'Hours', exact: true });
    await expect(hours).toHaveValue('');
    await expect(timeDialog.getByRole('textbox', { name: 'Description', exact: true })).toHaveValue('');
    await expect(timeDialog.getByRole('button', { name: 'Register hours', exact: true })).toBeDisabled();
    await hours.fill('0.75');
    await timeDialog.getByRole('textbox', { name: 'Description', exact: true }).fill('Synthetic reviewed work');
    await accessible(page);
    await page.screenshot({ path: testInfo.outputPath('task-ticket-time-mobile-light-synthetic.png'), fullPage: true });
    const cancel = timeDialog.getByRole('button', { name: 'Cancel', exact: true });
    const light = { surface: await timeDialog.evaluate(el => getComputedStyle(el).backgroundColor), text: await cancel.evaluate(el => getComputedStyle(el).color) };
    await page.emulateMedia({ colorScheme: 'dark' });
    // Media changes notify React asynchronously. Assert the rendered theme before scanning its contrast: the app's own switch
    // (data-theme), finished colour transitions, then dark colours that differ from the light ones. The palette is the visual
    // system's (app/theme.ts), so the check does not name Fluent's default colours.
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
    await page.evaluate(async () => {
      await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => undefined)));
    });
    await expect(timeDialog).not.toHaveCSS('background-color', light.surface);
    await expect(cancel).not.toHaveCSS('color', light.text);
    await expect(timeDialog.getByRole('textbox', { name: 'Description', exact: true })).toBeFocused();
    await accessible(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('task-ticket-time-mobile-dark-synthetic.png'), fullPage: true });
    const posting = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/time/entries'
      && response.request().method() === 'POST');
    await timeDialog.getByRole('button', { name: 'Register hours', exact: true }).click();
    const createdResponse = await posting; expect(createdResponse.status()).toBe(201);
    const submitted = createdResponse.request().postDataJSON() as Record<string, unknown>;
    expect(submitted.clientRequestId).toMatch(/^[a-f0-9-]{36}$/i);
    const entry = await createdResponse.json() as { id: string; technicianId: string; ticketId: string; sourceActivityId: string;
      organizationId: string; externalTicketId: number; ticketTitle: string; hours: number; description: string; source: string; workDate: string };
    expect(entry).toMatchObject({ technicianId: employee('Crm.Admin').id, ticketId: saved.ticketId, sourceActivityId: task.id,
      organizationId: saved.customerId, externalTicketId: saved.externalId, ticketTitle: saved.title,
      hours: 0.75, description: 'Synthetic reviewed work', source: 'Crm' });
    expect(entry.workDate).not.toBe('2030-11-01');
    const replay = await json(await page.request.post('/api/v1/time/entries', { headers: { 'X-CSRF': '1' }, data: submitted }),
      'An explicit repeat adopts the already accepted time entry', 201) as { id: string };
    expect(replay.id).toBe(entry.id);
    const times = await json(await page.request.get(`/api/v1/time/entries?organizationId=${saved.customerId}&mine=true`),
      'Persisted manual hours') as { items: { id: string; sourceActivityId: string }[] };
    expect(times.items.filter(item => item.sourceActivityId === task.id).map(item => item.id)).toEqual([entry.id]);
    const unchanged = await json(await page.request.get(`/api/v1/activities/?organizationId=${saved.customerId}&activityId=${task.id}`),
      'Task remains separately assigned and open') as { items: { assignee: { id: string }; status: string; body: string | null; dueAt: string }[] };
    expect(unchanged.items).toHaveLength(1); expect(unchanged.items[0]!.assignee.id).toBe(employee('Crm.Technician').id);
    expect(unchanged.items[0]!.status).toBe('Done'); expect(unchanged.items[0]!.body).toBeNull();
    expect(Date.parse(unchanged.items[0]!.dueAt)).toBe(Date.parse(task.dueAt));
    await expect(page.getByRole('dialog', { name: 'Task service ticket', exact: true })).toBeVisible();
    const refreshed = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/api/v1/activities/' && url.searchParams.get('activityId') === task.id && response.request().method() === 'GET';
    });
    await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
    const refreshedResponse = await refreshed;
    expect(refreshedResponse.status(), 'Closing a saved link rereads the complete selected Activity').toBe(200);
    const freshTask = await refreshedResponse.json() as { items: { id: string; etag: string }[] };
    expect(freshTask.items).toHaveLength(1); expect(freshTask.items[0]!.id).toBe(task.id); expect(freshTask.items[0]!.etag).toBe(linked.etag);
    await expect(page.getByRole('button', { name: 'Refresh activity', exact: true })).toBeFocused(); await accessible(page);
  } finally { await session.context.close(); }
});
