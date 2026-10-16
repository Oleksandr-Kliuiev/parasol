import { test, expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { join } from 'node:path';
import type { ApiProcess } from '../support/api-process.ts';
import { NOTHING_RETAINED, askRequests, recordConsole, recordRequests, startConsoleApi, submitToken, syntheticToken, tokenRetained, waitFor } from '../support/operator-ui.ts';
import { DB_CLIENT } from '../support/operator-journey.ts';
import { ADMISSION, BIG_VERSION, journeyRemoteAnswer } from '../support/operator-ask-remote.ts';
import {
  CONSENT, COST, HEADLINE, REMOTE_BADGE, askRemote, capabilityOk, fulfill, fulfillError, holdRemoteAsks, serveRemoteCapability, serveRemoteClients
} from '../support/operator-ask-remote-ui.ts';
import type { HeldRemote } from '../support/operator-ask-remote-ui.ts';

// ASK-REMOTE R-C browser contract on the real built console (CSP enforced) with ROUTE STUBS for the API answers: disclosure,
// cost notice and per-question consent; nothing sent without the manual check; the exact AskRequestV2; capture-then-clear;
// remote answers rendered locally; malformed answers, remote errors, non-admission and the current policy 409 with a manual
// refresh. Route stubs qualify browser behaviour only; authority/admission/ledger journeys are in ask-remote-pg.spec.ts.
const token = syntheticToken();
const MARKER = 'QUESTION-REMOTE-UI-MARKER-c41';
const SENTINEL = 'SERVER-DETAIL-SENTINEL<script>';
const visualDir = process.env.ATLAS_UI_VISUAL_DIR;
let api: ApiProcess & { console: string };
test.beforeAll(async () => { api = await startConsoleApi({ ATLAS_MODE: 'fixture', ATLAS_DEMO_TOKEN: token }); });
test.afterAll(async () => { await api?.stop(); });

async function open(page: Page) {
  const seen = recordRequests(page, api.base);
  const messages = recordConsole(page);
  await serveRemoteClients(page);
  const capability = await serveRemoteCapability(page);
  const asks = await holdRemoteAsks(page);
  await page.goto(api.console);
  await submitToken(page, token);
  await page.getByRole('button', { name: /^DB client/ }).click();
  await expect(page.locator('#queue-body .obs')).toHaveCount(3);
  return { seen, messages, capability, asks };
}
const answer = (page: Page) => page.locator('#ask-answer');
const observation = (page: Page, text: string) => page.locator('#queue-body .obs').filter({ hasText: text });
async function nextAsk(page: Page, asks: HeldRemote[], question: string, options: { focus?: boolean } = {}): Promise<HeldRemote> {
  const count = asks.length;
  await askRemote(page, question, options);
  await waitFor(() => asks.length === count + 1, `ask ${count + 1}`);
  return asks[count]!;
}
const reply = (held: HeldRemote, intent: 'SUMMARY' | 'WHY_URGENT' | 'SOURCE_STATE' | 'ENTITY' | 'UNSUPPORTED' = 'SUMMARY') =>
  fulfill(held, journeyRemoteAnswer(held.body, intent, DB_CLIENT.id));

test('REMOTE panel: fixed disclosure, cost and unchecked consent; no MOCK label/examples; nothing sent without consent; exact V2 body; capture then clear', async ({ page, context }) => {
  const { seen, messages, asks } = await open(page);
  await expect(page.locator('#ask-panel')).toBeVisible();
  await expect(page.locator('#ask-badge')).toHaveText(REMOTE_BADGE);
  await expect(page.locator('#ask-intro')).toHaveText(HEADLINE);
  await expect(page.locator('#ask-examples')).toBeHidden();
  const panel = await page.locator('#ask-panel').innerText();
  expect(/MOCK|What needs attention\?|Почему это срочно/.test(panel), 'no MOCK label or examples in REMOTE').toBe(false);
  const disclosure = page.locator('#ask-disclosure');
  await expect(disclosure).toBeVisible();
  for (const text of ['your original question, exactly as typed', 'a yes/no flag saying whether an observation is in focus', 'Stored evidence does not leave Atlas',
    'billed separately from any chat or coding subscription', 'owner-verified OpenAI account policy', 'Synthetic questions only', 'information, not permission',
    'What needs attention in this client', 'Why the selected observation is urgent', 'How fresh the stored read', 'Which device or person']) {
    await expect(disclosure).toContainText(text);
  }
  await expect(disclosure.locator('a')).toHaveCount(0);
  await disclosure.locator('summary').click();
  await expect(disclosure).toContainText(ADMISSION);
  await expect(disclosure).toContainText(BIG_VERSION);
  await expect(page.locator('#ask-cost')).toHaveText(COST);
  await expect(page.locator('#ask-cost')).toBeVisible();
  await expect(page.getByLabel(CONSENT)).not.toBeChecked();

  // Unchecked: refused locally, nothing sent, the draft stays.
  await observation(page, 'Possible credential theft').click();
  await askRemote(page, `Why is this urgent? ${MARKER}`, { focus: true, consent: false });
  await expect(page.locator('#ask-status')).toHaveText(/consent box is not checked for this question.*Nothing was sent/);
  await expect(page.locator('#ask-question')).toHaveValue(`Why is this urgent? ${MARKER}`);
  // Checking and then editing clears consent: still nothing sent.
  await page.locator('#ask-consent').check();
  await page.locator('#ask-question').press('End');
  await page.keyboard.insertText('!');
  await expect(page.locator('#ask-consent')).not.toBeChecked();
  await page.locator('#ask-submit').click();
  await page.waitForTimeout(150);
  expect(asks).toHaveLength(0);

  await page.locator('#ask-consent').check();
  await page.locator('#ask-submit').click();
  await waitFor(() => asks.length === 1, 'one POST');
  // Synchronous capture-then-clear: input and consent are empty before any response; the focus choice stays.
  await expect(page.locator('#ask-question')).toHaveValue('');
  await expect(page.locator('#ask-consent')).not.toBeChecked();
  await expect(page.locator('#ask-focus')).toBeChecked();
  await expect(page.locator('#ask-status')).toHaveText('Asking Ask Atlas REMOTE (OpenAI GPT-6 Luna interprets the question; facts are compiled locally)…');
  expect(Object.keys(asks[0]!.body)).toEqual(['contractVersion', 'requestId', 'question', 'observationId', 'acknowledgement']);
  expect(asks[0]!.body).toMatchObject({ contractVersion: 'AskRequestV2', question: `Why is this urgent? ${MARKER}!`, observationId: 'obs-crit',
    acknowledgement: { contractVersion: 'AskRemoteDisclosureV1', admissionId: ADMISSION, policyVersion: BIG_VERSION, questionDataClass: 'SYNTHETIC' } });
  expect(asks[0]!.body.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  await reply(asks[0]!, 'WHY_URGENT');
  await expect(answer(page).locator('h3')).toHaveText('Answer from stored evidence');
  await expect(answer(page)).toContainText('task chosen by OpenAI GPT-6 Luna from your question; every fact and claim compiled locally by Atlas');
  await expect(answer(page).locator('.ask-claims')).toContainText('Urgent: source severity CRITICAL');
  expect(await answer(page).innerText()).not.toContain('MOCK');
  // Citations open a card of this answer only: no request.
  const before = seen.length;
  await answer(page).locator('.ask-claims').getByRole('button', { name: 'Show evidence E1' }).click();
  await expect(answer(page).locator('details.ask-fact').first()).toHaveAttribute('open', '');
  await page.waitForTimeout(150);
  expect(seen.length).toBe(before);

  // Keep a handle on this answer's citation button: after the next answer it is detached and opens nothing.
  await page.evaluate(() => { (window as unknown as { staleCite: Element | null }).staleCite = document.querySelector('#ask-answer .ask-claims .btn-cite'); });
  // Next question: new consent required, new UUID; an unsupported intent renders the REMOTE wording.
  await askRemote(page, 'Tell me something else', { consent: false });
  await page.waitForTimeout(150);
  expect(asks).toHaveLength(1);
  await page.locator('#ask-consent').check();
  await page.locator('#ask-submit').click();
  await waitFor(() => asks.length === 2, 'second POST');
  expect(asks[1]!.body.requestId).not.toBe(asks[0]!.body.requestId);
  await reply(asks[1]!, 'UNSUPPORTED');
  await expect(answer(page).locator('h3')).toHaveText('Unsupported question');
  await expect(answer(page)).toContainText('Ask Atlas REMOTE supports only the four listed tasks');
  const requests = seen.length;
  expect(await page.evaluate(() => { const old = (window as unknown as { staleCite: HTMLElement | null }).staleCite; old?.click(); return old?.isConnected ?? null; })).toBe(false);
  await page.waitForTimeout(100);
  await expect(answer(page).locator('details[open]')).toHaveCount(0);
  expect(seen.length).toBe(requests);
  expect(askRequests(seen).map(r => `${r.method} ${r.path}`)).toEqual(['GET /ask/capabilities', `POST /clients/${DB_CLIENT.id}/ask`, `POST /clients/${DB_CLIENT.id}/ask`]);
  expect(seen.every(r => r.sameOrigin)).toBe(true);
  expect((await page.content()).includes(MARKER)).toBe(false);
  expect(await tokenRetained(page, context, token)).toEqual(NOTHING_RETAINED);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie, location.search, location.hash].join('|'))).toBe('0|0|||');
  expect(messages).toEqual([]);
});

test('malformed/mismatched remote answers are discarded whole; remote errors show fixed text without disconnect; NOT_ADMITTED is unavailable, not OFF', async ({ page }) => {
  const { asks, capability, messages } = await open(page);
  const cases: [string, (held: HeldRemote) => Promise<void>][] = [
    ['V1 answer', h => { const a: any = journeyRemoteAnswer(h.body, 'SUMMARY', DB_CLIENT.id); delete a.provenance; a.contractVersion = 'AskAnswerV1'; a.mode = 'mock'; return fulfill(h, a); }],
    ['mode downgrade', h => fulfill(h, { ...journeyRemoteAnswer(h.body, 'SUMMARY', DB_CLIENT.id), mode: 'mock' })],
    ['provenance model', h => { const a: any = journeyRemoteAnswer(h.body, 'SUMMARY', DB_CLIENT.id); a.provenance.model = SENTINEL; return fulfill(h, a); }],
    ['extra key', h => fulfill(h, { ...journeyRemoteAnswer(h.body, 'SUMMARY', DB_CLIENT.id), message: SENTINEL })],
    ['other request', h => fulfill(h, journeyRemoteAnswer({ ...h.body, requestId: crypto.randomUUID() }, 'SUMMARY', DB_CLIENT.id))],
    ['partial bank', h => { const a: any = journeyRemoteAnswer(h.body, 'SUMMARY', DB_CLIENT.id); a.evidence = a.evidence.slice(1); return fulfill(h, a); }],
    ['server text', h => fulfill(h, SENTINEL)]
  ];
  for (const [name, respond] of cases) {
    const held = await nextAsk(page, asks, 'What needs attention?');
    await respond(held);
    await expect(page.locator('#ask-status'), name).toHaveText(/^No answer: /);
    await expect(answer(page).locator('h3')).toHaveCount(0);
    expect(await page.locator('#ask-panel').innerText()).not.toContain('SERVER-DETAIL-SENTINEL');
  }
  for (const [code, status, text] of [['ASK_REMOTE_UNAVAILABLE', 503, 'Your sign-in and access are unchanged'], ['ASK_REMOTE_INVALID', 503, 'did not return one valid supported task'],
    ['ASK_REMOTE_BUDGET', 429, 'spending cap'], ['ASK_REMOTE_MODEL_MISMATCH', 503, 'unexpected model'], ['ASK_REMOTE_USAGE_INVALID', 503, 'usage report']] as const) {
    const held = await nextAsk(page, asks, 'What needs attention?');
    await fulfillError(held, code, status);
    await expect(page.locator('#ask-status')).toContainText(text);
    await expect(answer(page).locator('code').first()).toHaveText(code);
    await expect(page.locator('#session-status')).toHaveText('Connected');
    await expect(page.locator('#ask-form')).toBeVisible();
  }
  expect(capability.count).toBe(1);

  // A fresh page whose capability answers 503 NOT_ADMITTED: the panel says unavailable (not OFF), offers a manual check, no form.
  const other = await page.context().newPage();
  const cap = await serveRemoteCapability(other);
  cap.next = route => { const id = crypto.randomUUID(); return route.fulfill({ status: 503, body: JSON.stringify({ contractVersion: 'AskErrorV1', code: 'ASK_REMOTE_NOT_ADMITTED', correlationId: id }),
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-atlas-correlation-id': id } }); };
  await serveRemoteClients(other);
  await other.goto(api.console);
  await submitToken(other, token);
  await other.getByRole('button', { name: /^DB client/ }).click();
  await expect(other.locator('#ask-panel')).toBeVisible();
  await expect(other.locator('#ask-capability')).toContainText('It is unavailable, not switched off');
  await expect(other.locator('#ask-badge')).toHaveText('Ask Atlas — mode not confirmed');
  await expect(other.locator('#ask-form')).toBeHidden();
  cap.next = capabilityOk();
  await other.getByRole('button', { name: 'Check Ask Atlas again' }).click();
  await expect(other.locator('#ask-form')).toBeVisible();
  await expect(other.locator('#ask-badge')).toHaveText(REMOTE_BADGE);
  expect(cap.count).toBe(2);
  await other.close();
  expect(messages.filter(m => !/status of (409|429|503)/.test(m))).toEqual([]);
});

test('current policy 409: input/answer/consent cleared, unavailable with a manual refresh only; refresh, new consent, new UUID and version', async ({ page }) => {
  const { asks, capability } = await open(page);
  const first = await nextAsk(page, asks, 'What needs attention?');
  await reply(first);
  await expect(answer(page).locator('h3')).toHaveText('Answer from stored evidence');
  const held = await nextAsk(page, asks, 'What needs attention?');
  // A new draft typed (and consented) while the question is pending would invalidate it; here the operator only waits.
  await fulfillError(held, 'ASK_REMOTE_POLICY_CHANGED', 409);
  await expect(page.locator('#ask-capability')).toContainText('The remote Ask policy changed after your consent');
  await expect(page.locator('#ask-status')).toContainText('No answer: The remote Ask policy changed');
  await expect(page.locator('#ask-form')).toBeHidden();
  await expect(page.locator('#ask-question')).toHaveValue('');
  await expect(page.locator('#ask-consent')).not.toBeChecked();
  await expect(answer(page).locator('h3')).toHaveCount(0);
  await page.waitForTimeout(400);
  expect([capability.count, asks.length]).toEqual([1, 2]);
  capability.next = capabilityOk('9007199254740994');
  await page.getByRole('button', { name: 'Refresh the remote Ask disclosure' }).click();
  await expect(page.locator('#ask-form')).toBeVisible();
  await expect(page.locator('#ask-consent')).not.toBeChecked();
  await page.locator('#ask-disclosure summary').click();
  await expect(page.locator('#ask-disclosure')).toContainText('9007199254740994');
  expect(capability.count).toBe(2);
  const again = await nextAsk(page, asks, 'What needs attention?');
  expect(again.body.acknowledgement.policyVersion).toBe('9007199254740994');
  expect(new Set(asks.map(a => a.body.requestId)).size).toBe(3);
  await reply(again);
  await expect(answer(page).locator('h3')).toHaveText('Answer from stored evidence');
});

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
async function capture(page: Page, context: BrowserContext, name: string): Promise<void> {
  expect(await page.locator('#token').inputValue()).toBe('');
  expect(await page.locator('#ask-question').inputValue()).toBe('');
  expect(await tokenRetained(page, context, token)).toEqual(NOTHING_RETAINED);
  expect((await page.content()).includes(MARKER)).toBe(false);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  if (visualDir) await page.screenshot({ path: join(visualDir, `askremote-${name}.png`), fullPage: true });
}
for (const width of [320, 768, 1440]) {
  test(`REMOTE keyboard journey at ${width}px: labelled controls, consent by Space, live status, no horizontal overflow`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 800 });
    const { asks } = await open(page);
    await observation(page, 'Possible credential theft').click();
    await page.locator('#ask-panel').scrollIntoViewIfNeeded();
    await capture(page, context, `${width}-panel`);
    await page.locator('#ask-question').focus();
    await page.keyboard.insertText(`Why is this urgent? ${MARKER}`);
    await page.keyboard.press('Tab');
    await expect(page.locator('#ask-focus')).toBeFocused();
    await page.keyboard.press('Space');
    // A focus change is a boundary: it cleared the draft; type again, then consent with the keyboard.
    await expect(page.locator('#ask-question')).toHaveValue('');
    await page.locator('#ask-question').focus();
    await page.keyboard.insertText(`Why is this urgent? ${MARKER}`);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(page.getByLabel(CONSENT)).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.getByLabel(CONSENT)).toBeChecked();
    await page.keyboard.press('Tab');
    await expect(page.locator('#ask-submit')).toBeFocused();
    await page.keyboard.press('Enter');
    await waitFor(() => asks.length === 1, 'POST');
    await expect(page.locator('#ask-status')).toHaveAttribute('role', 'status');
    await expect(page.locator('#ask-submit')).toBeFocused();
    await reply(asks[0]!, 'WHY_URGENT');
    await expect(answer(page).locator('h3')).toHaveText('Answer from stored evidence');
    await page.keyboard.press('Tab');
    await expect(answer(page).locator('.ask-claims').getByRole('button', { name: 'Show evidence E1' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(answer(page).locator('details.ask-fact').first().locator('summary')).toBeFocused();
    expect(await page.locator('#ask-consent').boundingBox()).not.toBeNull();
    await page.locator('#ask-answer').scrollIntoViewIfNeeded();
    await capture(page, context, `${width}-answer`);
  });
}
