import { expect, test } from '@playwright/test';
import { api, createOrganization, marker, orgNumber, periodEnd, reserveBillingRun, signIn, toast } from './support';

const HEADER = 'orgnr;period;currency;group;productCode;quantity;amountExVat;externalRef';
const STATEMENT = 'I have compared the independent figures with the CRM run, and every difference has an owner and an explanation.';

test('Finance compares the independent figures with a run, explains the difference and signs', async ({ page }) => {
  test.setTimeout(180_000);
  const m = marker('Pil');
  await signIn(page, 'Crm.Admin');
  // The run is created first: that claims its month before anything depends on it.
  const run = await reserveBillingRun(page, m);
  const number = orgNumber();
  const organization = await createOrganization(page, { name: `${m} Pilot AS`, status: 'Customer', orgNumber: number });
  const product = await api.post<{ id: string }>(page, '/api/v1/catalog/products', {
    sku: `${m}-MSP`, name: `${m} Managed services`, type: 'ManagedService', businessLine: 'Atera', unit: 'Piece',
    billingPeriod: 'Monthly', vatRate: 25, listPrice: 750, unitCost: 300,
  });
  const contract = await api.post<{ id: string }>(page, '/api/v1/contracts', {
    organizationId: organization.id, title: `${m} Avtale`, type: 'Msp', startDate: run.start, endDate: periodEnd(run), autoRenew: false,
    renewalTermMonths: 0, noticePeriodDays: 30, invoiceFrequency: 'Monthly', invoiceTiming: 'InAdvance', indexation: false,
  });
  await api.post(page, `/api/v1/contracts/${contract.id}/lines`, { productId: product.id, quantityModel: 'Fixed', quantity: 2, unitPrice: 750, validFrom: run.start });
  await api.post(page, `/api/v1/contracts/${contract.id}/activate`);

  await signIn(page, 'Crm.Finance');
  await api.runCommand(page, run.id, 'collect');

  // The way in is the run page.
  await page.goto(`/billing/runs/${run.id}`);
  await page.getByRole('button', { name: 'Pilot reconciliation' }).click();
  await expect(page).toHaveURL(new RegExp(`/billing/runs/${run.id}/pilot$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Pilot reconciliation' })).toBeVisible();

  // Readiness: the answer comes from crm-web, and what only the worker knows is shown as unknown.
  const readiness = page.getByRole('region', { name: 'Readiness for a parallel run' });
  await expect(readiness.getByRole('status')).toContainText(/(Safe|Not safe) for a parallel run/);
  const credentials = readiness.getByRole('row').filter({ hasText: 'PowerOffice credentials' });
  await expect(credentials).toContainText('Unknown');
  await expect(readiness.getByText(/Provider keys and the worker's own settings live in crm-worker only/)).toBeVisible();

  // The trace shows the customer's line; narrowing by payer keeps the shared database's other lines out of the way.
  const trace = page.getByRole('region', { name: 'Trace of the run' });
  await trace.getByRole('combobox', { name: 'Payer' }).selectOption({ label: `${m} Pilot AS` });
  const line = trace.getByRole('row').filter({ hasText: `${m} Managed services` });
  await expect(line).toBeVisible();
  await expect(line).toContainText(number);
  await expect(trace.getByText(/^Showing 1 of 1$/)).toBeVisible();
  await expect(trace.getByRole('region', { name: 'Lines of the run' })).toHaveAttribute('tabindex', '0');
  const downloading = page.waitForEvent('download');
  await trace.getByRole('button', { name: 'Export to Excel' }).click();
  expect((await downloading).suggestedFilename()).toMatch(/\.xlsx$/);

  // The independent figures say 1 400 where the CRM bills 2 × 750.
  const compare = page.getByRole('region', { name: 'Compare with the independent calculation' });
  await expect(compare.getByText(HEADER)).toBeVisible();
  await compare.getByRole('textbox', { name: 'Or paste the rows' }).fill(`${HEADER}\n${number};${run.start.slice(0, 7)};NOK;Subscription;;;1400;PO-${m}`);
  await compare.getByRole('button', { name: 'Compare' }).click();

  const result = page.getByRole('region', { name: 'Result of the comparison' });
  await expect(result).toBeVisible();
  const key = result.getByRole('table', { name: 'Keys' }).getByRole('row').filter({ hasText: number });
  await expect(key).toContainText('Different');
  await expect(key).toContainText('The amounts differ.');
  await expect(result.getByText('Comparison id')).toBeVisible();
  await expect(result.getByRole('table', { name: 'Totals per currency' })).toBeVisible();
  await expect(result.getByRole('table', { name: 'Per payer' })).toContainText(number);

  // The sign-off: nothing is prefilled, the signer is the signed-in user, and every exception needs an explanation and an owner.
  const form = page.getByRole('region', { name: 'Finance sign-off' });
  await expect(form.getByText(/You sign as .+, the user you are signed in as/)).toBeVisible();
  const submit = form.getByRole('button', { name: 'Sign' });
  await expect(submit).toBeDisabled();
  // Other payers of the shared run, if any, are exceptions too ("missing in file"): every one is explained.
  const explanations = form.getByRole('textbox', { name: /^Explanation / });
  const owners = form.getByRole('combobox', { name: /^Owner / });
  const exceptions = await explanations.count();
  expect(exceptions).toBeGreaterThanOrEqual(1);
  for (let i = 0; i < exceptions; i++) {
    await explanations.nth(i).fill('The old sheet rounded the price down; Finance follows the contract.');
    await owners.nth(i).selectOption('Crm.Finance');
  }

  await form.getByRole('textbox', { name: /^Fallback process/ }).fill('Invoice the month with the old method and correct next month.');
  await expect(submit).toBeDisabled(); // not confirmed yet
  await form.getByRole('checkbox', { name: STATEMENT }).check();
  await expect(submit).toBeEnabled();
  await submit.click();

  await expect(toast(page, 'Signed')).toBeVisible();
  await expect(page.getByText(/^(You signed at|Signed by .+ at) /)).toBeVisible();
  await expect(form).toBeHidden();

  // The history lists the comparison and the sign-off (metadata only); it is still there after a reload.
  await page.reload();
  const history = page.getByRole('region', { name: 'Comparisons and sign-offs' });
  await expect(history.getByRole('table', { name: 'Comparisons' }).getByRole('row')).toHaveCount(2);
  await expect(history.getByRole('table', { name: 'Sign-offs', exact: true }).getByRole('row')).toHaveCount(2);
  await expect(history.getByText('Current').first()).toBeVisible();

  // Process figures for Finance, with what cannot be measured listed and explained.
  const kpi = page.getByRole('region', { name: 'Process figures', exact: true });
  await expect(kpi.getByRole('list', { name: 'Not measured' })).toContainText('Missed renewals');
});

test('Sales has no pilot button and cannot compare', async ({ page }) => {
  const m = marker('PilS');
  await signIn(page, 'Crm.Admin');
  const run = await reserveBillingRun(page, m);
  await signIn(page, 'Crm.Finance');
  await api.runCommand(page, run.id, 'collect');

  await signIn(page, 'Crm.Sales');
  await page.goto(`/billing/runs/${run.id}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pilot reconciliation' })).toHaveCount(0);

  // Reading is allowed, comparing is not.
  await page.goto(`/billing/runs/${run.id}/pilot`);
  await expect(page.getByRole('heading', { level: 1, name: 'Pilot reconciliation' })).toBeVisible();
  await expect(page.getByText(/Comparing and signing need the reconciliation permission/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Compare', exact: true })).toHaveCount(0);
  const refused = await page.request.post(`/api/v1/billing/runs/${run.id}/pilot/compare`, {
    data: `${HEADER}\n`, headers: { 'X-CSRF': '1', 'Content-Type': 'text/csv' },
  });
  expect(refused.status()).toBe(403);
});
