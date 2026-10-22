import { expect, test } from '@playwright/test';
import { api, createOrganization, marker, orgNumber, searchList, signIn, toast } from './support';

test('a lead becomes a customer with a deal, and the deal is won', { tag: '@critical' }, async ({ page }) => {
  test.setTimeout(120_000);
  const m = marker('Lead');
  await signIn(page, 'Crm.Sales');

  await page.goto('/sales/leads');
  await page.getByRole('button', { name: 'New lead' }).click();
  const form = page.getByRole('dialog');
  await form.getByRole('textbox', { name: 'Company', exact: true }).fill(`${m} Nykunde AS`);
  await form.getByRole('textbox', { name: 'Organisation number' }).fill(orgNumber());
  await form.getByRole('textbox', { name: 'Source' }).fill('Anbefaling');
  await form.getByRole('textbox', { name: 'Contact person' }).fill('Ola Nordmann');
  await form.getByRole('textbox', { name: 'E-mail' }).fill(`ola.${m.toLowerCase()}@example.no`);
  await form.getByRole('button', { name: 'Create' }).click();
  await expect(toast(page, 'Lead created')).toBeVisible();

  const row = page.getByRole('row').filter({ hasText: `${m} Nykunde AS` });
  await expect(row).toBeVisible();

  // Converting creates the customer and the first deal in one step (FR-SAL-01).
  await row.getByRole('button', { name: 'Convert to customer' }).click();
  const convert = page.getByRole('dialog');
  await expect(convert.getByRole('switch', { name: 'Also create a deal' })).toBeChecked();
  await convert.getByRole('textbox', { name: 'Name', exact: true }).fill(`${m} Driftsavtale`);
  await convert.getByRole('textbox', { name: 'One-off' }).fill('10 000');
  await convert.getByRole('textbox', { name: 'Monthly recurring' }).fill('5 000');
  await convert.getByRole('button', { name: 'Convert to customer' }).click();
  await expect(toast(page, 'Lead converted')).toBeVisible();

  // The browser lands on the new deal; the forecast is 10 000 + 12 × 5 000 weighted by the first stage (10 %).
  await expect(page.getByRole('heading', { level: 1, name: `${m} Driftsavtale` })).toBeVisible();
  await expect(page.getByText('NOK 7,000.00')).toBeVisible();

  // An activity keeps the deal from going quiet (BR-SAL-03).
  await page.getByRole('button', { name: 'Log activity' }).click();
  const activity = page.getByRole('dialog');
  await activity.getByRole('textbox', { name: 'Subject' }).fill(`${m} Oppfølgingssamtale`);
  await activity.getByRole('button', { name: 'Log activity' }).click();
  await expect(toast(page, 'Activity logged')).toBeVisible();
  // The deal shows the logged task both as its next step (DEV-18) and in the timeline.
  await expect(page.getByRole('region', { name: 'Next step' })).toContainText(`${m} Oppfølgingssamtale`);
  await expect(page.getByRole('listitem').filter({ hasText: `${m} Oppfølgingssamtale` })).toBeVisible();

  await page.getByRole('button', { name: 'Mark as won' }).click();
  await expect(toast(page, 'Deal won')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create contract' })).toBeVisible();

  // The pipeline no longer shows it, and the customer's Deals tab does.
  await page.goto('/pipeline');
  await expect(page.getByText(`${m} Driftsavtale`)).toBeHidden();
  const leads = await api.get<{ items: Array<{ organizationId: string | null }> }>(page, `/api/v1/sales/leads?search=${m}`);
  await page.goto(`/organizations/${leads.items[0]!.organizationId}?tab=deals`);
  await expect(page.getByRole('row').filter({ hasText: `${m} Driftsavtale` }).getByText('Won')).toBeVisible();
});

test('a pipeline stage is renamed from the admin screen', async ({ page }) => {
  // Editing sends If-Match from the row's ETag, which only works while the DTO serializes it as "etag".
  const m = marker('Etp');
  await signIn(page, 'Crm.Admin');
  await page.goto('/admin/pipeline');
  const row = page.getByRole('row').filter({ hasText: 'Qualification' });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Edit' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Name' }).fill(`Qualification ${m}`);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(toast(page, `Qualification ${m} saved`)).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: `Qualification ${m}` })).toBeVisible();

  // Put the name back so the other tests still find the seeded stage.
  const renamed = page.getByRole('row').filter({ hasText: `Qualification ${m}` });
  await renamed.getByRole('button', { name: 'Edit' }).click();
  const again = page.getByRole('dialog');
  await again.getByRole('textbox', { name: 'Name' }).fill('Qualification');
  await again.getByRole('button', { name: 'Save' }).click();
  await expect(toast(page, 'Qualification saved')).toBeVisible();
});

test('a lost deal keeps its reason and can be reopened', async ({ page }) => {
  const m = marker('Tap');
  await signIn(page, 'Crm.Sales');
  const organization = await createOrganization(page, { name: `${m} Tapt AS`, status: 'Prospect' });
  const stages = await api.get<Array<{ id: string; isWon: boolean; isLost: boolean }>>(page, '/api/v1/sales/stages');
  const first = stages.find((s) => !s.isWon && !s.isLost)!;
  const opportunity = await api.post<{ id: string }>(page, '/api/v1/sales/opportunities', {
    organizationId: organization.id, contactId: null, name: `${m} Anbud`, businessLine: 'Msp', stageId: first.id, probability: null,
    expectedCloseDate: '2027-03-01', oneOffAmount: 0, mrr: 2000, termMonths: 12, ownerId: null, source: 'Anbud', competitor: 'Annen leverandør',
  });

  await page.goto(`/sales/opportunities/${opportunity.id}`);
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Mark as lost' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Lost reason' }).click();
  await page.getByRole('option', { name: 'Price' }).click();
  await dialog.getByRole('button', { name: 'Mark as lost' }).click();
  await expect(toast(page, 'Deal lost')).toBeVisible();
  await expect(page.getByRole('main').getByText('Price', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Reopen' }).click();
  await expect(toast(page, 'Deal reopened')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark as won' })).toBeVisible();
});

test('a distributor file is previewed before the subscriptions are imported', async ({ page }) => {
  test.setTimeout(120_000);
  const m = marker('Lis');
  await signIn(page, 'Crm.Admin');
  const number = orgNumber();
  const organization = await createOrganization(page, { name: `${m} Lisens AS`, status: 'Customer', orgNumber: number });
  const csv = [
    'Kundeid;Kundenavn;Organisasjonsnummer;Abonnementsid;Produktid;Produktnavn;Antall;Bindingstid;Startdato;Fornyelsesdato;Autofornyelse;Partnerpris',
    `${m}-C1;${m} Lisens AS;${number};${m}-S1;CFQ7TTC0LF8Q:0002;Microsoft 365 Business Premium;12;P1Y;2026-09-01;2027-09-01;Ja;225,50`,
    `${m}-C1;${m} Lisens AS;${number};${m}-S2;CFQ7TTC0LH18:0001;Microsoft 365 Business Standard;4;P1M;2026-09-01;2026-10-01;Ja;127,00`,
  ].join('\n');

  await page.goto('/licenses');
  await page.getByRole('button', { name: 'Import from distributor' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Or paste the rows' }).fill(csv);

  // The preview writes nothing.
  await dialog.getByRole('button', { name: 'Preview' }).click();
  await expect(dialog.getByText('Would create 2, update 0 and leave 0 subscriptions unchanged.')).toBeVisible();
  const before = await api.get<{ items: unknown[]; totalCount: number }>(page, `/api/v1/licensing/subscriptions?search=${m}`);
  expect(before.items).toHaveLength(0);
  expect(before.totalCount).toBe(0);

  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(toast(page, 'Created 2 and updated 0 subscriptions')).toBeVisible();

  // The e2e database is shared between runs, so the table is narrowed to this run's customer, and read once that search is answered.
  await searchList(page, page.getByRole('searchbox', { name: 'Search offer or customer' }), '/api/v1/licensing/subscriptions', m);
  const row = page.getByRole('row').filter({ hasText: `${m} Lisens AS` }).filter({ hasText: 'Microsoft 365 Business Premium' });
  await expect(row).toBeVisible();
  // Linked by organisation number, and with no contract line the subscription is flagged as unbilled (BR-LIC-03).
  await expect(row.getByRole('link', { name: `${m} Lisens AS` })).toBeVisible();
  await expect(row.getByText('No product')).toBeVisible();
  // Partner cost is only shown to roles with finance.cost.read; the admin has it.
  await expect(row.getByText('NOK 225.50')).toBeVisible();

  // A second import of the same file changes nothing (hash-based change detection).
  await page.getByRole('button', { name: 'Import from distributor' }).click();
  const again = page.getByRole('dialog');
  await again.getByRole('textbox', { name: 'Or paste the rows' }).fill(csv);
  await again.getByRole('button', { name: 'Preview' }).click();
  await expect(again.getByText('Would create 0, update 0 and leave 2 subscriptions unchanged.')).toBeVisible();
  await again.getByRole('button', { name: 'Cancel' }).click();

  await page.goto(`/organizations/${organization.id}?tab=licenses`);
  await expect(page.getByText('Microsoft 365 Business Standard')).toBeVisible();

  // A technician may read licenses but never the partner cost.
  await signIn(page, 'Crm.Technician');
  await page.goto('/licenses');
  await expect(page.getByRole('button', { name: 'Import from distributor' })).toBeHidden();
  await expect(page.getByText('NOK 225.50')).toBeHidden();
});

test('microsoft cost lines are reconciled against what the customer was billed', async ({ page }) => {
  test.setTimeout(120_000);
  const m = marker('Rec');
  await signIn(page, 'Crm.Admin');
  const number = orgNumber();
  await createOrganization(page, { name: `${m} Avstemming AS`, status: 'Customer', orgNumber: number });

  // The cost lines find their customer through the CSP subscription, so the mirror is filled first.
  await api.postCsv(page, '/api/v1/licensing/import', [
    'Kundeid;Kundenavn;Organisasjonsnummer;Abonnementsid;Produktid;Produktnavn;Antall;Bindingstid',
    `${m}-C1;${m} Avstemming AS;${number};${m}-S1;CFQ7TTC0LF8Q:0002;Microsoft 365 Business Premium;12;P1Y`,
  ].join('\n'));

  const now = new Date();
  const period = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const month = String(period.getMonth() + 1).padStart(2, '0');
  const lastDay = new Date(period.getFullYear(), period.getMonth() + 1, 0).getDate();
  const csv = [
    'CustomerId;Kundenavn;SubscriptionId;OfferId;Produktnavn;Antall;Enhetspris;Beløp;Valuta;Fakturanummer;ChargeStartDate;ChargeEndDate',
    `${m}-C1;${m} Avstemming AS;${m}-S1;CFQ7TTC0LF8Q:0002;Microsoft 365 Business Premium;12;180,50;2 166,00;NOK;G-${m};` +
      `${period.getFullYear()}-${month}-01;${period.getFullYear()}-${month}-${lastDay}`,
  ].join('\n');

  await page.goto('/licenses?view=reconciliation');
  await page.getByRole('button', { name: 'Import Microsoft invoice' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Or paste the rows' }).fill(csv);
  await dialog.getByRole('button', { name: 'Preview' }).click();
  await expect(dialog.getByText('1 new lines, 0 changed, 0 unchanged, 0 without a customer.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(toast(page, 'Imported 1 new and 0 changed cost lines.')).toBeVisible();

  await page.getByRole('combobox', { name: 'Month' }).click();
  await page.getByRole('option', { name: `${month}.${period.getFullYear()}` }).click();

  // Nothing was billed to the customer for the month, which is what the report exists to surface (FR-LIC-04).
  const row = page.getByRole('row').filter({ hasText: `${m} Avstemming AS` });
  await expect(row.getByRole('cell', { name: 'NOK 2,166.00', exact: true })).toBeVisible();
  // The margin is the whole cost: nothing was billed to the customer for the month.
  await expect(row.getByText('-NOK 2,166.00')).toBeVisible();
  await expect(row.getByText('Not billed on')).toBeVisible();

  // Licence usage has its own tab; without a tenant reading it says so rather than showing zeros.
  await page.getByRole('tab', { name: 'Licence usage' }).click();
  await expect(page.getByRole('switch', { name: /Only seats unused/ })).toBeVisible();

  // Cost is finance data: a technician sees the subscriptions but not the reconciliation.
  await signIn(page, 'Crm.Technician');
  await page.goto('/licenses');
  await expect(page.getByRole('tab', { name: 'Microsoft reconciliation' })).toBeHidden();
});
