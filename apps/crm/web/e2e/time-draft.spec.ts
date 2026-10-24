import { expect, test } from '@playwright/test';
import { signIn } from './support';

test('the register dialog asks before Escape drops typed hours, and Keep editing returns to a working form', { tag: '@critical' }, async ({ page }) => {
  await signIn(page, 'Crm.Technician', '/time');
  await page.getByRole('button', { name: 'Register hours', exact: true }).first().click();
  const form = page.getByRole('dialog', { name: 'Register hours', exact: true });
  await form.getByRole('textbox', { name: 'Description', exact: true }).fill('Synthetic unsaved draft');
  await page.keyboard.press('Escape');
  const ask = page.getByRole('dialog', { name: 'Discard this entry?', exact: true });
  await ask.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(ask).toHaveCount(0);
  // The form is back: visible to assistive technology and taking input.
  const description = form.getByRole('textbox', { name: 'Description', exact: true });
  await expect(description).toHaveValue('Synthetic unsaved draft');
  await description.fill('Synthetic unsaved draft, edited');
  await page.keyboard.press('Escape');
  await ask.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(form).toHaveCount(0);
});
