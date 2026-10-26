import { expect, test } from '@playwright/test';
import { ateraAgent, fitsWidth, linkedAteraCustomer, seriousViolations, settled, syncDevices, syncPatches, widths } from './atera';
import { signIn } from './support';

// M40: the machine rows of the Drift tab and a machine's card (with a possible duplicate, the inventory and the Windows updates)
// at desktop, tablet and phone widths, in the theme of the project (desktop: light, desktop-dark: dark), against axe's WCAG 2.2 AA
// rules and with the keyboard alone.
test('machine rows and the device card pass axe at every width and work from the keyboard', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const scheme = testInfo.project.use.colorScheme ?? 'light';
  await signIn(page, 'Crm.Admin');
  const customer = await linkedAteraCustomer(page, 'MaxA');
  const id = customer.marker.slice(-6);
  await ateraAgent(page, customer, { MachineName: `SRV-${id}`, OSType: 'Server', OS: 'Windows Server 2022', VendorSerialNumber: `SN-${id}` });
  await ateraAgent(page, customer, { MachineName: `SRV2-${id}`, OSType: 'Server', OS: 'Windows Server 2022', VendorSerialNumber: `SN-${id}`, MacAddresses: [] });
  await syncDevices(page, customer, 2);
  await syncPatches(page, customer);

  for (const [width, height] of widths) {
    await page.setViewportSize({ width, height });
    await page.goto(`/organizations/${customer.organizationId}?tab=drift`);
    const devices = page.getByRole('region', { name: 'Devices', exact: true });
    // The rows of machines, not the count pills of the types above them.
    await expect(devices.getByRole('listitem').filter({ has: page.getByRole('button') })).toHaveCount(2);
    await settled(page);
    expect(await seriousViolations(page), `Drift tab devices at ${width} px (${scheme})`).toEqual([]);
    expect(await fitsWidth(page), `Drift tab scrolls sideways at ${width} px (${scheme})`).toBe(true);

    // The keyboard opens the card from the name and closes it with Escape, focus back where it was.
    const name = devices.getByRole('button', { name: `SRV2-${id}`, exact: true });
    await name.focus(); await page.keyboard.press('Enter');
    const card = page.getByRole('dialog', { name: `SRV2-${id}`, exact: true });
    await expect(card.getByRole('region', { name: 'May be the same device', exact: true })).toBeVisible();
    await expect(card.getByRole('region', { name: 'Windows updates', exact: true }).getByText('1 update available', { exact: true })).toBeVisible();
    await settled(page);
    expect(await seriousViolations(page), `device card at ${width} px (${scheme})`).toEqual([]);
    expect(await card.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`device-card-${width}-${scheme}.png`), fullPage: true });

    // Keeping two machines apart asks first, and Escape leaves the question with nothing decided.
    await card.getByRole('button', { name: 'Different devices', exact: true }).click();
    const ask = page.getByRole('dialog', { name: `Keep SRV2-${id} and SRV-${id} apart?`, exact: true });
    await expect(ask.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    expect(await seriousViolations(page), `keep-apart question at ${width} px (${scheme})`).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(ask).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0); await expect(name).toBeFocused();
  }
});
