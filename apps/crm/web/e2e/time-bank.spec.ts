import { expect, test } from '@playwright/test';
import { api, createOrganization, marker, showRow, signIn, toast } from './support';

test('prepaid hours are approved, returned and approved again through the real staff workflow', { tag: '@critical' }, async ({ page }) => {
  const now = new Date(); const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const name = marker('Prepaid ');
  await signIn(page, 'Crm.Admin'); const customer = await createOrganization(page, { name, status: 'Customer' });
  const bank = await api.post<{ id: string }>(page, '/api/v1/contracts/hour-banks', { organizationId: customer.id,
    name: `${name} hours`, hours: 10, validFrom: date, overageRate: 100 });
  await signIn(page, 'Crm.ServiceLead');
  const entry = await api.post<{ id: string }>(page, '/api/v1/time/entries', { organizationId: customer.id, workDate: date,
    hours: 2, workType: 'Remote', billable: true, onsite: false, afterHours: false, description: `${name} explicit work`, clientRequestId: crypto.randomUUID() });
  await page.goto(`/time/entries?year=${now.getFullYear()}&month=${now.getMonth() + 1}`);
  const row = await showRow(page, page.getByRole('row').filter({ hasText: name }));
  const balance = async () => (await api.get<{ remainingHours: number }>(page, `/api/v1/contracts/hour-banks/${bank.id}`)).remainingHours;
  const saved = async () => (await api.get<{ items: { id: string; status: string; amount?: number; allocations: { classification: string; hours: number }[] }[] }>(
    page, `/api/v1/time/entries?organizationId=${customer.id}`)).items.find(item => item.id === entry.id)!;
  await row.getByRole('checkbox').check(); await page.getByRole('button', { name: 'Approve (1)', exact: true }).click();
  await expect(toast(page, '1 entry approved')).toBeVisible();
  await expect(row.getByText('Hour bank 2 h', { exact: true })).toBeVisible();
  expect(await balance()).toBe(8);
  const approved = await saved(); expect(approved.status).toBe('Approved'); expect(approved.amount).toBeUndefined();
  expect(approved.allocations).toMatchObject([{ classification: 'HourBank', hours: 2 }]);
  await expect(row.getByRole('checkbox')).not.toBeChecked(); await row.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Withdraw approval (1)', exact: true }).click();
  await expect(toast(page, 'Approval withdrawn')).toBeVisible();
  await expect(row.getByText('Hour bank 2 h', { exact: true })).toHaveCount(0);
  expect(await balance()).toBe(10); expect((await saved()).status).toBe('New'); expect((await saved()).allocations).toEqual([]);
  await expect(row.getByRole('checkbox')).not.toBeChecked(); await row.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Approve (1)', exact: true }).click();
  await expect(row.getByText('Hour bank 2 h', { exact: true })).toBeVisible();
  expect(await balance()).toBe(8); expect((await saved()).status).toBe('Approved');
});
