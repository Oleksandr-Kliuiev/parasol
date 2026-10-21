import { expect, test } from '@playwright/test';
import { ateraAgent, ateraAlert, fitsWidth, linkedAteraCustomer, settled, syncAlerts, syncDevices, widths } from './atera';
import { signIn } from './support';

// M38: the customer's Drift tab reads what the worker stored from the Atera stand-in: open alerts critical first and the oldest
// first, the devices with their open alerts, then tickets and ticket requests. Old ?tab=service links still open it.
test('the Drift tab lists a customer’s open alerts first, then its devices with their open alerts', { tag: '@critical' }, async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await signIn(page, 'Crm.Admin');
  const customer = await linkedAteraCustomer(page, 'Ops');
  const server = `SRV-${customer.marker}`;
  await ateraAgent(page, customer, { MachineName: server, OSType: 'Server', OS: 'Windows Server 2022' });
  await ateraAgent(page, customer, { MachineName: `PC-${customer.marker}`, OSType: 'Work Station', OS: 'Windows 11 Pro', Online: false });
  await syncDevices(page, customer, 2);
  // The warning waited longer, but a critical alert comes first; within a severity the oldest comes first.
  await ateraAlert(page, customer, { Title: `${customer.marker} backup is late`, Severity: 'Warning', DeviceName: server, hoursAgo: 30 });
  await ateraAlert(page, customer, { Title: `${customer.marker} disk almost full`, Severity: 'Critical', DeviceName: server, hoursAgo: 3 });
  await ateraAlert(page, customer, { Title: `${customer.marker} service stopped`, Severity: 'Critical', DeviceName: server, hoursAgo: 6 });
  await syncAlerts(page, customer, 3);

  // An old link to the Service tab opens Drift and the address says so.
  await page.goto(`/organizations/${customer.organizationId}?tab=service`);
  await expect(page.getByRole('tab', { name: 'Operations', exact: true, selected: true })).toBeVisible();
  await expect(page).toHaveURL(/[?&]tab=drift/);
  await expect(page.getByRole('tab', { name: 'Service', exact: true })).toHaveCount(0);

  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 2 })).toHaveText(['Saved service data', 'Open alerts', 'Devices', 'Tickets', 'Ticket requests']);
  const alerts = page.getByRole('region', { name: 'Open alerts', exact: true });
  await expect(alerts.getByRole('listitem')).toHaveText([
    new RegExp(`${customer.marker} service stopped.*Critical`), new RegExp(`${customer.marker} disk almost full.*Critical`),
    new RegExp(`${customer.marker} backup is late.*Warning`)]);
  await expect(alerts.getByRole('listitem').first().locator('time')).toHaveAttribute('datetime', /T/);
  const devices = page.getByRole('region', { name: 'Devices', exact: true });
  await expect(devices.getByRole('listitem').filter({ hasText: server }).getByText('3 open alerts', { exact: true })).toBeVisible();
  await expect(devices.getByRole('listitem').filter({ hasText: `PC-${customer.marker}` }).getByText(/open alert/)).toHaveCount(0);

  // The title opens the alert in a side panel, with its link to Atera; Escape closes it and focus returns to the title.
  const title = alerts.getByRole('button', { name: `${customer.marker} disk almost full`, exact: true });
  await title.focus(); await page.keyboard.press('Enter');
  const panel = page.getByRole('dialog', { name: `${customer.marker} disk almost full`, exact: true });
  await expect(panel.getByText(server, { exact: true })).toBeVisible();
  await expect(panel.getByRole('link', { name: 'Open in Atera', exact: true })).toHaveAttribute('href', /^https:\/\/atera\.example\.invalid\/alerts\/\d+$/);
  await expect(page).toHaveURL(/[?&]alert=/);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0); await expect(title).toBeFocused();
  await expect(page).not.toHaveURL(/[?&]alert=/);

  // The overview names the open alerts once, with the critical ones, and opens this tab.
  await page.goto(`/organizations/${customer.organizationId}`);
  const fact = page.getByRole('group', { name: 'Customer at a glance' }).getByRole('link', { name: /Open alerts/ });
  await expect(fact).toContainText('3'); await expect(fact).toContainText('2 critical');
  await fact.click();
  await expect(page.getByRole('tab', { name: 'Operations', exact: true, selected: true })).toBeFocused();

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [width, height] of widths) {
      await page.setViewportSize({ width, height });
      await settled(page);
      expect(await fitsWidth(page), `Drift tab scrolls sideways at ${width} px (${scheme})`).toBe(true);
      await expect(alerts.getByRole('listitem').first()).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`drift-tab-${width}-${scheme}.png`), fullPage: true });
    }
  }
});
