import { randomBytes } from 'node:crypto';
import type { BrowserContext, Page, Request } from '@playwright/test';
import { startApi } from './api-process.ts';
import type { ApiProcess } from './api-process.ts';

// Browser-suite support for the S5-A operator console (tests/ui). Tokens are synthetic and never printed: assertions on
// them are booleans, and leak inspection pulls page state into Node instead of sending the token into the page.

export const syntheticToken = (): string => randomBytes(24).toString('hex');

export async function startConsoleApi(env: Record<string, string>): Promise<ApiProcess & { console: string }> {
  const api = await startApi({ ATLAS_OPERATOR_UI: '1', ...env });
  return { ...api, console: `${api.base}/operator/` };
}

export interface SeenRequest { method: string; path: string; sameOrigin: boolean; hasAuthorization: boolean; bearerIs(token: string): boolean }
/** Records every request the page makes. The Authorization value is kept only behind a comparison function. */
export function recordRequests(page: Page, origin: string): SeenRequest[] {
  const seen: SeenRequest[] = [];
  page.on('request', (request: Request) => {
    const url = new URL(request.url());
    const authorization = request.headers().authorization;
    seen.push({ method: request.method(), path: `${url.pathname}${url.search}`, sameOrigin: url.origin === origin,
      hasAuthorization: authorization !== undefined, bearerIs: token => authorization === `Bearer ${token}` });
  });
  return seen;
}
/**
 * API data requests. ASK-B compatibility: the one fixed Ask capability GET (sent once per credential after a validated
 * client list; an ordinary 404 = Ask OFF in these suites) is excluded so the accepted S5 request assertions stay as they
 * were; askRequests() below and the ask-*.spec.ts suites assert every Ask request exactly.
 */
export const apiRequests = (seen: SeenRequest[]) => seen.filter(r => !r.path.startsWith('/operator/') && !(r.method === 'GET' && r.path === '/ask/capabilities'));
/** The Ask requests (capability GET and question POSTs), in order. */
export const askRequests = (seen: SeenRequest[]) => seen.filter(r => r.path === '/ask/capabilities' || /^\/clients\/[^/]+\/ask$/.test(r.path));

/** Console messages and page errors; a CSP violation or script error shows up here. */
export function recordConsole(page: Page): string[] {
  const messages: string[] = [];
  page.on('console', message => {
    // ASK-B compatibility: Chromium itself logs every 4xx resource; the one Ask capability GET answered 404 (Ask OFF, the
    // contract's own signal) is exactly that line for that URL and is not a console/script message. Everything else stays.
    const url = message.location().url;
    if (message.type() === 'error' && /status of 404/.test(message.text()) && url && new URL(url).pathname === '/ask/capabilities') return;
    messages.push(`${message.type()}: ${message.text()}`);
  });
  page.on('pageerror', error => messages.push(`pageerror: ${error.name}`));
  return messages;
}

/** Enters a token through the keyboard into the password field and submits with Enter. */
export async function submitToken(page: Page, token: string): Promise<void> {
  await page.locator('#token').focus();
  await page.keyboard.insertText(token);
  await page.keyboard.press('Enter');
}

export interface PageSnapshot { html: string; inputValues: string[]; url: string; cookie: string; local: string; session: string; indexedDbCount: number; title: string }
export async function snapshot(page: Page): Promise<PageSnapshot> {
  return page.evaluate(async () => {
    const dbs = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
    const dump = (storage: Storage) => JSON.stringify(Object.entries(storage));
    return { html: document.documentElement.outerHTML, inputValues: [...document.querySelectorAll('input')].map(i => `${i.value}|${i.getAttribute('value') ?? ''}`),
      url: location.href, cookie: document.cookie, local: dump(localStorage), session: dump(sessionStorage), indexedDbCount: dbs.length, title: document.title };
  });
}

/** True when the token appears anywhere the console could have retained it. Never returns or prints the token itself. */
export async function tokenRetained(page: Page, context: BrowserContext, token: string): Promise<Record<string, boolean>> {
  const s = await snapshot(page);
  const state = await context.storageState();
  return {
    dom: s.html.includes(token), input: s.inputValues.some(v => v.includes(token)), url: s.url.includes(token) || s.title.includes(token),
    cookie: s.cookie !== '' || state.cookies.length > 0, localStorage: s.local !== '[]', sessionStorage: s.session !== '[]',
    indexedDb: s.indexedDbCount > 0, storageState: JSON.stringify(state).includes(token)
  };
}
export const NOTHING_RETAINED = { dom: false, input: false, url: false, cookie: false, localStorage: false, sessionStorage: false, indexedDb: false, storageState: false };

/** Init script: fetch that ignores AbortSignal, so stale completions really arrive (isolation must not rely on abort). */
export async function ignoreAbort(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => original(input, { ...init, signal: undefined });
  });
}

/** A route gate: each intercepted request waits until the test releases it with a chosen response. */
export interface Held { path: string; release(status: number, body?: unknown, headers?: Record<string, string>): Promise<void> }
export async function holdApi(page: Page, pattern: string | RegExp | ((url: URL) => boolean)): Promise<Held[]> {
  const held: Held[] = [];
  await page.route(pattern, route => new Promise<void>(done => {
    held.push({ path: new URL(route.request().url()).pathname, release: async (status, body, headers) => {
      const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
      await route.fulfill({ status, body: text, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } }).catch(() => undefined);
      done();
    } });
  }));
  return held;
}

export async function waitFor(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
