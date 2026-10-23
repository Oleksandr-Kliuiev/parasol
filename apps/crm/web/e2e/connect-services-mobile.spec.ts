import { expect, test } from '@playwright/test';
import { customerToConnect } from './onboarding';
import { signIn } from './support';

// M43: on a phone the "Connect services" wizard keeps every step inside the screen, a contract line's fields stack under its box, and
// the counts on the contracts tab fit too.
test('the "Connect services" wizard and the counts fit a phone screen', async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page, 'Crm.Admin');
  const customer = await customerToConnect(page, 'KobM');
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

  await page.goto(`/organizations/${customer.id}`);
  await page.getByRole('button', { name: 'Connect services…', exact: true }).click();
  const wizard = page.getByRole('dialog', { name: 'Connect the customer to the services', exact: true });
  await expect(wizard.getByText('Step 1 of 4: Services', { exact: true })).toBeFocused();
  await expect(wizard.getByRole('textbox', { name: /^Organization key/ })).toHaveValue(customer.key);
  await page.waitForLoadState('networkidle');
  expect(await overflow(), 'the services step scrolls sideways').toBeLessThanOrEqual(1);
  await wizard.getByRole('checkbox', { name: 'Create in CloudAlly', exact: true }).uncheck();
  await wizard.getByRole('button', { name: 'Continue', exact: true }).click();

  await expect(wizard.getByText('Step 2 of 4: Contract', { exact: true })).toBeFocused();
  await wizard.getByRole('checkbox', { name: 'Bill per Atera device', exact: true }).uncheck();
  const line = wizard.getByRole('group', { name: 'Per Huntress agent', exact: true });
  await line.getByRole('combobox', { name: /^Product/ }).pressSequentially(customer.agent.sku);
  await page.getByRole('option', { name: new RegExp(customer.agent.sku, 'i') }).click();
  const product = await line.getByRole('combobox', { name: /^Product/ }).boundingBox();
  const estimate = await line.getByRole('textbox', { name: /^Quantity until the first count/ }).boundingBox();
  expect(estimate!.y, 'the quantity stacks under the product on a phone').toBeGreaterThan(product!.y + product!.height);
  expect(await overflow(), 'the contract step scrolls sideways').toBeLessThanOrEqual(1);
  await wizard.getByRole('button', { name: 'Continue', exact: true }).click();

  await expect(wizard.getByText('Step 3 of 4: Confirm', { exact: true })).toBeFocused();
  await expect(wizard.getByText(`Huntress gets the organization “${customer.name}” with the organization key ${customer.key}.`, { exact: true })).toBeVisible();
  expect(await overflow(), 'the confirmation scrolls sideways').toBeLessThanOrEqual(1);
  await wizard.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(wizard).toHaveCount(0);

  await page.goto(`/organizations/${customer.id}?tab=contracts`);
  await expect(page.getByRole('region', { name: 'Counted by the services', exact: true }).getByRole('listitem')).toHaveCount(3);
  await page.waitForLoadState('networkidle');
  expect(await overflow(), 'the contracts tab scrolls sideways').toBeLessThanOrEqual(1);
});
