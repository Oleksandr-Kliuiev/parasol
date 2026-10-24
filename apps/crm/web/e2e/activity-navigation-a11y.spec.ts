import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { api, createOrganization, marker, signIn, toast } from './support';
import { computedTextContrast } from './computedTextContrast';

test('selected activity and return to the customer timeline work with a keyboard on a phone', async ({ page }, testInfo) => {
  await signIn(page, 'Crm.Sales');
  const employee = await api.get<{ id: string }>(page, '/bff/user');
  const customer = await createOrganization(page, { name: marker('Accessible selected ') });
  const subject = marker('Synthetic exact activity ');
  const activity = await api.post<{ id: string }>(page, '/api/v1/activities/', {
    type: 'Task', organizationId: customer.id, subject, body: 'SyntheticLongTaskDetails'.repeat(15),
    priority: 'Normal', assigneeId: employee.id, dueAt: '2050-11-01T09:00:47.123Z', addToCalendar: false,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/organizations/${customer.id}?tab=activities&activityId=${activity.id}`);
  const timeline = page.getByRole('region', { name: 'Activities', exact: true });
  await expect(timeline.getByRole('heading', { name: 'Selected activity', exact: true })).toBeFocused();
  const activeTab = page.getByRole('tab', { name: 'Activities', exact: true });
  await expect(activeTab).toHaveAttribute('aria-selected', 'true');
  await expect(activeTab).toBeInViewport({ ratio: 1 });
  const verticalScroll = await page.evaluate(() => window.scrollY);
  await page.setViewportSize({ width: 360, height: 844 });
  await expect(activeTab).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => window.scrollY)).toBe(verticalScroll);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(activeTab).toBeInViewport({ ratio: 1 });
  await expect(timeline.getByRole('heading', { name: 'Selected activity', exact: true })).toBeFocused();
  await expect(timeline.getByRole('listitem')).toHaveCount(1);
  expect(await timeline.getByRole('heading', { name: 'Activities', exact: true }).evaluate(heading => {
    const text = document.createRange(); text.selectNodeContents(heading);
    return text.getClientRects().length;
  }), 'Header actions must not split the short panel title across lines on a phone').toBe(1);
  await page.waitForLoadState('networkidle');
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => undefined)));
  });
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .exclude('[data-tabster-dummy]').analyze();
  expect(result.violations.filter(violation => violation.impact === 'serious' || violation.impact === 'critical')
    .map(violation => ({ id: violation.id, nodes: violation.nodes.map(node => node.target) }))).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('selected-activity-mobile-synthetic.png'), fullPage: true });
  const edit = timeline.getByRole('button', { name: `Edit ${subject}`, exact: true });
  await edit.focus(); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Edit activity', exact: true });
  await expect(dialog.getByRole('textbox', { name: 'Subject', exact: true })).toHaveValue(subject);
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(edit).toBeFocused();
  const refresh = timeline.getByRole('button', { name: 'Refresh activity', exact: true });
  const refreshed = page.waitForResponse(response => response.request().method() === 'GET'
    && new URL(response.url()).searchParams.get('activityId') === activity.id);
  await refresh.focus(); await page.keyboard.press('Enter');
  expect((await refreshed).status()).toBe(200);
  await expect(timeline.getByRole('listitem')).toHaveCount(1); await expect(refresh).toBeFocused();
  const complete = timeline.getByRole('button', { name: `Mark ${subject} as done`, exact: true });
  await complete.focus(); await page.keyboard.press('Enter');
  const reopen = timeline.getByRole('button', { name: `Reopen ${subject}`, exact: true });
  await expect(reopen).toBeFocused();
  await page.keyboard.press('Enter'); await expect(complete).toBeFocused();
  // Wait for this receipt's entrance only. The finite timer animation belongs to its
  // child; waiting for every page animation would wait for dismissal before measuring.
  const receipt = toast(page, 'Reopened');
  await expect(receipt).toBeVisible();
  const receiptContainer = page.locator('.fui-ToastContainer').filter({ has: receipt });
  await receiptContainer.evaluate(async container => {
    await Promise.all(container.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => undefined)));
  });
  await expect(receiptContainer).toHaveCSS('opacity', '1');
  expect((await computedTextContrast(receipt)).ratio).toBeGreaterThanOrEqual(4.5);
  await expect(page.locator('.fui-ToastTitle')).toHaveCount(0);
  const statusResult = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .exclude('[data-tabster-dummy]').analyze();
  expect(statusResult.violations.filter(violation => violation.impact === 'serious' || violation.impact === 'critical')
    .map(violation => ({ id: violation.id, nodes: violation.nodes.map(node => node.target) }))).toEqual([]);
  const showAll = timeline.getByRole('button', { name: 'All customer activities', exact: true });
  await showAll.focus(); await page.keyboard.press('Enter');
  await expect(timeline.getByRole('heading', { name: 'Selected activity', exact: true })).toHaveCount(0);
  await expect(timeline.getByRole('listitem')).toHaveCount(1);
  expect(new URL(page.url()).searchParams.get('tab')).toBe('activities');
  expect(new URL(page.url()).searchParams.has('activityId')).toBe(false);
});
