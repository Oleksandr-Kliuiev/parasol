import { expect, test } from '@playwright/test';
import { signIn } from './support';

test('the chosen language is saved to the profile', async ({ page }) => {
  await signIn(page, 'Crm.Finance', '/organizations');
  for (const [language, label, heading] of [
    ['nb', 'Norsk bokmål', 'Organisasjoner'],
    ['ru', 'Русский', 'Организации'],
    ['en', 'English', 'Organizations'],
  ] as const) {
    await page.getByRole('button', { name: 'Dev Finance' }).click();
    await page.getByRole('menuitemradio', { name: label }).click();
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', language);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', language);
  }
});
