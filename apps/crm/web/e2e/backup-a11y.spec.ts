import { expect, test } from '@playwright/test';
import { fitsWidth, seriousViolations, settled, widths } from './atera';
import { linkedCloudAllyCustomer, syncCustomer } from './cloudally';
import { signIn } from './support';

// M42: the Sikkerhetskopi tab, a user's menu and the restore wizard at desktop, tablet and phone widths, in the theme of the project
// (desktop: light, desktop-dark: dark), against axe's WCAG 2.2 AA rules and with the keyboard alone.
test('the backup tab, a user’s menu and the restore wizard pass axe at every width and work from the keyboard', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const scheme = testInfo.project.use.colorScheme ?? 'light';
  await signIn(page, 'Crm.Admin');
  const customer = await linkedCloudAllyCustomer(page, 'BkpA', {
    users: [{ name: 'kari', fullName: 'Kari Nordmann' }, { name: 'ola', fullName: 'Ola Nordmann', state: 'failed', error: 'Mailbox is full' },
      { name: 'nina', state: 'notactive' }],
    pausedServices: ['SHAREPOINT_MULTI'],
  });
  await syncCustomer(page, customer, 6);
  const kari = `Kari Nordmann (kari@${customer.domain})`;

  for (const [width, height] of widths) {
    await page.setViewportSize({ width, height });
    await page.goto(`/organizations/${customer.organizationId}?tab=backup`);
    const users = page.getByRole('region', { name: 'Users and sites', exact: true });
    await expect(users.getByRole('listitem')).toHaveCount(7);
    await settled(page);
    expect(await seriousViolations(page), `backup tab at ${width} px (${scheme})`).toEqual([]);
    expect(await fitsWidth(page), `backup tab scrolls sideways at ${width} px (${scheme})`).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`backup-tab-${width}-${scheme}.png`), fullPage: true });

    // The keyboard opens a user's menu and the restore wizard from it; Escape closes the wizard with focus back on the menu button.
    const actions = users.getByRole('listitem').filter({ hasText: 'Mail' }).getByRole('button', { name: `Actions for ${kari}`, exact: true });
    await actions.focus(); await page.keyboard.press('Enter');
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem')).toHaveText(['Back up now', 'Restore …']);
    expect(await seriousViolations(page, '[role="menu"]'), `user menu at ${width} px (${scheme})`).toEqual([]);
    await menu.getByRole('menuitem', { name: 'Restore …', exact: true }).focus();
    await page.keyboard.press('Enter');
    const wizard = page.getByRole('dialog', { name: `Restore ${kari}`, exact: true });
    await wizard.getByRole('radio', { name: 'Into another account of the same domain', exact: true }).check();
    await expect(wizard.getByRole('textbox', { name: /Account to restore into/ })).toBeVisible();
    await settled(page);
    expect(await seriousViolations(page), `restore wizard at ${width} px (${scheme})`).toEqual([]);
    expect(await fitsWidth(page), `restore wizard scrolls sideways at ${width} px (${scheme})`).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`restore-wizard-${width}-${scheme}.png`), fullPage: true });
    await page.keyboard.press('Escape');
    await expect(wizard).toHaveCount(0);
    await expect(actions).toBeFocused();
  }
});
