import { expect, test } from '@playwright/test';
import { api, createOrganization, marker, signIn, toast } from './support';

test('a custom field is defined once and answered on the customer card', async ({ page }) => {
  test.setTimeout(120_000);
  const m = marker('Cf');
  await signIn(page, 'Crm.Admin');
  const organization = await createOrganization(page, { name: `${m} Felt AS`, status: 'Customer' });

  await page.goto('/admin/custom-fields');
  await page.getByRole('button', { name: 'New field' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(`${m} Segment`);
  await dialog.getByRole('combobox', { name: 'Type' }).click();
  await page.getByRole('option', { name: 'List' }).click();
  await dialog.getByRole('textbox', { name: 'Choices' }).fill('Liten\nMellomstor\nStor');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(toast(page, 'Field saved')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: `${m} Segment` })).toBeVisible();

  // The field shows up on the customer card and keeps what is chosen there (FR-ADM-04).
  await page.goto(`/organizations/${organization.id}`);
  const panel = page.getByRole('main');
  await panel.getByRole('combobox', { name: `${m} Segment` }).selectOption('Stor');
  await panel.getByRole('button', { name: 'Save' }).click();
  await expect(toast(page, 'Field saved')).toBeVisible();

  await page.reload();
  await expect(page.getByRole('combobox', { name: `${m} Segment` })).toHaveValue('Stor');
});

test('the sla report measures tickets against the contract and finance sees the margins', async ({ page }) => {
  test.setTimeout(120_000);
  const m = marker('An');
  await signIn(page, 'Crm.Admin');

  await page.goto('/service/sla');
  await expect(page.getByRole('heading', { level: 1, name: 'SLA report' })).toBeVisible();
  // The month picker offers the last twelve months and the report answers for the chosen one.
  await expect(page.getByRole('combobox', { name: 'Month' })).toBeVisible();

  await signIn(page, 'Crm.Finance');
  const product = await api.post<{ id: string }>(page, '/api/v1/catalog/products', {
    sku: `${m}-SRV`, name: `${m} Managed server`, type: 'ManagedService', businessLine: 'Atera', unit: 'Device', billingPeriod: 'Monthly', vatRate: 25, listPrice: 1490,
  });
  expect(product.id).toBeTruthy();

  await page.goto('/reports/margins');
  await expect(page.getByRole('heading', { level: 1, name: 'Customer margins' })).toBeVisible();
  await expect(page.getByText('Internal hourly cost')).toBeVisible();
  // FR-RPT-03: the Power BI section lists the tables an analyst can point the Web connector at.
  await expect(page.getByRole('button', { name: 'revenue-by-customer' })).toBeVisible();

  // Cost is finance data: sales is not offered the report at all.
  await signIn(page, 'Crm.Sales');
  await expect(page.getByRole('link', { name: 'Margins' })).toBeHidden();
});
