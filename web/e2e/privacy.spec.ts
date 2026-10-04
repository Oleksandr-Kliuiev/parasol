import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { api, createContact, createOrganization, marker, signIn, toast } from './support';

/** Opens a request from the contact card, as the privacy administrator does, and verifies the requester. */
async function openRequest(page: Page, contactId: string, name: string, kind: 'Access' | 'Erasure') {
  await page.goto(`/contacts/${contactId}`);
  await page.getByRole('button', { name: 'Personal data request' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New personal data request' })).toBeVisible();
  // The name came along in the navigation state; the address carries only the id.
  await expect(page.getByText(name)).toBeVisible();
  expect(page.url()).not.toContain(encodeURIComponent(name.split(' ')[1]!));
  if (kind === 'Erasure') await page.getByRole('radio', { name: /^Erasure:/ }).check();
  await page.getByRole('button', { name: 'Open the request' }).click();
  const heading = page.getByRole('heading', { level: 1, name: new RegExp(`^PRV-\\d{4}-\\d{4,} · ${kind} request$`) });
  await expect(heading).toBeVisible();
  const number = (await heading.textContent())!.split(' · ')[0]!;
  await page.getByRole('button', { name: 'Identity verified' }).click();
  return number;
}

test('a person gets their data, then is erased and stays erased (DEV-11)', { tag: '@critical' }, async ({ page }) => {
  test.setTimeout(120_000);
  const m = marker('Prv');
  await signIn(page, 'Crm.Admin');
  const organization = await createOrganization(page, { name: `${m} Personvern AS` });
  const email = `petra.${m.toLowerCase()}@example.no`;
  const { contactId } = await createContact(page, organization.id, { firstName: 'Petra', lastName: m, email, phone: '41 00 00 00' });
  // Her new role queues a contact person sync for PowerOffice through the outbox. The erasure plan covers that queue entry,
  // so it is previewed once the entry exists (its status is not part of the plan) — a plan that changes under the preview is
  // refused, as it should be.
  await expect
    .poll(async () => (await api.get<Array<{ entityId: string; status: string }>>(page, '/api/v1/integrations/outbound?system=poweroffice'))
      .find((o) => o.entityId === contactId)?.status, { timeout: 30_000 })
    .toBeDefined();

  // Access: the export holds what the CRM keeps on her, and answering it completes the request.
  const access = await openRequest(page, contactId, `Petra ${m}`, 'Access');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download the export' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`${access}-export.json`);
  expect(await readFile((await file.path())!, 'utf8')).toContain(email);
  await expect(page.getByText('Completed', { exact: true })).toBeVisible();
  await expect(page.getByText(/^Exported .*, SHA-256:/)).toBeVisible();

  // Erasure: previewed, confirmed with the case number, carried out.
  const erasure = await openRequest(page, contactId, `Petra ${m}`, 'Erasure');
  await page.getByRole('button', { name: 'Preview the plan' }).click();
  const plan = page.getByRole('table', { name: 'Plan per module' });
  await expect(plan.getByRole('row', { name: /Customers Pseudonymize 1/ })).toBeVisible();
  await page.getByRole('button', { name: 'Carry out the erasure' }).click();
  const dialog = page.getByRole('dialog', { name: `Carry out erasure ${erasure}` });
  await expect(dialog.getByRole('button', { name: 'Erase' })).toBeDisabled();
  await dialog.getByRole('textbox', { name: /Type the request number/ }).fill(erasure);
  await dialog.getByRole('button', { name: 'Erase' }).click();
  await expect(toast(page, 'The erasure was carried out.')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Done per module' })).toBeVisible();
  await expect(page.getByText(/suppressions? keeps? the person from being imported again/)).toBeVisible();

  // The card is gone, search does not find her, and her address is suppressed against a re-import.
  await page.goto(`/contacts/${contactId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
  await page.keyboard.press('Control+k');
  await page.keyboard.type(`petra ${m}`);
  await expect(page.getByText('Nothing found.')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.goto('/admin/privacy');
  await page.getByRole('switch', { name: 'Show closed' }).check();
  const cases = page.getByRole('table', { name: 'Personal data requests' });
  await expect(cases.getByRole('row', { name: new RegExp(`${access} Access request Contact person Completed`) })).toBeVisible();
  await expect(cases.getByRole('row', { name: new RegExp(`${erasure} Erasure request Contact person Completed`) })).toBeVisible();
  const suppressions = page.getByRole('table', { name: 'Suppressions' });
  await expect(suppressions.getByRole('row').filter({ hasText: erasure })).toHaveCount(1);
  await expect(page.getByText(email)).toHaveCount(0);
});
