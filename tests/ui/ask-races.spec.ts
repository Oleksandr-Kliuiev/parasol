import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { ApiProcess } from '../support/api-process.ts';
import { askRequests, ignoreAbort, recordConsole, recordRequests, startConsoleApi, submitToken, syntheticToken, waitFor } from '../support/operator-ui.ts';
import { DB_CLIENT, journeyItems, serveDbClient, WS } from '../support/operator-journey.ts';
import { compiledAnswer, dbRead } from '../support/operator-ask.ts';
import { askQuestion } from '../support/operator-ask-ui.ts';

// ASK-B Q6/Q7 browser races and malformed responses on the real built console with its CSP. Only HTTP answers are
// intercepted (synthetic DB-shaped client, answers compiled by the accepted server modules): this qualifies transport,
// race and validation behaviour, NOT authorization (ask-pg.spec.ts). fetch ignores AbortSignal and AbortController.abort is
// disabled, so stale completions really arrive and isolation must come from the captured generations.
const token = syntheticToken();
const other = syntheticToken();
let api: ApiProcess & { console: string };
test.beforeAll(async () => { api = await startConsoleApi({ ATLAS_MODE: 'fixture', ATLAS_DEMO_TOKEN: token }); });
test.afterAll(async () => { await api?.stop(); });

const SENTINEL = 'SERVER-DETAIL-SENTINEL<script>';
const headers = (correlationId: string) => ({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-atlas-correlation-id': correlationId });
const CAPABILITY = { contractVersion: 'AskCapabilityV1', mode: 'mock', questionMaxCodepoints: 2000 };
/** The answer the API would compile for this recorded question. */
function compiled(body: { requestId: string; question: string; observationId: string | null }) {
  const { source, focusId } = dbRead({ workspaceId: WS, clientId: DB_CLIENT.id, page: journeyItems(), focus: body.observationId === null ? null : { id: body.observationId } });
  return compiledAnswer(source, body.question, focusId, { workspaceId: WS, clientId: DB_CLIENT.id, requestId: body.requestId });
}
interface HeldAsk { body: { requestId: string; question: string; observationId: string | null }; route: Route }
const answerWith = (held: HeldAsk, body: unknown, status = 200, correlationId = (body as { correlationId?: string }).correlationId ?? randomUUID()) =>
  held.route.fulfill({ status, body: typeof body === 'string' ? body : JSON.stringify(body), headers: headers(correlationId) }).catch(() => undefined);
const errorWith = (held: HeldAsk, code: string, status: number) => { const id = randomUUID(); return answerWith(held, { contractVersion: 'AskErrorV1', code, correlationId: id }, status, id); };

async function open(page: Page, capability: (route: Route) => Promise<void> = route => route.fulfill({ status: 200, json: CAPABILITY, headers: headers(randomUUID()) })) {
  await ignoreAbort(page);
  await page.addInitScript(() => { AbortController.prototype.abort = function ignored() { /* abort never delivered */ }; });
  const seen = recordRequests(page, api.base);
  const messages = recordConsole(page);
  await serveDbClient(page, 'ok');
  const capabilities: Route[] = [];
  await page.route('**/ask/capabilities', route => { capabilities.push(route); return capability(route); });
  const asks: HeldAsk[] = [];
  await page.route(url => url.pathname === `/clients/${DB_CLIENT.id}/ask`, route => { asks.push({ body: JSON.parse(route.request().postData() ?? 'null'), route }); });
  await page.goto(api.console);
  await submitToken(page, token);
  await page.getByRole('button', { name: /DB client/ }).click();
  await expect(page.locator('#queue-body .obs')).toHaveCount(3);
  return { seen, messages, asks, capabilities };
}
const answer = (page: Page) => page.locator('#ask-answer');
const observation = (page: Page, text: string) => page.locator('#queue-body .obs').filter({ hasText: text });
/** Asks and waits for exactly one new held POST. */
async function nextAsk(page: Page, asks: HeldAsk[], question: string, focus = false): Promise<HeldAsk> {
  const count = asks.length;
  await askQuestion(page, question, focus);
  await waitFor(() => asks.length === count + 1, `ask ${count + 1}`);
  return asks[count]!;
}
/** Selects whichever of two observations is not currently selected (a real selection change every time). */
async function toggleObservation(page: Page): Promise<void> {
  const disk = observation(page, 'Disk usage high');
  await ((await disk.getAttribute('aria-current')) === 'true' ? observation(page, 'Ticket (synthetic)') : disk).click();
}

test('double submit while pending sends once; delayed success/error after observation, filter, page, context or queue refresh never renders', async ({ page }) => {
  const { asks, seen } = await open(page);
  await observation(page, 'Possible credential theft').click();
  await askQuestion(page, 'Why is this urgent?', true);
  // Activation while pending: the button keeps focus (aria-disabled, which Playwright's actionability treats as disabled,
  // so the duplicate activations are forced: a mouse click and Enter/Space on the focused button).
  await page.locator('#ask-submit').click({ force: true });
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  await expect(page.locator('#ask-status')).toHaveText('Asking Ask Atlas (local MOCK)…');
  await expect(page.locator('#ask-submit')).toHaveAttribute('aria-disabled', 'true');
  await page.waitForTimeout(200);
  expect(asks).toHaveLength(1);
  await answerWith(asks[0]!, compiled(asks[0]!.body));
  await expect(answer(page).locator('.ask-claims')).toContainText('Urgent: source severity CRITICAL');

  const changes: [string, () => Promise<void>][] = [
    ['observation', () => toggleObservation(page)],
    ['filter', async () => { await page.locator('#queue-controls input[value="LOW"]').setChecked(false); await page.getByRole('button', { name: 'Apply filters' }).click(); }],
    ['next page', () => page.getByRole('button', { name: 'Next page' }).click()],
    ['context refresh', () => page.getByRole('button', { name: 'Refresh context' }).click()],
    ['queue refresh', () => page.getByRole('button', { name: 'Refresh queue' }).click()]
  ];
  for (const [name, change] of changes) {
    for (const late of ['success', 'error'] as const) {
      await expect(page.locator('#queue-body .obs').first()).toBeVisible();
      const held = await nextAsk(page, asks, 'What needs attention?');
      await change();
      await expect(answer(page), `${name}: cleared synchronously`).toBeEmpty();
      await expect(page.locator('#ask-status')).toHaveText('');
      if (late === 'success') await answerWith(held, compiled(held.body)); else await errorWith(held, 'ASK_BUSY', 429);
      await page.waitForTimeout(200);
      await expect(answer(page), `${name}: stale ${late} ignored`).toBeEmpty();
      await expect(page.locator('#ask-status')).toHaveText('');
    }
  }
  expect(askRequests(seen).filter(r => r.method === 'GET')).toHaveLength(1);
});

test('stale 401/403 cannot disconnect or reset a newer session/scope; current 401 disconnects; current 403 resets once; 404/409 fixed', async ({ page }) => {
  const { asks, seen } = await open(page);
  await nextAsk(page, asks, 'What needs attention?');
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await submitToken(page, other);
  await page.getByRole('button', { name: /DB client/ }).click();
  await expect(page.locator('#queue-body .obs')).toHaveCount(3);
  await errorWith(asks[0]!, 'ASK_AUTHENTICATION_FAILED', 401);
  await page.waitForTimeout(200);
  await expect(page.locator('#session-status')).toHaveText('Connected');
  await nextAsk(page, asks, 'What needs attention?');
  await page.getByRole('button', { name: 'Refresh context' }).click();
  await errorWith(asks[1]!, 'ASK_SCOPE_DENIED', 403);
  await page.waitForTimeout(200);
  await expect(page.locator('#scope-panel')).not.toContainText('refused access');
  expect(seen.filter(r => r.path === '/clients')).toHaveLength(2);

  for (const [code, status, text] of [['ASK_CONTEXT_UNAVAILABLE', 404, 'Ask Atlas is unavailable for this client'], ['ASK_SCOPE_CHANGED', 409, 'Your access changed while the answer was prepared'],
    ['ASK_PLANNER_INVALID', 503, 'invalid plan']] as const) {
    await errorWith(await nextAsk(page, asks, 'What needs attention?'), code, status);
    await expect(page.locator('#ask-status')).toContainText(text);
    await expect(answer(page)).toContainText(code);
    await expect(answer(page).locator('details')).toHaveCount(0);
  }
  await errorWith(await nextAsk(page, asks, 'What needs attention?'), 'ASK_SCOPE_DENIED', 403);
  await expect(page.locator('#scope-panel')).toContainText('refused access to the previously selected client');
  await expect(page.locator('#workspace')).toBeHidden();
  await page.waitForTimeout(200);
  expect(seen.filter(r => r.path === '/clients')).toHaveLength(3);
  await page.getByRole('button', { name: /DB client/ }).click();
  await errorWith(await nextAsk(page, asks, 'What needs attention?'), 'ASK_AUTHENTICATION_FAILED', 401);
  await expect(page.locator('#connect-notice')).toContainText('The API did not accept the token');
  await expect(page.locator('#ask-panel')).toBeHidden();
});

test('malformed or mismatched answers are discarded whole with a fixed message; server text never shown; nothing retried', async ({ page }) => {
  const { asks, messages } = await open(page);
  await observation(page, 'Possible credential theft').click();
  const cases: [string, (held: HeldAsk) => Promise<void>, string][] = [
    ['extra key', h => answerWith(h, { ...compiled(h.body), message: SENTINEL }), 'did not match the expected contract'],
    ['other request', h => answerWith(h, { ...compiled(h.body), requestId: randomUUID() }), 'did not match the expected contract'],
    ['other focus', h => answerWith(h, { ...compiled(h.body), focusObservationId: null }), 'did not match the expected contract'],
    ['unknown claim', h => { const a: any = compiled(h.body); a.claims[0].code = 'ROOT_CAUSE'; return answerWith(h, a); }, 'did not match the expected contract'],
    ['urgency dropped', h => { const a: any = compiled(h.body); a.urgentRefs = []; return answerWith(h, a); }, 'did not match the expected contract'],
    ['partial JSON', h => answerWith(h, JSON.stringify(compiled(h.body)).slice(0, 200), 200, randomUUID()), 'did not match the expected contract'],
    ['correlation header', h => { const a = compiled(h.body); return answerWith(h, a, 200, randomUUID()); }, 'did not match the expected contract'],
    ['too large', h => answerWith(h, { ...compiled(h.body), pad: 'x'.repeat(256 * 1024) }), 'exceeded this console\'s size limits'],
    ['server error text', h => h.route.fulfill({ status: 500, body: SENTINEL, headers: { 'content-type': 'text/plain' } }), 'The API answered with an error.']
  ];
  for (const [name, respond, text] of cases) {
    await respond(await nextAsk(page, asks, 'Why is this urgent?', true));
    await expect(page.locator('#ask-status'), name).toContainText(text);
    await expect(answer(page).locator('.ask-claims, details, .ask-urgent'), `${name}: no partial render`).toHaveCount(0);
    expect(await page.locator('body').innerText()).not.toContain('SERVER-DETAIL-SENTINEL');
  }
  await page.waitForTimeout(200);
  expect(asks).toHaveLength(cases.length);
  // Only the browser's own network line for the synthetic 500; no script error, CSP violation or console output of the console.
  expect(messages).toEqual(['error: Failed to load resource: the server responded with a status of 500 (Internal Server Error)']);
});

test('capability: late MOCK of a replaced credential never exposes the input; a failure shows a fixed state and an explicit retry', async ({ page }) => {
  let mode: 'hold' | 'fail' | 'ok' = 'hold';
  const held: Route[] = [];
  const { capabilities } = await open(page, async route => {
    if (mode === 'hold') { held.push(route); return; }
    if (mode === 'fail') return route.fulfill({ status: 503, json: { contractVersion: 'AskErrorV1', code: 'ASK_RUNTIME_NOT_READY', correlationId: '0' }, headers: headers(randomUUID()) });
    return route.fulfill({ status: 200, json: CAPABILITY, headers: headers(randomUUID()) });
  });
  await expect(page.locator('#ask-panel')).toBeHidden();
  mode = 'fail';
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await submitToken(page, other);
  await page.getByRole('button', { name: /DB client/ }).click();
  await expect(page.locator('#ask-capability')).toHaveText('Ask Atlas availability could not be checked. Nothing else on this page was affected.');
  await held[0]!.fulfill({ status: 200, json: CAPABILITY, headers: headers(randomUUID()) });
  await page.waitForTimeout(200);
  await expect(page.locator('#ask-form'), 'the old credential\'s MOCK cannot expose the input').toBeHidden();
  mode = 'ok';
  await page.getByRole('button', { name: 'Check Ask Atlas again' }).click();
  await expect(page.locator('#ask-form')).toBeVisible();
  expect(capabilities).toHaveLength(3);

});

test('capability current 403: full scope reset and one picker refresh, never asked again (no loop, no auto-select)', async ({ page }) => {
  const seen = recordRequests(page, api.base);
  await serveDbClient(page, 'ok');
  let capabilities = 0;
  await page.route('**/ask/capabilities', route => { capabilities += 1; return route.fulfill({ status: 403, body: '', headers: { 'content-type': 'application/json' } }); });
  await page.goto(api.console);
  await submitToken(page, token);
  await expect(page.locator('#scope-panel')).toContainText('refused access to the previously selected client');
  await page.waitForTimeout(300);
  expect([capabilities, seen.filter(r => r.path === '/clients').length]).toEqual([1, 2]);
  await expect(page.locator('#workspace')).toBeHidden();
  await page.getByRole('button', { name: /DB client/ }).click();
  await expect(page.locator('#queue-body .obs')).toHaveCount(3);
  await expect(page.locator('#ask-capability')).toHaveText('Ask Atlas availability could not be checked. Nothing else on this page was affected.');
  await expect(page.locator('#ask-form')).toBeHidden();
  expect(capabilities).toBe(1);
});

test('one original 10 s browser budget: an answer that never completes is TIMEOUT, not retried; the panel stays usable', async ({ page }) => {
  test.setTimeout(60_000);
  const { asks } = await open(page);
  await askQuestion(page, 'What needs attention?');
  const started = Date.now();
  await expect(page.locator('#ask-status')).toContainText('did not complete within 10 seconds', { timeout: 15_000 });
  expect(Date.now() - started).toBeGreaterThanOrEqual(9_000);
  await page.waitForTimeout(300);
  expect(asks).toHaveLength(1);
  await nextAsk(page, asks, 'What needs attention?');
  expect(asks[1]!.body.requestId).not.toBe(asks[0]!.body.requestId);
  await answerWith(asks[1]!, compiled(asks[1]!.body));
  await expect(answer(page).locator('h3')).toHaveText('Answer from stored evidence');
  await answerWith(asks[0]!, compiled(asks[0]!.body));
  await page.waitForTimeout(200);
  await expect(answer(page).locator('h3')).toHaveText('Answer from stored evidence');
});
