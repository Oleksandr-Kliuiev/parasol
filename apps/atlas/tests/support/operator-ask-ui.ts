import type { Page, Request } from '@playwright/test';
import { startAskProcess } from './ask-pg.ts';
import type { AskProcess } from './ask-pg.ts';

// ASK-B browser support: the compiled API (fixture or DB) with the console and ATLAS_ASK_MODE as given, its whole output
// kept for log-privacy checks, and keyboard helpers for the Ask form. Tokens and question markers are synthetic.

/** A synthetic privacy marker typed into questions; it must never be echoed, stored, logged or captured. */
export const QUESTION_MARKER = 'QUESTION-SECRET-MARKER-ASKB-5d1';

export async function startAskConsole(env: Record<string, string>): Promise<AskProcess & { console: string }> {
  const api = await startAskProcess({ ATLAS_OPERATOR_UI: '1', ...env });
  return { ...api, console: `${api.base}/operator/` };
}

/**
 * Sets the focus checkbox, types `question` with the keyboard and submits with the Ask button. The checkbox comes first:
 * since RC2 (R2) a deliberate focus change is a generation boundary that clears a typed draft.
 */
export async function askQuestion(page: Page, question: string, useFocus = false): Promise<void> {
  // The input exists only for a validated current context (hidden while a context loads).
  await page.locator('#ask-question').waitFor({ state: 'visible' });
  await page.locator('#ask-focus').setChecked(useFocus);
  await page.locator('#ask-question').focus();
  await page.keyboard.insertText(question);
  await page.locator('#ask-submit').click();
}

/** JSON bodies of the Ask POSTs this page sends (synthetic questions only). */
export function askPosts(page: Page): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  page.on('request', (request: Request) => {
    if (request.method() === 'POST' && /\/clients\/[^/]+\/ask$/.test(new URL(request.url()).pathname)) bodies.push(JSON.parse(request.postData() ?? 'null'));
  });
  return bodies;
}

export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
