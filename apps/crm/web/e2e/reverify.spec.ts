import { expect, test } from '@playwright/test';
import { signIn } from './support';

// F-G2-08: a privileged action refused for want of a recent interactive sign-in offers "Confirm identity", which signs in again
// (in development: the same role at once; in Entra: prompt=login with max_age) and comes back to the same page.
test('a refused privileged action opens the identity confirmation, which returns to the same page', async ({ page }) => {
  await signIn(page, 'Crm.Finance', '/billing');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  let refused = false;
  await page.route(
    (url) => url.pathname === '/api/v1/billing/runs',
    async (route) => {
      if (refused || route.request().method() !== 'GET') return route.fallback();
      refused = true;
      return route.fulfill({
        status: 403,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          title: 'AUTH_REVERIFY_REQUIRED',
          status: 403,
          code: 'AUTH_REVERIFY_REQUIRED',
          reverifyUrl: '/bff/login?reverify=1',
        }),
      });
    },
  );
  await page.reload();

  const dialog = page.getByRole('alertdialog', {
    name: 'Confirm your identity to continue',
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Not now' }).click();
  await expect(dialog).toBeHidden();

  // Ask again, this time confirm: the browser leaves for the sign-in and comes back to the billing page, signed in as before.
  refused = false;
  await page.reload();
  await expect(dialog).toBeVisible();
  const back = page.waitForURL(/\/billing(\?|$)/);
  await dialog.getByRole('button', { name: 'Confirm identity' }).click();
  await back;
  await expect(page.getByRole('main')).toBeVisible();
  await expect(dialog).toBeHidden();
  expect(new URL(page.url()).pathname).toBe('/billing');
});

test('the confirmation address only ever returns to a page of this app', async ({ page }) => {
  await signIn(page, 'Crm.Finance', '/');
  const response = await page.request.get('/bff/login?reverify=1&returnUrl=//evil.example/x', { maxRedirects: 0 });
  expect(response.status()).toBe(302);
  expect(response.headers()['location']).toMatch(/returnUrl=%2F(&|$)/);
});
