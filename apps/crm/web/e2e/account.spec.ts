import { expect, test } from '@playwright/test';
import { signIn } from './support';

test('the account menu leads to the account page, which shows the person and keeps their settings', async ({ page }) => {
  // A user of its own: the language and the My day layout are saved with the person, and other specs signed in as Dev Admin
  // at the same time must keep theirs.
  await signIn(page, 'Crm.Admin', '/', 'Account');
  await page.getByRole('button', { name: /^Dev Account/ }).click();
  const myAccount = page.getByRole('menuitem', { name: 'My account' });
  await myAccount.waitFor();
  // The open menu covers only itself: the rail's dark fill once reached its portal and darkened the whole window.
  expect(await page.evaluate(() => Boolean(document.elementFromPoint(innerWidth * 0.66, innerHeight / 2)?.closest('main')))).toBe(true);
  await myAccount.click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole('heading', { level: 1, name: 'My account' })).toBeVisible();
  // The top bar names the page too (it lies outside the menu).
  await expect(page.getByRole('banner').getByText('My account', { exact: true })).toBeVisible();

  const profile = page.getByRole('region', { name: 'Profile' });
  await expect(profile.getByText('Dev Account', { exact: true })).toBeVisible();
  await expect(profile.getByText('Full access', { exact: true })).toBeVisible();
  await expect(profile.getByText('Development sign-in', { exact: true })).toBeVisible();

  // What My day shows first is kept with the account.
  const settings = page.getByRole('region', { name: 'Settings' });
  const layout = settings.getByRole('radiogroup', { name: 'My day shows first' });
  await layout.getByText('Billing', { exact: true }).click();
  await expect(layout.getByRole('radio', { name: 'Billing' })).toBeChecked();
  await expect.poll(async () => (await (await page.request.get('/bff/user')).json()).myDayLayout).toBe('finance');
  await layout.getByText('Alerts and tasks', { exact: true }).click();
  await expect.poll(async () => (await (await page.request.get('/bff/user')).json()).myDayLayout).toBe('work');

  // The theme stays with this browser.
  const theme = settings.getByRole('radiogroup', { name: 'Theme' });
  await theme.getByText('Dark', { exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('region', { name: 'Settings' }).getByRole('radiogroup', { name: 'Theme' }).getByText('Same as system', { exact: true }).click();

  // The language changes the whole page at once and is saved with the person.
  await page.getByRole('region', { name: 'Settings' }).getByRole('radiogroup', { name: 'Language' }).getByText('Norsk bokmål', { exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Min konto' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'nb');
  await page.getByRole('region', { name: 'Innstillinger' }).getByRole('radiogroup', { name: 'Språk' }).getByText('English', { exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'My account' })).toBeVisible();
});
