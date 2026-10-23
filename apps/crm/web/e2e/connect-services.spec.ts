import { expect, test } from '@playwright/test';
import { linkedCloudAllyCustomer, syncCustomer } from './cloudally';
import {
  cloudAllyCreations, contractOf, currentTerm, customerToConnect, huntressOrganizations, linkedHuntressOrganization, linksOf, serviceQuantities,
  servicesProducts, syncUntil,
} from './onboarding';
import { api, signIn } from './support';

// M43: "Connect services" creates the customer in the Atera, Huntress and CloudAlly stand-ins on the vendor action path — previewed
// from saved data, queued, sent by the worker and linked at once — and adds the contract lines billed by what each service counts.
// The contracts tab then shows those counts against the lines, and what CloudAlly bills for the customer.

const SENT = 30_000;

test('connecting a customer creates it in Atera, Huntress and CloudAlly and adds the lines to its contract @critical', async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page, 'Crm.Admin');
  const customer = await customerToConnect(page, 'Kob');
  const email = `backup@${customer.marker.toLowerCase()}.example`;

  await page.goto(`/organizations/${customer.id}`);
  const linked = page.getByRole('region', { name: 'Linked systems', exact: true });
  const open = linked.getByRole('button', { name: 'Connect services…', exact: true });
  await open.click();
  const wizard = page.getByRole('dialog', { name: 'Connect the customer to the services', exact: true });

  // Step 1: what Parasoll creates. Atera takes the customer card as it is, Huntress a key proposed from the name, CloudAlly an address.
  await expect(wizard.getByText('Step 1 of 4: Services', { exact: true })).toBeFocused();
  await expect(wizard.getByRole('checkbox', { name: 'Create in Atera', exact: true })).toBeChecked();
  await expect(wizard.getByRole('textbox', { name: /^Organization key/ })).toHaveValue(customer.key);
  await wizard.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(wizard.getByText('Enter an e-mail address.', { exact: true })).toBeVisible();
  await wizard.getByRole('textbox', { name: /^E-mail of the account/ }).fill(email);
  await expect(wizard.getByRole('combobox', { name: 'Data center', exact: true })).toHaveValue('EU');
  await wizard.getByRole('button', { name: 'Continue', exact: true }).click();

  // Step 2: the draft contract gets a line per Huntress agent and one per backup user; Atera's devices are billed elsewhere.
  await expect(wizard.getByText('Step 2 of 4: Contract', { exact: true })).toBeFocused();
  await expect(wizard.getByRole('combobox', { name: 'Contract', exact: true })).toContainText(customer.contract.number);
  await wizard.getByRole('checkbox', { name: 'Bill per Atera device', exact: true }).uncheck();
  for (const [group, product, estimate] of [['Per Huntress agent', customer.agent, '5'], ['Per backup user (CloudAlly)', customer.seat, '3']] as const) {
    const line = wizard.getByRole('group', { name: group, exact: true });
    await line.getByRole('combobox', { name: /^Product/ }).pressSequentially(product.sku);
    await page.getByRole('option', { name: new RegExp(product.sku, 'i') }).click();
    await line.getByRole('textbox', { name: /^Quantity until the first count/ }).fill(estimate);
  }
  await wizard.getByRole('button', { name: 'Continue', exact: true }).click();

  // Step 3: the preview names what each vendor gets and what the contract gets.
  await expect(wizard.getByText('Step 3 of 4: Confirm', { exact: true })).toBeFocused();
  await expect(wizard.getByText(new RegExp(`^Atera gets the customer “${customer.name}” \\(organization number \\d{9}\\)`))).toBeVisible();
  await expect(wizard.getByText(`Huntress gets the organization “${customer.name}” with the organization key ${customer.key}.`, { exact: true })).toBeVisible();
  await expect(wizard.getByText(`CloudAlly gets the account “${customer.name}” for ${email} in the data center EU, opened as a trial account.`, { exact: true }))
    .toBeVisible();
  await expect(wizard.getByText(new RegExp(`^${customer.agent.name} – Per Huntress agent, 5 until the first count`))).toBeVisible();
  await wizard.getByRole('button', { name: 'Create and link', exact: true }).click();

  // Step 4: each creation is followed until the worker has linked it, and what the APIs cannot do is named with the way to the console.
  await expect(wizard.getByText('Step 4 of 4: Result', { exact: true })).toBeFocused();
  await expect(wizard.getByText('Created and linked to the customer.', { exact: true })).toHaveCount(3, { timeout: SENT });
  await expect(wizard.getByText(`${customer.agent.name} added`, { exact: true })).toBeVisible();
  await expect(wizard.getByText(`${customer.seat.name} added`, { exact: true })).toBeVisible();
  const next = wizard.getByRole('region', { name: 'Left to do outside Parasoll', exact: true });
  await expect(next.getByText(new RegExp(`organization key ${customer.key}: add Huntress’s script`))).toBeVisible();
  await expect(next.getByText(/Give CloudAlly access to the customer’s Microsoft 365/)).toBeVisible();
  await expect(next.getByRole('link', { name: 'Open Atera', exact: true })).toHaveAttribute('href', 'https://app.atera.com/');
  await wizard.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(wizard).toHaveCount(0);
  await expect(open).toBeFocused();

  // The card lists the three records, and each stand-in got exactly one creation with what the preview said.
  for (const system of ['Atera', 'Huntress', 'CloudAlly']) await expect(linked.getByText(system, { exact: true })).toBeVisible();
  const links = await linksOf(page, customer.id);
  expect(links.map((l) => [l.system, l.method]).sort()).toEqual([['atera', 'Exported'], ['cloudally', 'Exported'], ['huntress', 'Exported']]);
  const huntress = await huntressOrganizations(page, customer.key);
  expect(huntress.map((o) => o.posted.created)).toEqual([{ name: customer.name, key: customer.key }]);
  expect(links.find((l) => l.system === 'huntress')!.externalId).toBe(String(huntress[0]!.id));
  const created = await cloudAllyCreations(page, email);
  expect(created).toHaveLength(1);
  expect(created[0]!.body).toMatchObject({ displayName: customer.name, region: 'EU', password: '[given]' });

  const contract = await contractOf(page, customer.contract.id);
  expect(contract.lines.filter((l) => l.isCurrent).map((l) => [l.quantityModel, l.quantity, l.productId]).sort()).toEqual([
    ['PerBackupSeat', 3, customer.seat.id], ['PerHuntressAgent', 5, customer.agent.id]]);
});

test('the contracts tab shows what Huntress and CloudAlly count against the lines, and what CloudAlly bills @critical', async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page, 'Crm.Admin');
  const customer = await linkedCloudAllyCustomer(page, 'Telle', { users: [{ name: 'kari', fullName: 'Kari Nordmann' }, { name: 'ola', fullName: 'Ola Nordmann' }] });
  await syncCustomer(page, customer, 6);
  await linkedHuntressOrganization(page, customer.organizationId, `${customer.marker} Vern AS`, 2);
  const { agent, seat } = await servicesProducts(page, customer.marker);
  const term = currentTerm();
  const contract = await api.post<{ id: string; number: string }>(page, '/api/v1/contracts', {
    organizationId: customer.organizationId, title: `${customer.marker} Drift`, type: 'Msp', startDate: term.start, endDate: term.end, autoRenew: false,
    renewalTermMonths: 0, noticePeriodDays: 30, invoiceFrequency: 'Monthly', invoiceTiming: 'InAdvance', indexation: false,
  });
  for (const [product, quantityModel] of [[agent, 'PerHuntressAgent'], [seat, 'PerBackupSeat']] as const) {
    await api.post(page, `/api/v1/contracts/${contract.id}/lines`, { productId: product.id, quantityModel, quantity: 1, validFrom: term.start });
  }
  await api.post(page, `/api/v1/contracts/${contract.id}/activate`);

  // Huntress's organization read stores the day's agents; CloudAlly's bill read the day's users per service.
  await syncUntil(page, ['huntress-organizations', 'cloudally-bills'], async () => {
    const services = await serviceQuantities(page, customer.organizationId);
    return services.find((s) => s.model === 'PerHuntressAgent')?.count === 2 && services.find((s) => s.model === 'PerBackupSeat')?.count === 2;
  }, `the counts of ${customer.name}`);

  await page.goto(`/organizations/${customer.organizationId}?tab=contracts`);
  const panel = page.getByRole('region', { name: 'Counted by the services', exact: true });
  const agents = panel.getByRole('listitem').filter({ hasText: 'Agents in Huntress' });
  await expect(agents).toContainText(`${agent.name} · contract ${contract.number}: the estimate is 1, the next basis bills 2`);
  await expect(agents).toContainText('Billed by the count');
  const users = panel.getByRole('listitem').filter({ hasText: 'Backup users in CloudAlly' });
  await expect(users).toContainText(`${seat.name} · contract ${contract.number}: the estimate is 1, the next basis bills 2`);
  // The customer has no Atera devices and no line bills them: the row says so without calling it unbilled.
  await expect(panel.getByRole('listitem').filter({ hasText: 'Devices in Atera' })).toContainText('Nothing to count');

  // The customer's one account is named above its bill; each row is a service with its users.
  await expect(panel.getByText(new RegExp(`^Bill of \\d{2}/\\d{2}/\\d{4} for the account ${customer.name}$`))).toBeVisible();
  const bill = panel.getByRole('table', { name: 'What CloudAlly bills', exact: true });
  await expect(bill.getByRole('row').filter({ hasText: 'Exchange' }).getByRole('cell').nth(1)).toHaveText('2');
  await expect(bill.getByRole('columnheader', { name: 'Total', exact: true })).toBeVisible();
});
