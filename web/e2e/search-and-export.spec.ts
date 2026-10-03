import { expect, test } from '@playwright/test';
import { createContact, createOrganization, marker, signIn } from './support';

test('global search finds a contact and opens it with the keyboard', { tag: '@critical' }, async ({ page }) => {
  const m = marker('Srch');
  await signIn(page, 'Crm.Sales');
  const organization = await createOrganization(page, { name: `${m} Kystlys AS` });
  await createContact(page, organization.id, { firstName: 'Solveig', lastName: m, email: `solveig.${m.toLowerCase()}@example.no` });

  await page.keyboard.press('Control+k');
  await page.keyboard.type(`solveig ${m}`);
  const option = page.getByRole('option', { name: new RegExp(`Solveig ${m}`) });
  await expect(option).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');

  await expect(page.getByRole('heading', { level: 1, name: `Solveig ${m}` })).toBeVisible();
  await expect(page).toHaveURL(/\/contacts\//);
});

test('the organization list exports the filtered rows to Excel', async ({ page }) => {
  const m = marker('Xls');
  await signIn(page, 'Crm.Sales');
  await createOrganization(page, { name: `${m} Eksport AS` });

  await page.goto(`/organizations?search=${m}`);
  await expect(page.getByRole('link', { name: `${m} Eksport AS` })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export to Excel' }).click();

  expect((await download).suggestedFilename()).toMatch(/^organizations-\d{4}-\d{2}-\d{2}-\d{4}\.xlsx$/);
});
