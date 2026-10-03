import { expect, test } from '@playwright/test';
import { api, createOrganization, freeBillingPeriod, marker, orgNumber, signIn, toast } from './support';

const monthName = (month: number) =>
  new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, month - 1, 1)));

/** Triggers a recurring job in crm-worker; the effect shows up in the UI a moment later. */
async function trigger(page: import('@playwright/test').Page, jobId: string) {
  await api.post(page, `/api/v1/integrations/jobs/${jobId}/trigger`);
}

test('a monthly run is collected, approved and sent to PowerOffice', async ({ page }) => {
  test.setTimeout(180_000);
  const m = marker('Fak');
  await signIn(page, 'Crm.Admin');
  const period = await freeBillingPeriod(page);
  const start = period.start;

  const organization = await createOrganization(page, { name: `${m} Faktura AS`, status: 'Customer', orgNumber: orgNumber() });
  // The customer and the product must exist in PowerOffice before an order can be sent (docs/05 §4.3).
  await api.post(page, '/api/v1/integrations/links', {
    system: 'poweroffice', externalType: 'Customer', externalId: `${Math.floor(Math.random() * 90_000) + 10_000}`, entityId: organization.id, entityType: 'Organization',
  });
  const product = await api.post<{ id: string }>(page, '/api/v1/catalog/products', {
    sku: `${m}-MSP`, name: `${m} Managed services`, type: 'ManagedService', businessLine: 'Atera', unit: 'Device',
    billingPeriod: 'Monthly', vatRate: 25, listPrice: 5000, unitCost: 2000,
  });
  await api.post(page, '/api/v1/integrations/links', {
    system: 'poweroffice', externalType: 'Product', externalId: `${Math.floor(Math.random() * 90_000) + 10_000}`, entityId: product.id, entityType: 'Product',
  });
  const contract = await api.post<{ id: string }>(page, '/api/v1/contracts', {
    organizationId: organization.id, title: `${m} Drift`, type: 'Msp', startDate: start, endDate: null, autoRenew: false,
    renewalTermMonths: 0, noticePeriodDays: 30, invoiceFrequency: 'Monthly', invoiceTiming: 'InAdvance', indexation: false,
    customerReference: 'PO-9001',
  });
  await api.post(page, `/api/v1/contracts/${contract.id}/lines`, {
    productId: product.id, quantityModel: 'Fixed', quantity: 2, unitPrice: 5000, validFrom: start,
  });
  await api.post(page, `/api/v1/contracts/${contract.id}/activate`);

  // Finance starts the run; the dialog offers the period just gone, which this test overrides.
  await signIn(page, 'Crm.Finance');
  await page.goto('/billing');
  await page.getByRole('button', { name: 'New run' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('spinbutton', { name: 'Year' }).fill(String(period.year));
  await dialog.getByRole('combobox', { name: 'Month' }).click();
  await page.getByRole('option', { name: new RegExp(`^${monthName(period.month)}`, 'i') }).click();
  await dialog.getByRole('textbox', { name: 'Note' }).fill(m);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(toast(page, /Run for .* created/)).toBeVisible();
  await expect(page).toHaveURL(/\/billing\/runs\//);
  const runUrl = page.url();

  await page.getByRole('button', { name: 'Collect', exact: true }).click();
  await expect(toast(page, 'The run was collected')).toBeVisible();

  const row = page.getByRole('row').filter({ hasText: `${m} Faktura AS` });
  await expect(row).toBeVisible();
  await expect(row.getByText('NOK 10,000.00')).toBeVisible();

  await row.getByRole('link', { name: `${m} Faktura AS` }).click();
  await expect(page.getByRole('heading', { level: 1, name: `${m} Faktura AS` })).toBeVisible();
  await expect(page.getByText(`${m} Managed services (`)).toBeVisible();
  await expect(page.getByText('Recurring services')).toBeVisible();

  // A one-off line is added by hand and priced without VAT (BR-BIL-02).
  await page.getByRole('button', { name: 'Add line' }).click();
  const lineDialog = page.getByRole('dialog');
  await lineDialog.getByRole('textbox', { name: 'Description' }).fill(`${m} Onboarding`);
  await lineDialog.getByRole('textbox', { name: 'Unit price' }).fill('2 500');
  await lineDialog.getByRole('button', { name: 'Create' }).click();
  await expect(toast(page, 'Line added')).toBeVisible();
  await expect(page.getByText('NOK 12,500.00').first()).toBeVisible();

  // Approval locks the basis and queues the export.
  await page.goBack();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(toast(page, 'The run is approved')).toBeVisible();
  await expect(page.getByText('Approved', { exact: true }).first()).toBeVisible();

  await signIn(page, 'Crm.Admin');
  await trigger(page, 'outbound-operations');

  await signIn(page, 'Crm.Finance');
  await page.goto(runUrl);
  // The worker sends the order within a minute; the page is polled until the customer shows the order status.
  const basisRow = page.getByRole('row').filter({ hasText: `${m} Faktura AS` });
  await expect(basisRow.getByText('Sent', { exact: true })).toBeVisible({ timeout: 90_000 });

  // PowerOffice invoices the order right away in the mock: 12 500 + 25 % MVA. Invoices are synced hourly, so the job is
  // triggered and the page reloaded until the mirror has caught up — the worker may be busy with other tests' work.
  let invoiceVisible = false;
  for (let attempt = 0; attempt < 4 && !invoiceVisible; attempt++) {
    await signIn(page, 'Crm.Admin');
    await trigger(page, 'poweroffice-invoices');
    await signIn(page, 'Crm.Finance');
    invoiceVisible = await expect
      .poll(
        async () => {
          await page.goto(`/organizations/${organization.id}?tab=invoices`);
          await page.waitForLoadState('networkidle');
          return page.getByText('NOK 15,625.00').first().isVisible();
        },
        { timeout: 30_000, intervals: [2_000, 3_000, 5_000] },
      )
      .toBeTruthy()
      .then(() => true)
      .catch(() => false);
  }

  expect(invoiceVisible, 'the invoice from PowerOffice reached the customer card').toBeTruthy();
  await expect(page.getByText('Sent', { exact: true }).first()).toBeVisible();

  await page.goto('/billing/invoices');
  await expect(page.getByRole('row').filter({ hasText: `${m} Faktura AS` })).toBeVisible();
});

test('a run without a PowerOffice customer reports the anomaly and can be cancelled', async ({ page }) => {
  test.setTimeout(120_000);
  const m = marker('Avv');
  await signIn(page, 'Crm.Admin');
  const period = await freeBillingPeriod(page);
  const start = period.start;

  const organization = await createOrganization(page, { name: `${m} Uten kobling AS`, status: 'Customer' });
  const product = await api.post<{ id: string }>(page, '/api/v1/catalog/products', {
    sku: `${m}-SRV`, name: `${m} Service`, type: 'ManagedService', businessLine: 'Atera', unit: 'Piece',
    billingPeriod: 'Monthly', vatRate: 25, listPrice: 1500, unitCost: 500,
  });
  const contract = await api.post<{ id: string }>(page, '/api/v1/contracts', {
    organizationId: organization.id, title: `${m} Avtale`, type: 'Msp', startDate: start, endDate: null, autoRenew: false,
    renewalTermMonths: 0, noticePeriodDays: 30, invoiceFrequency: 'Monthly', invoiceTiming: 'InAdvance', indexation: false,
  });
  await api.post(page, `/api/v1/contracts/${contract.id}/lines`, {
    productId: product.id, quantityModel: 'Fixed', quantity: 1, unitPrice: 1500, validFrom: start,
  });
  await api.post(page, `/api/v1/contracts/${contract.id}/activate`);

  await signIn(page, 'Crm.Finance');
  const run = await api.post<{ id: string }>(page, '/api/v1/billing/runs', { year: period.year, month: period.month, notes: m });
  await api.post(page, `/api/v1/billing/runs/${run.id}/collect`);

  await page.goto(`/billing/runs/${run.id}?anomalies=true`);
  const row = page.getByRole('row').filter({ hasText: `${m} Uten kobling AS` });
  await expect(row).toBeVisible();
  await expect(row.getByText('not linked to the accounting system', { exact: false })).toBeVisible();

  await row.getByRole('link', { name: `${m} Uten kobling AS` }).click();
  await expect(page).toHaveURL(/\/billing\/bases\//);
  await expect(page.getByRole('listitem').filter({ hasText: 'The customer is not linked to the accounting system' })).toBeVisible();

  await page.getByRole('button', { name: 'Cancel basis' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Reason' }).fill('Mangler i PowerOffice');
  await dialog.getByRole('button', { name: 'Cancel basis' }).click();
  await expect(toast(page, 'The basis is cancelled')).toBeVisible();
  await expect(page.getByText('Cancelled', { exact: true }).first()).toBeVisible();
});
