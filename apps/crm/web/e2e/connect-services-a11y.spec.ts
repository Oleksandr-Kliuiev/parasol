import { expect, test, type Page } from '@playwright/test';
import { fitsWidth, seriousViolations, settled, widths } from './atera';
import { linkedCloudAllyCustomer, syncCustomer } from './cloudally';
import { currentTerm, serviceQuantities, servicesProducts, syncUntil, type Product } from './onboarding';
import { api, signIn } from './support';

// M43: the "Connect services" wizard and the counts on the contracts tab at desktop, tablet and phone widths, in the theme of the
// project (desktop: light, desktop-dark: dark), against axe's WCAG 2.2 AA rules and with the keyboard alone. The customer is backed up
// in CloudAlly already, so the wizard shows a linked service beside the ones it offers to create, and the counts show CloudAlly's bill.

/** Steps through the wizard to its confirmation, with a Huntress line on the contract and the Atera line left out. */
async function toConfirmation(page: Page, agent: Product, check: (step: string) => Promise<void>) {
  const wizard = page.getByRole('dialog', { name: 'Connect the customer to the services', exact: true });
  await expect(wizard.getByText('Step 1 of 4: Services', { exact: true })).toBeFocused();
  await expect(wizard.getByText('Linked', { exact: true })).toBeVisible();
  await check('services');
  await wizard.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(wizard.getByText('Step 2 of 4: Contract', { exact: true })).toBeFocused();
  await wizard.getByRole('checkbox', { name: 'Bill per Atera device', exact: true }).uncheck();
  const line = wizard.getByRole('group', { name: 'Per Huntress agent', exact: true });
  await line.getByRole('combobox', { name: /^Product/ }).pressSequentially(agent.sku);
  await page.getByRole('option', { name: new RegExp(agent.sku, 'i') }).click();
  await check('contract');
  await wizard.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(wizard.getByText('Step 3 of 4: Confirm', { exact: true })).toBeFocused();
  await expect(wizard.getByText(/^Huntress gets the organization /)).toBeVisible();
  await check('confirm');
  return wizard;
}

test('the "Connect services" wizard and the counts pass axe at every width and work from the keyboard', async ({ page }, testInfo) => {
  test.setTimeout(360_000);
  const scheme = testInfo.project.use.colorScheme ?? 'light';
  await signIn(page, 'Crm.Admin');
  const customer = await linkedCloudAllyCustomer(page, 'KobA', { users: [{ name: 'kari', fullName: 'Kari Nordmann' }, { name: 'ola', fullName: 'Ola Nordmann' }] });
  await syncCustomer(page, customer, 6);
  const { agent, seat } = await servicesProducts(page, customer.marker);
  const term = currentTerm();
  const contract = await api.post<{ id: string }>(page, '/api/v1/contracts', {
    organizationId: customer.organizationId, title: `${customer.marker} Drift`, type: 'Msp', startDate: term.start, endDate: term.end, autoRenew: false,
    renewalTermMonths: 0, noticePeriodDays: 30, invoiceFrequency: 'Monthly', invoiceTiming: 'InAdvance', indexation: false,
  });
  await api.post(page, `/api/v1/contracts/${contract.id}/lines`, { productId: seat.id, quantityModel: 'PerBackupSeat', quantity: 1, validFrom: term.start });
  await api.post(page, `/api/v1/contracts/${contract.id}/activate`);
  await syncUntil(page, ['cloudally-bills'], async () =>
    (await serviceQuantities(page, customer.organizationId)).find((s) => s.model === 'PerBackupSeat')!.billLines.length > 0, `the bill of ${customer.name}`);

  for (const [width, height] of widths) {
    await page.setViewportSize({ width, height });
    await page.goto(`/organizations/${customer.organizationId}?tab=contracts`);
    const counts = page.getByRole('region', { name: 'Counted by the services', exact: true });
    await expect(counts.getByRole('table', { name: 'What CloudAlly bills', exact: true })).toBeVisible();
    await settled(page);
    expect(await seriousViolations(page), `counts at ${width} px (${scheme})`).toEqual([]);
    expect(await fitsWidth(page), `counts scroll sideways at ${width} px (${scheme})`).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`service-counts-${width}-${scheme}.png`), fullPage: true });

    // The keyboard opens the wizard from the customer card; Escape closes it with focus back on the button.
    await page.goto(`/organizations/${customer.organizationId}`);
    const open = page.getByRole('region', { name: 'Linked systems', exact: true }).getByRole('button', { name: 'Connect services…', exact: true });
    await open.focus();
    await page.keyboard.press('Enter');
    await toConfirmation(page, agent, async (step) => {
      await settled(page);
      expect(await seriousViolations(page), `wizard step ${step} at ${width} px (${scheme})`).toEqual([]);
      expect(await fitsWidth(page), `wizard step ${step} scrolls sideways at ${width} px (${scheme})`).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`connect-${step}-${width}-${scheme}.png`), fullPage: true });
    });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(open).toBeFocused();
  }

  // Once the customer is created, the outcome and the work left in the consoles pass at every width too.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/organizations/${customer.organizationId}`);
  await page.getByRole('button', { name: 'Connect services…', exact: true }).click();
  const wizard = await toConfirmation(page, agent, async () => undefined);
  await wizard.getByRole('button', { name: 'Create and link', exact: true }).click();
  await expect(wizard.getByText('Step 4 of 4: Result', { exact: true })).toBeFocused();
  await expect(wizard.getByText('Created and linked to the customer.', { exact: true })).toHaveCount(2, { timeout: 30_000 });
  for (const [width, height] of widths) {
    await page.setViewportSize({ width, height });
    await settled(page);
    expect(await seriousViolations(page), `wizard result at ${width} px (${scheme})`).toEqual([]);
    expect(await fitsWidth(page), `wizard result scrolls sideways at ${width} px (${scheme})`).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`connect-result-${width}-${scheme}.png`), fullPage: true });
  }
});
