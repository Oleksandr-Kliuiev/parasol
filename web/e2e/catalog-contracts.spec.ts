import { expect, test } from '@playwright/test';
import { api, createOrganization, marker, signIn, toast } from './support';

test('finance adds a product and prices it in a price list', async ({ page }) => {
  const m = marker('Cat');
  await signIn(page, 'Crm.Finance', '/catalog');
  // A category per run: active price lists of the same category may not overlap, and the e2e database is reused.
  const category = await api.post<{ code: string; name: string }>(page, '/api/v1/catalog/categories', { code: m, name: `${m} customers`, licenseMarkupPct: 10, isDefault: false });

  await page.getByRole('button', { name: 'New product' }).click();
  await page.getByRole('textbox', { name: 'SKU' }).fill(`${m}-WS`);
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(`${m} Managed workstation`);
  await page.getByRole('textbox', { name: 'List price' }).fill('450');
  await page.getByRole('textbox', { name: 'Cost' }).fill('180');
  await page.getByRole('button', { name: 'Create' }).click();

  await expect(toast(page, 'Product created')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: `${m} Managed workstation` })).toBeVisible();
  await expect(page.getByText('60 %')).toBeVisible();
  await expect(page.getByText(/Not linked to a PowerOffice product yet/)).toBeVisible();

  await page.getByRole('link', { name: 'Catalog' }).first().click();
  await page.getByRole('tab', { name: 'Price lists' }).click();
  await page.getByRole('button', { name: 'New price list' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Name' }).fill(`${m} 2026`);
  await dialog.getByRole('combobox', { name: 'Customer category' }).click();
  await page.getByRole('option', { name: category.name }).click();
  await dialog.getByRole('button', { name: 'Create' }).click();

  await expect(page.getByRole('heading', { level: 1, name: `${m} 2026` })).toBeVisible();
  await page.getByRole('button', { name: 'Add price' }).click();
  const priceDialog = page.getByRole('dialog');
  await priceDialog.getByRole('combobox', { name: 'Product' }).pressSequentially(`${m}-WS`);
  await page.getByRole('option', { name: new RegExp(`${m}-WS`, 'i') }).click();
  await priceDialog.getByRole('textbox', { name: 'Price' }).fill('425');
  await priceDialog.getByRole('button', { name: 'Save' }).click();
  await expect(toast(page, 'Price saved')).toBeVisible();

  const row = page.getByRole('row').filter({ hasText: `${m} Managed workstation` });
  await expect(row.getByText('NOK 425.00')).toBeVisible();
  await expect(row.getByText('57.6 %')).toBeVisible();
  await page.getByRole('button', { name: 'Activate' }).click();
  await expect(toast(page, 'Price list activated')).toBeVisible();
  await expect(page.getByText('Active', { exact: true })).toBeVisible();
});

test('sales sets up a contract, gives notice and warns on a low hour bank', async ({ page }) => {
  test.setTimeout(120_000);
  const m = marker('Con');
  await signIn(page, 'Crm.Finance');
  const product = await api.post<{ id: string }>(page, '/api/v1/catalog/products', {
    sku: `${m}-SRV`, name: `${m} Managed server`, type: 'ManagedService', businessLine: 'Atera', unit: 'Device', billingPeriod: 'Monthly', vatRate: 25, listPrice: 1490,
  });
  expect(product.id).toBeTruthy();

  await signIn(page, 'Crm.Sales');
  const me = await api.get<{ id: string; displayName: string }>(page, '/bff/user');
  const organization = await createOrganization(page, { name: `${m} Kontrakt AS`, status: 'Customer', accountManagerId: me.id });

  await page.goto(`/organizations/${organization.id}?tab=contracts`);
  await expect(page.getByText('This organization has no contracts.')).toBeVisible();
  await page.getByRole('button', { name: 'New contract' }).click();
  await expect(page.getByRole('combobox', { name: 'Organization', exact: true })).toHaveValue(`${m} Kontrakt AS`);
  await expect(page.getByRole('combobox', { name: 'Responsible' })).toHaveValue(me.displayName);
  await page.getByRole('textbox', { name: 'Title' }).fill('Driftsavtale');
  await page.getByRole('textbox', { name: 'Start date' }).fill('2026-01-01');
  await page.getByRole('textbox', { name: 'End date' }).fill('2027-12-31');
  await page.getByRole('button', { name: 'Create' }).click();

  await expect(toast(page, /Contract K-\d{4}-\d{4} created as a draft/)).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Driftsavtale' })).toBeVisible();
  await expect(page.getByText('Draft', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Add line' }).click();
  const lineDialog = page.getByRole('dialog');
  await lineDialog.getByRole('combobox', { name: 'Product' }).pressSequentially(`${m}-SRV`);
  await page.getByRole('option', { name: new RegExp(`${m}-SRV`, 'i') }).click();
  await lineDialog.getByRole('textbox', { name: 'Quantity' }).fill('2');
  await lineDialog.getByRole('button', { name: 'Add line' }).click();
  await expect(toast(page, 'Line added')).toBeVisible();
  const line = page.getByRole('row').filter({ hasText: `${m} Managed server` });
  await expect(line.getByText('NOK 2,980.00')).toBeVisible();
  await expect(line.getByText('List price')).toBeVisible();
  await expect(page.getByText('NOK 2,980.00').first()).toBeVisible();

  await page.getByRole('button', { name: 'Activate' }).click();
  await expect(toast(page, 'Contract activated')).toBeVisible();
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Give notice…' }).click();
  const notice = page.getByRole('dialog');
  await notice.getByRole('textbox', { name: 'Notice received' }).fill('2027-11-15');
  await expect(notice.getByText(/can end on 13\/02\/2028 at the earliest/)).toBeVisible();
  await notice.getByRole('textbox', { name: 'End date' }).fill('2028-02-29');
  await notice.getByRole('button', { name: 'Give notice' }).click();
  await expect(toast(page, 'Notice registered')).toBeVisible();
  await expect(page.getByText('Notice given', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Withdraw notice' }).click();
  await expect(toast(page, 'Notice withdrawn')).toBeVisible();

  await page.getByRole('button', { name: 'New hour bank' }).click();
  const bankDialog = page.getByRole('dialog');
  await bankDialog.getByRole('textbox', { name: 'Name' }).fill(`${m} klippekort`);
  await bankDialog.getByRole('button', { name: 'Create' }).click();
  await expect(toast(page, 'Hour bank created')).toBeVisible();
  await page.getByRole('link', { name: `${m} klippekort` }).click();

  await page.getByRole('button', { name: 'Register hours' }).click();
  const entry = page.getByRole('dialog');
  await entry.getByRole('textbox', { name: 'Hours' }).fill('16,5');
  await entry.getByRole('textbox', { name: 'Description' }).fill('Serverbytte');
  await entry.getByRole('button', { name: 'Save' }).click();
  await expect(toast(page, 'Hours registered')).toBeVisible();
  await expect(page.getByText('3.5 h', { exact: true })).toBeVisible();
  await expect(page.getByText('Low balance')).toBeVisible();

  // crm-worker turns the HourBankLow event into a reminder for the contract owner.
  await expect(async () => {
    await page.goto('/');
    await expect(page.getByRole('link', { name: `Low hour bank: ${m} klippekort` })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 45_000 });
  await page.getByRole('button', { name: `Mark ${m} klippekort as done` }).click();
  await expect(page.getByRole('link', { name: `Low hour bank: ${m} klippekort` })).toBeHidden();
});

test('the microsoft price sheet prices a draft price list after a preview', async ({ page }) => {
  const m = marker('Sheet');
  await signIn(page, 'Crm.Finance', '/catalog');
  const category = await api.post<{ code: string; name: string }>(page, '/api/v1/catalog/categories', {
    code: m, name: `${m} customers`, licenseMarkupPct: 15, isDefault: false,
  });
  const offerId = `CFQ7${m}:0001`;
  await api.post(page, '/api/v1/catalog/products', {
    sku: `${m}-M365`, name: `${m} Microsoft 365 Business Premium`, type: 'MicrosoftLicense', businessLine: 'Microsoft',
    unit: 'User', billingPeriod: 'Monthly', vatRate: 25, listPrice: 0, microsoftOfferId: offerId, commitmentTerm: 'P1Y',
  });
  const list = await api.post<{ id: string }>(page, '/api/v1/catalog/price-lists', {
    name: `${m} NCE`, customerCategory: category.code, validFrom: '2026-01-01', currency: 'NOK',
  });

  const csv = [
    'ProductTitle,ProductId,SkuId,SkuTitle,TermDuration,BillingPlan,Currency,UnitPrice',
    `${m} Microsoft 365 Business Premium,CFQ7${m},0001,Business Premium,P1Y,Annual,USD,264.00`,
    `${m} Microsoft 365 Business Premium,CFQ7${m},0001,Business Premium,P1M,Monthly,USD,26.40`,
  ].join('\n');

  await page.goto(`/catalog/price-lists/${list.id}`);
  await page.getByRole('button', { name: 'Import price sheet' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Exchange rate' }).fill('10.5');
  await dialog.getByRole('textbox', { name: 'Or paste the rows' }).fill(csv);
  await dialog.getByRole('button', { name: 'Preview' }).click();

  // The product is sold on a yearly commitment, so the annual row is used: 264 × 10.5 × 1.15 = 3188.
  await expect(dialog.getByText('1 products matched, 1 prices change, 0 offers without a product. Markup 15 %.')).toBeVisible();
  await expect(dialog.getByText('NOK 3,188.00')).toBeVisible();

  await dialog.getByRole('button', { name: 'Apply prices' }).click();
  await expect(toast(page, '1 of 1 prices updated.')).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: `${m} Microsoft 365 Business Premium` });
  await expect(row.getByText('NOK 3,188.00')).toBeVisible();
});
