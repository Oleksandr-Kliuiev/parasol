import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { api, collectedBillingRun, createContact, createOrganization, marker, signIn } from './support';

async function expectNoSeriousViolations(page: Page, name: string) {
  // The element, not the role: an open modal dialog hides the rest of the page from assistive technology, and when that
  // happens depends on timing — looking the landmark up by role made the dialog checks fail on a busy machine.
  await expect(page.locator('main')).toBeVisible();
  await page.waitForLoadState('networkidle');
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    // Fluent UI's Tabster inserts focusable aria-hidden sentinels to manage focus in groups and dialogs; they are skipped
    // by screen readers and keyboard focus is redirected, but axe reports them (aria-hidden-focus).
    .exclude('[data-tabster-dummy]')
    .analyze();
  const serious = results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.slice(0, 3).map((n) => `${n.target.join(' ')} ${n.html.slice(0, 120)}`).join(' | ')}`);
  expect(serious, `Accessibility violations on ${name}`).toEqual([]);
}

test('main pages have no serious accessibility violations', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, 'Crm.Admin');
  const m = marker('A11y');
  const organization = await createOrganization(page, { name: `${m} Tilgjengelig AS`, email: `post@${m.toLowerCase()}.no`, phone: '22 00 00 00' });
  const contact = await createContact(page, organization.id, { firstName: 'Aksel', lastName: m, email: `aksel.${m.toLowerCase()}@example.no`, roles: ['Billing'], isPrimary: true });
  const product = await api.post<{ id: string }>(page, '/api/v1/catalog/products', {
    sku: `${m}-A11Y`, name: `${m} Support`, type: 'HourlyService', businessLine: 'Consulting', unit: 'Hour', billingPeriod: 'OneTime', vatRate: 25, listPrice: 1250, unitCost: 500,
  });
  const priceList = await api.post<{ id: string }>(page, '/api/v1/catalog/price-lists', { name: `${m} draft`, customerCategory: 'STANDARD', validFrom: '2030-01-01' });
  await page.request.put(`/api/v1/catalog/price-lists/${priceList.id}/items/${product.id}`, { data: { unitPrice: 1100 }, headers: { 'X-CSRF': '1' } });
  const contract = await api.post<{ id: string }>(page, '/api/v1/contracts', {
    organizationId: organization.id, title: 'Tilgjengelighet', type: 'Msp', startDate: '2026-01-01', endDate: '2026-12-31', autoRenew: true, renewalTermMonths: 12,
    noticePeriodDays: 90, invoiceFrequency: 'Monthly', invoiceTiming: 'InAdvance', indexation: false,
  });
  await api.post(page, `/api/v1/contracts/${contract.id}/lines`, { productId: product.id, quantityModel: 'Fixed', quantity: 2, validFrom: '2026-01-01' });
  const stages = await api.get<Array<{ id: string; isWon: boolean; isLost: boolean }>>(page, '/api/v1/sales/stages');
  const firstStage = stages.find((s) => !s.isWon && !s.isLost)!;
  const opportunity = await api.post<{ id: string }>(page, '/api/v1/sales/opportunities', {
    organizationId: organization.id, contactId: null, name: `${m} Salg`, businessLine: 'Msp', stageId: firstStage.id, probability: null,
    expectedCloseDate: '2027-01-15', oneOffAmount: 5000, mrr: 2500, termMonths: 12, ownerId: null, source: 'Kampanje', competitor: null,
  });
  await api.post(page, '/api/v1/sales/leads', { companyName: `${m} Lead AS`, orgNumber: null, contactName: 'Kari Lead', email: null, phone: null, source: 'Nettside', ownerId: null, notes: null });
  await api.post(page, '/api/v1/activities', {
    type: 'Task', organizationId: organization.id, opportunityId: opportunity.id, contractId: null, contactId: null,
    subject: `${m} Ring kunden`, body: 'Avklar behov for lisenser.', dueAt: '2027-01-10T09:00:00Z', priority: 'High', assigneeId: null,
  });
  const quote = await api.post<{ id: string }>(page, '/api/v1/sales/quotes', {
    organizationId: organization.id, contactId: contact.contactId, opportunityId: opportunity.id, title: `${m} Tilbud`, termMonths: 12,
    lines: [{ productId: product.id, name: `${m} Support`, quantity: 10, unitPrice: 1250, discountPct: 20, recurrence: 'OneTime' }],
  });
  await api.post(page, `/api/v1/sales/quotes/${quote.id}/submit`);
  const run = await collectedBillingRun(page, `${m} a11y`);
  const bases = await api.get<Array<{ id: string }>>(page, `/api/v1/billing/runs/${run.id}/bases`);
  const hourBank = await api.post<{ id: string }>(page, '/api/v1/contracts/hour-banks', { organizationId: organization.id, contractId: contract.id, name: 'Klippekort', hours: 10, validFrom: '2026-01-01' });
  // DEV-09: a project with a team, for the team section.
  const project = await api.post<{ id: string }>(page, '/api/v1/projects', {
    organizationId: organization.id, name: `${m} Prosjekt`, type: 'Other', billingModel: 'TimeAndMaterial', startDate: '2026-10-01', budgetHours: 10, budgetAmount: 0,
  });
  const me = await api.get<{ id: string }>(page, '/bff/user');
  await api.post(page, `/api/v1/projects/${project.id}/members`, { userId: me.id });
  // DEV-11: an erasure request with its plan previewed (never carried out), for the request page.
  const privacyCase = await api.post<{ id: string; etag: string }>(page, '/api/v1/privacy/cases', {
    kind: 'Erasure', subjectKind: 'Contact', subjectId: contact.contactId, channel: 'Email', receivedAt: null, note: null,
  });
  const verified = await page.request.post(`/api/v1/privacy/cases/${privacyCase.id}/verify`, {
    data: { method: 'KnownEmail', note: null }, headers: { 'X-CSRF': '1', 'If-Match': privacyCase.etag },
  });
  expect(verified.ok(), await verified.text()).toBeTruthy();
  const previewed = await page.request.post(`/api/v1/privacy/cases/${privacyCase.id}/preview`, {
    data: {}, headers: { 'X-CSRF': '1', 'If-Match': ((await verified.json()) as { etag: string }).etag },
  });
  expect(previewed.ok(), await previewed.text()).toBeTruthy();

  const pages: Array<[string, string]> = [
    ['My day', '/'],
    ['Organizations', '/organizations'],
    ['New organization', '/organizations/new'],
    ['Organization overview', `/organizations/${organization.id}`],
    ['Organization contacts', `/organizations/${organization.id}?tab=contacts`],
    ['Organization history', `/organizations/${organization.id}?tab=history`],
    ['Duplicates', '/organizations/duplicates'],
    ['Contact', `/contacts/${contact.contactId}`],
    ['Audit log', '/admin/audit'],
    ['Record access', '/admin/record-access'],
    ['Users', '/admin/users'],
    ['Integrations', '/admin/integrations'],
    ['Mappings', '/admin/mappings'],
    ['Catalog', '/catalog'],
    ['Price lists', '/catalog?tab=price-lists'],
    ['Customer categories', '/catalog?tab=categories'],
    ['New product', '/catalog/products/new'],
    ['Product', `/catalog/products/${product.id}`],
    ['Price list', `/catalog/price-lists/${priceList.id}`],
    ['Contracts', '/contracts'],
    ['New contract', `/contracts/new?organizationId=${organization.id}`],
    ['Contract', `/contracts/${contract.id}`],
    ['SLA policies', '/contracts/sla-policies'],
    ['Hour bank', `/contracts/hour-banks/${hourBank.id}`],
    ['Organization contracts', `/organizations/${organization.id}?tab=contracts`],
    ['Organization service', `/organizations/${organization.id}?tab=service`],
    ['My timesheet', '/time'],
    ['Time entries', '/time/entries'],
    ['Technicians', '/admin/technicians'],
    ['Pipeline', '/pipeline'],
    ['Leads', '/sales/leads'],
    ['Deal', `/sales/opportunities/${opportunity.id}`],
    ['Pipeline stages', '/admin/pipeline'],
    ['Projects', '/projects'],
    ['Project', `/projects/${project.id}`],
    ['SLA report', '/service/sla'],
    ['Margins', '/reports/margins'],
    ['Custom fields', '/admin/custom-fields'],
    ['Migration', '/admin/migration'],
    ['Migration runs', '/admin/migration?tab=runs'],
    ['Migration reconciliation', '/admin/migration?tab=reconcile'],
    ['Licenses', '/licenses'],
    ['Licence usage', '/licenses?view=usage'],
    ['Microsoft reconciliation', '/licenses?view=reconciliation'],
    ['Organization deals', `/organizations/${organization.id}?tab=deals`],
    ['Organization licenses', `/organizations/${organization.id}?tab=licenses`],
    ['Organization projects', `/organizations/${organization.id}?tab=projects`],
    ['Organization activities', `/organizations/${organization.id}?tab=activities`],
    ['Organization mail', `/organizations/${organization.id}?tab=mail`],
    ['Organization documents', `/organizations/${organization.id}?tab=documents`],
    ['Price indexation', '/contracts/indexation'],
    ['Billing runs', '/billing'],
    ['Billing run', `/billing/runs/${run.id}`],
    ['Pilot reconciliation', `/billing/runs/${run.id}/pilot`],
    ['Invoices', '/billing/invoices'],
    ['Organization invoices', `/organizations/${organization.id}?tab=invoices`],
    ...(bases[0] ? [['Billing basis', `/billing/bases/${bases[0].id}`] as [string, string]] : []),
    ['Quotes', '/quotes'],
    ['New quote', `/quotes/new?organizationId=${organization.id}`],
    ['Quote', `/quotes/${quote.id}`],
    ['Quote templates', '/admin/quote-templates'],
    ['Dashboard', '/dashboard'],
    ['Notifications', '/notifications'],
    ['Personal data', '/admin/privacy'],
    ['New personal data request', `/admin/privacy/new?subjectKind=Contact&subjectId=${contact.contactId}`],
    ['Personal data request', `/admin/privacy/cases/${privacyCase.id}`],
    ['Maintenance', '/admin/maintenance'],
  ];

  for (const [name, path] of pages) {
    await page.goto(path);
    await expectNoSeriousViolations(page, name);
  }

  // DEV-20: a preview with a rejected row, its reason breakdown and the owner coverage on screen.
  await page.goto('/admin/migration');
  await page.getByRole('textbox', { name: 'Or paste the rows' }).fill('Navn;Organisasjonsnummer\nA11y Migrering AS;123\nA11y Annen AS;');
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByRole('region', { name: 'Rows that change something or need attention' })).toBeVisible();
  await expectNoSeriousViolations(page, 'Migration preview');

  // DEV-22: a comparison with an unknown customer, its result and the sign-off form on screen.
  const runPeriod = (await api.get<{ periodStart: string }>(page, `/api/v1/billing/runs/${run.id}`)).periodStart.slice(0, 7);
  await page.goto(`/billing/runs/${run.id}/pilot`);
  await page.getByRole('textbox', { name: 'Or paste the rows' }).fill(
    `orgnr;period;currency;group;productCode;quantity;amountExVat;externalRef\n123456789;${runPeriod};NOK;Subscription;;;100;A11Y`,
  );
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Finance sign-off' })).toBeVisible();
  await expectNoSeriousViolations(page, 'Pilot comparison and sign-off');

  // DEV-13: the maintenance banner and the paused sign-in, with the public state faked for this page only — switching the
  // shared application to read-only would stop the specs running beside this one.
  await page.route('**/bff/maintenance', (route) =>
    route.fulfill({ json: { mode: 'ReadOnly', since: new Date().toISOString(), reason: 'e2e: restore drill' } }));
  await page.goto('/organizations');
  await expect(page.getByText('Read-only maintenance')).toBeVisible();
  await expectNoSeriousViolations(page, 'Maintenance banner');
  await page.route('**/bff/user', (route) => route.fulfill({ status: 401, json: { status: 401 } }));
  await page.goto('/?maintenance=signin');
  await expect(page.getByRole('heading', { name: 'Signing in is paused' })).toBeVisible();
  await expectNoSeriousViolations(page, 'Sign-in paused');
  await page.unroute('**/bff/user');
  await page.unroute('**/bff/maintenance');

  await page.goto(`/organizations/${organization.id}?tab=contacts`);
  await page.getByRole('button', { name: 'Add contact' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectNoSeriousViolations(page, 'Add contact dialog');

  await page.goto(`/contracts/${contract.id}`);
  await page.getByRole('button', { name: 'Add line' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectNoSeriousViolations(page, 'Add line dialog');

  await page.goto('/licenses');
  await page.getByRole('button', { name: 'Import from distributor' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectNoSeriousViolations(page, 'Import subscriptions dialog');

  await page.goto(`/sales/opportunities/${opportunity.id}`);
  await page.getByRole('button', { name: 'Log activity' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectNoSeriousViolations(page, 'Log activity dialog');

  await page.goto('/billing');
  await page.getByRole('button', { name: 'New run' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectNoSeriousViolations(page, 'New billing run dialog');

  await page.goto(`/quotes/${quote.id}`);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectNoSeriousViolations(page, 'Send quote dialog');

  await page.goto(`/admin/privacy/cases/${privacyCase.id}`);
  await page.getByRole('button', { name: 'Carry out the erasure' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectNoSeriousViolations(page, 'Carry out erasure dialog');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();

  await page.goto('/');
  await page.getByRole('button', { name: /^Notifications/ }).click();
  await expect(page.getByRole('button', { name: 'See all' })).toBeVisible();
  await expectNoSeriousViolations(page, 'Notification bell');
});

test('the app can be used with the keyboard', async ({ page }) => {
  await signIn(page, 'Crm.Sales');
  const m = marker('Kbd');
  const organization = await createOrganization(page, { name: `${m} Tastatur AS` });

  // First Tab reaches the skip link, which moves focus to the main content.
  await page.goto('/organizations');
  await expect(page.getByRole('heading', { level: 1, name: 'Organizations' })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();

  // A dialog opened from the keyboard closes with Escape and returns focus to its trigger.
  await page.goto(`/organizations/${organization.id}?tab=contacts`);
  const add = page.getByRole('button', { name: 'Add contact' });
  await add.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'First name' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(add).toBeFocused();

  // Tabs switch with arrow keys.
  await page.getByRole('tab', { name: 'Contacts' }).focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: 'Contracts' })).toHaveAttribute('aria-selected', 'true');
});
