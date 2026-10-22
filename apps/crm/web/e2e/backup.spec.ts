import { expect, test, type Locator, type Page } from '@playwright/test';
import { cloudAllyCalls, linkedCloudAllyCustomer, syncCustomer, taskOf, type BackupCustomer } from './cloudally';
import { api, signIn } from './support';

// M42: the customer's Sikkerhetskopi tab reads what the worker read from the CloudAlly stand-in: one tile per service, the users that
// need someone first, and the actions — a backup now, adding a user, a restore — through the one confirmation every vendor action
// uses; the worker sends them within seconds and the tab shows what CloudAlly shows afterwards. A failed or paused backup is also a
// coverage gap of Parasoll in the alert queue, which leads back to the tab.
const SENT = 30_000;
const followUp = (dialog: Locator) => dialog.getByRole('status');

const users = (page: Page) => page.getByRole('region', { name: 'Users and sites', exact: true });
const row = (page: Page, name: string) => users(page).getByRole('listitem').filter({ hasText: name });

async function openTab(page: Page, customer: BackupCustomer) {
  await page.goto(`/organizations/${customer.organizationId}?tab=backup`);
  await expect(page.getByRole('tab', { name: 'Backup', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('region', { name: 'Backup at a glance', exact: true }).getByText(/CloudAlly read at/)).toBeVisible();
}

test('the backup tab shows each service and the users that need someone first, and a failed backup is a gap that leads back', { tag: '@critical' }, async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page, 'Crm.Admin');
  const customer = await linkedCloudAllyCustomer(page, 'Bkp', {
    users: [{ name: 'kari', fullName: 'Kari Nordmann' }, { name: 'ola', fullName: 'Ola Nordmann', state: 'failed', error: 'Mailbox is full' },
      { name: 'nina', state: 'notactive' }],
    pausedServices: ['SHAREPOINT_MULTI'],
  });
  await syncCustomer(page, customer, 6);

  await openTab(page, customer);
  const summary = page.getByRole('region', { name: 'Backup at a glance', exact: true });
  await expect(summary.getByRole('term')).toHaveText(['Mail', 'OneDrive', 'SharePoint', 'Teams and groups']);
  await expect(summary.getByText('1 failed · 1 not in backup', { exact: true })).toBeVisible();
  await expect(summary.getByText('1 paused', { exact: true })).toBeVisible();
  await expect(summary.getByText(/Partner Center has no licence data for this customer/)).toBeVisible();
  await expect(summary.getByText(customer.name, { exact: true })).toBeVisible();

  // The users and sites that need someone come first: the failed mailbox with CloudAlly's words, the paused site, the user not in the backup.
  const listed = users(page).getByRole('listitem');
  await expect(listed.first()).toContainText(`Ola Nordmann (ola@${customer.domain})`);
  await expect(listed.first().getByText('CloudAlly: Mailbox is full', { exact: true })).toBeVisible();
  await expect(listed.nth(1)).toContainText('Prosjekter');
  await expect(listed.nth(1).getByText('Paused', { exact: true })).toBeVisible();
  await expect(listed.nth(2)).toContainText(`nina@${customer.domain}`);
  await page.getByRole('group', { name: 'Which ones', exact: true }).getByRole('button', { name: /Need attention/ }).click();
  await expect(listed).toHaveCount(3);

  // The same failure is a gap of Parasoll's own in the alert queue, worded in the reader's language, and its panel leads back to the tab.
  await page.goto(`/alerts?customer=${customer.organizationId}`);
  const gap = page.getByRole('button', { name: `Mail: the CloudAlly backup failed for 1 of 2 (${customer.name})`, exact: true });
  await expect(gap).toBeVisible();
  await expect(page.getByRole('button', { name: `SharePoint: the CloudAlly backup is paused (${customer.name})`, exact: true })).toBeVisible();
  await gap.click();
  await page.getByRole('dialog').getByRole('link', { name: 'Open the customer’s backup', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/organizations/${customer.organizationId}\\?tab=backup$`));
  await expect(row(page, 'ola@').filter({ hasText: 'CloudAlly: Mailbox is full' })).toBeVisible();
});

test('a backup now and adding a user go through the confirmation and reach CloudAlly', { tag: '@critical' }, async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page, 'Crm.Admin');
  const customer = await linkedCloudAllyCustomer(page, 'BkpRun', { users: [{ name: 'kari', fullName: 'Kari Nordmann', state: 'late' }, { name: 'nina', state: 'notactive' }] });
  await syncCustomer(page, customer, 4);
  await openTab(page, customer);
  const mail = taskOf(customer, 'MS365');

  const services = page.getByRole('region', { name: 'Services in CloudAlly', exact: true });
  await services.getByRole('button', { name: 'Back up now: Mail', exact: true }).click();
  const run = page.getByRole('dialog', { name: 'Back up now', exact: true });
  await expect(run.getByText(/CloudAlly backs up Mail at .* now: 1 user or site\./)).toBeVisible();
  await run.getByRole('button', { name: 'Back up now', exact: true }).click();
  await expect(followUp(run)).toContainText('Done', { timeout: SENT });
  await run.getByRole('button', { name: 'Close', exact: true }).click();
  await expect.poll(async () => (await cloudAllyCalls(page, customer)).map((call) => `${call.method} ${call.path}`))
    .toContain(`POST v2/resellers/accounts/${customer.account.id}/backup-tasks/${mail.id}/backupNow`);

  // A user CloudAlly knows but does not back up is added, and the tab shows them waiting for the first backup.
  const nina = mail.entities.find((entity) => entity.entity.startsWith('nina@'))!;
  await row(page, 'nina@').getByRole('button', { name: `Actions for nina@${customer.domain}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Add to the backup', exact: true }).click();
  const add = page.getByRole('dialog', { name: 'Add to the backup', exact: true });
  await expect(add.getByText('CloudAlly bills one more user or site from then on.')).toBeVisible();
  await add.getByRole('button', { name: 'Add to the backup', exact: true }).click();
  await expect(followUp(add)).toContainText('Done', { timeout: SENT });
  await add.getByRole('button', { name: 'Close', exact: true }).click();
  expect((await cloudAllyCalls(page, customer)).map((call) => `${call.method} ${call.path}`))
    .toContain(`POST v2/resellers/accounts/${customer.account.id}/backup-tasks/${mail.id}/entities/${nina.id}/activate`);
  await expect(row(page, 'nina@').getByText('Waiting for its first backup', { exact: true })).toBeVisible();
});

test('a mailbox is exported as PST through the restore wizard, and a restore in place waits out its hold and can be cancelled', { tag: '@critical' }, async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page, 'Crm.Admin');
  const customer = await linkedCloudAllyCustomer(page, 'BkpRes', { users: [{ name: 'kari', fullName: 'Kari Nordmann' }] });
  await syncCustomer(page, customer, 4);
  await openTab(page, customer);
  const kari = `Kari Nordmann (kari@${customer.domain})`;

  await row(page, `kari@${customer.domain}`).filter({ hasText: 'Mail' }).getByRole('button', { name: `Actions for ${kari}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Restore …', exact: true }).click();
  const wizard = page.getByRole('dialog', { name: `Restore ${kari}`, exact: true });
  await expect(wizard.getByRole('radio', { name: 'Download as PST', exact: true })).toBeChecked();
  // The wizard opens on its first way, not on the day: WebKit gives a date field focus without a focusin, and the dialog then
  // stayed hidden from assistive technology (aria-hidden), which this locator would not find either.
  await expect(wizard.getByRole('radio', { name: 'Download as PST', exact: true })).toBeFocused();
  await expect(wizard.getByText(/A single e-mail or file is restored in CloudAlly/)).toBeVisible();
  await wizard.getByRole('button', { name: 'Continue', exact: true }).click();
  const exporting = page.getByRole('dialog', { name: 'Export a backup', exact: true });
  await expect(exporting.getByText(/e-mails the download link when the file is ready; Parasoll does not get it/)).toBeVisible();
  await exporting.getByRole('textbox', { name: 'Reason' }).fill('The customer’s lawyer needs the mailbox as it was');
  await exporting.getByRole('button', { name: 'Export the backup', exact: true }).click();
  await expect(followUp(exporting)).toContainText('Done', { timeout: SENT });
  await exporting.getByRole('button', { name: 'Close', exact: true }).click();
  const exported = (await cloudAllyCalls(page, customer)).find((call) => call.path.endsWith('/recovery/export'))!;
  expect(exported.body).toMatchObject({ account: `kari@${customer.domain}`, source: 'MS365', downloadToPst: true, includeDeleted: false });
  expect(String(exported.body.date)).toMatch(/^\d{8}235959$/);

  // In place is destructive: the address typed, a reason, and a minute during which it can still be cancelled.
  await row(page, `kari@${customer.domain}`).filter({ hasText: 'Mail' }).getByRole('button', { name: `Actions for ${kari}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Restore …', exact: true }).click();
  await wizard.getByRole('radio', { name: 'Back where it was', exact: true }).check();
  await wizard.getByRole('button', { name: 'Continue', exact: true }).click();
  const inPlace = page.getByRole('dialog', { name: 'Restore in place', exact: true });
  await expect(inPlace.getByText(/This cannot be undone/)).toBeVisible();
  await inPlace.getByRole('textbox', { name: `Type “kari@${customer.domain}” to confirm` }).fill(`kari@${customer.domain}`);
  await inPlace.getByRole('textbox', { name: 'Reason' }).fill('Ransomware encrypted her mailbox yesterday');
  await inPlace.getByRole('button', { name: 'Restore in place', exact: true }).click();
  await expect(followUp(inPlace)).toContainText('On hold', { timeout: SENT });
  await inPlace.getByRole('button', { name: 'Cancel the action', exact: true }).click();
  await expect(followUp(inPlace)).toContainText('Cancelled', { timeout: SENT });
  expect((await cloudAllyCalls(page, customer)).filter((call) => call.path.endsWith('/recovery/restore'))).toEqual([]);
});

test('without a linked CloudAlly account the tab says so and leads to the mapping', async ({ page }) => {
  await signIn(page, 'Crm.Admin');
  const organization = await api.post<{ id: string }>(page, '/api/v1/customers/organizations', { name: `Uten kopi ${Date.now()}`, status: 'Customer' });
  await page.goto(`/organizations/${organization.id}?tab=backup`);
  await expect(page.getByText('No CloudAlly account is linked to this customer.', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Link a CloudAlly account', exact: true })).toHaveAttribute('href', '/admin/mappings?system=cloudally&type=Customer');
});
