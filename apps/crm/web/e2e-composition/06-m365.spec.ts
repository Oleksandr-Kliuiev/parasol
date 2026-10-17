import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { parseM365 } from '../src/features/parasol/m365Contract';
import { parseWorkspace } from '../src/features/parasol/workspaceContract';
import { assertTaskEvidence, control, fixture, json, staffContext } from './support';

test('Microsoft 365 metadata crosses the actual scoped bridge without exposing directory DTOs or creating work', async ({ browser }, testInfo) => {
  const f = fixture(), endpoint = `/api/v1/parasol/customers/${f.target.customerId}/m365`;
  const before = control('countsTaskEvidence');
  const admin = await staffContext(browser, 'Crm.Admin', `/organizations/${f.target.customerId}`);
  try {
    let viewRequests = 0;
    admin.page.on('request', request => { if (request.url().endsWith('/m365') && request.method() === 'GET') viewRequests++; });
    const response = await admin.page.request.get(endpoint);
    expect(response.headers()['cache-control']).toContain('no-store');
    const raw = await json(response, 'Actual CRM–Atlas M365 metadata'); const result = parseM365(raw, f.target.customerId);
    expect(result.status).toBe('READY'); expect(result.summary!.totalConnections).toBe(1);
    expect(result.summary!.connections[0]!.directory.map(d => [d.status, d.count])).toEqual([['OK', 1], ['STALE', 1]]);
    const signIns = result.summary!.connections[0]!.signIns;
    expect([signIns.status, signIns.coverage, signIns.freshness]).toEqual(['MISSING', 'UNAVAILABLE', 'UNKNOWN']);
    expect(signIns.gaps).toEqual([{ fromInclusive: result.summary!.windowFrom, toExclusive: result.summary!.windowTo }]);
    const serialized = JSON.stringify(raw);
    expect(['synthetic-hidden@example.invalid', 'Synthetic hidden M365', 'secretRef', 'tenantId', 'userPrincipalName', 'deviceId', 'dto']
      .some(value => serialized.includes(value)), 'No directory DTO, vendor ID, credential reference or source identity').toBe(false);
    const panel = admin.page.getByRole('region', { name: 'Technical workspace · Atlas' });
    await panel.getByRole('tab', { name: 'Microsoft 365', exact: true }).focus(); await admin.page.keyboard.press('Enter');
    await expect(panel.getByText('Directory user records', { exact: true })).toBeVisible();
    await expect(panel.getByText('No usable coverage', { exact: true })).toBeVisible();
    const gaps = panel.locator('summary').filter({ hasText: 'Intervals without coverage: 1' });
    await gaps.focus(); await admin.page.keyboard.press('Enter'); await expect(gaps.locator('..')).toHaveAttribute('open', '');
    await gaps.press('Enter'); await expect(gaps.locator('..')).not.toHaveAttribute('open', '');
    await admin.page.setViewportSize({ width: 390, height: 844 });
    for (const colorScheme of ['light', 'dark'] as const) {
      await admin.page.emulateMedia({ colorScheme });
      await expect.poll(() => panel.evaluate(el => getComputedStyle(el).getPropertyValue('--colorNeutralBackground1').trim()))
        .toBe(colorScheme === 'dark' ? '#292929' : '#ffffff');
      await admin.page.waitForLoadState('networkidle');
      await admin.page.evaluate(async () => { await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity)
        .map(a => a.finished.catch(() => undefined))); });
      const scan = await new AxeBuilder({ page: admin.page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .exclude('[data-tabster-dummy]').analyze();
      expect(scan.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => v.id)).toEqual([]);
      expect(await admin.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await admin.page.screenshot({ path: testInfo.outputPath(`actual-m365-${colorScheme}-phone.png`), fullPage: true });
    }
    expect(viewRequests, 'Opening and inspecting the view makes one explicit metadata read').toBe(1);
    const read = admin.page.waitForResponse(res => res.url().endsWith('/m365') && res.request().method() === 'GET');
    await panel.getByRole('button', { name: 'Refresh Microsoft 365', exact: true }).focus(); await admin.page.keyboard.press('Enter');
    expect((await read).status()).toBe(200);
    await expect(panel.getByRole('button', { name: 'Refresh Microsoft 365', exact: true })).toBeFocused();
    expect(viewRequests).toBe(2);
  } finally { await admin.context.close(); }
  const technician = await staffContext(browser, 'Crm.Technician', `/organizations/${f.target.customerId}`);
  try {
    const result = parseM365(await json(await technician.page.request.get(endpoint), 'Context-only employee M365 refusal'), f.target.customerId);
    expect(result.status).toBe('ACCESS_DENIED'); expect(result.summary).toBeNull();
    const panel = technician.page.getByRole('region', { name: 'Technical workspace · Atlas' });
    await expect(panel.getByRole('tab', { name: 'Microsoft 365', exact: true })).toBeVisible();
    const recheck = technician.page.waitForResponse(response => response.url().endsWith('/workspace') && response.request().method() === 'GET');
    await panel.getByRole('tab', { name: 'Microsoft 365', exact: true }).click();
    await expect(panel.getByText('Your Atlas access does not permit reading this customer’s Microsoft 365 data.', { exact: true })).toBeVisible();
    const freshContext = await recheck; expect(freshContext.status()).toBe(200);
    expect(parseWorkspace(await freshContext.json(), f.target.customerId).status).toBe('READY');
    await expect(panel.getByRole('tab', { name: 'Microsoft 365', exact: true })).toHaveAttribute('aria-selected', 'true');
    await panel.getByRole('tab', { name: 'Atlas devices', exact: true }).click();
    await expect(panel.getByRole('region', { name: 'Atlas devices' }).getByRole('listitem')).toHaveCount(10);
  } finally { await technician.context.close(); }
  const after = control('countsTaskEvidence');
  assertTaskEvidence(after, 1, 2); expect(after.ticketWork).toEqual(before.ticketWork);
  expect(after.atlasRequests).toBeGreaterThan(before.atlasRequests); expect(after.providerWrites).toBe(0);
});
