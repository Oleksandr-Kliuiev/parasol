import { expect, test } from '@playwright/test';
import { createOrganization, formatOrgNumber, marker, orgNumber, signIn, toast } from './support';

test('sales creates an organization from the registry, adds a contact, edits it and sees the history', async ({ page }) => {
  const number = orgNumber();
  const name = `TESTFIRMA ${number} AS`;
  await signIn(page, 'Crm.Sales', '/organizations');

  await page.getByRole('button', { name: 'New organization' }).click();
  await page.getByRole('textbox', { name: 'Name or organization number' }).fill(number);
  await page.getByRole('listitem').filter({ hasText: name }).getByRole('button', { name: 'Use' }).click();
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(name);
  await expect(page.getByRole('textbox', { name: 'Organization number', exact: true })).toHaveValue(formatOrgNumber(number));
  await page.getByRole('button', { name: 'Create' }).click();

  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  await expect(toast(page, 'Organization created')).toBeVisible();

  await page.getByRole('tab', { name: 'Contacts' }).click();
  await page.getByRole('button', { name: 'Add contact' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'First name' }).fill('Kari');
  await dialog.getByRole('textbox', { name: 'Last name' }).fill('Nordmann');
  await dialog.getByRole('textbox', { name: 'E-mail' }).fill(`kari.${number}@example.no`);
  await dialog.getByRole('checkbox', { name: 'Technical' }).check();
  await dialog.getByRole('checkbox', { name: 'Primary contact for the organization' }).check();
  await dialog.getByRole('button', { name: 'Add contact' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Kari Nordmann' })).toBeVisible();

  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('textbox', { name: 'Phone', exact: true }).fill('22 33 44 55');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(toast(page, 'Changes saved')).toBeVisible();
  await expect(page.getByRole('link', { name: '22 33 44 55' })).toBeVisible();

  await page.getByRole('tab', { name: 'History' }).click();
  await expect(page.getByText('Dev Sales').first()).toBeVisible();
  await expect(page.getByText('changed', { exact: true })).toBeVisible();
});

test('the registry warns about a bankrupt company', async ({ page }) => {
  await signIn(page, 'Crm.Sales', '/organizations/new');
  await page.getByRole('textbox', { name: 'Name or organization number' }).fill('912345675');
  await page.getByRole('listitem').filter({ hasText: 'NORDLYS DRIFT AS' }).getByRole('button', { name: 'Use' }).click();
  await expect(page.getByText('The registry reports this entity as: Bankrupt')).toBeVisible();
});

test('a technician can read organizations and manage contacts but not edit the organization', async ({ page }) => {
  const name = `${marker('Tech')} AS`;
  await signIn(page, 'Crm.Sales');
  const organization = await createOrganization(page, { name });

  await signIn(page, 'Crm.Technician', '/organizations');
  await expect(page.getByRole('heading', { level: 1, name: 'Organizations' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New organization' })).toHaveCount(0);

  await page.goto(`/organizations/${organization.id}?tab=contacts`);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add contact' })).toBeVisible();
});
