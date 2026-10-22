import { expect, test, type Page } from '@playwright/test';
import { ateraAlert, linkedAteraCustomer, searchAlerts, syncAlerts } from './atera';
import { api, createOrganization, marker, periodEnd, reserveBillingRun, signIn } from './support';

// Safari moves focus to a date, time or datetime-local field with a focus event and no focusin, and Fluent's modal handling
// (tabster) learns about focus only from focusin: a dialog that opened on such a field stayed aria-hidden, so VoiceOver did
// not read it and getByRole found nothing in WebKit. app/focusin.ts sends the missing focusin. These are the dialogs that
// open on a date field (22.10.2026); each is found by role as it opens, with that field focused. Tagged @critical, so the
// spec runs in Chromium, Firefox and WebKit.

/** The dialog `open` brings up is found by role, with its date field `field` focused; Escape closes it. */
async function opensOnDate(page: Page, open: () => Promise<void>, name: string, field: string) {
  await open();
  const dialog = page.getByRole('dialog', { name, exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel(field)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
}

test('the contract dialogs that ask for a date open on it', { tag: '@critical' }, async ({ page }) => {
  test.setTimeout(120_000);
  const m = marker('Day');
  await signIn(page, 'Crm.Admin');
  // The contract lives in a month this test claims, so no other test's billing run bills it.
  const run = await reserveBillingRun(page, m);
  const organization = await createOrganization(page, { name: `${m} Dato AS`, status: 'Customer' });
  const product = await api.post<{ id: string }>(page, '/api/v1/catalog/products', {
    sku: `${m}-MSP`, name: `${m} Drift`, type: 'ManagedService', businessLine: 'Atera', unit: 'Device', billingPeriod: 'Monthly', vatRate: 25, listPrice: 900,
  });
  const contract = await api.post<{ id: string; number: string }>(page, '/api/v1/contracts', {
    organizationId: organization.id, title: `${m} Drift`, type: 'Msp', startDate: run.start, endDate: periodEnd(run),
    autoRenew: false, renewalTermMonths: 0, noticePeriodDays: 30, invoiceFrequency: 'Monthly', invoiceTiming: 'InAdvance', indexation: false,
  });
  await api.post(page, `/api/v1/contracts/${contract.id}/lines`, { productId: product.id, quantityModel: 'Fixed', quantity: 2, unitPrice: 900, validFrom: run.start });
  await api.post(page, `/api/v1/contracts/${contract.id}/activate`);

  await page.goto(`/contracts/${contract.id}`);
  await expect(page.getByRole('heading', { level: 1, name: `${m} Drift` })).toBeVisible();
  const more = page.getByRole('button', { name: 'More actions', exact: true });
  const fromMenu = (item: string) => async () => {
    await more.click();
    await page.getByRole('menuitem', { name: item, exact: true }).click();
  };
  await opensOnDate(page, fromMenu('Give notice…'), `Give notice on ${contract.number}`, 'Notice received');
  await opensOnDate(page, fromMenu('End contract…'), `End ${contract.number}`, 'End date');

  const lineActions = page.getByRole('button', { name: `Actions for ${m} Drift`, exact: true });
  await opensOnDate(page, async () => {
    await lineActions.click();
    await page.getByRole('menuitem', { name: 'End line…', exact: true }).click();
  }, `End ${m} Drift`, 'End date');
});

test('hiding an alert from its side panel opens on the day', { tag: '@critical' }, async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page, 'Crm.Admin');
  const customer = await linkedAteraCustomer(page, 'Day');
  const m = customer.marker;
  await ateraAlert(page, customer, { Title: `${m} disk filling up`, Severity: 'Warning' });
  await syncAlerts(page, customer, 1);

  await page.goto('/alerts');
  await searchAlerts(page, m);
  await page.getByRole('button', { name: `${m} disk filling up`, exact: true }).click();
  const panel = page.getByRole('dialog', { name: `${m} disk filling up`, exact: true });
  // The panel has read the alert, so the dialog opens with it shown and starts on the day.
  const hide = panel.getByRole('region', { name: 'In Parasoll', exact: true }).getByRole('button', { name: 'Hide until…', exact: true });
  await opensOnDate(page, () => hide.click(), 'Hide the alert until a date', 'Hide until');
  await expect(panel).toBeVisible();
});
