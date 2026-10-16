import { test, expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { join } from 'node:path';
import type { ApiProcess } from '../support/api-process.ts';
import { NOTHING_RETAINED, startConsoleApi, submitToken, syntheticToken, tokenRetained } from '../support/operator-ui.ts';
import { dbJourney } from '../support/operator-journey.ts';

// S5-B responsive read journey on the real built console (B9): queue, selected detail and evidence at 320, 768 and 1440 px
// fit without horizontal page overflow and keep labelled, keyboard-reachable controls. Synthetic screenshots are written
// only when ATLAS_UI_VISUAL_DIR is set and only after the password field was cleared and the page verified token-free;
// the synthetic session stays connected. The fixture journey uses the compiled fixture API; the DB-shaped states are
// synthetic responses for one route-intercepted client (no PostgreSQL, no source call).
const token = syntheticToken();
const visualDir = process.env.ATLAS_UI_VISUAL_DIR;
let api: ApiProcess & { console: string };
test.beforeAll(async () => { api = await startConsoleApi({ ATLAS_MODE: 'fixture', ATLAS_DEMO_TOKEN: token }); });
test.afterAll(async () => { await api?.stop(); });

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
async function capture(page: Page, context: BrowserContext, name: string): Promise<void> {
  expect(await page.locator('#token').inputValue()).toBe('');
  expect(await tokenRetained(page, context, token)).toEqual(NOTHING_RETAINED);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  if (visualDir) await page.screenshot({ path: join(visualDir, `s5b-${name}.png`), fullPage: true });
}

for (const width of [320, 768, 1440]) {
  test(`fixture journey at ${width}px: queue, urgent detail with honest Huntress limitation, Atera alert evidence`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 800 });
    await page.goto(api.console);
    await submitToken(page, token);
    await page.getByRole('button', { name: /Gasta/ }).click();
    await expect(page.locator('#queue-body .obs')).toHaveCount(2);
    await expect(page.getByRole('heading', { name: 'Observation queue' })).toBeVisible();
    await capture(page, context, `${width}-queue`);

    await page.locator('#queue-body .obs').filter({ hasText: 'credential theft' }).click();
    await expect(page.locator('#detail-body')).toContainText('Urgent: source severity CRITICAL');
    await expect(page.locator('#evidence-action')).toContainText('not available in this synthetic demo');
    await page.locator('#detail-panel').scrollIntoViewIfNeeded();
    await capture(page, context, `${width}-detail`);

    await page.locator('#queue-body .obs').filter({ hasText: 'Disk capacity' }).click();
    await page.getByRole('button', { name: 'Read the stored Atera alert list and find this alert' }).click();
    await expect(page.locator('#evidence-body')).toContainText('FIXTURE');
    await page.locator('#evidence-panel').scrollIntoViewIfNeeded();
    await capture(page, context, `${width}-evidence`);
  });

  test(`DB-shaped states at ${width}px: filters, paging, STALE truncated evidence without the selected item`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 800 });
    await dbJourney(page, api.console, token, { evidence: 'stale-truncated-empty' });
    await expect(page.locator('#queue-controls fieldset')).toHaveCount(2);
    await expect(page.locator('#evidence-body')).toContainText('may exist beyond it');
    await capture(page, context, `${width}-db-states`);
  });
}
