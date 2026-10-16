import { test, expect } from '@playwright/test';
import type { Page, Request } from '@playwright/test';
import type { ApiProcess } from '../support/api-process.ts';
import { apiRequests, NOTHING_RETAINED, recordConsole, recordRequests, startConsoleApi, submitToken, syntheticToken, tokenRetained } from '../support/operator-ui.ts';

// S5-B fixture read journey on the real built console and the compiled fixture API, CSP enforced, nothing intercepted
// (B1, B2, B3, B7, B8, B9): fixed demo queue with no query and no filter/paging control, urgent CRITICAL Huntress detail
// with the honest demo limitation and no request, positive Atera alert evidence through the actual Gateway (HTTP 201,
// normalized externalEventId, fixture audit rows under the request ID), keyboard-only flow, nothing retained.
const token = syntheticToken();
let api: ApiProcess & { console: string };
test.beforeAll(async () => { api = await startConsoleApi({ ATLAS_MODE: 'fixture', ATLAS_DEMO_TOKEN: token }); });
test.afterAll(async () => { await api?.stop(); });

const ALLOWED = [/^GET \/clients$/, /^GET \/clients\/demo-gasta\/overview$/, /^GET \/clients\/demo-gasta\/observations$/, /^POST \/tools\/execute$/];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function evidencePosts(page: Page): { body: Record<string, unknown>; status: Promise<number> }[] {
  const posts: { body: Record<string, unknown>; status: Promise<number> }[] = [];
  page.on('request', (request: Request) => {
    if (request.method() !== 'POST') return;
    posts.push({ body: JSON.parse(request.postData() ?? 'null'), status: request.response().then(r => r?.status() ?? 0) });
  });
  return posts;
}
const fixtureAudit = async () => (await (await fetch(`${api.base}/clients/demo-gasta/audit`, { headers: { Authorization: `Bearer ${token}` } })).json()) as
  { eventType: string; correlationId: string; metadata: Record<string, string> }[];

test('fixed demo queue, urgent Huntress detail without request, Atera alert evidence via the actual Gateway (201) and its audit', async ({ page, context }) => {
  const seen = recordRequests(page, api.base);
  const messages = recordConsole(page);
  const posts = evidencePosts(page);
  await page.goto(api.console);
  await submitToken(page, token);
  await page.getByRole('button', { name: /Gasta/ }).click();
  const rows = page.locator('#queue-body .obs');
  await expect(rows).toHaveCount(2);
  await expect(page.locator('#queue-controls')).toContainText('This demo has no filters or pagination');
  for (const control of ['#queue-controls fieldset', '#queue-controls select', '#queue-body .paging']) await expect(page.locator(control)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Next page|First page|Apply filters/ })).toHaveCount(0);
  await expect(rows.first()).toContainText('Urgent: source severity CRITICAL');
  await expect(page.locator('#queue-status')).toHaveText('2 observations on the fixed demo page.');

  await rows.filter({ hasText: 'credential theft' }).click();
  const detail = page.locator('#detail-body');
  await expect(detail).toContainText('Urgent: source severity CRITICAL');
  await expect(detail).toContainText('Confirmed device: GASTA-LT-07');
  await expect(page.locator('#evidence-action')).toContainText('not available in this synthetic demo');
  await expect(page.locator('#evidence-action button')).toHaveCount(0);
  expect(await page.locator('#evidence-body').innerText(), 'no hint about a button that does not exist').toBe('');
  await page.waitForTimeout(200);
  expect(posts).toEqual([]);

  await rows.filter({ hasText: 'Disk capacity' }).click();
  await expect(page.locator('#evidence-body')).toContainText('Evidence is read only when you press the button');
  const before = (await fixtureAudit()).length;
  await page.getByRole('button', { name: 'Read the stored Atera alert list and find this alert' }).click();
  const evidence = page.locator('#evidence-body');
  await expect(evidence).toContainText('FIXTURE — Synthetic fixture data, not a source read');
  await expect(evidence).toContainText('demo-alert-1');
  await expect(evidence).toContainText('matching the selected source ID exactly: 1 of 1');
  expect(posts.length).toBe(1);
  expect(await posts[0]!.status).toBe(201);
  const { requestId, ...rest } = posts[0]!.body;
  expect(rest).toEqual({ version: '1', clientId: 'demo-gasta', tool: 'atera.alert.list', parameters: { connectionId: 'demo-atera-connection' } });
  expect(requestId).toMatch(UUID);
  await expect(evidence).toContainText(`Correlation ID${requestId}`);
  await expect(evidence).not.toContainText('Tool execution ID');
  const audit = (await fixtureAudit()).slice(before);
  expect(audit.map(a => [a.eventType, a.correlationId, a.metadata.tool])).toEqual([['tool.started', requestId, 'atera.alert.list'], ['tool.succeeded', requestId, 'atera.alert.list']]);

  await page.getByRole('button', { name: 'Read the stored Atera alert list and find this alert' }).click();
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[1]!.body.requestId).not.toBe(requestId);
  expect(apiRequests(seen).every(r => ALLOWED.some(p => p.test(`${r.method} ${r.path}`)) && r.sameOrigin && r.bearerIs(token))).toBe(true);
  expect(apiRequests(seen).filter(r => r.method === 'GET').map(r => r.path)).toEqual(['/clients', '/clients/demo-gasta/overview', '/clients/demo-gasta/observations']);
  expect(await tokenRetained(page, context, token)).toEqual(NOTHING_RETAINED);
  expect(messages).toEqual([]);

  await page.getByRole('button', { name: 'Disconnect' }).click();
  for (const region of ['#queue-body', '#detail-body', '#evidence-body', '#context-body']) expect(await page.locator(region).innerText(), region).toBe('');
  await expect(page.locator('#workspace')).toBeHidden();
});

test('keyboard only: queue row, detail, evidence button; focus stays on the action and the result is announced', async ({ page }) => {
  await page.goto(api.console);
  await submitToken(page, token);
  await page.locator('#client-list button').first().focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#queue-body .obs')).toHaveCount(2);
  await page.locator('#refresh-queue').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('#queue-body .obs').first()).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  const alertRow = page.locator('#queue-body .obs').nth(1);
  await expect(alertRow).toBeFocused();
  await expect(alertRow).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('#detail-status')).toHaveText('Observation selected.');
  const action = page.getByRole('button', { name: 'Read the stored Atera alert list and find this alert' });
  for (let i = 0; i < 40 && !(await action.evaluate(b => b === document.activeElement)); i++) await page.keyboard.press('Tab');
  await expect(action).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#evidence-status')).toHaveText('Stored read FIXTURE: 1 matching item.');
  await expect(action).toBeFocused();
  expect(await action.evaluate(b => getComputedStyle(b).outlineStyle)).toBe('solid');
  // A keyboard queue refresh replaces the rows: focus is kept on the control, never dropped to the page body.
  await page.locator('#refresh-queue').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#queue-body .obs')).toHaveCount(2);
  await expect(page.locator('#refresh-queue')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#queue-body .obs').first()).toBeFocused();
  await expect(page.locator('#evidence-panel')).toBeHidden();
});
