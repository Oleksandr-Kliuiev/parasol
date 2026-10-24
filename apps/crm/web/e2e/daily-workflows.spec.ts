import { expect, test } from '@playwright/test';
import { api, collectedBillingRun, createOrganization, marker, signIn, toast } from './support';

// DEV-18: how the interface behaves when things go wrong during daily work — a record changed by someone else, an unsaved
// form, a repeated click, a rate limit, no connection, a long export — and saved views.

test('a save that loses to someone else shows both versions and never overwrites in silence', { tag: '@critical' }, async ({ page, context }) => {
  const m = marker('Conf');
  await signIn(page, 'Crm.Sales');
  const organization = await createOrganization(page, { name: `${m} AS`, phone: '11 11 11 11' });

  // Tab A starts editing; tab B changes the phone and the name first.
  await page.goto(`/organizations/${organization.id}/edit`);
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(`${m} AS`);
  const other = await context.newPage();
  await other.goto(`/organizations/${organization.id}/edit`);
  await other.getByRole('textbox', { name: 'Phone', exact: true }).fill('22 22 22 22');
  await other.getByRole('textbox', { name: 'Website', exact: true }).fill('https://their.example.no');
  await other.getByRole('button', { name: 'Save' }).click();
  await expect(toast(other, 'Changes saved')).toBeVisible();
  await other.close();

  // Tab A changes the phone as well and the e-mail, then saves.
  await page.getByRole('textbox', { name: 'Phone', exact: true }).fill('33 33 33 33');
  await page.getByRole('textbox', { name: 'E-mail', exact: true }).fill(`mine.${m.toLowerCase()}@example.no`);
  await page.getByRole('button', { name: 'Save' }).click();

  const conflict = page.getByRole('alert').filter({ hasText: 'changed while you were editing' });
  await expect(conflict).toBeVisible();
  // The overlapping field is shown with both values; the field only the other side changed is named as kept.
  await expect(conflict.getByRole('listitem').filter({ hasText: 'Phone' })).toContainText('33 33 33 33');
  await expect(conflict.getByRole('listitem').filter({ hasText: 'Phone' })).toContainText('22 22 22 22');
  await expect(conflict).toContainText('Website');
  // Nothing was written: the stored phone is still the other tab's.
  const stored = await api.get<{ phone: string; website: string }>(page, `/api/v1/customers/organizations/${organization.id}`);
  expect(stored.phone).toBe('22 22 22 22');

  await conflict.getByRole('button', { name: 'Keep my changes on the latest version' }).click();
  await expect(conflict).toBeHidden();
  // My fields are laid over the latest version; theirs (website) are there too. Still nothing saved until I save.
  await expect(page.getByRole('textbox', { name: 'Phone', exact: true })).toHaveValue('33 33 33 33');
  await expect(page.getByRole('textbox', { name: 'Website', exact: true })).toHaveValue('https://their.example.no');
  expect((await api.get<{ phone: string }>(page, `/api/v1/customers/organizations/${organization.id}`)).phone).toBe('22 22 22 22');

  await page.getByRole('button', { name: 'Save' }).click();
  await expect(toast(page, 'Changes saved')).toBeVisible();
  const final = await api.get<{ phone: string; website: string; email: string }>(page, `/api/v1/customers/organizations/${organization.id}`);
  expect(final).toMatchObject({ phone: '33 33 33 33', website: 'https://their.example.no', email: `mine.${m.toLowerCase()}@example.no` });
});

test('discarding my side after a conflict shows the latest version', async ({ page, context }) => {
  const m = marker('Latest');
  await signIn(page, 'Crm.Sales');
  const organization = await createOrganization(page, { name: `${m} AS`, phone: '11 11 11 11' });
  await page.goto(`/organizations/${organization.id}/edit`);
  await expect(page.getByRole('textbox', { name: 'Phone', exact: true })).toHaveValue('11 11 11 11');
  const other = await context.newPage();
  await other.goto(`/organizations/${organization.id}/edit`);
  await other.getByRole('textbox', { name: 'Phone', exact: true }).fill('22 22 22 22');
  await other.getByRole('button', { name: 'Save' }).click();
  await expect(toast(other, 'Changes saved')).toBeVisible();
  await other.close();

  await page.getByRole('textbox', { name: 'Phone', exact: true }).fill('33 33 33 33');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Discard mine, show the latest' }).click();
  await expect(page.getByRole('textbox', { name: 'Phone', exact: true })).toHaveValue('22 22 22 22');
});

test('leaving a form with unsaved changes asks first and returns focus when the user stays', { tag: '@critical' }, async ({ page }) => {
  await signIn(page, 'Crm.Sales', '/organizations/new');
  const name = page.getByRole('textbox', { name: 'Name', exact: true });
  await name.fill(`${marker('Draft')} AS`);

  const cancel = page.getByRole('button', { name: 'Cancel' });
  await cancel.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog'));
  await expect(dialog).toContainText('Leave without saving?');
  await expect(page).toHaveURL(/\/organizations\/new$/);

  await dialog.getByRole('button', { name: 'Keep editing' }).click();
  await expect(dialog).toBeHidden();
  await expect(name).toHaveValue(/Draft/);
  await expect(cancel).toBeFocused();

  await cancel.click();
  await dialog.getByRole('button', { name: 'Leave and discard' }).click();
  await expect(page).toHaveURL(/\/organizations$/);
});

test('a form that was saved leaves without asking', async ({ page }) => {
  await signIn(page, 'Crm.Sales', '/organizations/new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(`${marker('Saved')} AS`);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(toast(page, 'Organization created')).toBeVisible();
  await expect(page).toHaveURL(/\/organizations\/[0-9a-f-]{36}$/);
  await expect(page.getByText('Leave without saving?')).toHaveCount(0);
});

test('a missing name is announced and tied to its field', async ({ page }) => {
  await signIn(page, 'Crm.Sales', '/organizations/new');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const name = page.getByRole('textbox', { name: 'Name', exact: true });
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  // The field says what it wants; the summary above the form says that something needs a look.
  await expect(name).toHaveAccessibleDescription(/Enter the organization's name/);
  await expect(page.getByRole('alert').or(page.locator('[aria-live]').filter({ hasText: 'Check the highlighted fields' })).first()).toContainText('Check the highlighted fields');
});

test('a double click on Create makes one organization', async ({ page }) => {
  const m = marker('Dbl');
  await signIn(page, 'Crm.Sales', '/organizations/new');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(`${m} AS`);
  await page.getByRole('button', { name: 'Create', exact: true }).dblclick();
  await expect(toast(page, 'Organization created')).toBeVisible();
  const found = await api.get<{ items: unknown[] }>(page, `/api/v1/customers/organizations?search=${m}`);
  expect(found.items).toHaveLength(1);
});

test('a rate limit says how long to wait and keeps the draft', async ({ page }) => {
  const m = marker('Rate');
  await signIn(page, 'Crm.Sales');
  const organization = await createOrganization(page, { name: `${m} AS` });
  await page.goto(`/organizations/${organization.id}/edit`);
  await page.route(`**/api/v1/customers/organizations/${organization.id}`, (route) =>
    route.request().method() === 'PUT'
      ? route.fulfill({ status: 429, headers: { 'Retry-After': '7', 'Content-Type': 'application/problem+json' }, body: JSON.stringify({ status: 429, title: 'Too many requests' }) })
      : route.continue(),
  );
  await page.getByRole('textbox', { name: 'Phone', exact: true }).fill('44 44 44 44');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Too many requests. Try again in 7 seconds.')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Phone', exact: true })).toHaveValue('44 44 44 44');
});

test('saving without a connection says nothing was sent and keeps the draft', async ({ page, context }) => {
  const m = marker('Off');
  await signIn(page, 'Crm.Sales');
  const organization = await createOrganization(page, { name: `${m} AS` });
  await page.goto(`/organizations/${organization.id}/edit`);
  await expect(page.getByRole('textbox', { name: 'Phone', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Phone', exact: true }).fill('55 55 55 55');
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('You are offline. Reconnect and try again; nothing was sent.')).toBeVisible();
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(toast(page, 'Changes saved')).toBeVisible();
});

test('a long export shows its progress and survives a failed refresh', async ({ page }) => {
  await signIn(page, 'Crm.Finance');
  const run = await collectedBillingRun(page, marker('Exp'));
  const path = `**/api/v1/billing/runs/${run.id}`;
  let failNext = false;
  await page.route(path, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    if (failNext) return route.abort('connectionfailed');
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    return route.fulfill({ response, json: { ...body, status: 'Exporting', exported: 2, failed: 1, organizations: 5 } });
  });
  await page.goto(`/billing/runs/${run.id}`);
  const progress = page.getByRole('status').filter({ hasText: 'Sending to PowerOffice' });
  await expect(progress).toContainText('2 sent, 1 failed, out of 5 customers');
  await expect(progress).toContainText('nothing is sent twice');
  // The action buttons that start a second export are not offered while it runs.
  await expect(page.getByRole('button', { name: /Send to PowerOffice|Retry/ })).toHaveCount(0);

  failNext = true;
  await progress.getByRole('button', { name: 'Refresh now' }).click();
  await expect(page.getByText(/Could not refresh the run/)).toBeVisible();
  // The run is still on screen.
  await expect(page.getByRole('status').filter({ hasText: 'Sending to PowerOffice' })).toBeVisible();
});

test('saved views keep filters for this account and apply them again', async ({ page }) => {
  await signIn(page, 'Crm.Sales', '/organizations?status=Customer');
  await page.getByRole('button', { name: 'Views' }).click();
  await page.getByRole('menuitem', { name: 'Save current filters…' }).click();
  await page.getByRole('textbox', { name: 'Name of the view' }).fill('Customers');
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  await page.goto('/organizations');
  await expect(page).not.toHaveURL(/status=/);
  await page.reload();
  await page.getByRole('button', { name: 'Views' }).click();
  await page.getByRole('menuitem', { name: 'Customers' }).click();
  await expect(page).toHaveURL(/status=Customer/);

  // Another account in the same browser does not see it.
  await signIn(page, 'Crm.Finance', '/organizations');
  await page.getByRole('button', { name: 'Views' }).click();
  await expect(page.getByRole('menuitem', { name: 'Customers' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // An old format is cleared with an explanation, not shown half-working.
  const me = await api.get<{ id: string }>(page, '/bff/user');
  await page.evaluate((key) => localStorage.setItem(key, '[{"name":"Old","filters":{}}]'), `crm.views.${me.id}.organizations`);
  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: 'could not be kept' })).toBeVisible();
  await page.getByRole('button', { name: 'Views' }).click();
  await expect(page.getByRole('menuitem', { name: 'No saved views' })).toBeVisible();
});

// Chromium only: Safari moves Tab between form fields but skips buttons unless the system's keyboard navigation is on, and Firefox
// on macOS selects text differently; the same flow is checked by hand there (evidence/DEV-18.md).
test('a record is created and then corrected with the keyboard alone', async ({ page }) => {
  const m = marker('Kbd');
  await signIn(page, 'Crm.Sales', '/organizations/new');
  const name = page.getByRole('textbox', { name: 'Name', exact: true });
  await name.focus();
  await page.keyboard.type(`${m} AS`);

  // Tab until the Create button has focus, then press it: no pointer anywhere in this flow.
  const create = page.getByRole('button', { name: 'Create', exact: true });
  for (let i = 0; i < 60 && !(await create.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
  await expect(create).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(toast(page, 'Organization created')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: `${m} AS` })).toBeVisible();

  // Correct it: an invalid e-mail is announced next to its field and the focus can reach the field again.
  await page.getByRole('button', { name: 'Edit' }).focus();
  await page.keyboard.press('Enter');
  const email = page.getByRole('textbox', { name: 'E-mail', exact: true });
  await email.focus();
  await page.keyboard.type('not-an-address');
  await page.keyboard.press('Tab');
  await expect(email).toHaveAttribute('aria-invalid', 'true');
  await expect(email).toHaveAccessibleDescription(/Enter an e-mail address like post@firma\.no/);
  await email.focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await page.keyboard.type(`post@${m.toLowerCase()}.no`);
  const save = page.getByRole('button', { name: 'Save' });
  for (let i = 0; i < 60 && !(await save.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(toast(page, 'Changes saved')).toBeVisible();
  await expect(page.getByRole('link', { name: `post@${m.toLowerCase()}.no` })).toBeVisible();
});
