import { expect, test } from '@playwright/test';
import { signIn } from './support';

test('the chosen language is saved to the profile', async ({ page }) => {
  await signIn(page, 'Crm.Finance', '/organizations');
  await page.getByRole('button', { name: 'Dev Finance' }).click();
  await page.getByRole('menuitemradio', { name: 'Norsk bokmål' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Organisasjoner' })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Organisasjoner' })).toBeVisible();

  await page.getByRole('button', { name: 'Dev Finance' }).click();
  await page.getByRole('menuitemradio', { name: 'English' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Organizations' })).toBeVisible();
});
