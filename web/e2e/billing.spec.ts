import { expect, test, type Page } from '@playwright/test';
import { api, candidatePeriods, createOrganization, DIALOG_RUNS_FROM_YEAR, marker, orgNumber, periodEnd, reserveBillingRun, signIn, toast, type BillingPeriod } from './support';

const monthName = (month: number) =>
  new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, month - 1, 1)));

/**
 * Creates a run from the dialog. The dialog's create is what claims the month (BR-BIL-01 allows one open run per period),
 * so when a parallel browser project or another run on the same database took the month first, the dialog reports it
 * and the next free month is tried. Nothing about the month is set up before the claim succeeds.
 */
async function createRunInDialog(page: Page, notes: string, candidates: AsyncGenerator<BillingPeriod>) {
  for await (const period of candidates) {
    await page.goto('/billing');
    await page.getByRole('button', { name: 'New run' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('spinbutton', { name: 'Year' }).fill(String(period.year));
    await dialog.getByRole('combobox', { name: 'Month' }).click();
    await page.getByRole('option', { name: new RegExp(`^${monthName(period.month)}`, 'i') }).click();
    await dialog.getByRole('textbox', { name: 'Note' }).fill(notes);
    await dialog.getByRole('button', { name: 'Create' }).click();
    const created = toast(page, /Run for .* created/);
    // BIL_PERIOD_BUSY, or the unique index when the other run was created in the same instant.
    const busy = dialog.getByText(/is already open|already exists/);
    await expect(created.or(busy)).toBeVisible();
    if (await created.isVisible()) {
      await expect(page).toHaveURL(/\/billing\/runs\//);
      return period;
    }
  }

  throw new Error('No free month left for a run created from the dialog.');
}

/** Triggers a recurring job in crm-worker; the effect shows up in the UI a moment later. */
async function trigger(page: import('@playwright/test').Page, jobId: string) {
  await api.post(page, `/api/v1/integrations/jobs/${jobId}/trigger`);
}

test('a monthly run is collected, approved and sent to PowerOffice', { tag: '@critical' }, async ({ page }) => {
  test.setTimeout(180_000);
  const m = marker('Fak');
  await signIn(page, 'Crm.Admin');

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

  // Finance starts the run; the dialog offers the period just gone, which this test overrides.
  await signIn(page, 'Crm.Finance');
  const period = await createRunInDialog(page, m, candidatePeriods(page, DIALOG_RUNS_FROM_YEAR));
  const runUrl = page.url();

  // The contract covers exactly the claimed month, so the run bills it and no other test's run bills this customer too.
  await signIn(page, 'Crm.Admin');
  const contract = await api.post<{ id: string }>(page, '/api/v1/contracts', {
    organizationId: organization.id, title: `${m} Drift`, type: 'Msp', startDate: period.start, endDate: periodEnd(period), autoRenew: false,
    renewalTermMonths: 0, noticePeriodDays: 30, invoiceFrequency: 'Monthly', invoiceTiming: 'InAdvance', indexation: false,
    customerReference: 'PO-9001',
  });
  await api.post(page, `/api/v1/contracts/${contract.id}/lines`, {
    productId: product.id, quantityModel: 'Fixed', quantity: 2, unitPrice: 5000, validFrom: period.start,
  });
  await api.post(page, `/api/v1/contracts/${contract.id}/activate`);
  await signIn(page, 'Crm.Finance');
  await page.goto(runUrl);

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
  // The run is created first: that claims its month before anything else depends on it.
  const run = await reserveBillingRun(page, m);
  const start = run.start;

  const organization = await createOrganization(page, { name: `${m} Uten kobling AS`, status: 'Customer' });
  const product = await api.post<{ id: string }>(page, '/api/v1/catalog/products', {
    sku: `${m}-SRV`, name: `${m} Service`, type: 'ManagedService', businessLine: 'Atera', unit: 'Piece',
    billingPeriod: 'Monthly', vatRate: 25, listPrice: 1500, unitCost: 500,
  });
  const contract = await api.post<{ id: string }>(page, '/api/v1/contracts', {
    organizationId: organization.id, title: `${m} Avtale`, type: 'Msp', startDate: start, endDate: periodEnd(run), autoRenew: false,
    renewalTermMonths: 0, noticePeriodDays: 30, invoiceFrequency: 'Monthly', invoiceTiming: 'InAdvance', indexation: false,
  });
  await api.post(page, `/api/v1/contracts/${contract.id}/lines`, {
    productId: product.id, quantityModel: 'Fixed', quantity: 1, unitPrice: 1500, validFrom: start,
  });
  await api.post(page, `/api/v1/contracts/${contract.id}/activate`);

  await signIn(page, 'Crm.Finance');
  await api.runCommand(page, run.id, 'collect');

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

test('a correction survives a new collect and a line left out stays out', async ({ page }) => {
  test.setTimeout(120_000);
  const m = marker('Kor');
  await signIn(page, 'Crm.Admin');
  const run = await reserveBillingRun(page, m);
  const organization = await createOrganization(page, { name: `${m} Korrigert AS`, status: 'Customer' });
  const product = (name: string, price: number) =>
    api.post<{ id: string }>(page, '/api/v1/catalog/products', {
      sku: `${m}-${name}`, name: `${m} ${name}`, type: 'ManagedService', businessLine: 'Atera', unit: 'Piece',
      billingPeriod: 'Monthly', vatRate: 25, listPrice: price, unitCost: price / 2,
    });
  const drift = await product('Drift', 1000);
  const backup = await product('Backup', 500);
  const contract = await api.post<{ id: string }>(page, '/api/v1/contracts', {
    organizationId: organization.id, title: `${m} Avtale`, type: 'Msp', startDate: run.start, endDate: periodEnd(run), autoRenew: false,
    renewalTermMonths: 0, noticePeriodDays: 30, invoiceFrequency: 'Monthly', invoiceTiming: 'InAdvance', indexation: false,
  });
  for (const [productId, unitPrice] of [[drift.id, 1000], [backup.id, 500]] as const) {
    await api.post(page, `/api/v1/contracts/${contract.id}/lines`, { productId, quantityModel: 'Fixed', quantity: 1, unitPrice, validFrom: run.start });
  }
  await api.post(page, `/api/v1/contracts/${contract.id}/activate`);

  await signIn(page, 'Crm.Finance');
  await api.runCommand(page, run.id, 'collect');
  const bases = await api.get<Array<{ id: string; organization: { id: string } }>>(page, `/api/v1/billing/runs/${run.id}/bases?search=${m}`);
  const basisId = bases.find((b) => b.organization.id === organization.id)!.id;
  await page.goto(`/billing/bases/${basisId}`);

  // A collected line is corrected only with a reason, and the reason stays on the line.
  const driftRow = page.getByRole('row').filter({ hasText: `${m} Drift` });
  await driftRow.getByRole('button', { name: /^Edit / }).click();
  const edit = page.getByRole('dialog');
  await expect(edit.getByRole('button', { name: 'Save' })).toBeDisabled();
  await edit.getByRole('textbox', { name: 'Unit price' }).fill('900');
  await edit.getByRole('textbox', { name: 'Reason' }).fill('Price agreed for the year');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(toast(page, 'Line saved')).toBeVisible();
  await expect(driftRow.getByText('Corrected: Price agreed for the year', { exact: false })).toBeVisible();

  // A collected line is left out instead of deleted, so the next collect cannot bring it back.
  const backupRow = page.getByRole('row').filter({ hasText: `${m} Backup` });
  await backupRow.getByRole('button', { name: /^Leave out / }).click();
  const exclude = page.getByRole('dialog');
  await exclude.getByRole('textbox', { name: 'Reason' }).fill('Included in the bundle this month');
  await exclude.getByRole('button', { name: 'Leave out' }).click();
  await expect(toast(page, 'The line is left out')).toBeVisible();

  await page.goto(`/billing/runs/${run.id}`);
  await page.getByRole('button', { name: 'Collect again', exact: true }).click();
  await expect(toast(page, 'The run was collected')).toBeVisible();
  await page.goto(`/billing/bases/${basisId}`);
  await expect(page.getByText('NOK 900.00').first()).toBeVisible();
  await expect(driftRow.getByText('Source: NOK 1,000.00')).toBeVisible();
  await expect(backupRow.getByText('Left out: Included in the bundle this month', { exact: false })).toBeVisible();
  await expect(backupRow.getByRole('button', { name: /^Include .* again$/ })).toBeVisible();
});

test('an approval belongs to the revision on screen and a change sets it aside with the reason', async ({ page }) => {
  test.setTimeout(120_000);
  const m = marker('God');
  await signIn(page, 'Crm.Admin');
  const run = await reserveBillingRun(page, m);
  const organization = await createOrganization(page, { name: `${m} Godkjenning AS`, status: 'Customer' });
  // Above the 200 000 threshold, so the run needs Finance and management (BR-BIL-04).
  const product = await api.post<{ id: string }>(page, '/api/v1/catalog/products', {
    sku: `${m}-PRJ`, name: `${m} Prosjekt`, type: 'ManagedService', businessLine: 'Atera', unit: 'Piece',
    billingPeriod: 'Monthly', vatRate: 25, listPrice: 250000, unitCost: 100000,
  });
  const contract = await api.post<{ id: string }>(page, '/api/v1/contracts', {
    organizationId: organization.id, title: `${m} Avtale`, type: 'Msp', startDate: run.start, endDate: periodEnd(run), autoRenew: false,
    renewalTermMonths: 0, noticePeriodDays: 30, invoiceFrequency: 'Monthly', invoiceTiming: 'InAdvance', indexation: false,
  });
  await api.post(page, `/api/v1/contracts/${contract.id}/lines`, { productId: product.id, quantityModel: 'Fixed', quantity: 1, unitPrice: 250000, validFrom: run.start });
  await api.post(page, `/api/v1/contracts/${contract.id}/activate`);

  await signIn(page, 'Crm.Finance');
  await api.runCommand(page, run.id, 'collect');
  await page.goto(`/billing/runs/${run.id}`);
  const approvals = page.getByRole('region', { name: 'Approvals' });
  await expect(approvals).toContainText('is waiting for approval');
  await expect(approvals).toContainText('two different people');

  // Finance approves; the run waits for somebody else, and Finance is not offered the other approval.
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(toast(page, 'Your approval is recorded')).toBeVisible();
  await expect(page.getByText('The other approval has to come from someone else.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  await expect(approvals.getByRole('listitem').filter({ hasText: 'Finance:' })).toBeVisible();

  // A line changes on the basis: the approval no longer counts, and the run page says why.
  const bases = await api.get<Array<{ id: string; organization: { id: string } }>>(page, `/api/v1/billing/runs/${run.id}/bases?search=${m}`);
  await page.goto(`/billing/bases/${bases.find((b) => b.organization.id === organization.id)!.id}`);
  await page.getByRole('button', { name: 'Add line' }).click();
  const lineDialog = page.getByRole('dialog');
  await lineDialog.getByRole('textbox', { name: 'Description' }).fill(`${m} Tillegg`);
  await lineDialog.getByRole('textbox', { name: 'Unit price' }).fill('1 000');
  await lineDialog.getByRole('button', { name: 'Create' }).click();
  await expect(toast(page, 'Line added')).toBeVisible();

  await page.goto(`/billing/runs/${run.id}`);
  await expect(page.getByText('Earlier approvals no longer count', { exact: false })).toBeVisible();
  await expect(approvals.getByRole('heading', { name: 'Set aside' })).toBeVisible();
  await expect(approvals.getByRole('listitem').filter({ hasText: 'Lines were changed afterwards.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
});

test('a billed and closed month gets a supplementary run that bills nothing twice', async ({ page }) => {
  // The export waits for the worker, which works the shared outbox of every parallel test in order: under load that can
  // take most of two minutes, so the test has room after it.
  test.setTimeout(300_000);
  const m = marker('Til');
  await signIn(page, 'Crm.Admin');
  const run = await reserveBillingRun(page, m);
  // Not linked to PowerOffice: the export fails at once, which is enough to close the run.
  const organization = await createOrganization(page, { name: `${m} Tillegg AS`, status: 'Customer' });
  const product = await api.post<{ id: string }>(page, '/api/v1/catalog/products', {
    sku: `${m}-SRV`, name: `${m} Drift`, type: 'ManagedService', businessLine: 'Atera', unit: 'Piece',
    billingPeriod: 'Monthly', vatRate: 25, listPrice: 1200, unitCost: 600,
  });
  const contract = await api.post<{ id: string }>(page, '/api/v1/contracts', {
    organizationId: organization.id, title: `${m} Avtale`, type: 'Msp', startDate: run.start, endDate: periodEnd(run), autoRenew: false,
    renewalTermMonths: 0, noticePeriodDays: 30, invoiceFrequency: 'Monthly', invoiceTiming: 'InAdvance', indexation: false,
  });
  await api.post(page, `/api/v1/contracts/${contract.id}/lines`, { productId: product.id, quantityModel: 'Fixed', quantity: 1, unitPrice: 1200, validFrom: run.start });
  await api.post(page, `/api/v1/contracts/${contract.id}/activate`);

  await signIn(page, 'Crm.Finance');
  await api.runCommand(page, run.id, 'collect');
  await api.runCommand(page, run.id, 'approve');
  await expect
    .poll(
      async () => {
        await signIn(page, 'Crm.Admin');
        await trigger(page, 'outbound-operations');
        return (await api.get<{ status: string }>(page, `/api/v1/billing/runs/${run.id}`)).status;
      },
      { timeout: 240_000, intervals: [2_000, 5_000, 10_000] },
    )
    .toMatch(/^Exported(WithErrors)?$/);
  await signIn(page, 'Crm.Finance');
  await api.post(page, `/api/v1/billing/runs/${run.id}/close`);

  // A second regular run of the closed month is refused with the way out; a supplementary run is created.
  await page.goto('/billing');
  await page.getByRole('button', { name: 'New run' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('spinbutton', { name: 'Year' }).fill(String(run.year));
  await dialog.getByRole('combobox', { name: 'Month' }).click();
  await page.getByRole('option', { name: new RegExp(`^${monthName(run.month)}`, 'i') }).click();
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog.getByText('This month is already billed and closed. Create a supplementary run', { exact: false })).toBeVisible();
  await dialog.getByRole('switch', { name: 'Supplementary run' }).click();
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(toast(page, /Run for .* created/)).toBeVisible();
  await expect(page.getByText('Supplementary', { exact: true }).first()).toBeVisible();

  // The month left with the first run; collecting the supplementary run does not bring it back.
  await page.getByRole('button', { name: 'Collect', exact: true }).click();
  await expect(toast(page, 'The run was collected')).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search customer' }).fill(m);
  await expect(page.getByRole('row').filter({ hasText: `${m} Tillegg AS` })).toHaveCount(0);
});
