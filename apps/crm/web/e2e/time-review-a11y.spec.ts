import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { financialReviewFixture } from '../src/features/time/financialReviewFixture';
import { api, createOrganization, marker, signIn } from './support';
import { computedTextContrast } from './computedTextContrast';

// This layout/keyboard case controls only the financial-review response. The critical time-billing workflow uses
// the actual report API in Chromium/Firefox/WebKit; SQL tests separately prove financial facts and zero writes.
test('financial review remains readable on a phone and keeps focus while refreshing without showing old facts', async ({ page }, testInfo) => {
  await signIn(page, 'Crm.Admin'); const customer = await createOrganization(page, { name: marker('Review a11y ') });
  await signIn(page, 'Crm.ServiceLead');
  const entry = await api.post<{ id: string }>(page, '/api/v1/time/entries', { organizationId: customer.id, workDate: '2026-10-17',
    hours: 2, workType: 'Remote', billable: true, onsite: false, afterHours: false, description: 'Synthetic review layout', clientRequestId: crypto.randomUUID() });
  const report = financialReviewFixture(entry.id); report.organizationId = customer.id;
  report.organizationName = 'SyntheticLongCustomer'.repeat(10); report.banks[0]!.name = 'SYNTHETIC-'.repeat(12);
  report.banks[0]!.consumedHours = 1; report.banks[0]!.netHours = 1;
  report.requiresReview = true; report.findings = [{ code: 'BANK_ALLOCATION_MISMATCH', level: 'Review' }, { code: 'BILLING_PROTECTED', level: 'Info' }];
  let reads = 0; let held: Promise<void> | undefined; let entered: (() => void) | undefined;
  await page.route(`**/api/v1/time/entries/${entry.id}/financial-review`, async route => {
    reads++; if (held) { entered?.(); await held; } await route.fulfill({ json: report });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, 'Crm.Finance', `/time/entries/${entry.id}/financial-review`);
  await expect(page.getByRole('heading', { name: 'Review saved time', exact: true })).toBeVisible();
  const mismatch = page.getByText('Hours on the current approval differ from net bank movements. Compare the figures below.', { exact: true });
  await expect(mismatch).toBeVisible(); await page.waitForLoadState('networkidle');
  await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => undefined))); });
  expect((await computedTextContrast(mismatch)).ratio).toBeGreaterThanOrEqual(4.5);
  const axe = await new AxeBuilder({ page }).include('main').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .exclude('[data-tabster-dummy]').analyze();
  expect(axe.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('financial-review-mobile.png'), fullPage: true });
  const refresh = page.getByRole('button', { name: 'Refresh saved facts', exact: true });
  let release!: () => void; held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; }); const before = reads;
  try {
    await refresh.focus(); await page.keyboard.press('Enter'); await started;
    await expect(refresh).toHaveAttribute('aria-disabled', 'true'); await expect(refresh).toBeFocused();
    await expect(page.getByRole('link', { name: report.banks[0]!.name!, exact: true })).toHaveCount(0);
    await page.keyboard.press('Enter'); await page.keyboard.press('Space'); expect(reads).toBe(before + 1);
  } finally { held = undefined; entered = undefined; release(); }
  await expect(mismatch).toBeVisible(); await expect(refresh).not.toHaveAttribute('aria-disabled', 'true'); await expect(refresh).toBeFocused();
  await expect(page.getByRole('button', { name: /Approve|Withdraw|Repair|Adjust|Cancel basis/ })).toHaveCount(0);
});
