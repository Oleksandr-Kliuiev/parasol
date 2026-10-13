import { test, expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { join } from 'node:path';
import type { AskProcess } from '../support/ask-pg.ts';
import { NOTHING_RETAINED, submitToken, syntheticToken, tokenRetained } from '../support/operator-ui.ts';
import { QUESTION_MARKER, askQuestion, startAskConsole } from '../support/operator-ask-ui.ts';

// ASK-B responsive Ask journey on the real built console and compiled fixture MOCK API (Q8): the Ask panel, a cited answer
// with an opened evidence card, an unsupported and an insufficient answer at 320, 768 and 1440 px fit without horizontal page overflow and keep
// labelled, keyboard-reachable controls. Synthetic screenshots are written only when ATLAS_UI_VISUAL_DIR is set and only
// after the password field and the question input were cleared and the page was verified token- and marker-free.
const token = syntheticToken();
const visualDir = process.env.ATLAS_UI_VISUAL_DIR;
let api: AskProcess & { console: string };
test.beforeEach(async () => { api = await startAskConsole({ ATLAS_MODE: 'fixture', ATLAS_DEMO_TOKEN: token, ATLAS_ASK_MODE: 'mock' }); });
test.afterEach(async () => { await api?.stop(); });

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
async function capture(page: Page, context: BrowserContext, name: string): Promise<void> {
  expect(await page.locator('#token').inputValue()).toBe('');
  expect(await page.locator('#ask-question').inputValue()).toBe('');
  expect(await tokenRetained(page, context, token)).toEqual(NOTHING_RETAINED);
  expect((await page.content()).includes(QUESTION_MARKER)).toBe(false);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  if (visualDir) await page.screenshot({ path: join(visualDir, `askb-${name}.png`), fullPage: true });
}

for (const width of [320, 768, 1440]) {
  test(`Ask journey at ${width}px: panel, cited answer with an opened evidence card, unsupported answer`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 800 });
    await page.goto(api.console);
    await submitToken(page, token);
    await page.getByRole('button', { name: /Gasta/ }).click();
    await page.locator('#queue-body .obs').filter({ hasText: 'credential theft' }).click();
    await expect(page.locator('#ask-panel')).toBeVisible();
    await page.locator('#ask-panel').scrollIntoViewIfNeeded();
    await capture(page, context, `${width}-panel`);

    await askQuestion(page, 'Why is this urgent?', true);
    await expect(page.locator('#ask-answer h3')).toHaveText('Answer from stored evidence');
    await page.locator('#ask-answer .ask-claims').getByRole('button', { name: 'Show evidence E1' }).click();
    await expect(page.locator('#ask-answer details.ask-fact').first().locator('summary')).toBeFocused();
    await page.locator('#ask-answer').scrollIntoViewIfNeeded();
    await capture(page, context, `${width}-answer`);

    await askQuestion(page, `What is the root cause? ${QUESTION_MARKER}`);
    await expect(page.locator('#ask-answer h3')).toHaveText('Unsupported question');
    await page.locator('#ask-answer').scrollIntoViewIfNeeded();
    await capture(page, context, `${width}-unsupported`);

    // RC2 (R1): an INSUFFICIENT answer shows the neutral no-claim text and only the established note.
    await askQuestion(page, 'Why is this urgent?', false);
    await expect(page.locator('#ask-answer h3')).toHaveText('Insufficient stored evidence');
    await expect(page.locator('#ask-answer .ask-insufficient li')).toHaveText(/asked without one/);
    await page.locator('#ask-answer').scrollIntoViewIfNeeded();
    await capture(page, context, `${width}-insufficient`);
  });
}
