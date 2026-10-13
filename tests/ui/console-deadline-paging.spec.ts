import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { ApiProcess } from '../support/api-process.ts';
import { apiRequests, holdApi, recordRequests, startConsoleApi, submitToken, syntheticToken, waitFor } from '../support/operator-ui.ts';
import { dbContext } from '../support/operator-fixtures.ts';

// S5A-rc1 review R1/R2 on the real built console and compiled fixture API (CSP enforced, no request to a real source).
// R1: the original default 10 s budget must also bound synchronous decode/parse/validation. Playwright's controlled
// clock brings the operation near its expiry, then lets time flow and stalls synchronously across it; no real 10 s wait.
// R2: a fixture overview whose observation page implies pagination must never be marked validated.
const token = syntheticToken();
let api: ApiProcess & { console: string };
test.beforeAll(async () => { api = await startConsoleApi({ ATLAS_MODE: 'fixture', ATLAS_DEMO_TOKEN: token }); });
test.afterAll(async () => { await api?.stop(); });

interface Outcome { ok: boolean; code?: string; rows?: number; bodyAtMs: number; elapsedMs: number }
/** Built transport.js with its defaults (performance.now, 10 000 ms); validation stalls synchronously until `stallUntilMs`. */
async function builtDeadlineCase(page: Page, stallUntilMs: number): Promise<Outcome> {
  await page.clock.install();
  await page.goto(api.console);
  await page.evaluate(async stallUntil => {
    // Built same-origin modules, loaded by URL in the page (not resolvable by the Node typecheck).
    const load = (path: string): Promise<Record<string, (...args: unknown[]) => unknown>> => import(path);
    const getValidated = (await load('/operator/transport.js')).getValidated as (...args: unknown[]) => Promise<unknown>;
    const validateClients = (await load('/operator/validate-clients.js')).validateClients!;
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } }), { headers: { 'content-type': 'application/json' } });
    const start = performance.now();
    const stalling = (value: unknown) => { while (performance.now() < start + stallUntil) { /* synchronous stall */ } return validateClients(value); };
    const pending = getValidated({ get: async () => response }, { kind: 'clients' }, new AbortController().signal, stalling);
    (window as unknown as { r1: unknown }).r1 = { pending, body, start };
  }, stallUntilMs);
  await page.clock.fastForward(9_000);
  await page.clock.resume();
  return page.evaluate(async () => {
    const { pending, body, start } = (window as unknown as { r1: { pending: Promise<{ ok: boolean; code?: string; value?: unknown[] }>; body: ReadableStreamDefaultController<Uint8Array>; start: number } }).r1;
    const list = Array.from({ length: 10_000 }, (_, i) => ({ id: `c-${i}`, name: 'x'.repeat(360) }));
    const bodyAtMs = performance.now() - start;
    body.enqueue(new TextEncoder().encode(JSON.stringify(list)));
    body.close();
    const result = await pending;
    return { ok: result.ok, code: result.code, rows: result.value?.length, bodyAtMs, elapsedMs: performance.now() - start };
  });
}

test('R1 built transport, default budget: a valid 10 000-client body received in time but validated past 10 s is TIMEOUT', async ({ page }) => {
  const late = await builtDeadlineCase(page, 10_200);
  expect(late.bodyAtMs).toBeLessThan(10_000);
  expect(late.elapsedMs).toBeGreaterThanOrEqual(10_000);
  expect([late.ok, late.code, late.rows]).toEqual([false, 'TIMEOUT', undefined]);
});

test('R1 built transport, default budget: the same body validated just before 10 s is accepted', async ({ page }) => {
  const inTime = await builtDeadlineCase(page, 9_950);
  expect(inTime.elapsedMs).toBeLessThan(10_000);
  expect([inTime.ok, inTime.rows]).toEqual([true, 10_000]);
});

test('R1 console flow: a client list whose JSON parsing crosses the original budget is TIMEOUT, never a list or READY', async ({ page }) => {
  // Synthetic synchronous stall inside JSON.parse for the next large payload only (the console's own parse call).
  await page.addInitScript(() => {
    const parse = JSON.parse;
    const w = window as unknown as { stallUntil?: number };
    JSON.parse = function (this: unknown, text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) {
      const until = w.stallUntil;
      if (until && text.length > 10_000) { w.stallUntil = 0; while (performance.now() < until) { /* synchronous stall */ } }
      return parse.call(this, text, reviver);
    } as typeof JSON.parse;
  });
  await page.clock.install();
  const seen = recordRequests(page, api.base);
  const held = await holdApi(page, /\/clients(\/|$)/);
  await page.goto(api.console);
  await submitToken(page, token);
  await waitFor(() => held.length === 1, 'client list request');
  await page.clock.fastForward(9_000);
  await page.clock.resume();
  await page.evaluate(() => { (window as unknown as { stallUntil: number }).stallUntil = performance.now() + 1_500; });
  await held[0]!.release(200, Array.from({ length: 2_000 }, (_, i) => ({ id: `c-${i}`, name: `Client ${i} (synthetic)` })));
  await expect(page.locator('#clients-status')).toContainText('TIMEOUT');
  await expect(page.locator('#client-list button')).toHaveCount(0);
  await expect(page.locator('#session-status')).toHaveText('Connecting…');
  await page.waitForTimeout(200);
  expect(apiRequests(seen).length).toBe(1);
});

/** Fixture overview from the real compiled API with only the observation-page metadata changed. */
async function fixtureOverview(page: Page, change: ((page: { truncated: boolean; nextCursor: string | null }) => void) | null): Promise<string> {
  await page.route('**/clients/demo-gasta/overview', async route => {
    const response = await route.fetch();
    const body = await response.json();
    if (change) change(body.observations);
    await route.fulfill({ response, json: body });
  });
  await page.goto(api.console);
  await submitToken(page, token);
  await page.getByRole('button', { name: /Gasta/ }).click();
  const panel = page.locator('#scope-panel');
  await expect(panel).toContainText(/received and validated|RESPONSE_INVALID/);
  return panel.innerText();
}

for (const [name, change] of [
  ['cursor and truncated', (p: { truncated: boolean; nextCursor: string | null }) => { p.truncated = true; p.nextCursor = 'cursor'; }],
  ['cursor only', (p: { truncated: boolean; nextCursor: string | null }) => { p.nextCursor = 'cursor'; }],
  ['truncated only', (p: { truncated: boolean; nextCursor: string | null }) => { p.truncated = true; }]
] as const) {
  test(`R2 fixture overview with ${name}: RESPONSE_INVALID, no validated context, badge or payload`, async ({ page }) => {
    const text = await fixtureOverview(page, change);
    expect(text).toContain('RESPONSE_INVALID');
    expect(text.includes('received and validated')).toBe(false);
    await expect(page.locator('#mode-badge')).toBeHidden();
    for (const raw of ['cursor', 'credential theft', 'demo-alert-1']) expect(text.includes(raw), raw).toBe(false);
  });
}

test('R2 near-cases: the unchanged fixture overview validates; a truncated DB page with a cursor still validates', async ({ page }) => {
  expect(await fixtureOverview(page, null)).toContain('received and validated');
  await expect(page.locator('#mode-badge')).toHaveText('Synthetic fixture context');
  const other = await page.context().newPage();
  const held = await holdApi(other, /\/clients(\/|$)/);
  await other.goto(api.console);
  await submitToken(other, token);
  await waitFor(() => held.length === 1, 'list');
  await held[0]!.release(200, [{ id: 'c-db', name: 'DB client (synthetic)' }]);
  await other.getByRole('button', { name: /DB client/ }).click();
  await waitFor(() => held.length === 2, 'overview');
  const db = dbContext('c-db');
  db.observations = { ...db.observations, truncated: true, nextCursor: 'opaque_cursor-1', total: 250 };
  await held[1]!.release(200, db);
  await expect(other.locator('#scope-panel')).toContainText('received and validated');
  await expect(other.locator('#mode-badge')).toHaveText('Database-backed context');
});
