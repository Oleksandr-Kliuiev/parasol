import { expect, test, type Locator, type Page } from '@playwright/test';
import { ateraAlert, linkedAteraCustomer, searchAlerts, syncAlerts } from './atera';
import { api, createOrganization, marker, periodEnd, reserveBillingRun, signIn } from './support';

// Focus into and out of a dialog in every engine (22.10.2026). Safari moves focus to a date, time or datetime-local field with
// a focus event and no focusin, and Fluent's modal handling (tabster) learns about focus only from focusin: a dialog that
// opened on such a field stayed aria-hidden, so VoiceOver did not read it and getByRole found nothing in WebKit
// (app/focusin.ts sends the missing focusin). Escape from a field gave focus back to the dialog's button in Chromium only:
// Firefox and Safari send no blur for the removed field, and Safari does not focus a clicked button
// (shared/components/Dialog.tsx gives it back). These are the dialogs that open on a date field, and one that opens on a
// text field. Tagged @critical, so the spec runs in Chromium, Firefox and WebKit.

/**
 * The dialog `open` brings up is found by role with its field `field` focused, and Escape closes it with focus back on `back`,
 * the control the person opened it from.
 */
async function opensOn(page: Page, open: () => Promise<void>, name: string, field: string, back: Locator) {
  await open();
  const dialog = page.getByRole('dialog', { name, exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel(field)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(back).toBeFocused();
}

test('the contract dialogs open on their first field and Escape gives focus back to where they came from', { tag: '@critical' }, async ({ page }) => {
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
  await opensOn(page, fromMenu('Give notice…'), `Give notice on ${contract.number}`, 'Notice received', more);
  await opensOn(page, fromMenu('End contract…'), `End ${contract.number}`, 'End date', more);

  const lineActions = page.getByRole('button', { name: `Actions for ${m} Drift`, exact: true });
  await opensOn(page, async () => {
    await lineActions.click();
    await page.getByRole('menuitem', { name: 'End line…', exact: true }).click();
  }, `End ${m} Drift`, 'End date', lineActions);

  // A text field first, and the dialog opened from the keyboard.
  const newBank = page.getByRole('button', { name: 'New hour bank', exact: true });
  await opensOn(page, async () => {
    await newBank.focus();
    await page.keyboard.press('Enter');
  }, 'New hour bank', 'Name', newBank);
});

test('hiding an alert from its side panel opens on the day and Escape gives focus back to the panel', { tag: '@critical' }, async ({ page }) => {
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
  await opensOn(page, () => hide.click(), 'Hide the alert until a date', 'Hide until', hide);
  await expect(panel).toBeVisible();
});
