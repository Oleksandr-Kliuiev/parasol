import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { ApiProcess } from '../support/api-process.ts';
import { ignoreAbort, recordConsole, recordRequests, startConsoleApi, submitToken, syntheticToken, waitFor } from '../support/operator-ui.ts';
import { DB_CLIENT, journeyItems, WS } from '../support/operator-journey.ts';
import { compiledAnswer, dbRead } from '../support/operator-ask.ts';
import { askQuestion } from '../support/operator-ask-ui.ts';
import { journeyRemoteAnswer } from '../support/operator-ask-remote.ts';
import { askHeadersFor, askRemote, fulfill, fulfillError, holdRemoteAsks, serveRemoteCapability, serveRemoteClients } from '../support/operator-ask-remote-ui.ts';
import type { HeldRemote } from '../support/operator-ask-remote-ui.ts';

// ASK-REMOTE R-C browser races (route stubs; fetch ignores AbortSignal and AbortController.abort is disabled, so stale
// completions really arrive): REMOTE typing during a pending question invalidates it while MOCK typing stays as accepted;
// every boundary (credential, client, context, queue, page, filter, observation, focus both directions, pagehide, bfcache)
// clears consent, and a late success/error/401/403/409 of the old question never renders, resets auth or clears a newer
// draft/spinner. Isolation comes from the captured generations, never from abort.
const token = syntheticToken();
const other = syntheticToken();
let api: ApiProcess & { console: string };
test.beforeAll(async () => { api = await startConsoleApi({ ATLAS_MODE: 'fixture', ATLAS_DEMO_TOKEN: token }); });
test.afterAll(async () => { await api?.stop(); });

async function open(page: Page) {
  await ignoreAbort(page);
  await page.addInitScript(() => { AbortController.prototype.abort = function ignored() { /* abort never delivered */ }; });
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
async function nextAsk(page: Page, asks: HeldRemote[], question: string, focus = false): Promise<HeldRemote> {
  const count = asks.length;
  await askRemote(page, question, { focus });
  await waitFor(() => asks.length === count + 1, `ask ${count + 1}`);
  return asks[count]!;
}
const late = (held: HeldRemote, kind: string) => kind === 'success' ? fulfill(held, journeyRemoteAnswer(held.body, 'SUMMARY', DB_CLIENT.id))
  : kind === 'error' ? fulfillError(held, 'ASK_REMOTE_UNAVAILABLE', 503) : kind === '409' ? fulfillError(held, 'ASK_REMOTE_POLICY_CHANGED', 409)
    : fulfillError(held, kind === '401' ? 'ASK_AUTHENTICATION_FAILED' : 'ASK_SCOPE_DENIED', Number(kind));
const LATE = ['success', 'error', '409', '401', '403'] as const;

test('REMOTE typing during a pending question invalidates it (late outcomes ignored, draft kept); MOCK typing during pending is unchanged', async ({ page }) => {
  const { asks } = await open(page);
  for (const kind of LATE) {
    const held = await nextAsk(page, asks, 'What needs attention?');
    await expect(page.locator('#ask-submit')).toHaveAttribute('aria-disabled', 'true');
    await page.locator('#ask-question').focus();
    await page.keyboard.insertText(`new draft ${kind}`);
    await expect(page.locator('#ask-status')).toHaveText('');
    await expect(page.locator('#ask-submit')).toHaveAttribute('aria-disabled', 'false');
    await late(held, kind);
    await page.waitForTimeout(250);
    await expect(page.locator('#ask-question')).toHaveValue(`new draft ${kind}`);
    await expect(answer(page)).toBeEmpty();
    await expect(page.locator('#session-status')).toHaveText('Connected');
    await expect(page.locator('#ask-form')).toBeVisible();
    await expect(page.locator('#ask-consent')).not.toBeChecked();
    await page.locator('#ask-question').fill('');
  }
  // The newly typed (consented) draft is a new question: new UUID, and only its answer renders.
  const fresh = await nextAsk(page, asks, 'What needs attention?');
  expect(new Set(asks.map(a => a.body.requestId)).size).toBe(asks.length);
  await fulfill(fresh, journeyRemoteAnswer(fresh.body, 'SUMMARY', DB_CLIENT.id));
  await expect(answer(page).locator('h3')).toHaveText('Answer from stored evidence');

  // MOCK on another page: typing while a MOCK question is pending neither cancels it nor loses the new draft.
  const mock = await page.context().newPage();
  await ignoreAbort(mock);
  await serveRemoteClients(mock);
  await mock.route('**/ask/capabilities', route => route.fulfill({ status: 200, body: JSON.stringify({ contractVersion: 'AskCapabilityV1', mode: 'mock', questionMaxCodepoints: 2000 }),
    headers: askHeadersFor(randomUUID()) }));
  const mockAsks: { body: any; route: Route }[] = [];
  await mock.route(url => url.pathname === `/clients/${DB_CLIENT.id}/ask`, route => { mockAsks.push({ body: JSON.parse(route.request().postData() ?? 'null'), route }); });
  await mock.goto(api.console);
  await submitToken(mock, token);
  await mock.getByRole('button', { name: /^DB client/ }).click();
  await expect(mock.locator('#ask-consent-row')).toBeHidden();
  await askQuestion(mock, 'What needs attention?');
  await waitFor(() => mockAsks.length === 1, 'mock POST');
  await mock.locator('#ask-question').focus();
  await mock.keyboard.insertText('typed during MOCK pending');
  await expect(mock.locator('#ask-status')).toHaveText('Asking Ask Atlas (local MOCK)…');
  const { source } = dbRead({ workspaceId: WS, clientId: DB_CLIENT.id, page: journeyItems() });
  const v1 = compiledAnswer(source, 'What needs attention?', null, { requestId: mockAsks[0]!.body.requestId, workspaceId: WS, clientId: DB_CLIENT.id });
  await mockAsks[0]!.route.fulfill({ status: 200, body: JSON.stringify(v1), headers: askHeadersFor(v1.correlationId) });
  await expect(mock.locator('#ask-answer h3')).toHaveText('Answer from stored evidence');
  await expect(mock.locator('#ask-question')).toHaveValue('typed during MOCK pending');
  expect(Object.keys(mockAsks[0]!.body)).toEqual(['contractVersion', 'requestId', 'question', 'observationId']);
  await mock.close();
});

test('every boundary clears consent; a late success/error/409/401/403 of the old question never renders or resets; a newer spinner survives', async ({ page }) => {
  const { asks, seen } = await open(page);
  /** Selects whichever of two observations is not currently selected (a real selection change every time). */
  const toggleObservation = async () => {
    const disk = observation(page, 'Disk usage high');
    await ((await disk.getAttribute('aria-current')) === 'true' ? observation(page, 'Ticket (synthetic)') : disk).click();
  };
  const boundaries: [string, () => Promise<void>][] = [
    ['observation', toggleObservation],
    ['focus on', () => page.locator('#ask-focus').check()],
    ['focus off', async () => { await page.locator('#ask-focus').check(); await page.locator('#ask-focus').uncheck(); }],
    ['filter', async () => { await page.locator('#queue-controls input[value="LOW"]').setChecked(false); await page.getByRole('button', { name: 'Apply filters' }).click(); }],
    ['next page', () => page.getByRole('button', { name: 'Next page' }).click()],
    ['queue refresh', () => page.getByRole('button', { name: 'Refresh queue' }).click()],
    ['context refresh', () => page.getByRole('button', { name: 'Refresh context' }).click()],
    ['client', async () => { await page.getByRole('button', { name: /^Second DB client/ }).click(); await page.getByRole('button', { name: /^DB client/ }).click(); }]
  ];
  for (const [name, change] of boundaries) {
    for (const kind of LATE) {
      await expect(page.locator('#queue-body .obs')).toHaveCount(3);
      const held = await nextAsk(page, asks, 'What needs attention?');
      // Consent checked for the (empty) next draft while the question is pending; no edit, so the question stays current.
      await page.locator('#ask-consent').check();
      await expect(page.locator('#ask-status')).toHaveText(/^Asking Ask Atlas REMOTE/);
      await change();
      await expect(page.locator('#ask-consent'), `${name}: consent cleared`).not.toBeChecked();
      await expect(page.locator('#ask-status')).not.toHaveText(/Asking/);
      await expect(page.locator('#queue-body .obs')).toHaveCount(3);
      // A newer pending question keeps its spinner while the old outcome arrives.
      const newer = await nextAsk(page, asks, 'What needs attention?');
      await late(held, kind);
      await page.waitForTimeout(150);
      await expect(page.locator('#ask-status'), `${name} ← ${kind}`).toHaveText(/^Asking Ask Atlas REMOTE/);
      await expect(page.locator('#session-status')).toHaveText('Connected');
      await expect(page.locator('#ask-form')).toBeVisible();
      await expect(answer(page)).toBeEmpty();
      await fulfill(newer, journeyRemoteAnswer(newer.body, 'SUMMARY', DB_CLIENT.id));
      await expect(answer(page).locator('h3')).toHaveText('Answer from stored evidence');
      if (name.startsWith('focus')) await page.locator('#ask-focus').setChecked(false);
    }
  }
  expect(seen.filter(r => r.path === '/ask/capabilities')).toHaveLength(1);
});

test('credential replacement, pagehide and bfcache restore: draft, consent and answer cleared; late outcomes of the old session change nothing', async ({ page }) => {
  const { asks } = await open(page);
  for (const kind of LATE) {
    const held = await nextAsk(page, asks, 'What needs attention?');
    await page.locator('#ask-question').fill('draft before reconnect');
    await page.locator('#ask-consent').check();
    await page.getByRole('button', { name: 'Disconnect' }).click();
    await expect(page.locator('#ask-panel')).toBeHidden();
    expect(await page.locator('#ask-question').inputValue()).toBe('');
    expect(await page.locator('#ask-consent').isChecked()).toBe(false);
    await submitToken(page, kind === '401' ? other : token);
    await page.getByRole('button', { name: /^DB client/ }).click();
    await expect(page.locator('#ask-form')).toBeVisible();
    await late(held, kind);
    await page.waitForTimeout(200);
    await expect(page.locator('#session-status')).toHaveText('Connected');
    await expect(answer(page)).toBeEmpty();
    await expect(page.locator('#ask-consent')).not.toBeChecked();
  }
  for (const persisted of [false, true]) {
    const held = await nextAsk(page, asks, 'What needs attention?');
    await fulfill(held, journeyRemoteAnswer(held.body, 'SUMMARY', DB_CLIENT.id));
    await expect(answer(page).locator('h3')).toHaveText('Answer from stored evidence');
    await page.locator('#ask-question').fill('typed before leaving');
    await page.locator('#ask-consent').check();
    await page.evaluate(p => { dispatchEvent(new PageTransitionEvent(p ? 'pageshow' : 'pagehide', { persisted: true })); }, persisted);
    await expect(page.locator('#connect-notice')).toContainText('The page was left or hidden');
    expect(await answer(page).innerHTML()).toBe('');
    expect(await page.locator('#ask-question').inputValue()).toBe('');
    expect(await page.locator('#ask-consent').isChecked()).toBe(false);
    await expect(page.locator('#ask-panel')).toBeHidden();
    await submitToken(page, token);
    await page.getByRole('button', { name: /^DB client/ }).click();
    await expect(page.locator('#ask-consent')).not.toBeChecked();
  }
});
