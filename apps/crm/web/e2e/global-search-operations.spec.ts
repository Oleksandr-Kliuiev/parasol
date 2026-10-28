import { expect, test, type Page } from '@playwright/test';
import { ateraAgent, ateraAlert, ateraTicket, linkedAteraCustomer, syncAlerts, syncDevices, syncTicket } from './atera';
import { linkedCloudAllyCustomer, syncCustomer } from './cloudally';
import { signIn } from './support';

// The global search reaches the operations records as well as customers and contacts: a technician types what they have — a
// machine's name, its serial number, the user logged in on it, an alert, a ticket number, a person's mailbox — and lands on the
// card, panel or tab that shows it, without a vendor's console. The records come from the Atera and CloudAlly stand-ins through the
// real worker reads; every name carries the test's own marker, as the e2e database is shared between runs.

const LABEL = 'Search customers, devices and more';

/**
 * Opens the palette unless it is open, and searches for `text`. The shortcut works once the shell is on the page: a key pressed
 * while the page is still loading is lost, so it is pressed again until the palette shows.
 */
async function search(page: Page, text: string) {
  const palette = page.getByRole('dialog', { name: 'Search', exact: true });
  await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeVisible();
  await expect(async () => {
    if (!(await palette.isVisible())) await page.keyboard.press('Control+k');
    await expect(palette).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  await palette.getByRole('combobox', { name: LABEL }).fill(text);
  return palette;
}

test('a device is found by its name, serial number or logged-in user and opens on its card', { tag: '@critical' }, async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page, 'Crm.Admin');
  const customer = await linkedAteraCustomer(page, 'Find');
  const id = customer.marker.slice(-6);
  await ateraAgent(page, customer, { MachineName: `HV01-${id}`, VendorSerialNumber: `SN-${id}`, LastLoginUser: `kari.nordmann${id}` });
  await syncDevices(page, customer, 1);
  await page.goto('/');

  let palette = await search(page, `hv01-${id}`);
  const device = palette.getByRole('option', { name: new RegExp(`^HV01-${id}`) });
  await expect(device).toContainText(customer.name);
  await expect(palette.getByRole('group', { name: 'Devices', exact: true })).toBeVisible();
  // The first hit is the one Enter opens, marked as such: the machine's card on the customer's Drift tab.
  await expect(device).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/organizations/${customer.organizationId}\\?tab=drift&device=[0-9a-f-]{36}$`));
  const card = page.getByRole('dialog', { name: `HV01-${id}`, exact: true });
  await expect(card).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);

  // What the agent reported finds the machine too, and the hit says where the words were found.
  palette = await search(page, `sn-${id}`);
  await expect(palette.getByRole('option', { name: new RegExp(`^HV01-${id}`) })).toContainText(`Serial number: SN-${id}`);
  await palette.getByRole('combobox', { name: LABEL }).fill(`kari.nordmann${id}`);
  await expect(palette.getByRole('option', { name: new RegExp(`^HV01-${id}`) })).toContainText(`Last logged in: kari.nordmann${id}`);
  // A word of the customer's name narrows to that customer; the name alone lists the customer, not all of its devices.
  await palette.getByRole('combobox', { name: LABEL }).fill(`hv01-${id} ${customer.marker}`);
  await expect(palette.getByRole('option', { name: new RegExp(`^HV01-${id}`) })).toBeVisible();
  await palette.getByRole('combobox', { name: LABEL }).fill(customer.marker);
  await expect(palette.getByRole('option', { name: new RegExp(`^${customer.name}`) })).toBeVisible();
  await expect(palette.getByRole('group', { name: /^Devices/ })).toHaveCount(0);
});

test('alerts, saved tickets and the people in backups are found and open where they are worked', async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page, 'Crm.Admin');
  const customer = await linkedAteraCustomer(page, 'FindOps');
  const id = customer.marker.slice(-6);
  await ateraAlert(page, customer, { Title: `Disk C almost full ${id}`, Severity: 'Critical', DeviceName: `FS01-${id}` });
  await syncAlerts(page, customer, 1);
  const ticket = await ateraTicket(page, customer, { TicketTitle: `Printer ${id} jams` });
  await syncTicket(page, ticket, 0);
  const backup = await linkedCloudAllyCustomer(page, 'FindBak', { users: [{ name: 'kari', fullName: `Kari ${id}` }] });
  await syncCustomer(page, backup, 4);
  await page.goto('/');

  // An alert by its device's name, opened with the mouse: the queue's panel.
  let palette = await search(page, `fs01-${id}`);
  const alert = palette.getByRole('option', { name: new RegExp(`^Disk C almost full ${id}`) });
  await expect(alert).toContainText('Critical');
  await expect(alert).toContainText(`${customer.name} · FS01-${id} · Source: Atera`);
  await alert.click();
  await expect(page).toHaveURL(/\/alerts\?alert=[0-9a-f-]{36}$/);
  const panel = page.getByRole('dialog', { name: `Disk C almost full ${id}`, exact: true });
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);

  // A ticket by its number alone: its panel on the tickets page.
  palette = await search(page, `#${ticket.TicketID}`);
  const found = palette.getByRole('option', { name: new RegExp(`^#${ticket.TicketID} Printer ${id} jams`) });
  await expect(found).toContainText('Open');
  await expect(found).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/tickets\?ticket=[0-9a-f-]{36}$/);
  const ticketPanel = page.getByRole('dialog', { name: `#${ticket.TicketID} Printer ${id} jams`, exact: true });
  await expect(ticketPanel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(ticketPanel).toHaveCount(0);

  // A person in a backup is one hit for mailbox and OneDrive; the customer's tab opens narrowed to them, their list in view.
  palette = await search(page, `kari ${id}`);
  const person = palette.getByRole('option', { name: new RegExp(`^Kari ${id}`) });
  await expect(person).toContainText(`${backup.name} · Mail, OneDrive · kari@${backup.domain}`);
  await person.click();
  await expect(page).toHaveURL(new RegExp(`/organizations/${backup.organizationId}\\?tab=backup&search=kari%40`));
  await expect(page.getByRole('searchbox', { name: 'Search name or address' })).toHaveValue(`kari@${backup.domain}`);
  const users = page.getByRole('region', { name: 'Users and sites', exact: true });
  await expect(users.getByRole('listitem')).toHaveCount(2);
  await expect(page.getByRole('heading', { name: 'Users and sites', exact: true })).toBeFocused();
});
