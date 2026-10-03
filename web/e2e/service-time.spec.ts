import { expect, test } from '@playwright/test';
import { api, createOrganization, marker, signIn, toast } from './support';

test('a technician books hours and the service lead approves them', async ({ page }) => {
  test.setTimeout(120_000);
  const m = marker('Tid');
  await signIn(page, 'Crm.Finance');
  await api.post(page, '/api/v1/catalog/products', {
    sku: `${m}-HOUR`, name: `${m} Support hour`, type: 'HourlyService', businessLine: 'Consulting', unit: 'Hour', billingPeriod: 'OneTime',
    vatRate: 25, listPrice: 1150, unitCost: 500, ateraWorkType: 'Remote',
  });

  await signIn(page, 'Crm.Sales');
  await createOrganization(page, { name: `${m} Timer AS`, status: 'Customer' });

  // Technicians book their own hours; they cannot create customers.
  await signIn(page, 'Crm.Technician');
  await page.goto('/time');
  await page.getByRole('button', { name: 'Register hours' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Organization' }).pressSequentially(`${m} Timer`);
  await page.getByRole('option', { name: `${m} Timer AS` }).click();
  await dialog.getByRole('textbox', { name: 'Hours' }).fill('2,5');
  await dialog.getByRole('combobox', { name: 'Work type' }).fill('Remote');
  await dialog.getByRole('textbox', { name: 'Description' }).fill('Feilsøking av skriver');
  await dialog.getByRole('button', { name: 'Register hours' }).click();
  await expect(toast(page, 'Hours registered')).toBeVisible();
  await expect(page.getByText('Feilsøking av skriver').first()).toBeVisible();
  // The e2e database is reused, so only this entry is checked, not the week total.
  await expect(page.getByText('2.5 h', { exact: true }).first()).toBeVisible();

  // A technician sees their own hours but no money and no approval.
  await expect(page.getByRole('link', { name: 'Time entries' })).toBeHidden();

  await signIn(page, 'Crm.ServiceLead');
  await page.goto('/time/entries');
  const row = page.getByRole('row').filter({ hasText: `${m} Timer AS` });
  await expect(row).toBeVisible();
  await row.getByRole('checkbox').check();
  await page.getByRole('button', { name: /Approve \(1\)/ }).click();
  await expect(toast(page, '1 entries approved')).toBeVisible();
  await expect(row.getByText('By rate 2.5 h')).toBeVisible();

  // Finance sees the amount: 2.5 h at the catalog rate.
  await signIn(page, 'Crm.Finance');
  await page.goto('/time/entries');
  await expect(page.getByRole('row').filter({ hasText: `${m} Timer AS` }).getByText('NOK 2,875.00')).toBeVisible();
});

test('the service tab offers a ticket and reports that writing to Atera is off', async ({ page }) => {
  const m = marker('Srv');
  await signIn(page, 'Crm.Sales');
  const organization = await createOrganization(page, { name: `${m} Service AS`, status: 'Customer' });
  await api.post(page, `/api/v1/customers/organizations/${organization.id}/contacts`, {
    firstName: 'Kari', lastName: m, email: `kari.${m.toLowerCase()}@example.no`, roles: ['Technical'], isPrimary: true,
  });

  await page.goto(`/organizations/${organization.id}?tab=service`);
  await expect(page.getByText('Open tickets', { exact: true })).toBeVisible();
  await expect(page.getByText('No open tickets.')).toBeVisible();

  await page.getByRole('button', { name: 'New ticket' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Contact' }).click();
  await page.getByRole('option', { name: new RegExp(`Kari ${m}`) }).click();
  await dialog.getByRole('textbox', { name: 'Title' }).fill('Skriveren virker ikke');
  await dialog.getByRole('textbox', { name: 'Description' }).fill('Feilmelding ved utskrift');
  await dialog.getByRole('button', { name: 'Create in Atera' }).click();
  await expect(toast(page, 'The ticket is being created in Atera')).toBeVisible();

  // Atera is not connected in this environment, so the request is rejected and says why.
  await expect(page.getByText(/was not created/)).toBeVisible({ timeout: 30_000 });
});
