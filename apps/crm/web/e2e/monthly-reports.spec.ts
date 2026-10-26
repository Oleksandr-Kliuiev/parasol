import { expect, test } from '@playwright/test';
import { linkedHuntressCustomer, syncHuntress } from './huntress';
import { api, signIn } from './support';

// M43: the monthly reports the CRM files for a customer. Huntress's PDF is fetched by the worker through the stand-in's link (a
// redirect to its "file storage", tools/dev-mocks/huntress.mjs) and Parasoll's own summary of last month is rendered by the CRM; both
// are kept unchanged among the customer's documents and downloaded from there, and the Drift tab offers the stored copy beside
// Huntress's link.

interface Stored { id: string; kind: string; sourceKey: string; fileName: string; provenance: string; periodStart: string }

test('a customer\'s monthly reports are filed among its documents and downloaded from there @critical', async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page, 'Crm.Admin');
  const customer = await linkedHuntressCustomer(page, 'Arkiv');
  const created = await page.request.post('http://localhost:5299/_mock/huntress/reports', {
    data: { organization_id: customer.huntressId, incidents_reported: 2, incidents_resolved: 2, agents_count: 9 },
  });
  expect(created.status()).toBe(201);
  const report = (await created.json()) as { id: number; period: string };
  const month = report.period.slice(0, 7);
  const stored = async () =>
    (await api.get<{ items: Stored[] }>(page, `/api/v1/customers/organizations/${customer.organizationId}/stored-documents`)).items;

  // The reports are read, then their files fetched, then last month summarised: three jobs, each started on request here.
  await syncHuntress(page, ['huntress-reports', 'huntress-report-files', 'reports-customer-months'], async () => {
    const items = await stored();
    return items.some((d) => d.sourceKey === `huntress:report:${report.id}`) && items.some((d) => d.kind === 'parasoll-monthly');
  }, `the monthly reports of ${customer.name}`);
  const items = await stored();
  expect(items.find((d) => d.kind === 'huntress-monthly')).toMatchObject({ fileName: `huntress-${month}-${report.id}.pdf`, provenance: 'Source' });
  expect(items.find((d) => d.kind === 'parasoll-monthly')).toMatchObject({ fileName: `parasoll-${month}.pdf`, periodStart: `${month}-01` });

  await page.goto(`/organizations/${customer.organizationId}?tab=documents`);
  const panel = page.getByRole('region', { name: 'Monthly reports' });
  const label = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`));
  await expect(panel.getByText(`Huntress report · ${label}`)).toBeVisible();
  await expect(panel.getByText(`Parasoll summary · ${label}`)).toBeVisible();
  const download = page.waitForEvent('download');
  await panel.getByRole('button', { name: `Download Huntress report · ${label}` }).click();
  expect((await download).suggestedFilename()).toBe(`huntress-${month}-${report.id}.pdf`);
  await expect(panel.getByRole('alert')).toHaveCount(0);

  // The Drift tab's security panel offers the same copy beside Huntress's link.
  await page.goto(`/organizations/${customer.organizationId}?tab=drift`);
  const security = page.getByRole('region', { name: 'Security', exact: true });
  const row = security.getByRole('row').filter({ hasText: '2 reported, 2 closed' });
  await expect(row.getByRole('link', { name: /^Open the report for .* in Huntress$/ })).toBeVisible();
  const copy = page.waitForEvent('download');
  await row.getByRole('button', { name: /^Copy in Parasoll: download the report for / }).click();
  expect((await copy).suggestedFilename()).toBe(`huntress-${month}-${report.id}.pdf`);
});

test('the monthly reports read with the keyboard and fit a phone\'s width', async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page, 'Crm.Admin');
  const customer = await linkedHuntressCustomer(page, 'Smal');
  expect((await page.request.post('http://localhost:5299/_mock/huntress/reports', { data: { organization_id: customer.huntressId } })).status()).toBe(201);
  await syncHuntress(page, ['huntress-reports', 'huntress-report-files'], async () =>
    (await api.get<{ items: Stored[] }>(page, `/api/v1/customers/organizations/${customer.organizationId}/stored-documents`)).items.length > 0,
  `the report file of ${customer.name}`);

  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(`/organizations/${customer.organizationId}?tab=documents`);
  const panel = page.getByRole('region', { name: 'Monthly reports' });
  const button = panel.getByRole('button', { name: /^Download Huntress report · / });
  await expect(button).toBeVisible();
  await button.focus();
  await expect(button).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
