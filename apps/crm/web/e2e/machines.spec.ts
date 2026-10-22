import { expect, test } from '@playwright/test';
import { ateraAgent, linkedAteraCustomer, storedMachines, syncDevices, syncPatches } from './atera';
import { signIn } from './support';

// M40: the Drift tab lists one row per computer. Two agents of one computer (same serial number, MAC address and name) are one
// machine; an agent that shares only the serial number with another is a possible duplicate a person decides on, and the
// decision survives the next read. The card shows what Atera's API v3 says about the computer and its Windows updates.
test('one row per computer: a full match joins, a possible duplicate waits for a person, and the card shows Atera’s inventory', { tag: '@critical' }, async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page, 'Crm.Admin');
  const customer = await linkedAteraCustomer(page, 'Mach');
  const id = customer.marker.slice(-6);
  const mac = `00:1A:2B:${id.slice(0, 2).replace(/[^0-9A-F]/gi, '0')}:7E:01`;
  // The same computer, its agent installed twice: every key matches.
  await ateraAgent(page, customer, { MachineName: `WS-${id}`, VendorSerialNumber: `SN-${id}`, MacAddresses: [mac], Online: false, LastSeen: new Date(Date.now() - 86_400_000).toISOString() });
  await ateraAgent(page, customer, { MachineName: `WS-${id}`, VendorSerialNumber: `SN-${id}`, MacAddresses: [mac] });
  // A computer that was renamed: only the serial number says it may be the same one.
  await ateraAgent(page, customer, { MachineName: `LAP-${id}`, VendorSerialNumber: `SN2-${id}`, MacAddresses: [] });
  await ateraAgent(page, customer, { MachineName: `ACC-${id}`, VendorSerialNumber: `SN2-${id}`, MacAddresses: [] });
  await syncDevices(page, customer, 4);

  await page.goto(`/organizations/${customer.organizationId}?tab=drift`);
  const devices = page.getByRole('region', { name: 'Devices', exact: true });
  // The rows of machines, not the count pills of the types above them.
  const rows = devices.getByRole('listitem').filter({ has: page.getByRole('button') });
  await expect(rows).toHaveCount(3);
  await expect(devices.getByRole('listitem').filter({ hasText: `WS-${id}` })).toHaveCount(1);
  const renamed = devices.getByRole('listitem').filter({ hasText: `ACC-${id}` });
  await expect(renamed.getByText('Check: may be a duplicate', { exact: true })).toBeVisible();

  // The name opens the card (?device=); the proposal says why, and one click joins them.
  const name = renamed.getByRole('button', { name: `ACC-${id}`, exact: true });
  await name.click();
  await expect(page).toHaveURL(/[?&]device=/);
  let card = page.getByRole('dialog', { name: `ACC-${id}`, exact: true });
  const proposal = card.getByRole('region', { name: 'May be the same device', exact: true });
  await expect(proposal.getByText(`May be LAP-${id}`, { exact: true })).toBeVisible();
  await expect(proposal.getByText('same serial number', { exact: true })).toBeVisible();
  await proposal.getByRole('button', { name: 'Same device', exact: true }).click();
  card = page.getByRole('dialog');
  await expect(card.getByRole('region', { name: 'May be the same device', exact: true })).toHaveCount(0);
  await expect(card.getByRole('region', { name: 'Sources', exact: true }).getByRole('listitem')).toHaveCount(2);
  // The button that decided is gone: the result is said, and focus stays in the panel, on the devices it has now.
  await expect(card.getByRole('status')).toHaveText('The two are one device now.');
  await expect(card.getByRole('heading', { name: 'Sources', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await expect(rows).toHaveCount(2);

  // The next read applies the decision before any rule: still two rows, no proposal.
  await syncDevices(page, customer, 4);
  await expect.poll(async () => (await storedMachines(page, customer.organizationId)).map((m) => m.proposals)).toEqual([0, 0]);

  // What Atera says about the computer, and its Windows updates once they were read.
  await syncPatches(page, customer);
  await page.reload();
  const workstation = devices.getByRole('button', { name: `WS-${id}`, exact: true });
  await workstation.focus(); await page.keyboard.press('Enter');
  card = page.getByRole('dialog', { name: `WS-${id}`, exact: true });
  await expect(card.getByRole('region', { name: 'Sources', exact: true }).getByRole('listitem')).toHaveCount(2);
  const hardware = card.getByRole('region', { name: 'Hardware', exact: true });
  await expect(hardware.getByText('Dell Inc. Latitude 5440', { exact: true })).toBeVisible();
  await expect(hardware.getByText(`SN-${id}`, { exact: true })).toBeVisible();
  const updates = card.getByRole('region', { name: 'Windows updates', exact: true });
  await expect(updates.getByText('1 update available', { exact: true })).toBeVisible();
  await expect(updates.getByText('KB5045993', { exact: true })).toBeVisible();
  await expect(updates.getByText('2 updates installed', { exact: true })).toBeVisible();
  await expect(card.getByRole('region', { name: 'In Atera', exact: true }).getByRole('link', { name: 'Open in Atera', exact: true }))
    .toHaveAttribute('href', /^https:\/\/atera\.example\.invalid\/Admin#\/rmm\/device\/[0-9a-f-]+\/agent$/);
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0); await expect(workstation).toBeFocused();
  await expect(page).not.toHaveURL(/[?&]device=/);
});
