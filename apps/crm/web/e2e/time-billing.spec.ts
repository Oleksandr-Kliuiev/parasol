import { expect, test } from '@playwright/test';
import { api, createOrganization, marker, reservePastBillingRun, signIn, toast } from './support';

test('approved billing explains why hours cannot be refunded and Finance cancellation releases them', { tag: '@critical' }, async ({ page }) => {
  const name = marker('Committed hours ');
  // The run claims a free month before anything is dated in it, so engines and reruns on one database never share a month.
  await signIn(page, 'Crm.Finance'); const run = await reservePastBillingRun(page, name); const { year, month } = run;
  const date = `${year}-${String(month).padStart(2, '0')}-17`;
  await signIn(page, 'Crm.Admin'); const customer = await createOrganization(page, { name, status: 'Customer' });
  // Bought the year before the work, so the package purchase is never part of this run's month.
  const bank = await api.post<{ id: string }>(page, '/api/v1/contracts/hour-banks', { organizationId: customer.id,
    name, hours: 10, validFrom: `${year - 1}-01-01`, overageRate: 100 });
  await signIn(page, 'Crm.ServiceLead');
  const entry = await api.post<{ id: string }>(page, '/api/v1/time/entries', { organizationId: customer.id, workDate: date,
    hours: 2, workType: 'Remote', billable: true, onsite: false, afterHours: false, description: name, clientRequestId: crypto.randomUUID() });
  await api.post(page, '/api/v1/time/approve', { entryIds: [entry.id] });

  await signIn(page, 'Crm.Finance');
  await api.runCommand(page, run.id, 'collect');
  const bases = await api.get<{ id: string; organization: { id: string } }[]>(page, `/api/v1/billing/runs/${run.id}/bases`);
  const basis = bases.find(b => b.organization.id === customer.id)!;
  expect(basis).toBeDefined();
  await page.goto(`/billing/bases/${basis.id}`);
  await page.getByRole('button', { name: 'Add line', exact: true }).click();
  const line = page.getByRole('dialog');
  await line.getByRole('textbox', { name: /^Description\s*\*?$/ }).fill('Synthetic separate fee');
  await line.getByRole('textbox', { name: /^Unit price\s*\*?$/ }).fill('10');
  await line.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(toast(page, 'Line added')).toBeVisible();
  await page.goto(`/billing/runs/${run.id}`);
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(toast(page, 'The run is approved')).toBeVisible();

  await signIn(page, 'Crm.ServiceLead', `/time/entries?year=${year}&month=${month}`);
  const row = page.getByRole('row').filter({ hasText: customer.name });
  await row.getByRole('checkbox').check();
  const refused = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/time/withdraw' && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Withdraw approval (1)', exact: true }).click();
  const response = await refused; expect(response.status()).toBe(409); expect((await response.json()).code).toBe('TIM_BILLING_COMMITTED');
  await expect(page.getByText('Approved billing already includes this work. Ask Finance to cancel an unsent basis or correct it in a later period.', { exact: true })).toBeVisible();
  await expect(row.getByText('Hour bank 2 h', { exact: true })).toBeVisible();
  expect((await api.get<{ remainingHours: number }>(page, `/api/v1/contracts/hour-banks/${bank.id}`)).remainingHours).toBe(8);

  await expect(row.getByRole('link', { name: 'Financial review', exact: true })).toHaveCount(0);
  expect((await page.request.get(`/api/v1/time/entries/${entry.id}/financial-review`)).status()).toBe(403);
  await signIn(page, 'Crm.Finance', `/time/entries?year=${year}&month=${month}`);
  await row.getByRole('link', { name: 'Financial review', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/time/entries/${entry.id}/financial-review$`));
  await expect(page.getByRole('heading', { name: 'Review saved time', exact: true })).toBeVisible();
  await expect(page.getByText('Approved or exported billing protects this work. Use Finance cancellation for an unsent basis, or a later-period correction.', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Hour bank comparison', exact: true }).getByRole('link', { name, exact: true })).toHaveAttribute('href', `/contracts/hour-banks/${bank.id}`);
  await page.getByRole('link', { name: 'Open billing record', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel basis', exact: true }).click();
  const cancel = page.getByRole('dialog');
  await cancel.getByRole('textbox', { name: /^Reason\s*\*?$/ }).fill('Synthetic reviewed customer correction');
  await cancel.getByRole('button', { name: 'Cancel basis', exact: true }).click();
  await expect(toast(page, 'The basis is cancelled')).toBeVisible();

  await signIn(page, 'Crm.ServiceLead', `/time/entries?year=${year}&month=${month}`);
  await row.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Withdraw approval (1)', exact: true }).click();
  await expect(toast(page, 'Approval withdrawn')).toBeVisible();
  expect((await api.get<{ remainingHours: number }>(page, `/api/v1/contracts/hour-banks/${bank.id}`)).remainingHours).toBe(10);
});
