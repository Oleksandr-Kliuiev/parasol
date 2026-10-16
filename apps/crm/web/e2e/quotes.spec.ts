import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { api, createContact, createOrganization, marker, signIn, toast } from './support';

test('a quote with an extra discount is approved, downloaded and accepted', { tag: '@critical' }, async ({ page }) => {
  test.setTimeout(120_000);
  const m = marker('Quo');
  await signIn(page, 'Crm.Sales');
  const organization = await createOrganization(page, { name: `${m} Tilbud AS` });
  await createContact(page, organization.id, { firstName: 'Kari', lastName: m, email: `kari.${m.toLowerCase()}@example.no`, isPrimary: true });

  await page.goto(`/quotes/new?organizationId=${organization.id}&organizationName=${encodeURIComponent(`${m} Tilbud AS`)}`);
  await page.getByRole('textbox', { name: 'Title' }).fill(`${m} Drift av Microsoft 365`);
  await page.getByRole('spinbutton', { name: 'Contract term' }).fill('24');

  // One monthly line with a discount above the 15 % a salesperson may give (BR-SAL-05).
  const line = page.getByRole('row').filter({ has: page.getByRole('textbox', { name: 'Quantity' }) });
  await line.getByRole('textbox', { name: 'Description', exact: true }).fill('Drift og brukerstøtte');
  await line.getByRole('textbox', { name: 'Quantity' }).fill('25');
  await line.getByRole('textbox', { name: 'Unit price' }).fill('250');
  await line.getByRole('textbox', { name: 'Discount' }).fill('20');
  await expect(page.getByText('Above the 15 % limit')).toBeVisible();

  await page.getByRole('button', { name: 'Create quote' }).click();
  await expect(toast(page, 'The quote is created')).toBeVisible();
  // The toast can come before the page has moved on to the new quote: take its address only once it is there.
  await expect(page).toHaveURL(/\/quotes\/[0-9a-f-]{36}$/);
  const quoteUrl = page.url();
  await expect(page.getByRole('heading', { level: 1, name: /^T-\d{4}-\d{4}$/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Total' }).getByText('NOK 5,000.00')).toBeVisible();

  await page.getByRole('button', { name: 'Release for sending' }).click();
  await expect(toast(page, 'The quote is ready')).toBeVisible();
  await expect(page.getByText('Awaiting approval', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download PDF' })).toBeHidden();

  // Management approves the discount; only then is there a document (BR-SAL-05).
  await signIn(page, 'Crm.Management');
  await page.goto(quoteUrl);
  await page.getByRole('button', { name: 'Approve discount' }).click();
  await expect(toast(page, 'The discount is approved')).toBeVisible();

  const pdfLink = page.getByRole('link', { name: 'Download PDF' });
  await expect(pdfLink).toBeVisible();
  const pdf = await page.request.get((await pdfLink.getAttribute('href'))!);
  expect(pdf.headers()['content-type']).toContain('application/pdf');
  const body = await pdf.body();
  expect(body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  // DEV-08: the document was stored at approval; the page names its revision and hash, and the download is those bytes.
  const sha256 = createHash('sha256').update(body).digest('hex');
  expect(pdf.headers()['x-document-sha256']).toBe(sha256);
  await expect(page.getByText('Revision 1 · issued at release · stored')).toBeVisible();
  await expect(page.getByText(`SHA-256 ${sha256.slice(0, 16)}…`)).toBeVisible();

  await page.getByRole('button', { name: 'Mark as accepted' }).click();
  await expect(toast(page, 'The quote is accepted')).toBeVisible();
  await expect(page.getByText(/The quote was accepted on/)).toBeVisible();

  // BR-SAL-07: the monthly line became a draft contract with the quoted price.
  await expect(async () => {
    const contracts = await api.get<{ items: Array<{ id: string; status: string }> }>(page, `/api/v1/contracts?search=${m}`);
    expect(contracts.items.length).toBe(1);
    expect(contracts.items[0]!.status).toBe('Draft');
  }).toPass({ timeout: 60_000 });

  await page.goto('/quotes');
  const row = page.getByRole('row').filter({ hasText: `${m} Drift av Microsoft 365` });
  await expect(row.getByText('Accepted')).toBeVisible();
});

test('a new version starts from the old one and the old one becomes history', async ({ page }) => {
  const m = marker('Ver');
  await signIn(page, 'Crm.Sales');
  const organization = await createOrganization(page, { name: `${m} Versjon AS` });
  const quote = await api.post<{ id: string; number: string }>(page, '/api/v1/sales/quotes', {
    organizationId: organization.id,
    title: `${m} Pakke`,
    termMonths: 12,
    lines: [{ name: 'Drift', quantity: 10, unitPrice: 1000, discountPct: 5, recurrence: 'Monthly' }],
  });
  await api.post(page, `/api/v1/sales/quotes/${quote.id}/submit`);

  await page.goto(`/quotes/${quote.id}`);
  await page.getByRole('button', { name: 'New version' }).click();
  await expect(toast(page, 'Version 2 is created')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: `${quote.number} · v2` })).toBeVisible();
  await expect(page.getByText('Version 1 — Superseded')).toBeVisible();

  // The copy is editable again and keeps the line.
  const line = page.getByRole('row').filter({ has: page.getByRole('textbox', { name: 'Quantity' }) });
  await expect(line.getByRole('textbox', { name: 'Quantity' })).toHaveValue('10');
  await line.getByRole('textbox', { name: 'Discount' }).fill('10');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(toast(page, 'The quote is saved')).toBeVisible();
  await expect(page.getByText('Discount 10 %')).toBeVisible();
});

test('a quote template is edited by an administrator', async ({ page }) => {
  const m = marker('Tpl');
  await signIn(page, 'Crm.Admin');
  await page.goto('/admin/quote-templates');
  const row = page.getByRole('row').filter({ hasText: 'Standard (norsk)' });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: /^Edit the template/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Introduction' }).fill(`${m} Takk for samtalen.`);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(toast(page, 'The template is saved')).toBeVisible();
  await expect(page.getByText(`${m} Takk for samtalen.`)).toBeVisible();
});
