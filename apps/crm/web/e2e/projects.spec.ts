import { expect, test, type Page } from '@playwright/test';
import { api, createOrganization, marker, orgNumber, searchList, signIn, toast } from './support';

/**
 * Sets the phase's status from its row. The project is read again after a task is added or changed, which draws the phase row
 * anew, and a list opened just before closes with it: the choice is made again until the option could be picked.
 */
async function setPhaseStatus(page: Page, status: string) {
  await expect(async () => {
    await page.getByRole('combobox', { name: 'Status' }).first().click();
    await page.getByRole('option', { name: status }).click({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

test('a project is planned in phases and a completed phase queues its fee', async ({ page }) => {
  test.setTimeout(120_000);
  const m = marker('Prj');
  await signIn(page, 'Crm.Admin');
  const organization = await createOrganization(page, { name: `${m} Prosjekt AS`, status: 'Customer', orgNumber: orgNumber() });

  await page.goto('/projects');
  await page.getByRole('button', { name: 'New project' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Customer' }).pressSequentially(m);
  await page.getByRole('option', { name: `${m} Prosjekt AS` }).click();
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(`${m} M365 migration`);
  await dialog.getByRole('textbox', { name: 'Budget, hours' }).fill('120');
  await dialog.getByRole('textbox', { name: 'Budget, amount' }).fill('180000');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(toast(page, 'Project created')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: `${m} M365 migration` })).toBeVisible();

  await page.getByRole('button', { name: 'Add phase' }).click();
  const phaseDialog = page.getByRole('dialog');
  await phaseDialog.getByRole('textbox', { name: 'Phase', exact: true }).fill('Pilot');
  await phaseDialog.getByRole('textbox', { name: 'Planned hours' }).fill('40');
  await phaseDialog.getByRole('textbox', { name: 'Fee' }).fill('40000');
  await phaseDialog.getByRole('button', { name: 'Save' }).click();
  await expect(toast(page, 'Phase added')).toBeVisible();

  await page.getByRole('button', { name: 'Add task' }).click();
  const taskDialog = page.getByRole('dialog');
  await taskDialog.getByRole('textbox', { name: 'Task', exact: true }).fill('Migrate mailboxes');
  await taskDialog.getByRole('textbox', { name: 'Estimate, h' }).fill('8');
  await taskDialog.getByRole('button', { name: 'Save' }).click();
  await expect(toast(page, 'Task added')).toBeVisible();

  // An open task keeps the phase — and its fee — from being completed.
  await setPhaseStatus(page, 'Completed');
  await expect(page.locator('.fui-ToastBody').filter({ hasText: 'The phase still has open tasks' })).toBeVisible();

  await page.getByRole('row').filter({ hasText: 'Migrate mailboxes' }).getByRole('button', { name: 'Edit' }).click();
  const editTask = page.getByRole('dialog');
  await editTask.getByRole('combobox', { name: 'Status' }).click();
  await page.getByRole('option', { name: 'Done' }).click();
  await editTask.getByRole('button', { name: 'Save' }).click();
  await expect(toast(page, 'Task updated')).toBeVisible();

  await setPhaseStatus(page, 'Completed');
  await expect(toast(page, 'Phase completed; the fee is waiting for the next billing run')).toBeVisible();

  // The fee is queued as a one-time charge, and the project shows it (FR-PRJ-01).
  await expect(page.getByText('NOK 40,000.00').first()).toBeVisible();

  // The customer card lists the project on its own tab.
  await page.goto(`/organizations/${organization.id}?tab=projects`);
  await expect(page.getByRole('link', { name: `${m} M365 migration` })).toBeVisible();
});

test('a subsidiary can be put on the parent company invoice', async ({ page }) => {
  const m = marker('Grp');
  await signIn(page, 'Crm.Admin');
  const parent = await createOrganization(page, { name: `${m} Konsern AS`, status: 'Customer', orgNumber: orgNumber() });
  const child = await createOrganization(page, { name: `${m} Datter AS`, status: 'Customer', orgNumber: orgNumber() });

  await page.goto(`/organizations/${child.id}`);
  await page.getByRole('button', { name: 'Add to a group' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Parent company' }).pressSequentially(`${m} Konsern`);
  await page.getByRole('option', { name: `${m} Konsern AS` }).click();
  await dialog.getByRole('switch', { name: 'The parent is invoiced for this company' }).click();
  await expect(dialog.getByText(`these lines appear on ${m} Konsern AS`)).toBeVisible();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(toast(page, 'Group saved')).toBeVisible();

  await expect(page.getByText('invoiced through the parent')).toBeVisible();
  await page.goto(`/organizations/${parent.id}`);
  await expect(page.getByRole('link', { name: `${m} Datter AS` })).toBeVisible();
  await expect(page.getByText('on this invoice')).toBeVisible();
});

test('finance previews the yearly indexation before the prices change', async ({ page }) => {
  test.setTimeout(120_000);
  const m = marker('Idx');
  await signIn(page, 'Crm.Admin');
  const organization = await createOrganization(page, { name: `${m} Indeks AS`, status: 'Customer' });
  await signIn(page, 'Crm.Finance');
  const product = await api.post<{ id: string }>(page, '/api/v1/catalog/products', {
    sku: `${m}-SRV`, name: `${m} Managed server`, type: 'ManagedService', businessLine: 'Atera', unit: 'Device', billingPeriod: 'Monthly', vatRate: 25, listPrice: 1490,
  });
  const start = new Date();
  start.setMonth(start.getMonth() - 6);
  const startDate = start.toISOString().slice(0, 10);
  const contract = await api.post<{ id: string }>(page, '/api/v1/contracts', {
    organizationId: organization.id,
    title: `${m} Drift`,
    type: 'Msp',
    startDate,
    endDate: null,
    autoRenew: false,
    renewalTermMonths: 0,
    noticePeriodDays: 90,
    invoiceFrequency: 'Monthly',
    invoiceTiming: 'InAdvance',
    indexation: true,
    nextIndexationDate: startDate,
  });
  await api.post(page, `/api/v1/contracts/${contract.id}/lines`, {
    productId: product.id, quantityModel: 'Fixed', quantity: 1, unitPrice: 1000, discountPct: 0, validFrom: startDate,
  });
  await api.post(page, `/api/v1/contracts/${contract.id}/activate`);

  const effectiveFrom = new Date();
  effectiveFrom.setMonth(effectiveFrom.getMonth() + 1);
  const effective = effectiveFrom.toISOString().slice(0, 10);

  await page.goto('/contracts/indexation');
  await page.getByRole('textbox', { name: 'Percentage' }).fill('3.5');
  await page.getByRole('textbox', { name: 'From date' }).fill(effective);
  await page.getByRole('button', { name: 'Show preview' }).click();

  const row = page.getByRole('row').filter({ hasText: `${m} Drift` });
  await expect(row.getByRole('cell', { name: 'NOK 1,000.00', exact: true })).toBeVisible();
  await expect(row.getByRole('cell', { name: 'NOK 1,035.00', exact: true })).toBeVisible();

  // The preview wrote nothing until a contract is picked and the change applied.
  await row.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Index 1 contract' }).click();
  await expect(toast(page, 'Indexed 1 contract and 1 line')).toBeVisible();

  await page.goto(`/contracts/${contract.id}`);
  await expect(page.getByText('NOK 1,035.00').first()).toBeVisible();
});

test('a technician sees a project once on its team, and a project they are not on does not exist for them', async ({ page }) => {
  const m = marker('Scope');
  await signIn(page, 'Crm.Admin');
  const organization = await createOrganization(page, { name: `${m} Omfang AS`, status: 'Customer', orgNumber: orgNumber() });
  const project = await api.post<{ id: string }>(page, '/api/v1/projects', {
    organizationId: organization.id, name: `${m} Utrulling`, type: 'Other', billingModel: 'TimeAndMaterial', startDate: '2026-10-01', budgetHours: 10, budgetAmount: 0,
  });

  // DEV-09: the list says whose projects it holds; a saved link to someone else's project is a page that does not exist.
  await signIn(page, 'Crm.Technician', '/projects');
  await expect(page.getByText('The projects you are on: as manager, team member or task assignee.')).toBeVisible();
  // The answer to this very search: until it is there, the list is the technician's projects before the search.
  await searchList(page, page.getByRole('searchbox', { name: 'Search project or number' }), '/api/v1/projects', m);
  await expect(page.getByText('No projects yet.')).toBeVisible();
  await page.goto(`/projects/${project.id}`);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();

  // The administrator puts the technician on the team; the project is theirs to see at once.
  await signIn(page, 'Crm.Admin', `/projects/${project.id}`);
  await page.getByRole('combobox', { name: 'Person' }).pressSequentially('Dev Technician');
  await page.getByRole('option', { name: /Dev Technician/ }).click();
  await page.getByRole('button', { name: 'Add to team' }).click();
  await expect(toast(page, 'Dev Technician is on the team.')).toBeVisible();

  await signIn(page, 'Crm.Technician', `/projects/${project.id}`);
  await expect(page.getByRole('heading', { level: 1, name: `${m} Utrulling` })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Team' }).getByText('Dev Technician')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add to team' })).toHaveCount(0);
});
