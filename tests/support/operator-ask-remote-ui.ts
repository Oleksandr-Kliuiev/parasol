import { randomUUID } from 'node:crypto';
import type { Page, Route } from '@playwright/test';
import { dbContext } from './operator-fixtures.ts';
import { DB_CLIENT, journeyItems, page as queuePage, WS } from './operator-journey.ts';
import { remoteCapabilityBody } from './operator-ask-remote.ts';

// ASK-REMOTE R-C browser support for ROUTE-STUB suites (tests/ui/ask-remote-{ui,races}.spec.ts): the real built console with
// its CSP, served by the compiled FIXTURE API, with the console's API answers intercepted in the page (two synthetic DB-shaped
// clients, a paged queue, a REMOTE capability and held Ask POSTs). This qualifies browser contract, consent, race and rendering
// behaviour only — NOT authorization, admission, ledger or provider behaviour (tests/ui/ask-remote-pg.spec.ts).

export const TWO_CLIENT = { id: 'c-two', name: 'Second DB client (synthetic)' };
export const REMOTE_BADGE = 'Ask Atlas — REMOTE: OpenAI GPT-6 Luna interprets; facts compiled locally';
export const HEADLINE = 'OpenAI GPT-6 Luna interprets the question; Atlas compiles facts locally.';
export const COST = 'Up to US$0.30 reserved per attempt; unknown outcomes retain this reservation.';
export const CONSENT = 'I consent to sending this question to OpenAI and confirm it is synthetic.';
export const askHeadersFor = (correlationId: string) => ({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-atlas-correlation-id': correlationId });

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, body: JSON.stringify(body), headers: { 'content-type': 'application/json; charset=utf-8' } });
/** Two DB-shaped clients with the journey page (paged: a next cursor exists); no hold. */
export async function serveRemoteClients(target: Page): Promise<void> {
  await target.route(url => /^\/clients(\/[^/]+\/(overview|observations))?$/.test(url.pathname), route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/clients') return json(route, 200, [DB_CLIENT, TWO_CLIENT]);
    for (const client of [DB_CLIENT.id, TWO_CLIENT.id]) {
      if (path === `/clients/${client}/overview`) return json(route, 200, dbContext(client, WS));
      if (path === `/clients/${client}/observations`) {
        return json(route, 200, queuePage(journeyItems().map(o => ({ ...o, clientId: client })), { total: 40, truncated: true, nextCursor: 'opaque-cursor_2' }));
      }
    }
    return route.fulfill({ status: 404, body: '' });
  });
}

/** The capability route: each GET is answered by `next()` (default: the exact REMOTE V2 body), all GETs are recorded. */
export interface CapabilityScript { count: number; next: (route: Route) => Promise<void> }
export const capabilityOk = (policyVersion?: string) => (route: Route) => {
  const id = randomUUID();
  return route.fulfill({ status: 200, body: JSON.stringify(remoteCapabilityBody(undefined, policyVersion)), headers: askHeadersFor(id) });
};
export async function serveRemoteCapability(target: Page): Promise<CapabilityScript> {
  const script: CapabilityScript = { count: 0, next: capabilityOk() };
  await target.route('**/ask/capabilities', route => { script.count += 1; return script.next(route); });
  return script;
}

/** Held Ask POSTs of one client: the parsed body and its route, answered later by the test. */
export interface HeldRemote { body: any; route: Route }
export async function holdRemoteAsks(target: Page, clientId = DB_CLIENT.id): Promise<HeldRemote[]> {
  const held: HeldRemote[] = [];
  await target.route(url => url.pathname === `/clients/${clientId}/ask`, route => { held.push({ body: JSON.parse(route.request().postData() ?? 'null'), route }); });
  return held;
}
export const fulfill = (held: HeldRemote, body: unknown, status = 200, correlationId = (body as { correlationId?: string })?.correlationId ?? randomUUID()) =>
  held.route.fulfill({ status, body: typeof body === 'string' ? body : JSON.stringify(body), headers: askHeadersFor(correlationId) }).catch(() => undefined);
export const fulfillError = (held: HeldRemote, code: string, status: number) => {
  const id = randomUUID();
  return fulfill(held, { contractVersion: 'AskErrorV1', code, correlationId: id }, status, id);
};

/**
 * The operator's REMOTE sequence: focus choice first (a focus change clears a draft), then the typed question (an edit clears
 * consent), then the MANUAL consent check, then the Ask button. `consent: false` leaves the box unchecked.
 */
export async function askRemote(target: Page, question: string, options: { focus?: boolean; consent?: boolean } = {}): Promise<void> {
  await target.locator('#ask-question').waitFor({ state: 'visible' });
  await target.locator('#ask-focus').setChecked(options.focus ?? false);
  await target.locator('#ask-question').focus();
  await target.keyboard.insertText(question);
  if (options.consent ?? true) await target.locator('#ask-consent').check();
  await target.locator('#ask-submit').click();
}
