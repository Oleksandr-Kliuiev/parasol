import { expect, test } from '@playwright/test';
import { fitsWidth, seriousViolations, settled, widths } from './atera';
import { linkedHuntressCustomer, syncHuntress } from './huntress';
import { api, signIn } from './support';

// M43: the monthly reports among a customer's documents, and the stored copy beside Huntress's link on the Drift tab, at desktop,
// tablet and phone widths in the theme of the project (desktop: light, desktop-dark: dark), against axe's WCAG 2.2 AA rules; a
// report downloads from the keyboard.
test('the monthly reports pass axe at every width and download from the keyboard', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const scheme = testInfo.project.use.colorScheme ?? 'light';
  await signIn(page, 'Crm.Admin');
  const customer = await linkedHuntressCustomer(page, 'ArkA');
  const created = await page.request.post('http://localhost:5299/_mock/huntress/reports', {
    data: { organization_id: customer.huntressId, incidents_reported: 1, incidents_resolved: 1, agents_count: 4 },
  });
  expect(created.status()).toBe(201);
  await syncHuntress(page, ['huntress-reports', 'huntress-report-files', 'reports-customer-months'], async () =>
    (await api.get<{ items: Array<{ kind: string }> }>(page, `/api/v1/customers/organizations/${customer.organizationId}/stored-documents`)).items
      .map((d) => d.kind).sort().join() === 'huntress-monthly,parasoll-monthly',
  `the monthly reports of ${customer.name}`);

  for (const [width, height] of widths) {
    await page.setViewportSize({ width, height });
    await page.goto(`/organizations/${customer.organizationId}?tab=documents`);
    const panel = page.getByRole('region', { name: 'Monthly reports', exact: true });
    await expect(panel.getByRole('button', { name: /^Download / })).toHaveCount(2);
    await settled(page);
    expect(await seriousViolations(page), `monthly reports at ${width} px (${scheme})`).toEqual([]);
    expect(await fitsWidth(page), `monthly reports scroll sideways at ${width} px (${scheme})`).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`monthly-reports-${width}-${scheme}.png`), fullPage: true });
  }

  // The keyboard reaches a report's button and Enter downloads it.
  const button = page.getByRole('region', { name: 'Monthly reports', exact: true }).getByRole('button', { name: /^Download Huntress report · / });
  await button.focus();
  const download = page.waitForEvent('download');
  await page.keyboard.press('Enter');
  expect((await download).suggestedFilename()).toMatch(/^huntress-\d{4}-\d{2}-\d+\.pdf$/);

  // The Drift tab's security panel offers the stored copy beside Huntress's own link.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/organizations/${customer.organizationId}?tab=drift`);
  const security = page.getByRole('region', { name: 'Security', exact: true });
  await expect(security.getByRole('button', { name: /^Copy in Parasoll: download the report for / })).toBeVisible();
  await settled(page);
  expect(await seriousViolations(page), `security panel with the stored copy (${scheme})`).toEqual([]);
});
