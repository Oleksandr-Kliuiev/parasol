import { expect, test, type Locator } from '@playwright/test';
import { ateraAlert, ateraAlertState, linkedAteraCustomer, storedAlerts, syncAlerts } from './atera';
import { signIn } from './support';

// M40: an Atera alert is closed in Atera from the queue's row, through the one confirmation every vendor action uses; the worker
// sends it within seconds (its loop runs every 5 s), reads the alert again, and the CRM shows it resolved once Atera has archived
// it. Deleting is destructive: the title is typed, a reason given, and the action waits a minute, in which it can be cancelled.
const SENT = 30_000;
const followUp = (dialog: Locator) => dialog.getByRole('status');

test('an alert is closed in Atera from the queue and deleting one waits for its hold and can be cancelled', { tag: '@critical' }, async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page, 'Crm.Admin');
  const customer = await linkedAteraCustomer(page, 'Act');
  const m = customer.marker;
  const closing = await ateraAlert(page, customer, { Title: `${m} disk almost full`, Severity: 'Critical' });
  const deleting = await ateraAlert(page, customer, { Title: `${m} backup is late`, Severity: 'Warning' });
  await syncAlerts(page, customer, 2);

  await page.goto('/alerts');
  await page.getByRole('searchbox', { name: 'Search title or device' }).fill(m);
  await expect(page.getByRole('status').filter({ hasText: /alerts:/ })).toHaveText('2 alerts: 1 critical, 1 warnings');
  await page.getByRole('button', { name: `Actions for ${m} disk almost full`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Close in Atera', exact: true }).click();
  const close = page.getByRole('dialog', { name: 'Close the alert in Atera', exact: true });
  await expect(close.getByText(`Atera closes “${m} disk almost full”`, { exact: false })).toBeVisible();
  await close.getByRole('button', { name: 'Close in Atera', exact: true }).click();
  await expect(followUp(close)).toContainText('Done', { timeout: SENT });
  await close.getByRole('button', { name: 'Close', exact: true }).click();

  // Atera archived it, and the read of the alert after the action resolved it here: the queue no longer lists it as open.
  expect((await ateraAlertState(page, closing))?.Archived).toBe(true);
  await expect.poll(async () => (await storedAlerts(page, customer.organizationId)).map((a) => a.title)).toEqual([`${m} backup is late`]);
  await expect(page.getByRole('button', { name: `${m} disk almost full`, exact: true })).toHaveCount(0);

  // Deleting from the alert's panel: destructive, so it asks for the title, a reason and holds the action for a minute.
  await page.getByRole('button', { name: `${m} backup is late`, exact: true }).click();
  const panel = page.getByRole('dialog', { name: `${m} backup is late`, exact: true });
  await panel.getByRole('region', { name: 'In Atera', exact: true }).getByRole('button', { name: 'Delete in Atera…', exact: true }).click();
  const remove = page.getByRole('dialog', { name: 'Delete the alert in Atera', exact: true });
  await expect(remove.getByText(/This cannot be undone/)).toBeVisible();
  const confirm = remove.getByRole('button', { name: 'Delete in Atera', exact: true });
  await remove.getByRole('textbox', { name: `Type “${m} backup is late” to confirm` }).fill(`${m} backup is late`);
  await remove.getByRole('textbox', { name: 'Reason' }).fill('The customer replaced the backup disk already');
  await confirm.click();
  await expect(followUp(remove)).toContainText('On hold', { timeout: SENT });
  await remove.getByRole('button', { name: 'Cancel the action', exact: true }).click();
  await expect(followUp(remove)).toContainText('Cancelled', { timeout: SENT });
  await remove.getByRole('button', { name: 'Close', exact: true }).click();
  expect(await ateraAlertState(page, deleting)).not.toBeNull();
  await expect(panel.getByRole('region', { name: 'In Atera', exact: true }).getByText('Cancelled', { exact: true })).toBeVisible();
});
