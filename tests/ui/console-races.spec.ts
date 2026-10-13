import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { ApiProcess } from '../support/api-process.ts';
import { apiRequests, holdApi, ignoreAbort, recordConsole, recordRequests, startConsoleApi, submitToken, syntheticToken, waitFor } from '../support/operator-ui.ts';
import { dbContext, mutate } from '../support/operator-fixtures.ts';

// S5-A deterministic browser races and malformed responses (A5, A6, A7). The real built console is served by the compiled
// fixture API with its CSP; only the API answers are intercepted and held. Every test installs a fetch that ignores
// AbortSignal, so stale completions really arrive and isolation must come from the console's epochs and generations.
// These S5-A cases hold the picker and context; the queue request that follows a validated context (S5-B) is answered at
// once with an empty valid page so the held indices stay the S5-A ones (queue races: console-races-queue.spec.ts).
const token = syntheticToken();
const other = syntheticToken();
let api: ApiProcess & { console: string };
test.beforeAll(async () => { api = await startConsoleApi({ ATLAS_MODE: 'fixture', ATLAS_DEMO_TOKEN: token }); });
test.afterAll(async () => { await api?.stop(); });

const CLIENTS = [{ id: 'c-alpha', name: 'Alpha (synthetic)' }, { id: 'c-beta', name: 'Beta (synthetic)' }];
const SENTINEL = 'SERVER-DETAIL-SENTINEL<script>';

const EMPTY_PAGE = { items: [], counts: { INFO: 0, LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 }, total: 0, truncated: false, nextCursor: null };
async function open(page: Page) {
  await ignoreAbort(page);
  const seen = recordRequests(page, api.base);
  const messages = recordConsole(page);
  const held = await holdApi(page, /\/clients(\/[^/?]+\/overview)?$/);
  await page.route(/\/clients\/[^/?]+\/observations(\?|$)/, route => route.fulfill({ status: 200, json: EMPTY_PAGE }));
  await page.goto(api.console);
  return { seen, held, messages };
}
const clientsPanelText = (page: Page) => page.locator('#clients-panel').innerText();

test('token replacement during a deferred list: old success, 401 and error cannot render or clear the new session', async ({ page }) => {
  const { held, seen } = await open(page);
  await submitToken(page, token);
  await waitFor(() => held.length === 1, 'first list request');
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await submitToken(page, other);
  await waitFor(() => held.length === 2, 'second list request');
  await page.waitForTimeout(150);
  await expect(page.locator('#clients-status'), 'the old aborted request is stale, not an error').toHaveText('Loading clients…');
  expect([apiRequests(seen)[0]!.bearerIs(token), apiRequests(seen)[1]!.bearerIs(other)]).toEqual([true, true]);
  await held[1]!.release(200, [CLIENTS[1]]);
  await expect(page.locator('#client-list button')).toHaveCount(1);
  await held[0]!.release(200, CLIENTS);
  await page.waitForTimeout(150);
  await expect(page.locator('#client-list button')).toHaveText([/Beta/]);
  // Stale 401 and stale 500 of a replaced credential's refresh: the current session and its list are untouched.
  for (const [status, body] of [[401, ''], [500, SENTINEL]] as [number, string][]) {
    const index = held.length;
    await page.getByRole('button', { name: 'Refresh' }).click();
    await waitFor(() => held.length === index + 1, 'refresh');
    await page.getByRole('button', { name: 'Disconnect' }).click();
    await submitToken(page, token);
    await waitFor(() => held.length === index + 2, 'replacement list');
    await held[index + 1]!.release(200, [CLIENTS[0]]);
    await expect(page.locator('#client-list button')).toHaveText([/Alpha/]);
    await held[index]!.release(status, body);
    await page.waitForTimeout(150);
    await expect(page.locator('#session-status')).toHaveText('Connected');
    await expect(page.locator('#client-list button')).toHaveText([/Alpha/]);
    expect((await clientsPanelText(page)).includes('error'), `stale ${status}`).toBe(false);
  }
});

test('client switch during deferred contexts: stale success, 403 and 500 never touch the current scope', async ({ page }) => {
  const { held, seen } = await open(page);
  await submitToken(page, token);
  await waitFor(() => held.length === 1, 'list');
  await held[0]!.release(200, CLIENTS);
  await page.getByRole('button', { name: /Alpha/ }).click();
  await waitFor(() => held.length === 2, 'alpha context');
  await expect(page.locator('#scope-panel')).toContainText('Loading and validating');
  await page.getByRole('button', { name: /Beta/ }).click();
  await waitFor(() => held.length === 3, 'beta context');
  await page.waitForTimeout(150);
  await expect(page.locator('#scope-panel'), 'the old aborted context is stale, not an error').toContainText('Loading and validating');
  await held[2]!.release(200, dbContext('c-beta'));
  await expect(page.locator('#scope-panel')).toContainText('validated');
  await held[1]!.release(403);
  await page.waitForTimeout(150);
  await expect(page.locator('#scope-panel h1')).toHaveText('Client c-beta (synthetic)');
  await expect(page.locator('#session-status')).toHaveText('Connected');
  expect(apiRequests(seen).filter(r => r.path === '/clients').length).toBe(1);
  // Old alpha 500 after re-selecting alpha twice: only the newest generation decides.
  await page.getByRole('button', { name: /Alpha/ }).click();
  await waitFor(() => held.length === 4, 'alpha again');
  await page.getByRole('button', { name: /Beta/ }).click();
  await page.getByRole('button', { name: /Alpha/ }).click();
  await waitFor(() => held.length === 6, 'alpha third');
  await held[5]!.release(200, dbContext('c-alpha'));
  await expect(page.locator('#scope-panel h1')).toHaveText('Client c-alpha (synthetic)');
  await held[3]!.release(500, SENTINEL);
  await held[4]!.release(401);
  await page.waitForTimeout(150);
  await expect(page.locator('#session-status')).toHaveText('Connected');
  await page.waitForTimeout(150);
  await expect(page.locator('#scope-panel h1')).toHaveText('Client c-alpha (synthetic)');
  await expect(page.locator('#scope-panel')).toContainText('validated');
});

test('current 401 on a context clears everything; late completions after it change nothing', async ({ page, context }) => {
  const { held, seen } = await open(page);
  await submitToken(page, token);
  await waitFor(() => held.length === 1, 'list');
  await held[0]!.release(200, CLIENTS);
  await page.getByRole('button', { name: /Alpha/ }).click();
  await waitFor(() => held.length === 2, 'context');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await waitFor(() => held.length === 3, 'refresh');
  await held[1]!.release(401);
  await expect(page.locator('#session-status')).toHaveText('Not connected');
  await expect(page.locator('#connect-notice')).toContainText('did not accept the token');
  await held[2]!.release(200, CLIENTS);
  await page.waitForTimeout(150);
  await expect(page.locator('#clients-panel')).toBeHidden();
  expect(await page.locator('#client-list li').count()).toBe(0);
  expect((await context.storageState()).cookies).toEqual([]);
  expect(apiRequests(seen).length).toBe(3);
});

test('current 403: scope cleared, exactly one picker refresh, no auto-select and no loop', async ({ page }) => {
  const { held, seen } = await open(page);
  await submitToken(page, token);
  await waitFor(() => held.length === 1, 'list');
  await held[0]!.release(200, CLIENTS);
  await page.getByRole('button', { name: /Alpha/ }).click();
  await waitFor(() => held.length === 2, 'context');
  await held[1]!.release(403, SENTINEL);
  await expect(page.locator('#scope-panel')).toContainText('refused access to the previously selected client');
  await expect(page.locator('#scope-panel h1')).toHaveText('No client selected');
  await waitFor(() => held.length === 3, 'one refresh');
  expect(held[2]!.path).toBe('/clients');
  await held[2]!.release(403);
  await expect(page.locator('#clients-status')).toContainText('The API refused access.');
  await page.waitForTimeout(300);
  expect(apiRequests(seen).map(r => r.path), 'no queue request without a valid context').toEqual(['/clients', '/clients/c-alpha/overview', '/clients']);
  expect(await page.locator('body').innerText()).not.toContain('SENTINEL');
});

test('a 403 refresh supersedes a pending manual refresh: the superseded request is stale, never an error or a list', async ({ page }) => {
  const { held } = await open(page);
  await submitToken(page, token);
  await waitFor(() => held.length === 1, 'list');
  await held[0]!.release(200, CLIENTS);
  await page.getByRole('button', { name: /Alpha/ }).click();
  await waitFor(() => held.length === 2, 'context');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await waitFor(() => held.length === 3, 'manual refresh');
  await held[1]!.release(403);
  await waitFor(() => held.length === 4, 'refresh caused by the 403');
  await page.waitForTimeout(150);
  await expect(page.locator('#clients-status')).toHaveText('Loading clients…');
  await held[3]!.release(200, [CLIENTS[1]]);
  await expect(page.locator('#client-list button')).toHaveText([/Beta/]);
  await held[2]!.release(200, CLIENTS);
  await page.waitForTimeout(150);
  await expect(page.locator('#client-list button')).toHaveText([/Beta/]);
});

test('malformed, mismatched, redirected and oversized responses clear the panel with a fixed code and no echo', async ({ page }) => {
  const { held } = await open(page);
  const big = JSON.stringify(CLIENTS[0]).length;
  const cases: [string, number, unknown, Record<string, string> | undefined, RegExp][] = [
    ['not JSON', 200, '<html>' + SENTINEL, undefined, /RESPONSE_INVALID/],
    ['wrong content type', 200, JSON.stringify(CLIENTS), { 'content-type': 'text/html' }, /RESPONSE_INVALID/],
    ['bad client ID', 200, [{ id: '../audit', name: SENTINEL }], undefined, /RESPONSE_INVALID/],
    ['duplicate IDs', 200, [CLIENTS[0], CLIENTS[0]], undefined, /RESPONSE_INVALID/],
    ['10 001 clients', 200, Array.from({ length: 10_001 }, (_, i) => ({ id: `c-${i}`, name: 'x' })), undefined, /RESPONSE_TOO_LARGE/],
    ['over 4 MiB', 200, `[${' '.repeat(4 * 1024 * 1024)}]`, undefined, /RESPONSE_TOO_LARGE/],
    ['server error body', 502, SENTINEL, { 'content-type': 'text/html' }, /HTTP_ERROR/],
    ['redirect', 302, '', { location: `${api.base}/clients/elsewhere` }, /NETWORK/]
  ];
  const seen = recordRequests(page, api.base);
  expect(big).toBeGreaterThan(0);
  await submitToken(page, token);
  for (const [name, status, body, headers, expected] of cases) {
    await waitFor(() => held.length >= 1, name);
    await held.shift()!.release(status, body, headers);
    await expect(page.locator('#clients-status'), name).toContainText(expected);
    await expect(page.locator('#client-list button'), name).toHaveCount(0);
    expect((await clientsPanelText(page)).includes('SENTINEL'), name).toBe(false);
    await page.getByRole('button', { name: 'Refresh' }).click();
  }
  expect(seen.some(r => r.path.includes('elsewhere')), 'a redirect is never followed').toBe(false);
  // Context: wrong client, foreign workspace after an established one, candidate link, unknown enum.
  await waitFor(() => held.length >= 1, 'list');
  await held.shift()!.release(200, CLIENTS);
  const contextCases: [string, unknown][] = [
    ['other client', dbContext('c-beta')], ['candidate link', mutate(dbContext('c-alpha'), c => { c.links[0].status = 'CANDIDATE'; })],
    ['unknown severity', mutate(dbContext('c-alpha'), c => { c.observations.items[0].severity = 'SEVERE'; })],
    ['oversized resource items', mutate(dbContext('c-alpha'), c => { c.resources[0].items = Array(1001).fill(c.resources[0].items[0]); })]
  ];
  for (const [name, body] of contextCases) {
    await page.getByRole('button', { name: /Alpha/ }).click();
    await waitFor(() => held.length >= 1, name);
    await held.shift()!.release(200, body);
    await expect(page.locator('#scope-panel'), name).toContainText(name === 'oversized resource items' ? 'RESPONSE_TOO_LARGE' : 'RESPONSE_INVALID');
    await expect(page.locator('#mode-badge'), name).toBeHidden();
  }
  await page.getByRole('button', { name: 'Retry' }).click();
  await waitFor(() => held.length >= 1, 'retry');
  await held.shift()!.release(200, dbContext('c-alpha', 'ws-1'));
  await expect(page.locator('#scope-panel')).toContainText('validated');
  await page.getByRole('button', { name: /Beta/ }).click();
  await waitFor(() => held.length >= 1, 'beta');
  await held.shift()!.release(200, dbContext('c-beta', 'ws-2'));
  await expect(page.locator('#scope-panel')).toContainText('RESPONSE_INVALID');
});

test('large accepted list: 250 rows shown with an explicit limitation; local search reaches later clients', async ({ page }) => {
  const { held, seen } = await open(page);
  await submitToken(page, token);
  await waitFor(() => held.length === 1, 'list');
  await held[0]!.release(200, Array.from({ length: 600 }, (_, i) => ({ id: `c-${String(i).padStart(3, '0')}`, name: `Client ${i} (synthetic)` })));
  await expect(page.locator('#client-list button')).toHaveCount(250);
  await expect(page.locator('#clients-status')).toHaveText('Showing the first 250 of 600 matching clients (of 600). Refine the search to reach the others.');
  await page.locator('#client-search').fill('c-599');
  await expect(page.locator('#client-list button')).toHaveCount(1);
  await page.locator('#client-list button').click();
  await waitFor(() => held.length === 2, 'context');
  expect(held[1]!.path).toBe('/clients/c-599/overview');
  expect(apiRequests(seen).length).toBe(2);
});

test('timeout: one original 10 s deadline, visible TIMEOUT, no automatic retry; late answer ignored', async ({ page }) => {
  await page.clock.install();
  const { held, seen } = await open(page);
  await submitToken(page, token);
  await waitFor(() => held.length === 1, 'list');
  await page.clock.runFor(9_000);
  await expect(page.locator('#clients-status')).toHaveText('Loading clients…');
  await page.clock.runFor(1_100);
  await expect(page.locator('#clients-status')).toContainText('TIMEOUT');
  await held[0]!.release(200, CLIENTS);
  await page.waitForTimeout(150);
  await expect(page.locator('#client-list button')).toHaveCount(0);
  await page.clock.runFor(30_000);
  expect(apiRequests(seen).length).toBe(1);
});
