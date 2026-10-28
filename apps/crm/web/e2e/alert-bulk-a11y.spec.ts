import { expect, test } from '@playwright/test';
import { ateraAlert, fitsWidth, linkedAteraCustomer, searchAlerts, seriousViolations, settled, syncAlerts, widths } from './atera';
import { signIn } from './support';

// M45: the queue with chosen alerts, its bulk bar and both bulk dialogs at desktop, tablet and phone widths, in the theme of the
// project (desktop: light, desktop-dark: dark), against axe's WCAG 2.2 AA rules and with the keyboard alone.
test('chosen alerts, the bulk bar and the bulk dialogs pass axe at every width and work from the keyboard', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const scheme = testInfo.project.use.colorScheme ?? 'light';
  await signIn(page, 'Crm.Admin');
  const customer = await linkedAteraCustomer(page, 'BulkAxe');
  const m = customer.marker;
  await ateraAlert(page, customer, { Title: `${m} no SNMP response from the printer on the third floor by the meeting rooms`, Severity: 'Warning',
    hoursAgo: 24 * 120 });
  await ateraAlert(page, customer, { Title: `${m} toner below threshold`, Severity: 'Critical', hoursAgo: 30 });
  await syncAlerts(page, customer, 2);

  for (const [width, height] of widths) {
    await page.setViewportSize({ width, height });
    await page.goto('/alerts');
    await searchAlerts(page, m);
    await expect(page.getByRole('status').filter({ hasText: /alerts:/ })).toHaveText('2 alerts: 1 critical, 1 warnings');

    // A row's box answers Space; the box over the rows chooses them all.
    const bar = page.getByRole('region', { name: 'Selected alerts' });
    await expect(bar.getByRole('status')).toHaveText('Select alerts to act on several at once.');
    const row = page.getByRole('checkbox', { name: `Select ${m} toner below threshold (${customer.name})`, exact: true });
    await row.focus(); await page.keyboard.press('Space');
    await expect(row).toBeChecked();
    await expect(bar.getByRole('status')).toHaveText('1 selected');
    await page.getByRole('checkbox', { name: 'Select all alerts shown' }).check();
    await expect(bar.getByRole('status')).toHaveText('2 selected');
    await settled(page);
    expect(await seriousViolations(page), `chosen alerts at ${width} px (${scheme})`).toEqual([]);
    expect(await fitsWidth(page), `chosen alerts scroll sideways at ${width} px (${scheme})`).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`bulk-bar-${width}-${scheme}.png`), fullPage: true });

    // The hide dialog by keyboard: it reads the alerts, Escape gives focus back to the bar's button.
    const hideButton = bar.getByRole('button', { name: 'Hide until… (2)' });
    await hideButton.focus(); await page.keyboard.press('Enter');
    const hide = page.getByRole('dialog', { name: 'Hide 2 alerts until a date', exact: true });
    await expect(hide.getByRole('textbox', { name: /Reason/ })).toBeVisible();
    await settled(page);
    expect(await seriousViolations(page), `bulk hide dialog at ${width} px (${scheme})`).toEqual([]);
    expect(await fitsWidth(page), `bulk hide dialog scrolls sideways at ${width} px (${scheme})`).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`bulk-hide-${width}-${scheme}.png`) });
    await page.keyboard.press('Escape');
    await expect(hide).toHaveCount(0); await expect(hideButton).toBeFocused();

    // The close dialog by keyboard: its preview takes the way out as focus, Escape gives focus back.
    const closeButton = bar.getByRole('button', { name: 'Close in Atera (2)' });
    await closeButton.focus(); await page.keyboard.press('Enter');
    const close = page.getByRole('dialog', { name: 'Close alerts in Atera', exact: true });
    await expect(close.getByRole('button', { name: 'Close 2 in Atera', exact: true })).toBeEnabled();
    await expect(close.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await settled(page);
    expect(await seriousViolations(page), `bulk close dialog at ${width} px (${scheme})`).toEqual([]);
    expect(await fitsWidth(page), `bulk close dialog scrolls sideways at ${width} px (${scheme})`).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`bulk-close-${width}-${scheme}.png`) });
    await page.keyboard.press('Escape');
    await expect(close).toHaveCount(0); await expect(closeButton).toBeFocused();

    // The way out of the choice goes with what was chosen: focus goes to the list, not to the page; the bar stays, waiting.
    await bar.getByRole('button', { name: 'Clear selection' }).click();
    await expect(bar.getByRole('status')).toHaveText('Select alerts to act on several at once.');
    await expect(page.locator('[data-alert-list]')).toBeFocused();
  }
});
