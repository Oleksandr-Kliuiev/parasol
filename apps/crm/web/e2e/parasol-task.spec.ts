import { expect, test } from '@playwright/test';
import { atlasWorkspace } from '../src/test/atlasWorkspace';
import { createOrganization, marker, signIn } from './support';

// Controlled technical BFF contract journey. SQL tests exercise real creation, replay, receipt and completion separately.
test('review assigns work with explicit employee and source confirmation, then adopts the existing task', { tag: '@critical' }, async ({ page }) => {
  await signIn(page, 'Crm.Admin', '/organizations');
  const customer = await createOrganization(page, { name: marker('Observation work ') });
  const overview = atlasWorkspace(customer.id); const summary = overview.summary!;
  const observation = summary.observationPage.items[0]!;
  const employee = await (await page.request.get('/bff/user')).json() as { id: string };
  const task = { activityId: 'synthetic-task', organizationId: customer.id, status: 'Open', assigneeId: employee.id,
    dueAt: null, created: false, isAvailable: true };
  let writes = 0; let linked = false; const bodies: unknown[] = [];
  await page.route(`**/api/v1/parasol/customers/${customer.id}/workspace`, route => route.fulfill({ json: overview }));
  const path = `**/api/v1/parasol/customers/${customer.id}/observations/${observation.id}`;
  await page.route(`${path}/task-preview`, route => route.fulfill({ json: { customerId: customer.id, status: 'READY',
    mode: 'db', observation, devices: summary.devices, sha256: 'a'.repeat(64), task: linked ? task : null, canCreate: !linked } }));
  await page.route(`${path}/task`, route => {
    writes++; bodies.push(route.request().postDataJSON()); linked = true;
    return route.fulfill({ json: { customerId: customer.id, status: 'CREATED', task: { ...task, created: true } } });
  });
  await page.goto(`/organizations/${customer.id}`);
  const row = page.getByRole('listitem').filter({ hasText: observation.summary });
  await row.getByRole('button', { name: 'Assign work', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Assign observation work' });
  await expect(dialog.getByText(observation.summary, { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Create task', exact: true })).toBeDisabled();
  const picker = dialog.getByRole('combobox');
  await picker.fill('Dev Admin'); await picker.press('ArrowDown');
  await page.getByRole('option').filter({ hasText: 'Dev Admin' }).click();
  await dialog.getByRole('checkbox', { name: 'I confirm the assignee and due date' }).check();
  await dialog.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(dialog.getByRole('link', { name: 'Open customer activities' })).toBeVisible();
  expect(writes).toBe(1); expect(bodies).toEqual([{ assigneeId: employee.id, dueAt: null, expectedSha256: 'a'.repeat(64) }]);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await row.getByRole('button', { name: 'Assign work', exact: true }).click();
  await expect(dialog.getByRole('link', { name: 'Open customer activities' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Create task', exact: true })).toHaveCount(0);
  expect(writes).toBe(1);
});

test('a changed source discards confirmation and requires a new preview before another write', async ({ page }) => {
  await signIn(page, 'Crm.Admin', '/organizations');
  const customer = await createOrganization(page, { name: marker('Changed observation ') });
  const overview = atlasWorkspace(customer.id); const summary = overview.summary!; const observation = summary.observationPage.items[0]!;
  let reads = 0; let writes = 0;
  await page.route(`**/api/v1/parasol/customers/${customer.id}/workspace`, route => route.fulfill({ json: overview }));
  const path = `**/api/v1/parasol/customers/${customer.id}/observations/${observation.id}`;
  await page.route(`${path}/task-preview`, route => {
    reads++; return route.fulfill({ json: { customerId: customer.id, status: 'READY', mode: 'db', observation,
      devices: summary.devices, sha256: (reads === 1 ? 'a' : 'b').repeat(64), task: null, canCreate: true } });
  });
  await page.route(`${path}/task`, route => {
    writes++; return route.fulfill({ status: 409, json: { code: 'PARASOL_TASK_SOURCE_CHANGED', title: 'Review required', status: 409 } });
  });
  await page.goto(`/organizations/${customer.id}`);
  await page.getByRole('listitem').filter({ hasText: observation.summary }).getByRole('button', { name: 'Assign work', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Assign observation work' });
  await dialog.getByRole('combobox').fill('Dev Admin'); await dialog.getByRole('combobox').press('ArrowDown');
  await page.getByRole('option').filter({ hasText: 'Dev Admin' }).click();
  await dialog.getByRole('checkbox').check(); await dialog.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(dialog.getByText(observation.summary, { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Create task', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Read fresh preview', exact: true }).click();
  await expect(dialog.getByText(observation.summary, { exact: true })).toBeVisible();
  await expect(dialog.getByRole('checkbox')).not.toBeChecked();
  expect(reads).toBe(2); expect(writes).toBe(1);
});

test('a source denial during assignment rechecks the whole customer workspace and removes previous technical data', async ({ page }) => {
  await signIn(page, 'Crm.Admin', '/organizations');
  const customer = await createOrganization(page, { name: marker('Revoked observation ') });
  const overview = atlasWorkspace(customer.id); const summary = overview.summary!; const observation = summary.observationPage.items[0]!;
  let denied = false;
  await page.route(`**/api/v1/parasol/customers/${customer.id}/workspace`, route => route.fulfill({ json:
    denied ? { customerId: customer.id, status: 'ACCESS_DENIED', summary: null } : overview,
  }));
  const path = `**/api/v1/parasol/customers/${customer.id}/observations/${observation.id}`;
  await page.route(`${path}/task-preview`, route => route.fulfill({ json: { customerId: customer.id, status: 'READY', mode: 'db',
    observation, devices: summary.devices, sha256: 'a'.repeat(64), task: null, canCreate: true } }));
  await page.route(`${path}/task`, route => {
    denied = true; return route.fulfill({ status: 409, json: { code: 'PARASOL_TASK_SOURCE_UNAVAILABLE', title: 'Refresh required', status: 409 } });
  });
  await page.goto(`/organizations/${customer.id}`);
  const panel = page.getByRole('region', { name: 'Technical workspace · Atlas' });
  await panel.getByRole('listitem').filter({ hasText: observation.summary }).getByRole('button', { name: 'Assign work', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Assign observation work' });
  await dialog.getByRole('combobox').fill('Dev Admin'); await dialog.getByRole('combobox').press('ArrowDown');
  await page.getByRole('option').filter({ hasText: 'Dev Admin' }).click();
  await dialog.getByRole('checkbox').check(); await dialog.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(panel.getByText('Your Atlas access does not permit reading this customer.')).toBeVisible();
  await expect(page.getByText(observation.summary, { exact: true })).toHaveCount(0);
  await expect(panel.getByRole('tab')).toHaveCount(0);
});
