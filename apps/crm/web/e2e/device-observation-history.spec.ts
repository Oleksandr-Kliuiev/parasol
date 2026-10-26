import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { atlasWorkspace } from '../src/test/atlasWorkspace';
import { atlasQueue } from '../src/test/atlasQueue';
import type { QueueState } from '../src/features/parasol/observationQueueContract';
import { createOrganization, marker, signIn } from './support';
import nb from '../src/i18n/locales/nb.json' with { type: 'json' };
import nn from '../src/i18n/locales/nn.json' with { type: 'json' };

test('device investigation preserves exact scope, keyboard return and other filters across viewport sizes', { tag: '@critical' }, async ({ page, browser }, testInfo) => {
  // Eight width and theme passes with an axe scan each: Firefox and WebKit on a CI runner need more than three minutes.
  test.setTimeout(360_000);
  await signIn(page, 'Crm.Admin', '/organizations');
  const customer = await createOrganization(page, { name: marker('Device history ') });
  const overview = atlasWorkspace(customer.id); const registry = overview.summary!.devices;
  registry[0]!.hostname = `SYNTHETIC-${'workstation'.repeat(4)}.branch-${'device'.repeat(8)}.example.invalid`;
  registry[40]!.hostname = registry[0]!.hostname;
  const requests: URL[] = [];
  const installFixtures = async (target: Page) => {
    await target.route(`**/api/v1/parasol/customers/${customer.id}/workspace`, route => route.fulfill({ json: overview }));
    await target.route(`**/api/v1/parasol/customers/${customer.id}/observations?*`, route => {
    const url = new URL(route.request().url()); requests.push(url);
    const deviceId = url.searchParams.get('deviceId'); const offset = url.searchParams.has('cursor') ? 25 : 0;
    const status = (url.searchParams.get('status') ?? 'ACTIVE') as QueueState;
    const result = atlasQueue({ customerId: customer.id, deviceId, status, offset,
      count: status === 'RESOLVED' ? 1 : offset ? 2 : 25, total: status === 'RESOLVED' ? 1 : 27,
      nextCursor: status === 'RESOLVED' || offset ? null : 'synthetic-device-next-page' });
    result.queue!.devices = registry;
    for (const item of result.queue!.items) item.summary = `${deviceId ?? 'all'} observation ${item.id}`;
    return route.fulfill({ json: result });
    });
  };
  await installFixtures(page);
  const capture = async (state: string, width: number, colorScheme: string, target = page) => {
    await expect(target.locator('html')).toHaveAttribute('lang', state.startsWith('locale-') ? state.slice(7, 9) : 'en');
    await target.evaluate(async () => { await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => undefined))); });
    const a11y = await new AxeBuilder({ page: target }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).exclude('[data-tabster-dummy]').analyze();
    expect(a11y.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
    expect(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await target.screenshot({ path: testInfo.outputPath(`${state}-${width}-${colorScheme}.png`), fullPage: state === 'devices' });
  };
  for (const width of [1440, 768, 390, 320]) for (const colorScheme of ['light', 'dark'] as const) {
    await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme });
    await page.goto(`/organizations/${customer.id}`);
    const panel = page.getByRole('region', { name: 'Technical workspace · Atlas', exact: true });
    await panel.getByRole('tab', { name: 'Atlas devices', exact: true }).click();
    const devices = () => panel.getByRole('region', { name: 'Atlas devices', exact: true });
    const search = devices().getByRole('searchbox'); await search.fill(registry[0]!.hostname);
    await expect(devices().getByRole('listitem')).toHaveCount(2);
    const action = () => devices().getByRole('listitem').filter({ has: page.getByText('Atlas device ID: device-40', { exact: true }) }).getByRole('button');
    await capture('devices', width, colorScheme);
    await search.click(); await expect(search).toBeFocused();
    const tabPath: string[] = [];
    for (let step = 0; step < 4 && !(await action().evaluate(el => el === document.activeElement)); step++) {
      await page.keyboard.press('Tab'); tabPath.push(await page.evaluate(() => `${document.activeElement?.tagName}:${document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.slice(0, 60)}`));
    }
    await expect(action(), `Keyboard path from device search: ${tabPath.join(' → ')}`).toBeFocused(); await page.keyboard.press('Enter');
    const queue = panel.getByRole('region', { name: 'Observation queue and history', exact: true });
    await expect(queue.getByText('device-40 observation queue-1', { exact: true })).toBeVisible();
    const firstTitle = queue.getByText('device-40 observation queue-1', { exact: true });
    await expect(firstTitle, JSON.stringify({ viewport: page.viewportSize(), firstTitle: await firstTitle.boundingBox() })).toBeInViewport({ ratio: 1 });
    await expect(queue.getByText(/Sources to review: 2/)).toBeVisible();
    const queueHeading = queue.getByRole('heading', { name: 'Observation queue and history', exact: true });
    await expect(queueHeading).toBeInViewport({ ratio: 1 });
    expect(await queueHeading.evaluate(el => el.getBoundingClientRect().top)).toBeGreaterThanOrEqual(53);
    expect(requests.at(-1)!.searchParams.get('deviceId')).toBe('device-40');
    await expect(panel.getByRole('tab', { name: 'Observation queue and history', exact: true })).toBeFocused();
    await capture('selected', width, colorScheme);
    await page.keyboard.press('Tab'); await expect(queue.getByRole('button', { name: 'All devices · keep other filters', exact: true })).toBeFocused();
    await page.keyboard.press('Tab'); await expect(queue.getByRole('button', { name: 'Back to device', exact: true })).toBeFocused();
    await page.keyboard.press('Enter'); await expect(action()).toBeFocused(); await expect(action()).toBeInViewport({ ratio: 1 });
    expect(await action().evaluate(el => el.getBoundingClientRect().top)).toBeGreaterThanOrEqual(53);
    await expect(devices().getByRole('searchbox')).toHaveValue(registry[0]!.hostname);
    await capture('returned', width, colorScheme);
    await page.keyboard.press('Enter'); await expect(queue.getByText('device-40 observation queue-1', { exact: true })).toBeVisible();
    await queue.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(queue.getByText('device-40 observation queue-26', { exact: true })).toBeVisible();
    expect(requests.at(-1)!.searchParams.get('deviceId')).toBe('device-40');
    expect(requests.at(-1)!.searchParams.get('cursor')).toBe('synthetic-device-next-page');
    await queue.getByLabel('Queue state', { exact: true }).selectOption('RESOLVED');
    await expect(queue.getByText('device-40 observation queue-1', { exact: true })).toBeVisible();
    expect(requests.at(-1)!.searchParams.get('cursor')).toBeNull(); await capture('history', width, colorScheme);
    const beforeDetails = requests.length;
    const readDetails = queue.locator('summary').filter({ hasText: 'Data details' });
    await readDetails.focus(); await expect(readDetails).toBeFocused(); await page.keyboard.press('Enter');
    await expect(queue.getByText(/Counts reflect this page request/)).toBeVisible();
    await expect(queue.getByText('Outdated snapshot', { exact: true })).toBeVisible();
    await capture('read-details', width, colorScheme);
    await page.keyboard.press('Enter'); await expect(queue.getByText(/Counts reflect this page request/)).not.toBeVisible();
    const help = queue.locator('summary').filter({ hasText: 'About this queue' });
    await help.focus(); await expect(help).toBeFocused(); await page.keyboard.press('Enter');
    await expect(queue.getByText(/Search covers this page only/)).toBeVisible();
    await expect(queue.getByText(/This history uses the exact device/)).toBeVisible();
    await capture('queue-help', width, colorScheme);
    await page.keyboard.press('Enter');
    expect(requests.length, 'Reading saved counts, source details and help must not issue another request').toBe(beforeDetails);
    await queue.getByRole('button', { name: 'All devices · keep other filters', exact: true }).click();
    await expect(queue.getByText('all observation queue-1', { exact: true })).toBeVisible();
    await expect(queue.getByLabel('Queue state', { exact: true })).toHaveValue('RESOLVED');
    await expect(queueHeading).toBeFocused(); await expect(queueHeading).toBeInViewport({ ratio: 1 });
    expect(await queueHeading.evaluate(el => el.getBoundingClientRect().top)).toBeGreaterThanOrEqual(53);
    expect(requests.at(-1)!.searchParams.get('deviceId')).toBeNull(); expect(requests.at(-1)!.searchParams.get('cursor')).toBeNull();
    await capture('cleared', width, colorScheme);
  }
  for (const [locale, labels] of [['nb-NO', nb], ['nn-NO', nn]] as const) {
    const context = await browser.newContext({ baseURL: new URL(page.url()).origin, locale, viewport: { width: 320, height: 900 }, ignoreHTTPSErrors: true });
    try {
      const localized = await context.newPage(); await installFixtures(localized);
      for (const colorScheme of ['light', 'dark'] as const) {
        await localized.emulateMedia({ colorScheme }); await signIn(localized, 'Crm.Admin', `/organizations/${customer.id}`);
        await localized.getByRole('tab', { name: labels.parasolDetails.devices, exact: true }).click();
        const device = localized.getByRole('region', { name: labels.parasolDetails.devices, exact: true }).getByRole('listitem')
          .filter({ has: localized.getByText(`${labels.parasolDetails.deviceId}: device-0`, { exact: true }) });
        await device.getByRole('button').click();
        const queue = localized.getByRole('region', { name: labels.parasolQueue.title, exact: true });
        await expect(queue.getByText('device-0 observation queue-1', { exact: true })).toBeVisible();
        const clear = queue.getByRole('button', { name: labels.parasolQueue.allDevices, exact: true });
        await clear.scrollIntoViewIfNeeded(); await expect(clear).toBeInViewport({ ratio: 1 });
        await capture(`locale-${locale}`, 320, colorScheme, localized);
      }
    } finally { await context.close(); }
  }
});
