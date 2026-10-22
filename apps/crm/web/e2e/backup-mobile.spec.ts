import { expect, test } from '@playwright/test';
import { linkedCloudAllyCustomer, syncCustomer } from './cloudally';
import { signIn } from './support';

// M42: on a phone the Sikkerhetskopi tab keeps its tiles, its rows and the restore wizard inside the screen, and the tab joins the
// row of tabs when it is opened from "More".
test('the backup tab and the restore wizard fit a phone screen', async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page, 'Crm.Admin');
  const customer = await linkedCloudAllyCustomer(page, 'BkpM', {
    users: [{ name: 'kari', fullName: 'Kari Nordmann' }, { name: 'ola', fullName: 'Ola Nordmann', state: 'failed', error: 'Mailbox is full' }],
  });
  await syncCustomer(page, customer, 6);
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

  await page.goto(`/organizations/${customer.organizationId}`);
  await page.getByRole('tab', { name: /^More/ }).click();
  await page.getByRole('menuitem', { name: 'Backup', exact: true }).click();
  await expect(page).toHaveURL(/tab=backup/);
  await expect(page.getByRole('tab', { name: 'Backup', exact: true })).toHaveAttribute('aria-selected', 'true');
  const summary = page.getByRole('region', { name: 'Backup at a glance', exact: true });
  await expect(summary.getByRole('term')).toHaveText(['Mail', 'OneDrive', 'SharePoint', 'Teams and groups']);
  await page.waitForLoadState('networkidle');
  expect(await overflow(), 'the backup tab scrolls sideways').toBeLessThanOrEqual(1);

  const kari = `Kari Nordmann (kari@${customer.domain})`;
  await page.getByRole('region', { name: 'Users and sites', exact: true }).getByRole('listitem').filter({ hasText: 'Mail' })
    .getByRole('button', { name: `Actions for ${kari}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Restore …', exact: true }).click();
  const wizard = page.getByRole('dialog', { name: `Restore ${kari}`, exact: true });
  await expect(wizard.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
  expect(await overflow(), 'the restore wizard scrolls sideways').toBeLessThanOrEqual(1);
  await wizard.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(wizard).toHaveCount(0);
});
