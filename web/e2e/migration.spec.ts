import { expect, test } from '@playwright/test';
import { marker, orgNumber, signIn, toast } from './support';

test('a migration file is previewed before the customers are created', async ({ page }) => {
  test.setTimeout(120_000);
  const m = marker('Mig');
  await signIn(page, 'Crm.Admin');
  const number = orgNumber();
  // The e2e database is shared between runs, so the domain and the e-mail carry this run's marker too.
  const domain = `${m.toLowerCase()}.no`;
  const csv = [
    'Navn;Organisasjonsnummer;E-post;Domene;Poststed;Fornavn;Etternavn;Kontaktepost;Kontaktrolle',
    `${m} Migrert AS;${number};post@${domain};${domain};Oslo;Kari;Nordmann;kari@${domain};Faktura`,
  ].join('\n');

  await page.goto('/admin/migration');
  await page.getByRole('textbox', { name: 'Or paste the rows' }).fill(csv);
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByText('1 new, 0 updated, 0 unchanged')).toBeVisible();

  // The preview wrote nothing: the customer does not exist yet.
  await page.goto(`/organizations?search=${m}`);
  await expect(page.getByText(`${m} Migrert AS`)).toBeHidden();

  await page.goto('/admin/migration');
  await page.getByRole('textbox', { name: 'Or paste the rows' }).fill(csv);
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByText('1 new, 0 updated, 0 unchanged')).toBeVisible();
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(toast(page, 'Imported 1 new and 0 updated customers')).toBeVisible();

  await page.goto(`/organizations?search=${m}`);
  await expect(page.getByRole('link', { name: `${m} Migrert AS` })).toBeVisible();
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

  // The reason is asked for in a prompt and goes into the log.
  page.once('dialog', (dialog) => void dialog.accept(`${m} incident`));
  await card.getByRole('button', { name: 'Pause' }).click();
  await expect(toast(page, 'The integration is paused')).toBeVisible();
  await expect(card.getByText('Paused', { exact: true })).toBeVisible();
  await expect(card.getByText(`${m} incident`)).toBeVisible();

  await card.getByRole('button', { name: 'Resume' }).click();
  await expect(toast(page, 'The integration runs again')).toBeVisible();
  await expect(card.getByText('Paused', { exact: true })).toBeHidden();
});
