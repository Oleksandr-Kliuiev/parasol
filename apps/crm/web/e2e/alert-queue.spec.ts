import { expect, test } from '@playwright/test';
import { ateraAlert, closeAteraAlert, fitsWidth, linkedAteraCustomer, settled, storedAlerts, syncAlerts, syncAtera } from './atera';
import { signIn } from './support';

// M38: Work → Alerts lists the open alerts of every customer, critical first and the longest waiting first, with filters, honest
// totals and each alert's side panel. The e2e database is shared, so the list is narrowed by this test's marker first.
test('the alert queue orders, filters and resolves alerts across customers', { tag: '@critical' }, async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  await signIn(page, 'Crm.Admin');
  const first = await linkedAteraCustomer(page, 'Qa');
  const second = await linkedAteraCustomer(page, 'Qb');
  const m = first.marker;
  await ateraAlert(page, first, { Title: `${m} backup is late`, Severity: 'Warning', hoursAgo: 48 });
  await ateraAlert(page, first, { Title: `${m} disk almost full`, Severity: 'Critical', hoursAgo: 10 });
  const closing = await ateraAlert(page, second, { Title: `${m} firewall down`, Severity: 'Critical', hoursAgo: 2 });
  await syncAlerts(page, first, 2); await syncAlerts(page, second, 1);

  // An old address of the queue lands here; the menu names the page.
  await page.goto('/observations');
  await expect(page).toHaveURL(/\/alerts$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Alerts' })).toBeVisible();
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Alerts', exact: true }).first()).toHaveAttribute('aria-current', 'page');

  const search = page.getByRole('searchbox', { name: 'Search title or device' });
  await search.fill(m);
  const table = page.getByRole('table', { name: 'Alerts' });
  const rows = table.getByRole('row').filter({ hasText: m });
  // Critical first, the longest waiting first within a severity, across customers.
  await expect(rows).toHaveText([new RegExp(`Critical.*${m} disk almost full.*${first.name}`), new RegExp(`Critical.*${m} firewall down.*${second.name}`),
    new RegExp(`Warning.*${m} backup is late.*${first.name}`)]);
  await expect(rows.first()).toContainText('Source: Atera');
  await expect(page.getByRole('status').filter({ hasText: /alerts:/ })).toHaveText('3 alerts: 2 critical, 1 warnings');
  await expect(rows.first().getByRole('button', { name: `Assign ${m} disk almost full`, exact: true })).toBeVisible();

  await page.getByRole('group', { name: 'Severity' }).getByRole('button', { name: /^Warning/ }).click();
  await expect(page).toHaveURL(/severity=warning/);
  await expect(rows).toHaveText([new RegExp(`${m} backup is late`)]);
  await page.getByRole('group', { name: 'Severity' }).getByRole('button', { name: 'All severities' }).click();
  await page.getByRole('combobox', { name: 'Customer' }).fill(second.name);
  await page.getByRole('option', { name: second.name }).click();
  await expect(page).toHaveURL(new RegExp(`customer=${second.organizationId}`));
  await expect(rows).toHaveText([new RegExp(`${m} firewall down`)]);

  // Closed in Atera: the next complete read resolves it; it leaves the open list and is found among the resolved.
  await closeAteraAlert(page, closing);
  await syncAtera(page, ['atera-alerts'], async () => (await storedAlerts(page, second.organizationId, 'Resolved')).length === 1, 'the resolved alert');
  await page.reload(); await search.fill(m);
  await expect(page.getByText('No alerts match these filters.')).toBeVisible();
  await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Resolved', exact: true }).click();
  await expect(rows).toHaveText([new RegExp(`${m} firewall down`)]);
  await expect(table.getByRole('columnheader', { name: 'Resolved' })).toBeVisible();

  // A link names one alert: its side panel opens over the queue and Back closes it.
  const [stored] = await storedAlerts(page, first.organizationId);
  await page.goto(`/alerts?alert=${stored!.id}`);
  const panel = page.getByRole('dialog', { name: stored!.title, exact: true });
  await expect(panel.getByText(first.name)).toBeVisible();
  await expect(panel.getByRole('link', { name: 'Open in Atera', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(panel).toHaveCount(0); await expect(page).not.toHaveURL(/alert=/);

  // A phone shows cards with the same facts and actions, and nothing scrolls sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  await search.fill(m);
  const cards = page.getByRole('list', { name: 'Alerts' }).getByRole('listitem').filter({ hasText: m });
  await expect(cards).toHaveCount(2);
  await expect(cards.first().getByRole('button', { name: `Assign ${m} disk almost full`, exact: true })).toBeVisible();
  await settled(page);
  expect(await fitsWidth(page)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('alert-queue-390.png'), fullPage: true });
});
