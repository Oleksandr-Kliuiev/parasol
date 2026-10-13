import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { AskProcess } from '../support/ask-pg.ts';
import { askRequests, apiRequests, NOTHING_RETAINED, recordConsole, recordRequests, submitToken, syntheticToken, tokenRetained } from '../support/operator-ui.ts';
import { QUESTION_MARKER, UUID_V4, askPosts, askQuestion, startAskConsole } from '../support/operator-ask-ui.ts';

// ASK-B Q7/Q8 on the real built console served by the compiled FIXTURE API with its CSP: OFF hides Ask entirely; MOCK runs
// the actual free-text → private bearer → synthetic fixture authority → validated source read → local MOCK planner →
// compiler → audit → HTTP → browser validation → answer/citations path. Fixture authority is synthetic (03 "Fixture path");
// DB authority/audit is proven in ask-pg.spec.ts. Nothing is intercepted here. Each test has its own MOCK API process: the
// server's per-actor budget (10 admitted questions per rolling 60 s) is per process and is itself exercised below.
const token = syntheticToken();
let mock: AskProcess & { console: string };
let off: AskProcess & { console: string };
test.beforeAll(async () => { off = await startAskConsole({ ATLAS_MODE: 'fixture', ATLAS_DEMO_TOKEN: token }); });
test.afterAll(async () => { await off?.stop(); });
test.beforeEach(async () => { mock = await startAskConsole({ ATLAS_MODE: 'fixture', ATLAS_DEMO_TOKEN: token, ATLAS_ASK_MODE: 'mock' }); });
test.afterEach(async () => { await mock?.stop(); });

async function openGasta(page: Page, base: string) {
  await page.goto(base);
  await submitToken(page, token);
  await page.getByRole('button', { name: /Gasta/ }).click();
  await expect(page.locator('#queue-body .obs')).toHaveCount(2);
}
const answer = (page: Page) => page.locator('#ask-answer');
const observation = (page: Page, text: string) => page.locator('#queue-body .obs').filter({ hasText: text });

test('OFF: one capability GET per credential answers 404; no Ask panel, input or POST; the accepted console works unchanged', async ({ page }) => {
  const seen = recordRequests(page, off.base);
  await openGasta(page, off.console);
  await observation(page, 'Disk capacity').click();
  await page.getByRole('button', { name: 'Read the stored Atera alert list and find this alert' }).click();
  await expect(page.locator('#evidence-body')).toContainText('FIXTURE');
  await expect(page.locator('#ask-panel')).toBeHidden();
  await expect(page.locator('#ask-question')).toBeHidden();
  expect(await page.locator('body').innerText()).not.toContain('Ask Atlas');
  expect(askRequests(seen).map(r => `${r.method} ${r.path}`)).toEqual(['GET /ask/capabilities']);
  expect(askRequests(seen).every(r => r.sameOrigin && r.bearerIs(token))).toBe(true);
});

test('MOCK EN summary: badge, free input, cited answer with independent urgency, coverage and stored-read limits; citations open cards without network', async ({ page, context }) => {
  const seen = recordRequests(page, mock.base);
  const messages = recordConsole(page);
  const posts = askPosts(page);
  await openGasta(page, mock.console);
  await expect(page.locator('#ask-panel')).toBeVisible();
  await expect(page.locator('#ask-panel .badge-ask')).toHaveText('Ask Atlas — local synthetic MOCK; no external model');
  await expect(page.locator('#ask-examples')).toContainText('What needs attention?');
  await expect(page.locator('#ask-examples')).toContainText('Какое устройство подтверждено?');
  await expect(page.locator('#ask-intro')).toContainText('It is not an LLM');
  await askQuestion(page, 'What needs attention?');
  await expect(page.locator('#ask-question')).toHaveValue('');
  await expect(answer(page).locator('h3')).toHaveText('Answer from stored evidence');
  await expect(page.locator('#ask-status')).toHaveText('Answer from stored evidence: 2 cited claims.');
  const claims = answer(page).locator('.ask-claims li');
  await expect(claims).toHaveCount(2);
  await expect(claims.nth(0)).toContainText('Recorded observation: Possible credential theft (synthetic)');
  await expect(claims.nth(1)).toContainText('Disk capacity used: 96%');
  await expect(answer(page).locator('.ask-urgent')).toContainText('Urgent: source severity CRITICAL: Possible credential theft (synthetic)');
  await expect(answer(page)).toContainText('Synthetic fixture data, not a source read');
  await expect(answer(page)).toContainText('only absent from this stored bounded read');
  await expect(answer(page)).toContainText('not one atomic snapshot');
  await expect(answer(page).locator('details.ask-fact')).toHaveCount(5);
  await expect(answer(page).locator('details.ask-fact[open]')).toHaveCount(0);
  const before = seen.length;
  await claims.nth(1).getByRole('button', { name: 'Show evidence E2' }).click();
  await expect(answer(page).locator('details.ask-fact').nth(1)).toHaveAttribute('open', '');
  await expect(answer(page).locator('details.ask-fact').nth(1).locator('summary')).toBeFocused();
  await expect(answer(page).locator('details.ask-fact').nth(1)).toContainText('demo-atera-connection');
  await page.waitForTimeout(150);
  expect(seen.length, 'a citation makes no request').toBe(before);
  expect(await answer(page).locator('a, [href], iframe, img').count()).toBe(0);
  expect(posts).toHaveLength(1);
  expect(Object.keys(posts[0]!)).toEqual(['contractVersion', 'requestId', 'question', 'observationId']);
  expect(posts[0]).toMatchObject({ contractVersion: 'AskRequestV1', question: 'What needs attention?', observationId: null });
  expect(String(posts[0]!.requestId)).toMatch(UUID_V4);
  expect(askRequests(seen).map(r => `${r.method} ${r.path}`)).toEqual(['GET /ask/capabilities', 'POST /clients/demo-gasta/ask']);
  expect(askRequests(seen).every(r => r.sameOrigin && r.bearerIs(token))).toBe(true);
  // The answer is a separate read: queue, detail and evidence state are unchanged and no other request followed.
  expect(apiRequests(seen).filter(r => r.method === 'GET').map(r => r.path)).toEqual(['/clients', '/clients/demo-gasta/overview', '/clients/demo-gasta/observations']);
  expect(messages).toEqual([]);
  expect(await tokenRetained(page, context, token)).toEqual(NOTHING_RETAINED);
});

test('RU/EN focus questions: source urgency, FIXTURE stored-read state, confirmed device, and insufficient without a focus', async ({ page }) => {
  const posts = askPosts(page);
  await openGasta(page, mock.console);
  await expect(page.locator('#ask-focus')).toBeDisabled();
  await expect(page.locator('#ask-focus-note')).toHaveText('No observation is selected. Select one in the queue to ask about it.');
  await askQuestion(page, 'Почему это срочно?');
  await expect(answer(page).locator('h3')).toHaveText('Insufficient stored evidence');
  await expect(answer(page)).toContainText('Asked without a selected observation.');
  await expect(answer(page).locator('.ask-urgent')).toContainText('CRITICAL', { useInnerText: true });

  await observation(page, 'credential theft').click();
  await expect(page.locator('#ask-focus-note')).toContainText('Selected observation: Possible credential theft (synthetic)');
  await askQuestion(page, 'Почему это срочно?', true);
  await expect(answer(page).locator('h3')).toHaveText('Answer from stored evidence');
  await expect(answer(page).locator('.ask-claims')).toContainText('Urgent: source severity CRITICAL — the source marked it so; it stays urgent regardless of Atlas route, confidence or priority label.');
  const focusId = String(posts.at(-1)!.observationId);
  await expect(answer(page)).toContainText(`Asked about observation ${focusId}.`);

  await askQuestion(page, 'How fresh is the evidence?', true);
  await expect(answer(page).locator('.ask-claims')).toContainText('Stored read of huntress incident on connection demo-huntress-connection: FIXTURE — Synthetic fixture data, not a source read');
  await askQuestion(page, 'Какое устройство подтверждено?', true);
  await expect(answer(page).locator('.ask-claims')).toContainText('Confirmed device: GASTA-LT-07 — exact graph ID demo-device-07 with a confirmed atera agent link');

  await observation(page, 'Disk capacity').click();
  await askQuestion(page, 'why is this urgent', true);
  await expect(answer(page).locator('.ask-claims')).toContainText('Source severity MEDIUM: not HIGH or CRITICAL in this stored read. This does not mean the client is healthy.');
  await expect(answer(page).locator('.ask-urgent'), 'the independent notice still lists the CRITICAL observation').toContainText('Possible credential theft (synthetic)');
  expect(posts.map(p => [p.question, p.observationId === null])).toEqual([['Почему это срочно?', true], ['Почему это срочно?', false], ['How fresh is the evidence?', false],
    ['Какое устройство подтверждено?', false], ['why is this urgent', false]]);
  expect(new Set(posts.map(p => p.requestId)).size).toBe(5);
});

test('unsupported keeps evidence, coverage and urgency; local refusals send nothing; the question marker is never echoed, kept or logged', async ({ page, context }) => {
  const posts = askPosts(page);
  await openGasta(page, mock.console);
  await askQuestion(page, `What is the root cause? ${QUESTION_MARKER}`);
  await expect(answer(page).locator('h3')).toHaveText('Unsupported question');
  await expect(answer(page)).toContainText('Root cause, remediation, other clients, finance, Microsoft 365');
  await expect(answer(page).locator('.ask-urgent')).toContainText('Possible credential theft (synthetic)');
  await expect(answer(page).locator('details.ask-fact')).toHaveCount(5);
  await expect(answer(page).locator('.ask-claims')).toHaveCount(0);
  for (const [question, text] of [['   ', 'Type a question first. Nothing was sent.'], ['x'.repeat(2001), 'longer than 2000 characters. Nothing was sent'],
    ['bell\u0007', 'control characters or invalid text']] as const) {
    await page.locator('#ask-question').fill(question);
    await page.locator('#ask-submit').click();
    await expect(page.locator('#ask-status')).toContainText(text);
    await expect(page.locator('#ask-question'), 'a refused question stays for correction').toHaveValue(question);
    if (question.length > 2000) await expect(page.locator('#ask-limit')).toHaveText('More than 2000 characters: too long to send.');
  }
  await page.locator('#ask-question').fill('');
  await page.locator('#ask-focus').setChecked(false);
  expect(posts).toHaveLength(1);
  const html = await page.content();
  expect(html.includes(QUESTION_MARKER)).toBe(false);
  expect(mock.output().includes(QUESTION_MARKER)).toBe(false);
  expect(mock.output()).not.toMatch(/root cause/i);
  expect(await tokenRetained(page, context, token)).toEqual(NOTHING_RETAINED);
});

test('keyboard-only journey; changes clear answer and input; disconnect and pagehide leave nothing', async ({ page, context }) => {
  await openGasta(page, mock.console);
  await observation(page, 'credential theft').click();
  await page.locator('#ask-question').focus();
  await page.keyboard.insertText('What needs attention?');
  await page.keyboard.press('Tab');
  await expect(page.locator('#ask-focus')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#ask-submit')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(answer(page).locator('h3')).toHaveText('Answer from stored evidence');
  await expect(page.locator('#ask-submit')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(answer(page).locator('.ask-claims').getByRole('button', { name: 'Show evidence E1' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(answer(page).locator('details.ask-fact').first().locator('summary')).toBeFocused();
  await expect(answer(page).locator('details.ask-fact').first()).toHaveAttribute('open', '');

  // Observation change: answer and typed question cleared synchronously; focus moves from the gone card to the Ask heading.
  await answer(page).locator('details.ask-fact').first().locator('summary').focus();
  await page.locator('#ask-question').fill('typed but not sent');
  await observation(page, 'Disk capacity').click();
  await expect(answer(page)).toBeEmpty();
  await expect(page.locator('#ask-question')).toHaveValue('');
  for (const action of ['Refresh queue', 'Refresh context'] as const) {
    await askQuestion(page, 'What needs attention?');
    await expect(answer(page).locator('h3')).toHaveText('Answer from stored evidence');
    await page.locator('#ask-question').fill('typed');
    await page.getByRole('button', { name: action }).click();
    await expect(answer(page)).toBeEmpty();
    await expect(page.locator('#ask-question')).toHaveValue('');
  }
  await askQuestion(page, 'What needs attention?');
  await expect(answer(page).locator('h3')).toHaveText('Answer from stored evidence');
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.locator('#ask-panel')).toBeHidden();
  expect(await answer(page).innerHTML()).toBe('');
  expect(await page.locator('#ask-question').inputValue()).toBe('');
  expect(await tokenRetained(page, context, token)).toEqual(NOTHING_RETAINED);

  await submitToken(page, token);
  await page.getByRole('button', { name: /Gasta/ }).click();
  await askQuestion(page, 'What needs attention?');
  await expect(answer(page).locator('h3')).toHaveText('Answer from stored evidence');
  await page.locator('#ask-question').fill('typed before leaving');
  await page.evaluate(() => { dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); });
  await expect(page.locator('#connect-notice')).toContainText('The page was left or hidden');
  expect(await answer(page).innerHTML()).toBe('');
  expect(await page.locator('#ask-question').inputValue()).toBe('');
  await expect(page.locator('#ask-panel')).toBeHidden();
});

test('the server budget (10 admitted questions per actor per rolling 60 s) answers ASK_BUSY: fixed message, no answer, no retry', async ({ page }) => {
  const posts = askPosts(page);
  await openGasta(page, mock.console);
  for (let i = 1; i <= 10; i += 1) {
    await askQuestion(page, 'What needs attention?');
    await expect(page.locator('#ask-status')).toHaveText('Answer from stored evidence: 2 cited claims.');
  }
  await askQuestion(page, 'What needs attention?');
  await expect(page.locator('#ask-status')).toHaveText('No answer: Ask Atlas is busy (local limits). Nothing was retried.');
  await expect(answer(page)).toContainText('ASK_BUSY');
  await expect(answer(page)).toContainText('Correlation ID');
  await expect(answer(page).locator('.ask-claims, details')).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(posts).toHaveLength(11);
});
