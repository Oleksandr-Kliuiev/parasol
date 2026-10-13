import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import type { ApiProcess } from '../support/api-process.ts';
import { startConsoleApi, submitToken, syntheticToken } from '../support/operator-ui.ts';

// S5-A responsive first screen and ready state of the real built console (A8): no horizontal page overflow at 320, 768 and
// 1440 px, landmarks and labelled controls present. Screenshots are written only when ATLAS_UI_VISUAL_DIR is set, only
// after the password field is cleared, and only of the synthetic fixture client.
const token = syntheticToken();
const visualDir = process.env.ATLAS_UI_VISUAL_DIR;
let api: ApiProcess & { console: string };
test.beforeAll(async () => { api = await startConsoleApi({ ATLAS_MODE: 'fixture', ATLAS_DEMO_TOKEN: token }); });
test.afterAll(async () => { await api?.stop(); });

for (const width of [320, 768, 1440]) {
  test(`layout at ${width}px: disconnected and ready states fit, are labelled and keyboard reachable`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 800 });
    await page.goto(api.console);
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(await overflow()).toBeLessThanOrEqual(0);
    await expect(page.getByRole('banner')).toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByLabel('Operator token')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect' })).toBeVisible();
    if (visualDir) await page.screenshot({ path: join(visualDir, `s5a-${width}-disconnected.png`), fullPage: true });

    await submitToken(page, token);
    expect(await page.locator('#token').inputValue()).toBe('');
    await page.getByRole('button', { name: /Gasta/ }).click();
    await expect(page.locator('#scope-panel')).toContainText('validated');
    await expect(page.getByRole('navigation', { name: 'Clients' })).toBeVisible();
    await expect(page.getByLabel('Search by name or ID')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.locator('#client-list button').first().focus();
    if (visualDir) await page.screenshot({ path: join(visualDir, `s5a-${width}-ready.png`), fullPage: true });
  });
}
