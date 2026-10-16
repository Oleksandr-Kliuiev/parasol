import { test, expect } from '@playwright/test';
import type { ApiProcess } from '../support/api-process.ts';
import { apiRequests, NOTHING_RETAINED, recordConsole, recordRequests, startConsoleApi, submitToken, syntheticToken, tokenRetained } from '../support/operator-ui.ts';

// S5-A on the real built console and compiled fixture API (A1, A3, A4, A7, A8): CSP enforced, no request mocking.
// S5-B renders the validated context: the former "content not rendered" check is now an explicit allowlist/privacy check.
const token = syntheticToken();
let api: ApiProcess & { console: string };
test.beforeAll(async () => { api = await startConsoleApi({ ATLAS_MODE: 'fixture', ATLAS_DEMO_TOKEN: token }); });
test.afterAll(async () => { await api?.stop(); });

const ALLOWED_API = [/^\/clients$/, /^\/clients\/[^/]+\/overview$/, /^\/clients\/[^/]+\/observations$/];
const onlyAllowedApi = (paths: { method: string; path: string; sameOrigin: boolean }[]) =>
  paths.every(r => r.sameOrigin && r.method === 'GET' && ALLOWED_API.some(p => p.test(r.path)));

test('built console loads as native modules under the enforced CSP, without errors', async ({ page }) => {
  const messages = recordConsole(page);
  const seen = recordRequests(page, api.base);
  const response = await page.goto(api.console);
  expect(response?.status()).toBe(200);
  expect(response?.headers()['content-security-policy']).toContain("script-src 'self'");
  await expect(page.locator('#connect-heading')).toHaveText('Connect to the local Atlas API');
  await expect(page.locator('#session-status')).toHaveText('Not connected');
  // The module graph actually ran (the token form is enabled only by main.js on the exact origin).
  await expect(page.locator('#token')).toBeEnabled();
  expect(seen.filter(r => r.path.endsWith('.js')).length).toBeGreaterThanOrEqual(10);
  expect(seen.every(r => r.sameOrigin && r.method === 'GET' && !r.hasAuthorization)).toBe(true);
  expect(apiRequests(seen)).toEqual([]);
  expect(messages).toEqual([]);
  // The CSP is in force for this page: an injected inline script is refused and reported as a violation.
  const probe = await page.evaluate(() => new Promise<{ executed: boolean; directive: string }>(resolve => {
    addEventListener('securitypolicyviolation', event => resolve({ executed: 'cspProbe' in window, directive: event.effectiveDirective }), { once: true });
    const script = document.createElement('script');
    script.textContent = 'window.cspProbe = 1';
    document.head.append(script);
  }));
  expect(probe).toEqual({ executed: false, directive: 'script-src-elem' });
});

test('token field: password, no autocomplete, cleared on submit; Authorization only on fixed API GETs; nothing retained', async ({ page, context }) => {
  const messages = recordConsole(page);
  const seen = recordRequests(page, api.base);
  await page.goto(api.console);
  const field = page.locator('#token');
  expect(await field.getAttribute('type')).toBe('password');
  expect(await field.getAttribute('autocomplete')).toBe('off');
  expect(await field.getAttribute('spellcheck')).toBe('false');
  expect(await field.getAttribute('name')).toBeNull();
  await submitToken(page, token);
  expect(await field.inputValue()).toBe('');
  await expect(page.locator('#session-status')).toHaveText('Connected');
  await expect(page.locator('#client-list button')).toHaveCount(1);
  const api1 = apiRequests(seen);
  expect(api1.map(r => r.path)).toEqual(['/clients']);
  expect(api1.every(r => r.bearerIs(token))).toBe(true);
  expect(seen.filter(r => r.path.startsWith('/operator/')).every(r => !r.hasAuthorization)).toBe(true);
  expect(await tokenRetained(page, context, token)).toEqual(NOTHING_RETAINED);
  expect(messages.some(m => m.includes(token))).toBe(false);
  expect(messages).toEqual([]);
});

test('malformed token is refused without any request; a well-formed wrong token is a 401 disconnect', async ({ page }) => {
  const seen = recordRequests(page, api.base);
  await page.goto(api.console);
  for (const bad of ['short', `${token}!`, `${token.slice(0, 30)} ${token.slice(30)}`]) {
    await submitToken(page, bad);
    await expect(page.locator('#connect-notice')).toHaveText('That token is not in the accepted format. Nothing was sent.');
    expect(await page.locator('#token').inputValue()).toBe('');
  }
  expect(apiRequests(seen)).toEqual([]);
  await submitToken(page, syntheticToken());
  await expect(page.locator('#connect-notice')).toContainText('The API did not accept the token');
  await expect(page.locator('#session-status')).toHaveText('Not connected');
  await expect(page.locator('#clients-panel')).toBeHidden();
  expect(apiRequests(seen).map(r => r.path)).toEqual(['/clients']);
});

test('fixture journey: explicit selection, validated context rendered from its allowlist only, fixed queue without a query', async ({ page }) => {
  const seen = recordRequests(page, api.base);
  await page.goto(api.console);
  await submitToken(page, token);
  const gasta = page.getByRole('button', { name: /Gasta \(synthetic\)/ });
  await expect(gasta).toBeVisible();
  await expect(page.locator('#scope-panel h1')).toHaveText('No client selected');
  expect(apiRequests(seen).map(r => r.path)).toEqual(['/clients']);
  await gasta.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#scope-panel')).toContainText('Client context received and validated');
  await expect(page.locator('#mode-badge')).toHaveText('Synthetic fixture context');
  await expect(gasta).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('#queue-body .obs')).toHaveCount(2);
  expect(apiRequests(seen).map(r => r.path)).toEqual(['/clients', '/clients/demo-gasta/overview', '/clients/demo-gasta/observations']);
  expect(onlyAllowedApi(apiRequests(seen))).toBe(true);
  // Stored resource items are collapsed by default; open them with the keyboard before reading their text.
  for (const summary of await page.locator('#context-panel summary').all()) { await summary.focus(); await page.keyboard.press('Enter'); }
  const context = await page.locator('#context-panel').innerText();
  for (const shown of ['Kari (synthetic)', 'GASTA-LT-07', 'stored person reference: Kari (synthetic)', 'demo-alert-1', 'Disk capacity follow-up (synthetic)']) {
    expect(context.includes(shown), shown).toBe(true);
  }
  const text = await page.locator('body').innerText();
  for (const hidden of ['kari@example.invalid', 'example.invalid', 'diskPercent', 'externalDevice', 'receivedAt', 'facts', 'safeErrorCode', '{"']) {
    expect(text.includes(hidden), hidden).toBe(false);
  }
});

test('disconnect, reload, pagehide and back/forward restore all end disconnected with nothing retained; tabs are independent', async ({ page, context }) => {
  const seen = recordRequests(page, api.base);
  await page.goto(api.console);
  await submitToken(page, token);
  await page.getByRole('button', { name: /Gasta/ }).click();
  await expect(page.locator('#scope-panel')).toContainText('validated');
  const other = await context.newPage();
  const otherSeen = recordRequests(other, api.base);
  await other.goto(api.console);
  await expect(other.locator('#session-status')).toHaveText('Not connected');
  expect(apiRequests(otherSeen)).toEqual([]);
  await other.close();

  await page.getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.locator('#connect-notice')).toContainText('Disconnected.');
  await expect(page.locator('#client-list li')).toHaveCount(0);
  expect(await page.locator('#scope-panel').innerText()).toBe('');
  await expect(page.locator('#mode-badge')).toBeHidden();
  expect(await tokenRetained(page, context, token)).toEqual(NOTHING_RETAINED);
  const before = apiRequests(seen).length;
  await page.locator('#refresh-clients').evaluate(b => (b as HTMLButtonElement).click());
  expect(apiRequests(seen).length).toBe(before);

  await submitToken(page, token);
  await expect(page.locator('#session-status')).toHaveText('Connected');
  await page.reload();
  await expect(page.locator('#session-status')).toHaveText('Not connected');
  expect(apiRequests(seen).length).toBe(before + 1);

  await submitToken(page, token);
  await expect(page.locator('#client-list button')).toHaveCount(1);
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await expect(page.locator('#connect-notice')).toContainText('The page was left or hidden');
  await expect(page.locator('#client-list li')).toHaveCount(0);

  await submitToken(page, token);
  await expect(page.locator('#client-list button')).toHaveCount(1);
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(page.locator('#session-status')).toHaveText('Not connected');

  await submitToken(page, token);
  await expect(page.locator('#client-list button')).toHaveCount(1);
  await page.goto('about:blank');
  await page.goBack();
  await expect(page.locator('#session-status')).toHaveText('Not connected');
  await expect(page.locator('#client-list li')).toHaveCount(0);
  expect(await tokenRetained(page, context, token)).toEqual(NOTHING_RETAINED);
  expect(onlyAllowedApi(apiRequests(seen))).toBe(true);
});

test('keyboard: token entry, client selection, refresh and disconnect without a pointer', async ({ page }) => {
  await page.goto(api.console);
  await page.keyboard.press('Tab');
  await expect(page.locator('.skip-link')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#token')).toBeFocused();
  await page.keyboard.insertText(token);
  await page.keyboard.press('Enter');
  await expect(page.locator('#client-search')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#client-list button').first()).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#scope-panel')).toContainText('validated');
  await expect(page.locator('#client-list button').first()).toBeFocused();
  const outline = await page.locator('#client-list button').first().evaluate(b => getComputedStyle(b).outlineStyle);
  expect(outline).toBe('solid');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#refresh-clients')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#disconnect')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#token')).toBeFocused();
  await expect(page.locator('#session-status')).toHaveText('Not connected');
});
