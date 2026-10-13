import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import type { ApiProcess } from '../support/api-process.ts';
import type { AskProcess } from '../support/ask-pg.ts';
import { ignoreAbort, recordConsole, recordRequests, startConsoleApi, submitToken, syntheticToken, waitFor } from '../support/operator-ui.ts';
import { DB_CLIENT, journeyItems, serveDbClient, WS } from '../support/operator-journey.ts';
import { compiledAnswer, dbRead, emptyPlanAnswer, link, resource } from '../support/operator-ask.ts';
import type { DbRead } from '../support/operator-ask.ts';
import { askQuestion, startAskConsole } from '../support/operator-ask-ui.ts';

// ASK-B RC2 repairs on the real built console (docs/stage5/reviews/ASTRA_S5ASKB_RC1.md). R1 rendering and the R2 races use an
// explicitly qualified HTTP response seam for a synthetic DB-shaped client (answers compiled by the ACCEPTED server modules):
// rendering/race proof only, never authorization. The last R2 test delays an ACTUAL fixture MOCK server response. fetch
// ignores AbortSignal and AbortController.abort is disabled, so stale completions really arrive.
const token = syntheticToken();
const other = syntheticToken();
let api: ApiProcess & { console: string };
test.beforeAll(async () => { api = await startConsoleApi({ ATLAS_MODE: 'fixture', ATLAS_DEMO_TOKEN: token }); });
test.afterAll(async () => { await api?.stop(); });

const CL = DB_CLIENT.id;
const headers = (correlationId: string) => ({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-atlas-correlation-id': correlationId });
const CAPABILITY = { contractVersion: 'AskCapabilityV1', mode: 'mock', questionMaxCodepoints: 2000 };
type Body = { requestId: string; question: string; observationId: string | null };
interface HeldAsk { body: Body; route: Route }
function read(focus: DbRead['focus'], patch: Partial<DbRead> = {}) {
  return dbRead({ workspaceId: WS, clientId: CL, focus, page: journeyItems(), devices: [{ id: 'd-1', label: 'HOST-01' }],
    links: [link('d-1', 'DEVICE', 'atera', 'agent', 'conn-atera', 'agent-1')],
    resources: [resource('atera', 'alert', 'conn-atera', 'OK'), resource('huntress', 'incident', 'conn-huntress', 'STALE')], ...patch });
}
const fulfill = (held: HeldAsk, body: unknown, status = 200) => {
  const correlationId = (body as { correlationId?: string }).correlationId ?? crypto.randomUUID();
  return held.route.fulfill({ status, body: JSON.stringify(body), headers: headers(correlationId) }).catch(() => undefined);
};
const compiled = (b: Body) => { const { source, focusId } = read(b.observationId === null ? null : { id: b.observationId });
  return compiledAnswer(source, b.question, focusId, { workspaceId: WS, clientId: CL, requestId: b.requestId }); };
const askError = (code: string) => { const id = crypto.randomUUID(); return { contractVersion: 'AskErrorV1', code, correlationId: id }; };

async function open(page: Page) {
  await ignoreAbort(page);
  await page.addInitScript(() => { AbortController.prototype.abort = function ignored() { /* abort never delivered */ }; });
  const seen = recordRequests(page, api.base);
  const messages = recordConsole(page);
  await serveDbClient(page, 'ok');
  await page.route('**/ask/capabilities', route => route.fulfill({ status: 200, json: CAPABILITY, headers: headers(crypto.randomUUID()) }));
  const asks: HeldAsk[] = [];
  await page.route(url => url.pathname === `/clients/${CL}/ask`, route => { asks.push({ body: JSON.parse(route.request().postData() ?? 'null'), route }); });
  await page.goto(api.console);
  await submitToken(page, token);
  await page.getByRole('button', { name: /DB client/ }).click();
  await expect(page.locator('#queue-body .obs')).toHaveCount(3);
  return { seen, messages, asks };
}
async function nextAsk(page: Page, asks: HeldAsk[], question: string, focus: boolean): Promise<HeldAsk> {
  const count = asks.length;
  await askQuestion(page, question, focus);
  await waitFor(() => asks.length === count + 1, `ask ${count + 1}`);
  return asks[count]!;
}
const answer = (page: Page) => page.locator('#ask-answer');
const observation = (page: Page, text: string) => page.locator('#queue-body .obs').filter({ hasText: text });
const MISLEADING = /no observation or stored-read fact to summarize|This needs a selected observation|not found in this client|Select one, check/;

test('R1 rendered: empty plans of all four supported intents with eligible evidence and a present focus show only the neutral no-claim text', async ({ page }) => {
  const { asks } = await open(page);
  await observation(page, 'Possible credential theft').click();
  for (const intent of ['SUMMARY', 'WHY_URGENT', 'SOURCE_STATE', 'ENTITY'] as const) {
    const held = await nextAsk(page, asks, 'What needs attention?', true);
    const { source, focusId } = read({ id: held.body.observationId! });
    await fulfill(held, emptyPlanAnswer(source, intent, focusId, { workspaceId: WS, clientId: CL, requestId: held.body.requestId }));
    await expect(answer(page).locator('h3')).toHaveText('Insufficient stored evidence');
    const box = answer(page).locator('.ask-insufficient');
    await expect(box).toContainText('No supported claim was compiled for this question. This is not a finding about the source');
    await expect(box.locator('li'), `${intent}: no established note applies`).toHaveCount(0);
    await expect(answer(page)).not.toContainText(MISLEADING);
    await expect(answer(page)).toContainText('Asked about observation obs-crit.');
    await expect(answer(page)).not.toContainText('not among the evidence');
    await expect(answer(page).locator('details.ask-fact')).toHaveCount(source.page.length + 2 + 1);
    await expect(answer(page).locator('.ask-urgent')).toContainText('Urgent: source severity CRITICAL: Possible credential theft (synthetic)');
    await expect(answer(page).locator('.ask-coverage')).toContainText('Evidence facts: 6 (limit 32)');
    await expect(answer(page).locator('.ask-claims')).toHaveCount(0);
  }
});

test('R1 rendered: genuinely absent focus/fact/evidence adds only the established note', async ({ page }) => {
  const { asks } = await open(page);
  const cases: [string, boolean, (b: Body) => unknown, RegExp | null, RegExp | null][] = [
    ['asked without focus', false, b => { const { source } = read(null); return emptyPlanAnswer(source, 'WHY_URGENT', null, { workspaceId: WS, clientId: CL, requestId: b.requestId }); },
      /This question is about a selected observation and was asked without one/, null],
    ['focus not returned', true, b => { const { source, focusId } = read({ missing: b.observationId! }, { page: journeyItems().filter(o => o.id !== b.observationId) });
      return emptyPlanAnswer(source, 'ENTITY', focusId, { workspaceId: WS, clientId: CL, requestId: b.requestId }); }, null, /It is not among the evidence returned with this answer/],
    ['no exact tuple read', true, b => { const { source, focusId } = read({ id: b.observationId! }, { resources: [resource('atera', 'alert', 'conn-atera', 'OK')] });
      return emptyPlanAnswer(source, 'SOURCE_STATE', focusId, { workspaceId: WS, clientId: CL, requestId: b.requestId }); },
      /No stored-read state with the selected observation's exact source, type and connection/, null],
    ['empty evidence', false, b => { const { source } = read(null, { page: [], resources: [] }); return emptyPlanAnswer(source, 'SUMMARY', null, { workspaceId: WS, clientId: CL, requestId: b.requestId }); },
      /This answer's bounded evidence has no facts/, null]
  ];
  await observation(page, 'Possible credential theft').click();
  for (const [name, focus, build, note, focusLine] of cases) {
    const held = await nextAsk(page, asks, 'Why is this urgent?', focus);
    await fulfill(held, build(held.body));
    await expect(answer(page).locator('h3'), name).toHaveText('Insufficient stored evidence');
    await expect(answer(page).locator('.ask-insufficient li')).toHaveCount(note ? 1 : 0);
    if (note) await expect(answer(page).locator('.ask-insufficient li')).toHaveText(note);
    if (focusLine) await expect(answer(page)).toContainText(focusLine);
    await expect(answer(page)).not.toContainText(MISLEADING);
  }
});

test('R2 keyboard: a deliberate focus change on a READY answer clears answer and draft in both directions; the choice and keyboard focus stay', async ({ page }) => {
  const { asks } = await open(page);
  await observation(page, 'Possible credential theft').click();
  for (const [submitWithFocus, expectChecked] of [[false, true], [true, false]] as const) {
    const held = await nextAsk(page, asks, 'Why is this urgent?', submitWithFocus);
    await expect(page.locator('#ask-focus'), 'a send keeps the sent choice').toBeChecked({ checked: submitWithFocus });
    await fulfill(held, compiled(held.body));
    await expect(answer(page).locator('h3')).toHaveText(submitWithFocus ? 'Answer from stored evidence' : 'Insufficient stored evidence');
    await page.locator('#ask-question').fill('draft question (synthetic)');
    await page.locator('#ask-focus').focus();
    await page.keyboard.press('Space');
    await expect(page.locator('#ask-focus')).toBeChecked({ checked: expectChecked });
    await expect(page.locator('#ask-focus')).toBeFocused();
    await expect(answer(page)).toBeEmpty();
    await expect(page.locator('#ask-question')).toHaveValue('');
    await expect(page.locator('#ask-status')).toHaveText('');
  }
});

test('R2 race (abort never delivered): late success/error/401/403 after a focus change in both directions never render, disconnect or reset; a newer pending survives', async ({ page }) => {
  const { asks, seen } = await open(page);
  await observation(page, 'Possible credential theft').click();
  for (const late of ['success', 'error', '401', '403'] as const) {
    for (const firstFocus of [false, true]) {
      const old = await nextAsk(page, asks, 'Why is this urgent?', firstFocus);
      await expect(page.locator('#ask-status')).toHaveText('Asking Ask Atlas (local MOCK)…');
      await page.locator('#ask-focus').setChecked(!firstFocus);
      await expect(page.locator('#ask-status'), 'spinner cleared synchronously').toHaveText('');
      const newer = await nextAsk(page, asks, 'Why is this urgent?', !firstFocus);
      expect(newer.body.requestId).not.toBe(old.body.requestId);
      expect(newer.body.observationId).toBe(firstFocus ? null : 'obs-crit');
      await page.locator('#ask-submit').click({ force: true });
      if (late === 'success') await fulfill(old, compiled(old.body));
      else if (late === 'error') await fulfill(old, askError('ASK_BUSY'), 429);
      else await fulfill(old, askError(late === '401' ? 'ASK_AUTHENTICATION_FAILED' : 'ASK_SCOPE_DENIED'), Number(late));
      await page.waitForTimeout(200);
      await expect(page.locator('#ask-status'), `old ${late} cannot clear the newer spinner`).toHaveText('Asking Ask Atlas (local MOCK)…');
      await expect(page.locator('#session-status')).toHaveText('Connected');
      await expect(page.locator('#scope-panel')).not.toContainText('refused access');
      await fulfill(newer, compiled(newer.body));
      await expect(answer(page).locator('h3')).toHaveText(firstFocus ? 'Insufficient stored evidence' : 'Answer from stored evidence');
    }
  }
  expect(asks).toHaveLength(16);
  // No newer question at all: only the focus change itself can void the old work (both directions, late success and error).
  for (const firstFocus of [false, true]) {
    for (const late of ['success', 'error'] as const) {
      const old = await nextAsk(page, asks, 'Why is this urgent?', firstFocus);
      await page.locator('#ask-focus').setChecked(!firstFocus);
      if (late === 'success') await fulfill(old, compiled(old.body)); else await fulfill(old, askError('ASK_BUSY'), 429);
      await page.waitForTimeout(200);
      await expect(answer(page), `focus ${firstFocus} → ${!firstFocus}: stale ${late} never renders`).toBeEmpty();
      await expect(page.locator('#ask-status')).toHaveText('');
    }
  }
  expect(seen.filter(r => r.path === '/clients')).toHaveLength(1);
  // A late 401 of an old-focus question after a credential replacement cannot disconnect the new session.
  const old = await nextAsk(page, asks, 'Why is this urgent?', true);
  await page.locator('#ask-focus').setChecked(true);
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await submitToken(page, other);
  await page.getByRole('button', { name: /DB client/ }).click();
  await expect(page.locator('#queue-body .obs')).toHaveCount(3);
  await fulfill(old, askError('ASK_AUTHENTICATION_FAILED'), 401);
  await page.waitForTimeout(200);
  await expect(page.locator('#session-status')).toHaveText('Connected');
});

test('R2 actual fixture server: a response delayed in transit across a deliberate focus change never renders', async ({ page }) => {
  const fixtureToken = syntheticToken();
  const real: AskProcess & { console: string } = await startAskConsole({ ATLAS_MODE: 'fixture', ATLAS_DEMO_TOKEN: fixtureToken, ATLAS_ASK_MODE: 'mock' });
  try {
    await ignoreAbort(page);
    await page.addInitScript(() => { AbortController.prototype.abort = function ignored() { /* abort never delivered */ }; });
    const held: Route[] = [];
    const askRoute = (url: URL) => /^\/clients\/[^/]+\/ask$/.test(url.pathname);
    await page.route(askRoute, route => { held.push(route); });
    await page.goto(real.console);
    await submitToken(page, fixtureToken);
    await page.getByRole('button', { name: /Gasta/ }).click();
    await page.locator('#queue-body .obs').filter({ hasText: 'credential theft' }).click();
    await askQuestion(page, 'What needs attention?', false);
    await waitFor(() => held.length === 1, 'held real request');
    await page.locator('#ask-question').fill('draft (synthetic)');
    await page.locator('#ask-focus').check();
    await expect(page.locator('#ask-status')).toHaveText('');
    await expect(page.locator('#ask-question')).toHaveValue('');
    const response = await held[0]!.fetch();
    expect(response.status()).toBe(200);
    await held[0]!.fulfill({ response });
    await page.waitForTimeout(300);
    await expect(answer(page)).toBeEmpty();
    // The checkbox remains usable: a focused question now goes through the real server.
    await page.unroute(askRoute);
    await askQuestion(page, 'Why is this urgent?', true);
    await expect(answer(page).locator('.ask-claims')).toContainText('Urgent: source severity CRITICAL');
  } finally { await real.stop(); }
});
