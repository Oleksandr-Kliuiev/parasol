import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { ApiProcess } from '../support/api-process.ts';
import { apiRequests, holdApi, ignoreAbort, recordConsole, recordRequests, startConsoleApi, submitToken, syntheticToken, waitFor } from '../support/operator-ui.ts';
import type { Held } from '../support/operator-ui.ts';
import { dbContext } from '../support/operator-fixtures.ts';
import { journeyItems, observation, page as obsPage, resourceView, snapshotAlert, WS } from '../support/operator-journey.ts';

// S5-B deterministic browser races (B6) on the real built console served by the compiled fixture API with its CSP. Only
// the API answers are held; fetch ignores AbortSignal, so stale completions really arrive. Stale success, error, 401 and
// 403 of queue and evidence must not render, select, clear, announce or reset a spinner of the current work.
const token = syntheticToken();
let api: ApiProcess & { console: string };
test.beforeAll(async () => { api = await startConsoleApi({ ATLAS_MODE: 'fixture', ATLAS_DEMO_TOKEN: token }); });
test.afterAll(async () => { await api?.stop(); });

const CLIENTS = [{ id: 'c-db', name: 'DB client (synthetic)' }, { id: 'c-two', name: 'Second client (synthetic)' }];
const SENTINEL = 'STALE-SENTINEL<b>';
const ALERT_BUTTON = 'Read the stored Atera alert list and find this alert';

async function open(page: Page) {
  await ignoreAbort(page);
  const seen = recordRequests(page, api.base);
  const messages = recordConsole(page);
  const held = await holdApi(page, url => /^\/(clients|tools)(\/|$)/.test(url.pathname));
  const take = async (path: string): Promise<Held> => {
    await waitFor(() => held.some(h => h.path === path), path);
    return held.splice(held.findIndex(h => h.path === path), 1)[0]!;
  };
  await page.goto(api.console);
  await submitToken(page, token);
  await (await take('/clients')).release(200, CLIENTS);
  return { seen, messages, held, take };
}
async function selectDb(page: Page, take: (path: string) => Promise<Held>) {
  await page.getByRole('button', { name: /DB client/ }).click();
  await (await take('/clients/c-db/overview')).release(200, dbContext('c-db', WS));
}
const row = (page: Page, text: string) => page.locator('#queue-body .obs').filter({ hasText: text });
const settle = (page: Page) => page.waitForTimeout(150);

test('delayed queue across a client switch and repeated refreshes: stale 403/401/500/success change nothing', async ({ page }) => {
  const { take, seen } = await open(page);
  await selectDb(page, take);
  const stale = await take('/clients/c-db/observations');
  await page.getByRole('button', { name: /Second client/ }).click();
  await (await take('/clients/c-two/overview')).release(200, dbContext('c-two', WS));
  const olders: Held[] = [await take('/clients/c-two/observations')];
  for (let i = 0; i < 3; i++) { await page.getByRole('button', { name: 'Refresh queue' }).click(); olders.push(await take('/clients/c-two/observations')); }
  const current = olders.pop()!;
  await stale.release(200, obsPage(journeyItems()));
  for (const [held, status] of olders.map((h, i) => [h, [403, 401, 500][i]!] as const)) await held.release(status, SENTINEL);
  await settle(page);
  await expect(page.locator('#session-status')).toHaveText('Connected');
  await expect(page.locator('#scope-panel h1')).toHaveText('Client c-two (synthetic)');
  await expect(page.locator('#queue-status')).toHaveText('Loading observations…');
  await expect(page.locator('#queue-body')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#queue-body .obs')).toHaveCount(0);
  expect(apiRequests(seen).filter(r => r.path === '/clients').length, 'no stale 403 picker refresh').toBe(1);
  await current.release(200, obsPage([observation('two-1', {}, 'c-two')]));
  await expect(page.locator('#queue-body .obs')).toHaveCount(1);
  expect(await page.locator('body').innerText()).not.toContain('STALE-SENTINEL');
});

test('filter change during a queue load: the old page never renders; a context refresh clears queue, selection and evidence first', async ({ page }) => {
  const { take } = await open(page);
  await selectDb(page, take);
  const first = await take('/clients/c-db/observations');
  await page.getByRole('checkbox', { name: 'ACKNOWLEDGED' }).uncheck();
  await page.getByRole('button', { name: 'Apply filters' }).click();
  const filtered = await take('/clients/c-db/observations');
  expect(filtered.path).toBe('/clients/c-db/observations');
  await settle(page);
  await expect(page.locator('#queue-status'), 'the aborted older page load is stale, not an error').toHaveText('Loading observations…');
  await first.release(200, obsPage(journeyItems()));
  await settle(page);
  await expect(page.locator('#queue-body .obs')).toHaveCount(0);
  await expect(page.locator('#queue-status')).toHaveText('Loading observations…');
  await filtered.release(200, obsPage([observation('only-open')]));
  await expect(page.locator('#queue-body .obs')).toHaveCount(1);
  await row(page, 'only-open').click();
  await page.getByRole('button', { name: ALERT_BUTTON }).click();
  const evidence = await take('/tools/execute');
  await page.getByRole('button', { name: 'Refresh context' }).click();
  await expect(page.locator('#queue-body .obs')).toHaveCount(0);
  await expect(page.locator('#evidence-panel')).toBeHidden();
  await expect(page.locator('#detail-body')).toHaveText('');
  const context = await take('/clients/c-db/overview');
  await evidence.release(201, resourceView('OK', [snapshotAlert('alert-only-open')]));
  await settle(page);
  await expect(page.locator('#evidence-panel')).toBeHidden();
  await context.release(200, dbContext('c-db', WS));
  await (await take('/clients/c-db/observations')).release(200, obsPage([observation('only-open')]));
  await expect(page.locator('#queue-body .obs')).toHaveCount(1);
  await expect(page.locator('#queue-body .obs[aria-current]')).toHaveCount(0);
});

test('pending evidence across selection changes: stale 201/403/401/500 never render, clear or unblock the current read', async ({ page }) => {
  const { take, seen } = await open(page);
  await selectDb(page, take);
  await (await take('/clients/c-db/observations')).release(200, obsPage(journeyItems()));
  const stale: Held[] = [];
  for (let i = 0; i < 4; i++) {
    await row(page, 'Disk usage high').click();
    await page.getByRole('button', { name: ALERT_BUTTON }).click();
    stale.push(await take('/tools/execute'));
    await row(page, 'Ticket (synthetic)').click();
  }
  await row(page, 'Disk usage high').click();
  const action = page.getByRole('button', { name: ALERT_BUTTON });
  await action.click();
  const current = await take('/tools/execute');
  await expect(action).toHaveAttribute('aria-disabled', 'true');
  await stale[0]!.release(201, resourceView('OK', [snapshotAlert('alert-1', { title: SENTINEL })]));
  for (const [held, status] of [[stale[1]!, 403], [stale[2]!, 401], [stale[3]!, 500]] as const) await held.release(status, SENTINEL);
  await settle(page);
  await expect(page.locator('#session-status')).toHaveText('Connected');
  await expect(page.locator('#evidence-status')).toHaveText('Reading stored evidence…');
  await expect(action).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('#queue-body .obs[aria-current]')).toContainText('Disk usage high');
  expect(apiRequests(seen).filter(r => r.path === '/clients').length).toBe(1);
  // Keyboard activation of the focused pending button (a pointer click would wait for aria-disabled to clear).
  await action.focus();
  await page.keyboard.press('Enter');
  await settle(page);
  expect(apiRequests(seen).filter(r => r.path === '/tools/execute').length, 'activation while pending sends nothing').toBe(5);
  await expect(action).toBeFocused();
  await current.release(201, resourceView('OK', [snapshotAlert('alert-1')]), { 'x-atlas-tool-execution-id': 'exec-current-1' });
  await expect(page.locator('#evidence-body')).toContainText('Tool execution IDexec-current-1');
  await expect(action).toHaveAttribute('aria-disabled', 'false');
  expect(await page.locator('body').innerText()).not.toContain('STALE-SENTINEL');
});

test('current evidence 403 clears the whole scope and refreshes the picker exactly once; current queue 401 disconnects', async ({ page }) => {
  const { take, seen } = await open(page);
  await selectDb(page, take);
  await (await take('/clients/c-db/observations')).release(200, obsPage(journeyItems()));
  await row(page, 'Disk usage high').click();
  await page.getByRole('button', { name: ALERT_BUTTON }).click();
  await (await take('/tools/execute')).release(403, SENTINEL);
  await expect(page.locator('#scope-panel')).toContainText('refused access to the previously selected client');
  await expect(page.locator('#workspace')).toBeHidden();
  await (await take('/clients')).release(403);
  await settle(page);
  expect(apiRequests(seen).map(r => r.path.split('?')[0])).toEqual(['/clients', '/clients/c-db/overview', '/clients/c-db/observations', '/tools/execute', '/clients']);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await (await take('/clients')).release(200, CLIENTS);
  await selectDb(page, take);
  await (await take('/clients/c-db/observations')).release(401);
  await expect(page.locator('#session-status')).toHaveText('Not connected');
  await expect(page.locator('#connect-notice')).toContainText('did not accept the token');
  expect(await page.locator('#queue-body').innerText()).toBe('');
});
