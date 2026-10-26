import { expect, test, type Page } from '@playwright/test';
import { api, createOrganization, marker, signIn, toast } from './support';

/** The company's own date, the way the CRM computes it. */
function today(offsetDays = 0) {
  const oslo = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Oslo' }));
  oslo.setDate(oslo.getDate() + offsetDays);
  return `${oslo.getFullYear()}-${String(oslo.getMonth() + 1).padStart(2, '0')}-${String(oslo.getDate()).padStart(2, '0')}`;
}

/**
 * Ends a contract the test made. The dashboard lists the twenty live contracts that end first and the e2e database keeps
 * every run's contracts, so a contract left live takes a place in that list from the runs that follow. The answer is not
 * checked: a contract that never became active cannot be ended and is in no list, and a failed clean-up must not hide why
 * the test failed.
 */
function endContract(page: Page, contractId: string) {
  return page.request.post(`/api/v1/contracts/${contractId}/end`, { data: {}, headers: { 'X-CSRF': '1' } });
}

test('the dashboard adds up contracts, renewals and hours', async ({ page }) => {
  test.setTimeout(120_000);
  const m = marker('Dash');
  await signIn(page, 'Crm.Admin');
  const organization = await createOrganization(page, { name: `${m} Dashbord AS`, status: 'Customer' });
  const product = await api.post<{ id: string }>(page, '/api/v1/catalog/products', {
    sku: `${m}-MSP`, name: `${m} Drift`, type: 'ManagedService', businessLine: 'Atera', unit: 'Device',
    billingPeriod: 'Monthly', vatRate: 25, listPrice: 2500, unitCost: 1000,
  });
  // The renewal list holds the twenty contracts that end first, and of those that end on the same day the ones made first.
  // Ending today, this contract comes before every contract that ends later: only live contracts that end today and were
  // made before it can push it out of the list.
  const contract = await api.post<{ id: string; number: string }>(page, '/api/v1/contracts', {
    organizationId: organization.id, title: `${m} Drift`, type: 'Msp', startDate: today(-30), endDate: today(),
    autoRenew: false, renewalTermMonths: 0, noticePeriodDays: 0, invoiceFrequency: 'Monthly', invoiceTiming: 'InAdvance', indexation: false,
  });
  try {
    await api.post(page, `/api/v1/contracts/${contract.id}/lines`, {
      productId: product.id, quantityModel: 'Fixed', quantity: 4, unitPrice: 2500, validFrom: today(-30),
    });
    await api.post(page, `/api/v1/contracts/${contract.id}/activate`);

    await signIn(page, 'Crm.Management');
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    // 4 × 2 500 of this contract is part of the monthly recurring revenue.
    await expect(page.getByText(/Monthly recurring revenue/)).toBeVisible();
    // The bars are drawn for the eye only; screen readers read the same months from the table the chart carries.
    await expect(page.getByRole('table', { name: 'Invoiced amount per month, excluding VAT' })).toBeAttached();

    const renewalRow = page.getByRole('row').filter({ hasText: contract.number });
    await expect(renewalRow).toBeVisible();
    await expect(renewalRow.getByText(`${m} Dashbord AS`)).toBeVisible();
    await renewalRow.getByRole('link', { name: contract.number }).click();
    await expect(page.getByRole('heading', { level: 1, name: `${m} Drift` })).toBeVisible();
  } finally {
    // Admin or Management is signed in here, and both may end contracts.
    await endContract(page, contract.id);
  }

  // A technician has no dashboard.
  await signIn(page, 'Crm.Technician');
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Dashboard' })).toBeHidden();
});

test('a contract reminder reaches the bell and can be muted', async ({ page }) => {
  test.setTimeout(180_000);
  const m = marker('Vars');
  await signIn(page, 'Crm.Sales', '/');
  const ownerId = (await api.get<{ id: string }>(page, '/bff/user')).id;
  const organization = await createOrganization(page, { name: `${m} Varsel AS`, status: 'Customer' });
  const contract = await api.post<{ id: string; number: string }>(page, '/api/v1/contracts', {
    organizationId: organization.id, title: `${m} Drift`, type: 'Msp', startDate: today(-365), endDate: today(25),
    autoRenew: false, renewalTermMonths: 0, noticePeriodDays: 30, invoiceFrequency: 'Monthly', invoiceTiming: 'InAdvance',
    indexation: false, ownerId,
  });
  try {
    await api.post(page, `/api/v1/contracts/${contract.id}/activate`);

    // The nightly lifecycle job creates the 30-day reminder, and notifications turn it into a notice.
    await signIn(page, 'Crm.Admin');
    await api.post(page, '/api/v1/integrations/jobs/contract-lifecycle/trigger');

    await signIn(page, 'Crm.Sales');
    await expect
      .poll(
        async () => {
          await page.goto('/notifications');
          await page.waitForLoadState('networkidle');
          return page.getByText(`Contract ${contract.number} for ${m} Varsel AS ends`).first().isVisible();
        },
        { timeout: 90_000, intervals: [3_000, 5_000] },
      )
      .toBeTruthy();

    // The bell counts it, and reading it clears the count.
    const bell = page.getByRole('button', { name: /^Notifications, \d+ unread$/ });
    await expect(bell).toBeVisible();
    await bell.click();
    await expect(page.getByText(`Contract ${contract.number}`).first()).toBeVisible();
    await page.keyboard.press('Escape');

    // The development user keeps their settings between runs, so the test starts from a known state.
    await api.put(page, '/api/v1/notifications/preferences', { emailEnabled: true, digestHour: 7, mutedKinds: [] });
    await page.reload();

    const row = page.getByRole('listitem').filter({ hasText: `Contract ${contract.number}` });
    await row.getByRole('button', { name: /Mark as read/ }).click();
    await expect(row.getByText('New', { exact: true })).toBeHidden();

    // Muting a kind is remembered and the digest leaves it out.
    const contractsEnding = page.getByRole('checkbox', { name: 'Contracts ending' });
    await contractsEnding.uncheck();
    await expect(contractsEnding).not.toBeChecked();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(toast(page, 'Your notification settings are saved')).toBeVisible();
    // Read it back from the API: other specs sign in as the same development user, so the stored value is what matters.
    const preferences = await api.get<{ mutedKinds: string[] }>(page, '/api/v1/notifications/preferences');
    expect(preferences.mutedKinds).toContain('ContractEnding');
  } finally {
    // Left live, it would be among the first renewals on the dashboard in 25 days. Sales and Admin may both end contracts.
    await endContract(page, contract.id);
  }
});
