import { expect, test } from '@playwright/test';
import { signIn } from './support';

test('the chosen language is saved to the profile', async ({ page }) => {
  // A user of its own: the language is saved with the person, and the specs signed in as Dev Finance at the same time must
  // keep their English interface.
  await signIn(page, 'Crm.Finance', '/organizations', 'Language');
  for (const [language, label, heading] of [
    ['nb', 'Norsk bokmål', 'Organisasjoner'],
    ['nn', 'Norsk nynorsk', 'Organisasjonar'],
    ['en', 'English', 'Organizations'],
  ] as const) {
    await page.getByRole('button', { name: 'Dev Language' }).click();
    await page.getByRole('menuitemradio', { name: label }).click();
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', language);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', language);
  }
});
