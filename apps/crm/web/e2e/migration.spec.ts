import { expect, test, type Page } from '@playwright/test';
import { api, createOrganization, marker, orgNumber, signIn, toast } from './support';

const HEADER = 'Navn;Organisasjonsnummer;E-post;Domene;Poststed;Telefon;Fornavn;Etternavn;Kontaktepost;Kontaktrolle';
const paste = (page: Page) => page.getByRole('textbox', { name: 'Or paste the rows' });
const importButton = (page: Page) => page.getByRole('button', { name: 'Import', exact: true });
/** A figure of the counts block, found by its label. */
const count = (page: Page, label: string) =>
  page.getByLabel('Counts', { exact: true }).locator('div').filter({ has: page.getByText(label, { exact: true }) }).locator('dd');

test('a migration file is previewed, imported, repeated and found in the runs', async ({ page }) => {
  test.setTimeout(150_000);
  const m = marker('Mig');
  await signIn(page, 'Crm.Admin');
  const number = orgNumber();
  // The e2e database is shared between runs, so the domain and the e-mail carry this run's marker too.
  const domain = `${m.toLowerCase()}.no`;
  const csv = [
    HEADER,
    `${m} Migrert AS;${number};post@${domain};${domain};Oslo;22 33 44 55;Kari;Nordmann;kari@${domain};Faktura`,
  ].join('\n');

  await page.goto('/admin/migration');
  await paste(page).fill(csv);
  // The import is enabled only after a preview of this same text.
  await expect(importButton(page)).toBeDisabled();
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(count(page, 'New')).toHaveText('1');
  await expect(count(page, 'Rows')).toHaveText('1');
  await expect(page.getByRole('row', { name: new RegExp(`${m} Migrert AS`) }).getByText('New', { exact: true })).toBeVisible();
  await expect(importButton(page)).toBeEnabled();

  // Another text is not the one that was previewed.
  await paste(page).fill(`${csv}\n`);
  await expect(importButton(page)).toBeDisabled();
  await paste(page).fill(csv);
  await expect(importButton(page)).toBeDisabled();

  // The preview wrote no customer.
  await page.goto(`/organizations?search=${m}`);
  await expect(page.getByText(`${m} Migrert AS`)).toBeHidden();

  await page.goto('/admin/migration');
  await paste(page).fill(csv);
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(count(page, 'New')).toHaveText('1');
  await importButton(page).click();
  await expect(toast(page, 'Imported 1 new and 0 updated customers')).toBeVisible();
  await expect(page.getByText('Import · Completed')).toBeVisible();
  const runLink = page.getByRole('link', { name: 'Open this run in the list of runs' });
  const runId = new URL((await runLink.getAttribute('href'))!, 'https://x').searchParams.get('run')!;
  expect(runId).toBeTruthy();

  await page.goto(`/organizations?search=${m}`);
  await expect(page.getByRole('link', { name: `${m} Migrert AS` })).toBeVisible();

  // The same file again: the preview finds nothing to change and the import returns the earlier run.
  await page.goto('/admin/migration');
  await paste(page).fill(csv);
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(count(page, 'Unchanged')).toHaveText('1');
  await expect(count(page, 'New')).toHaveText('0');
  await importButton(page).click();
  await expect(page.getByText('This file was already imported.', { exact: false })).toBeVisible();
  await expect(page.getByText('Import · Completed')).toBeVisible();

  // The run is in the list and its outcomes can be read page by page.
  await page.getByRole('tab', { name: 'Runs' }).click();
  await expect(page.getByRole('region', { name: 'Import runs' })).toBeVisible();
  await expect(page.getByText(/^Showing \d+ of \d+$/)).toBeVisible();
  const listed = await api.get<{ items: Array<{ id: string }> }>(page, '/api/v1/customers/organizations/import/runs?limit=50');
  expect(listed.items.map((r) => r.id)).toContain(runId);

  await page.goto(`/admin/migration?tab=runs&run=${runId}`);
  const outcomes = page.getByRole('region', { name: 'Row outcomes' });
  await expect(outcomes.getByRole('row', { name: /New/ })).toHaveCount(1);
  await page.getByRole('combobox', { name: 'Filter by action' }).selectOption('Conflict');
  await expect(page.getByText('No rows match.')).toBeVisible();
  await page.getByRole('combobox', { name: 'Filter by action' }).selectOption('');
  await expect(page.getByText(/^Showing 1 of 1$/)).toBeVisible();

  // The batch marker is a read-only list.
  await expect(page.getByText('is read-only', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Show what the run created or changed' }).click();
  await expect(page.getByRole('region', { name: 'Batch marker' }).getByRole('row', { name: /Customer/ }).first()).toBeVisible();
  await expect(page.getByText(/^Showing \d+ of \d+$/).last()).toBeVisible();
});

test('a different value in the file is a conflict and the CRM value stays', async ({ page }) => {
  test.setTimeout(120_000);
  const m = marker('Cnf');
  await signIn(page, 'Crm.Admin');
  const number = orgNumber();
  const domain = `${m.toLowerCase()}.no`;
  const organization = await createOrganization(page, {
    name: `${m} Konflikt AS`,
    orgNumber: number,
    email: `post@${domain}`,
    phone: '22 00 00 00',
  });
  const before = await api.get<{ phone: string | null }>(page, `/api/v1/customers/organizations/${organization.id}`);
  expect(before.phone).toBeTruthy();

  const csv = [HEADER, `${m} Konflikt AS;${number};post@${domain};${domain};Oslo;99 88 77 66;;;;`].join('\n');
  await page.goto('/admin/migration');
  await paste(page).fill(csv);
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(count(page, 'Conflicts')).toHaveText('1');
  const row = page.getByRole('row', { name: new RegExp(`${m} Konflikt AS`) });
  await expect(row.getByText('Conflict', { exact: true })).toBeVisible();
  await expect(row.getByText('The CRM holds a different value than the file. The CRM value is kept.')).toBeVisible();
  await expect(row.getByText('Different in the CRM (kept): phone')).toBeVisible();

  await importButton(page).click();
  await expect(page.getByText('Import · Completed')).toBeVisible();
  await expect(count(page, 'Conflicts')).toHaveText('1');

  const after = await api.get<{ phone: string | null }>(page, `/api/v1/customers/organizations/${organization.id}`);
  expect(after.phone).toBe(before.phone);
});

test('a row that cannot be imported is rejected with its reason and the rest goes through', async ({ page }) => {
  test.setTimeout(120_000);
  const m = marker('Rej');
  await signIn(page, 'Crm.Admin');
  const domain = `${m.toLowerCase()}.no`;
  const csv = [
    HEADER,
    `${m} God AS;${orgNumber()};post@${domain};${domain};Oslo;;;;;`,
    `${m} Dårlig AS;123;;;Oslo;;;;;`,
  ].join('\n');

  await page.goto('/admin/migration');
  await paste(page).fill(csv);
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(count(page, 'New')).toHaveText('1');
  await expect(count(page, 'Rejected')).toHaveText('1');
  const bad = page.getByRole('row', { name: new RegExp(`${m} Dårlig AS`) });
  await expect(bad.getByText('Rejected', { exact: true })).toBeVisible();
  await expect(bad.getByText('The organization number is not valid.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Why rows were not imported or need a decision' }).getByText('The organization number is not valid.')).toBeVisible();

  await importButton(page).click();
  await expect(toast(page, 'Imported 1 new and 0 updated customers')).toBeVisible();
  await page.goto(`/organizations?search=${m}`);
  await expect(page.getByRole('link', { name: `${m} God AS` })).toBeVisible();
  await expect(page.getByText(`${m} Dårlig AS`)).toBeHidden();
});

test('a reconciliation file is compared without writing anything', async ({ page }) => {
  await signIn(page, 'Crm.Admin');
  const unknown = orgNumber();
  await page.goto('/admin/migration?tab=reconcile');
  await page.getByRole('textbox', { name: 'Or paste the rows' }).fill(['OrgNumber;Period;Currency;Amount', `${unknown};2026-09;NOK;1000,50`, 'x;2026-09;NOK;5'].join('\n'));
  await page.getByRole('button', { name: 'Compare' }).click();
  const table = page.getByRole('region', { name: 'Reconciliation result' });
  await expect(table.getByRole('row', { name: new RegExp(unknown) }).getByText('Customer not in the CRM')).toBeVisible();
  await expect(table.getByText('Rejected', { exact: true })).toBeVisible();
});

test('an integration can be paused from the admin screen during an incident', async ({ page }) => {
  const m = marker('Pau');
  await signIn(page, 'Crm.Admin');
  await page.goto('/admin/integrations');

  const card = page.getByRole('region', { name: 'Atera' });
  await expect(card.getByRole('button', { name: 'Open mappings' })).toBeVisible();

  // The e2e database is shared, so an earlier run may have left the integration paused.
  const resume = card.getByRole('button', { name: 'Resume' });
  if ((await resume.count()) > 0) {
    await resume.click();
    await expect(card.getByRole('button', { name: 'Pause' })).toBeVisible();
  }

  // The reason is asked for in the app's own dialog, which refuses an empty one, and goes into the log.
  await card.getByRole('button', { name: 'Pause' }).click();
  const dialog = page.getByRole('dialog', { name: 'Pause Atera' });
  await dialog.getByRole('button', { name: 'Pause' }).click();
  await expect(dialog.getByText('Write why the integration is being paused.')).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Reason' }).fill(`${m} incident`);
  await dialog.getByRole('button', { name: 'Pause' }).click();
  await expect(dialog).toBeHidden();
  await expect(toast(page, 'The integration is paused')).toBeVisible();
  await expect(card.getByText('Paused', { exact: true })).toBeVisible();
  await expect(card.getByText(`${m} incident`)).toBeVisible();

  await card.getByRole('button', { name: 'Resume' }).click();
  await expect(toast(page, 'The integration runs again')).toBeVisible();
  await expect(card.getByText('Paused', { exact: true })).toBeHidden();
});
