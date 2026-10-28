import { expect, test, type Page } from '@playwright/test';
import { huntressAlerts, huntressIncident, linkedHuntressCustomer, syncHuntress } from './huntress';
import { collectedBillingRun, createContact, createOrganization, marker, signIn } from './support';

const createContactForMobile = (page: Page, organizationId: string, m: string) =>
  createContact(page, organizationId, { firstName: 'Mobil', lastName: m, email: `${m.toLowerCase()}@example.no`, mobilePhone: '900 00 000' });

async function expectNoHorizontalScroll(page: Page, name: string) {
  await expect(page.getByRole('main')).toBeVisible();
  await page.waitForLoadState('networkidle');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `${name} scrolls horizontally by ${overflow}px`).toBeLessThanOrEqual(1);
}

/** The same for an open dialog: a modal hides <main> from the accessibility tree, so the dialog itself and the page are measured. */
async function expectDialogFits(page: Page, dialog: ReturnType<Page['getByRole']>, name: string) {
  await expect(dialog).toBeVisible();
  await page.waitForLoadState('networkidle');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `${name}: the page scrolls horizontally by ${overflow}px`).toBeLessThanOrEqual(1);
  const inside = await dialog.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(inside, `${name} scrolls sideways by ${inside}px`).toBeLessThanOrEqual(1);
}

test('pages fit a phone screen and navigation works', async ({ page }) => {
  await signIn(page, 'Crm.Sales');
  const m = marker('Mob');
  const organization = await createOrganization(page, { name: `${m} Mobil AS`, email: `post@${m.toLowerCase()}.no` });

  for (const [name, path] of [
    ['My day', '/'],
    ['Organizations', '/organizations'],
    ['Organization', `/organizations/${organization.id}`],
    ['Organization contacts', `/organizations/${organization.id}?tab=contacts`],
    ['New organization', '/organizations/new'],
    ['Duplicates', '/organizations/duplicates'],
    ['Catalog', '/catalog'],
    ['Contracts', '/contracts'],
    ['Organization contracts', `/organizations/${organization.id}?tab=contracts`],
    ['New contract', `/contracts/new?organizationId=${organization.id}`],
    ['My timesheet', '/time'],
    ['Organization operations', `/organizations/${organization.id}?tab=drift`],
    ['Alerts', '/alerts'],
    ['Pipeline', '/pipeline'],
    ['Leads', '/sales/leads'],
    ['Projects', '/projects'],
    ['Margins', '/reports/margins'],
    ['Licenses', '/licenses'],
    ['Organization deals', `/organizations/${organization.id}?tab=deals`],
    ['Organization activities', `/organizations/${organization.id}?tab=activities`],
    ['Organization documents', `/organizations/${organization.id}?tab=documents`],
    ['Billing runs', '/billing'],
    ['Invoices', '/billing/invoices'],
    ['Organization invoices', `/organizations/${organization.id}?tab=invoices`],
    ['Notifications', '/notifications'],
    ['My account', '/account'],
    ['Quotes', '/quotes'],
    ['New quote', `/quotes/new?organizationId=${organization.id}`],
  ] as const) {
    await page.goto(path);
    await expectNoHorizontalScroll(page, name);
  }

  // Contact details that a technician taps (e-mail, phone) are visible without horizontal scrolling.
  await createContactForMobile(page, organization.id, m);
  await page.goto(`/organizations/${organization.id}?tab=contacts`);
  const email = page.getByRole('link', { name: `${m.toLowerCase()}@example.no` });
  await expect(email).toBeInViewport();
  await expect(page.getByRole('link', { name: '900 00 000' })).toBeInViewport();

  // Phone navigation: the bottom tabs reach the daily places, "More" opens the full menu (UX concept §4).
  await page.goto('/');
  const tabs = page.getByRole('navigation', { name: 'Main sections' });
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeHidden();
  await tabs.getByRole('link', { name: 'Customers' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Organizations' })).toBeVisible();
  await expect(tabs.getByRole('link', { name: 'Customers' })).toHaveAttribute('aria-current', 'page');
  await tabs.getByRole('button', { name: 'More' }).click();
  // The full menu is a drawer loaded on first use: Leads is looked up in it, by its exact name, as a customer behind it may be
  // called "LeadS5N0ZL Nykunde AS" (a leads test's marker) and was clicked instead while the drawer was still loading.
  await page.getByRole('dialog', { name: 'Main menu' }).getByRole('link', { name: 'Leads', exact: true }).click();
  await expect(page).toHaveURL(/\/sales\/leads/);

  // Search is a dialog (the command palette), opened from the top bar on a phone.
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const search = page.getByRole('dialog', { name: 'Search' }).getByRole('combobox', { name: 'Search customers, devices and more' });
  await search.fill(m);
  const option = page.getByRole('option', { name: new RegExp(`^${m} Mobil AS`) });
  await expect(option).toBeVisible();
  const box = await option.boundingBox();
  const width = page.viewportSize()!.width;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width);
});

test('the migration screens fit a phone screen with a preview on show', async ({ page }) => {
  const m = marker('MobMig');
  await signIn(page, 'Crm.Admin');
  await page.goto('/admin/migration');
  await expectNoHorizontalScroll(page, 'Migration');
  await page.getByRole('textbox', { name: 'Or paste the rows' }).fill(`Navn;Organisasjonsnummer\n${m} Mobil Migrering AS;123\n${m} Annen AS;`);
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByRole('region', { name: 'Rows that change something or need attention' })).toBeVisible();
  await expectNoHorizontalScroll(page, 'Migration preview');
  for (const [name, path] of [
    ['Migration runs', '/admin/migration?tab=runs'],
    ['Migration reconciliation', '/admin/migration?tab=reconcile'],
  ] as const) {
    await page.goto(path);
    await expectNoHorizontalScroll(page, name);
  }
});

test('the pilot reconciliation page fits a phone screen', async ({ page }) => {
  await signIn(page, 'Crm.Finance');
  const run = await collectedBillingRun(page, marker('MobPil'));
  await page.goto(`/billing/runs/${run.id}/pilot`);
  await expect(page.getByRole('heading', { level: 1, name: 'Pilot reconciliation' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Lines of the run' })).toBeVisible();
  await expectNoHorizontalScroll(page, 'Pilot reconciliation');
});

// M41: a Huntress incident is answered on a phone too: its panel, plan and comment box fit the screen, and approving the plan goes
// through the one confirmation.
test('a Huntress incident is read and answered on a phone', async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page, 'Crm.Admin');
  const customer = await linkedHuntressCustomer(page, 'Mob');
  const m = customer.marker;
  await huntressIncident(page, customer, { subject: `LOW - Incident ${m} on a phone`, remediations: [{ type: 'assisted', action: 'Delete scheduled task' }] });
  await syncHuntress(page, ['huntress-alerts'], async () => (await huntressAlerts(page, customer.organizationId)).length === 1, `the incident of ${customer.name}`);

  await page.goto('/alerts');
  await page.getByRole('searchbox', { name: 'Search title or device' }).fill(m);
  await page.getByRole('button', { name: `LOW - Incident ${m} on a phone`, exact: true }).click();
  const panel = page.getByRole('dialog', { name: `LOW - Incident ${m} on a phone`, exact: true });
  const incident = panel.getByRole('region', { name: 'Security incident', exact: true });
  await expect(incident.getByText('Waiting for you', { exact: true })).toBeVisible();
  await expect(incident.getByRole('textbox', { name: 'New comment' })).toBeVisible();
  await expectDialogFits(page, panel, 'Incident panel');
  await incident.getByRole('button', { name: 'Approve plan', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Approve the remediation plan in Huntress', exact: true });
  await confirm.getByRole('button', { name: 'Approve plan', exact: true }).click();
  await expect(confirm.getByRole('status')).toContainText('Done', { timeout: 30_000 });
  await expectDialogFits(page, confirm, 'Action confirmation');
});
