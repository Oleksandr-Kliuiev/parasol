import { expect, test } from '@playwright/test';
import { atlasWorkspace } from '../src/test/atlasWorkspace';
import { createOrganization, marker, signIn } from './support';

// The BFF -> Atlas HTTP boundary is tested independently with scoped contract fixtures and SQL in AtlasWorkspaceTests.
// This journey controls only the BFF workspace response; CRM navigation, authorization and customer data use the real API.
test('devices and active observations share the customer card and disappear after access is revoked', { tag: '@critical' }, async ({ page }) => {
  await signIn(page, 'Crm.Admin', '/organizations');
  const customer = await createOrganization(page, { name: marker('Technical detail ') });
  const ready = atlasWorkspace(customer.id);
  ready.summary!.activeObservations = 4; ready.summary!.severityCounts.CRITICAL = 2;
  ready.summary!.observationPage.truncated = true;
  let revoked = false;
  let reads = 0;
  await page.route(`**/api/v1/parasol/customers/${customer.id}/workspace`, route => {
    reads++;
    return route.fulfill({ json: revoked ? { customerId: customer.id, status: 'ACCESS_DENIED', summary: null } : ready });
  });
  await page.goto(`/organizations/${customer.id}`);
  const panel = page.getByRole('region', { name: 'Technical workspace · Atlas' });
  const observations = panel.getByRole('region', { name: 'Active Atlas observations' });
  await expect(observations.getByRole('listitem')).toHaveCount(3);
  await expect(observations.getByText(/Only the first 3 of 4 active observations are loaded/)).toBeVisible();
  const critical = observations.getByRole('listitem').filter({ hasText: 'Synthetic disk capacity used: 97%' });
  // The severity badge says the urgency once; the row has no second "urgent" label.
  await expect(critical.getByText('Critical', { exact: true })).toBeVisible();
  await expect(critical.getByText(/Urgent/)).toHaveCount(0);
  await expect(critical.getByText('Atlas recommendation: Monitor')).toBeVisible();
  await expect(critical.getByText('Confirmed device: SYNTHETIC-LT-01 (device-0)')).toBeVisible();
  await observations.getByLabel('Observation severity').selectOption('URGENT');
  await expect(observations.getByRole('listitem')).toHaveCount(2);
  await observations.getByLabel('Observation state').selectOption('ACKNOWLEDGED');
  await expect(observations.getByRole('listitem')).toHaveCount(1);
  await expect(observations.getByText('Device not resolved in Atlas')).toBeVisible();
  await panel.getByRole('tab', { name: 'Atlas devices', exact: true }).click();
  const devices = panel.getByRole('region', { name: 'Atlas devices' });
  await expect(devices.getByRole('listitem')).toHaveCount(25);
  await devices.getByRole('button', { name: 'Show more loaded devices' }).click();
  await expect(devices.getByRole('listitem')).toHaveCount(42);
  await devices.getByRole('searchbox').fill('device-0');
  await expect(devices.getByRole('listitem')).toHaveCount(1);
  await expect(devices.getByText('Confirmed sources: Atera, Huntress')).toBeVisible();
  expect(reads).toBe(1);
  revoked = true;
  await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(panel.getByText('Your Atlas access does not permit reading this customer.')).toBeVisible();
  await expect(panel.getByRole('tab')).toHaveCount(0);
  await expect(panel.getByText('SYNTHETIC-LT-01', { exact: true })).toHaveCount(0);
  await expect(panel.getByText('Synthetic disk capacity used: 97%')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: customer.name, exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Contacts', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add contact', exact: true })).toBeVisible();
});
