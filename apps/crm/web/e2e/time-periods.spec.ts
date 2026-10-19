import { expect, test } from '@playwright/test';
import { api, createOrganization, marker, signIn, toast } from './support';

test('a closed month refuses new hours without losing the form and Finance explicitly reopens it with a reason', { tag: '@critical' }, async ({ page, browserName }) => {
  const year = new Date().getFullYear() - 1;
  // Distinct real global months for the three engines sharing this owned database.
  const month = ({ chromium: 1, firefox: 2, webkit: 3 } as const)[browserName];
  const date = `${year}-${String(month).padStart(2, '0')}-17`;
  await signIn(page, 'Crm.Sales'); const customer = await createOrganization(page, { name: marker('Period ') });
  await signIn(page, 'Crm.ServiceLead');
  const entry = await api.post<{ id: string }>(page, '/api/v1/time/entries', { organizationId: customer.id, workDate: date, hours: 1,
    billable: true, onsite: false, afterHours: false, workType: 'Remote', description: 'Synthetic period work', clientRequestId: crypto.randomUUID() });
  await page.goto(`/time/entries?year=${year}&month=${month}`);
  const row = page.getByRole('row').filter({ hasText: customer.name }); await expect(row).toBeVisible();
  const periodRoute = `/api/v1/time/periods/${year}/${month}`;
  const refused = page.waitForResponse(r => new URL(r.url()).pathname === `${periodRoute}/close` && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Close the period', exact: true }).click();
  const refusal = await refused; expect(refusal.status()).toBe(409); expect((await refusal.json()).code).toBe('TIM_UNAPPROVED_ENTRIES');
  await row.getByRole('checkbox').check(); await page.getByRole('button', { name: 'Approve (1)', exact: true }).click();
  await expect(toast(page, '1 entries approved')).toBeVisible();
  const closing = page.waitForResponse(r => new URL(r.url()).pathname === `${periodRoute}/close` && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Close the period', exact: true }).click();
  const closed = await closing; expect(closed.status()).toBe(200); expect((await closed.json()).isClosed).toBe(true);
  await expect(page.getByRole('button', { name: 'Reopen', exact: true })).toHaveCount(0);
  await page.goto('/time'); await page.getByRole('button', { name: 'Register hours', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Organization', exact: true }).pressSequentially(customer.name);
  await page.getByRole('option', { name: customer.name, exact: true }).click();
  await dialog.getByLabel(/^Date\s*\*?$/).fill(date);
  await dialog.getByRole('textbox', { name: 'Hours', exact: true }).fill('2');
  await dialog.getByRole('textbox', { name: 'Description', exact: true }).fill('Keep this explicit draft');
  const saving = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/time/entries' && r.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Register hours', exact: true }).click();
  const rejected = await saving; expect(rejected.status()).toBe(409); expect((await rejected.json()).code).toBe('TIM_PERIOD_CLOSED');
  expect(rejected.request().postDataJSON().workDate).toBe(date);
  await expect(dialog.getByText('This period is closed. Finance must reopen it before hours can be changed.', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Hours', exact: true })).toHaveValue('2');
  await expect(dialog.getByRole('textbox', { name: 'Description', exact: true })).toHaveValue('Keep this explicit draft');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  const saved = await api.get<{ items: { id: string }[] }>(page, `/api/v1/time/entries?organizationId=${customer.id}`);
  expect(saved.items.map(item => item.id)).toEqual([entry.id]);
  await signIn(page, 'Crm.Finance', `/time/entries?year=${year}&month=${month}`);
  await page.getByRole('button', { name: 'Reopen', exact: true }).click();
  const reopen = page.getByRole('dialog'); const submit = reopen.getByRole('button', { name: 'Reopen', exact: true });
  await expect(submit).toBeDisabled(); await reopen.getByRole('textbox', { name: 'Reason', exact: true }).fill('Synthetic reviewed correction');
  await submit.click(); await expect(toast(page, 'The period is open again')).toBeVisible();
  const periods = await api.get<{ month: number; isClosed: boolean; reopenReason: string }[]>(page, `/api/v1/time/periods?year=${year}`);
  expect(periods.find(p => p.month === month)).toMatchObject({ isClosed: false, reopenReason: 'Synthetic reviewed correction' });
});
