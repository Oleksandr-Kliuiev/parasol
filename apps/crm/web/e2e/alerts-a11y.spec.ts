import { expect, test } from '@playwright/test';
import { ateraAgent, ateraAlert, fitsWidth, linkedAteraCustomer, seriousViolations, settled, syncAlerts, syncDevices, widths } from './atera';
import { signIn } from './support';

// M38: the queue, its side panel, the assign dialog and the Drift tab at desktop, tablet and phone widths, in the theme of the
// project (desktop: light, desktop-dark: dark), against axe's WCAG 2.2 AA rules and with the keyboard alone.
test('alerts, their side panel, the assign dialog and the Drift tab pass axe at every width and work from the keyboard', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const scheme = testInfo.project.use.colorScheme ?? 'light';
  await signIn(page, 'Crm.Admin');
  const customer = await linkedAteraCustomer(page, 'Axe');
  const m = customer.marker;
  await ateraAgent(page, customer, { MachineName: `SRV-${m}`, OSType: 'Server', OS: 'Windows Server 2022' });
  await syncDevices(page, customer, 1);
  await ateraAlert(page, customer, { Title: `${m} disk almost full on a server with a long name that wraps`, Severity: 'Critical', DeviceName: `SRV-${m}` });
  await ateraAlert(page, customer, { Title: `${m} backup is late`, Severity: 'Warning', hoursAgo: 26 });
  await syncAlerts(page, customer, 2);

  for (const [width, height] of widths) {
    await page.setViewportSize({ width, height });
    await page.goto('/alerts');
    const search = page.getByRole('searchbox', { name: 'Search title or device' });
    await search.fill(m);
    await expect(page.getByRole('status').filter({ hasText: /alerts:/ })).toHaveText('2 alerts: 1 critical, 1 warnings');
    await settled(page);
    expect(await seriousViolations(page), `queue at ${width} px (${scheme})`).toEqual([]);
    expect(await fitsWidth(page), `queue scrolls sideways at ${width} px (${scheme})`).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`alert-queue-${width}-${scheme}.png`), fullPage: true });

    // The keyboard opens the side panel from the title and closes it with Escape, focus back where it was.
    const title = page.getByRole('button', { name: `${m} backup is late`, exact: true });
    await title.focus(); await page.keyboard.press('Enter');
    const panel = page.getByRole('dialog', { name: `${m} backup is late`, exact: true });
    await expect(panel.getByRole('button', { name: 'Assign', exact: true })).toBeVisible();
    await settled(page);
    expect(await seriousViolations(page), `side panel at ${width} px (${scheme})`).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0); await expect(title).toBeFocused();

    // Assign from the row, by keyboard: the dialog takes focus, Escape gives it back to the button.
    const assign = page.getByRole('button', { name: `Assign ${m} backup is late`, exact: true });
    await assign.focus(); await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Assign alert', exact: true });
    await expect(dialog.getByRole('textbox', { name: 'Task subject' })).toHaveValue(`${m} backup is late`);
    await settled(page);
    expect(await seriousViolations(page), `assign dialog at ${width} px (${scheme})`).toEqual([]);
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0); await expect(assign).toBeFocused();

    // M40: Parasoll's own coverage checks, from the queue's header; Escape gives focus back to the button.
    const checks = page.getByRole('button', { name: 'Coverage checks', exact: true });
    await checks.focus(); await page.keyboard.press('Enter');
    const coverage = page.getByRole('dialog', { name: 'Coverage checks', exact: true });
    // M41 and M42 add Huntress's and the backup rules: the Atera rule is the one named here.
    await expect(coverage.getByRole('region', { name: 'Silent Atera agent', exact: true }).getByRole('switch', { name: 'Raise alerts' })).toBeVisible();
    await settled(page);
    expect(await seriousViolations(page), `coverage checks at ${width} px (${scheme})`).toEqual([]);
    expect(await fitsWidth(page), `coverage checks scroll sideways at ${width} px (${scheme})`).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`coverage-checks-${width}-${scheme}.png`) });
    await page.keyboard.press('Escape');
    await expect(coverage).toHaveCount(0); await expect(checks).toBeFocused();

    await page.goto(`/organizations/${customer.organizationId}?tab=drift`);
    await expect(page.getByRole('region', { name: 'Open alerts', exact: true }).getByRole('listitem')).toHaveCount(2);
    await expect(page.getByRole('tab', { name: 'Operations', exact: true })).toBeInViewport({ ratio: 1 });
    await settled(page);
    expect(await seriousViolations(page), `Drift tab at ${width} px (${scheme})`).toEqual([]);
    expect(await fitsWidth(page), `Drift tab scrolls sideways at ${width} px (${scheme})`).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`drift-tab-${width}-${scheme}.png`), fullPage: true });
  }
});
