import { expect, test } from '@playwright/test';
import { createOrganization, marker, signIn, toast } from './support';

test('management merges duplicates and undoes the merge', async ({ page }) => {
  const m = marker('Dup');
  await signIn(page, 'Crm.Management');
  const first = await createOrganization(page, { name: `${m} Havnelys AS`, email: `post@${m.toLowerCase()}.no` });
  await createOrganization(page, { name: `${m} Havnelys`, email: `faktura@${m.toLowerCase()}.no`, status: 'Customer' });

  await page.goto(`/organizations/${first.id}`);
  await expect(page.getByText(`This organization may be a duplicate of ${m} Havnelys.`)).toBeVisible();
  await page.getByRole('button', { name: 'Compare' }).click();

  // The order of the two organizations in a pair is not fixed.
  const pair = page.getByRole('region', { name: new RegExp(`${m} Havnelys`) });
  await expect(pair.getByText('Same name')).toBeVisible();
  await pair.getByRole('button', { name: `Keep this one: ${m} Havnelys AS` }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(`Merge ${m} Havnelys into ${m} Havnelys AS?`)).toBeVisible();
  await dialog.getByRole('button', { name: 'Merge' }).click();
  await expect(toast(page, /Merged: \d+ contacts moved/)).toBeVisible();

  const mergeRow = page.getByRole('row').filter({ hasText: `${m} Havnelys AS` });
  await mergeRow.getByRole('button', { name: 'Undo' }).click();
  await expect(toast(page, 'Merge undone')).toBeVisible();
  await expect(page.getByRole('region', { name: new RegExp(`${m} Havnelys`) })).toBeVisible();
});
