import { expect, test, type Locator } from '@playwright/test';
import { ateraAlert, closeAteraAlert, fitsWidth, linkedAteraCustomer, settled, storedAlerts, syncAlerts, syncAtera } from './atera';
import { searchList, signIn } from './support';

// M38: Work → Alerts lists the open alerts of every customer, critical first and the newest first, with filters, honest totals and
// each alert's side panel. The e2e database is shared, so the list is narrowed by this test's marker first.
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

  // The list is narrowed to this test's alerts and read once that very search is answered: until then it shows the queue before it.
  const search = page.getByRole('searchbox', { name: 'Search title or device' });
  const narrow = () => searchList(page, search, '/api/v1/service/alerts', m, 'q');
  await narrow();
  const table = page.getByRole('table', { name: 'Alerts' });
  const rows = table.getByRole('row').filter({ hasText: m });
  // Critical first, the newest first within a severity, across customers.
  await expect(rows).toHaveText([new RegExp(`Critical.*${m} firewall down.*${second.name}`), new RegExp(`Critical.*${m} disk almost full.*${first.name}`),
    new RegExp(`Warning.*${m} backup is late.*${first.name}`)]);
  await expect(rows.first()).toContainText('Source: Atera');
  // A title that opens the alert looks like the link it is: the tone of the customer link beside it, not plain text until hovered.
  // Polled as one comparison: a row drawn again between two reads gives no style for the node it replaced.
  const disk = rows.filter({ hasText: `${m} disk almost full` });
  const tone = (element: Locator) => element.evaluate((el) => getComputedStyle(el).color);
  await expect.poll(async () => {
    const title = await tone(disk.getByRole('button', { name: `${m} disk almost full`, exact: true }));
    return title !== '' && title === await tone(disk.getByRole('link', { name: first.name, exact: true }));
  }, { message: 'The alert title has the tone of the customer link beside it' }).toBe(true);
  await expect(page.getByRole('status').filter({ hasText: /alerts:/ })).toHaveText('3 alerts: 2 critical, 1 warnings');
  // How fresh the stored alerts are, under the page title (a read another spec held with a pause says it did not finish).
  await expect(page.getByRole('main').getByText(/^Atera:? (the )?read at /)).toBeVisible();
  await expect(disk.getByRole('button', { name: `Assign ${m} disk almost full`, exact: true })).toBeVisible();

  await page.getByRole('group', { name: 'Severity' }).getByRole('button', { name: /^Warning/ }).click();
  await expect(page).toHaveURL(/severity=warning/);
  await expect(rows).toHaveText([new RegExp(`${m} backup is late`)]);
  await page.getByRole('group', { name: 'Severity' }).getByRole('button', { name: 'All severities' }).click();
  // What is new: the last 24 hours leave out the warning raised two days ago; any age brings it back.
  await page.getByRole('combobox', { name: 'Age' }).click();
  await page.getByRole('option', { name: 'Last 24 hours', exact: true }).click();
  await expect(page).toHaveURL(/newerThan=1/);
  await expect(rows).toHaveText([new RegExp(`${m} firewall down`), new RegExp(`${m} disk almost full`)]);
  await page.getByRole('combobox', { name: 'Age' }).click();
  await page.getByRole('option', { name: 'Any age', exact: true }).click();
  await expect(page).not.toHaveURL(/newerThan=/);
  await expect(rows).toHaveCount(3);
  await page.getByRole('combobox', { name: 'Customer' }).pressSequentially(second.name);
  await page.getByRole('option', { name: second.name }).click();
  await expect(page).toHaveURL(new RegExp(`customer=${second.organizationId}`));
  await expect(rows).toHaveText([new RegExp(`${m} firewall down`)]);

  // Closed in Atera: the next complete read resolves it; it leaves the open list and is found among the resolved.
  await closeAteraAlert(page, closing);
  await syncAtera(page, ['atera-alerts'], async () => (await storedAlerts(page, second.organizationId, 'Resolved')).length === 1, 'the resolved alert');
  await page.reload(); await narrow();
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
  await expect(panel.getByText(/^Atera:? (the )?read at /)).toBeVisible();
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(panel).toHaveCount(0); await expect(page).not.toHaveURL(/alert=/);

  // A phone shows cards with the same facts and actions, and nothing scrolls sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  await narrow();
  const cards = page.getByRole('list', { name: 'Alerts' }).getByRole('listitem').filter({ hasText: m });
  await expect(cards).toHaveCount(2);
  await expect(cards.first().getByRole('button', { name: `Assign ${m} disk almost full`, exact: true })).toBeVisible();
  await settled(page);
  expect(await fitsWidth(page)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('alert-queue-390.png'), fullPage: true });
});
