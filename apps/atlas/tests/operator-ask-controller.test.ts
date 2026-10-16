import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCredentialHolder } from '../apps/operator/src/credential.ts';
import { createController } from '../apps/operator/src/controller.ts';
import type { Controller } from '../apps/operator/src/controller.ts';
import type { ConsoleState } from '../apps/operator/src/state.ts';
import { dbContext } from './support/operator-fixtures.ts';
import { journeyItems, page, WS } from './support/operator-journey.ts';
import { askError, askResponse, capabilityResponse, compiledAnswer, dbRead } from './support/operator-ask.ts';

// ASK-B Q7 controller isolation with deferred responses whose fake fetch IGNORES AbortSignal: capability once per credential
// after a validated client list; one question per submit for the current validated context; every completion (success,
// error, 401, 403) of a question or capability is ignored after any credential/client/context/filter/page/observation change,
// and every such change clears the answer and the input synchronously. The browser suite repeats key races over the DOM.
const A = 'synthetic-console-token-aaaaaaaaaaaa';
const B = 'synthetic-console-token-bbbbbbbbbbbb';
const CLIENTS = [{ id: 'c-db', name: 'DB (synthetic)' }, { id: 'c-two', name: 'Two (synthetic)' }];
interface Pending { method: string; path: string; body: string | null; resolve(response: Response): void }

function harness() {
  const pending: Pending[] = [];
  const sent: Pending[] = [];
  const holder = createCredentialHolder((path, init) => new Promise<Response>(resolve => {
    const p = { method: init.method ?? 'GET', path, body: typeof init.body === 'string' ? init.body : null, resolve };
    pending.push(p); sent.push(p);
  }));
  const states: ConsoleState[] = [];
  const controller = createController(holder, state => states.push(state), { deadlineMs: 2000 });
  const take = (prefix: string): Pending => {
    const index = pending.findLastIndex(p => p.path.split('?')[0] === prefix);
    assert.ok(index >= 0, `request ${prefix}`);
    return pending.splice(index, 1)[0]!;
  };
  const has = (prefix: string) => pending.some(p => p.path.split('?')[0] === prefix);
  return { holder, controller, pending, sent, take, has, states };
}
type H = ReturnType<typeof harness>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const status = (code: number) => new Response('', { status: code });
const settle = () => new Promise(resolve => setTimeout(resolve, 10));
const ASK = '/clients/c-db/ask';

/** The API's MOCK answer to one recorded question (compiled by the accepted server modules from the journey page). */
function reply(p: Pending, clientId = 'c-db'): Response {
  const body = JSON.parse(p.body!);
  const { source, focusId } = dbRead({ workspaceId: WS, clientId, page: journeyItems(), focus: body.observationId === null ? null : { id: body.observationId },
    devices: [{ id: 'd-1', label: 'HOST-01' }], links: [{ status: 'CONFIRMED', entityId: 'd-1', entityKind: 'DEVICE', system: 'atera', resourceType: 'agent', connectionId: 'conn-atera', externalId: 'agent-1' }] });
  return askResponse(compiledAnswer(source, body.question, focusId, { requestId: body.requestId, workspaceId: WS, clientId }));
}

async function connected(h: H, token = A, capability: Response = capabilityResponse()) {
  h.controller.connect(token);
  h.take('/clients').resolve(json(CLIENTS)); await settle();
  h.take('/ask/capabilities').resolve(capability); await settle();
}
async function ready(h: H, client = 'c-db') {
  h.controller.select(client);
  h.take(`/clients/${client}/overview`).resolve(json(dbContext(client, WS))); await settle();
  h.take(`/clients/${client}/observations`).resolve(json(page(journeyItems().map(o => ({ ...o, clientId: client }))))); await settle();
}
const state = (c: Controller) => c.state();

test('capability: only after a validated client list, once per credential; refresh and picker refresh never ask again; a new credential asks again', async () => {
  const h = harness();
  h.controller.connect(A);
  assert.equal(h.has('/ask/capabilities'), false, 'nothing before the client list');
  h.take('/clients').resolve(json([{ id: 'bad id' }])); await settle();
  assert.equal(h.has('/ask/capabilities'), false, 'an invalid client list is not a validated list');
  h.controller.refreshClients();
  h.take('/clients').resolve(json(CLIENTS)); await settle();
  assert.equal(state(h.controller).askCapability.status, 'LOADING');
  h.take('/ask/capabilities').resolve(capabilityResponse()); await settle();
  assert.equal(state(h.controller).askCapability.status, 'MOCK');
  h.controller.refreshClients();
  h.take('/clients').resolve(json(CLIENTS)); await settle();
  assert.equal(h.has('/ask/capabilities'), false);
  h.controller.connect(B);
  assert.equal(state(h.controller).askCapability.status, 'IDLE', 'no capability carried across credential epochs');
  h.take('/clients').resolve(json(CLIENTS)); await settle();
  assert.equal(h.sent.filter(p => p.path === '/ask/capabilities').length, 2);
});

test('stale capability completions of a replaced credential change nothing; current 404 OFF, failure + explicit retry, 401 and 403', () => withoutAbort(async () => {
  const h = harness();
  h.controller.connect(A);
  h.take('/clients').resolve(json(CLIENTS)); await settle();
  const old = h.take('/ask/capabilities');
  h.controller.connect(B);
  h.take('/clients').resolve(json(CLIENTS)); await settle();
  const current = h.take('/ask/capabilities');
  old.resolve(capabilityResponse()); await settle();
  assert.equal(state(h.controller).askCapability.status, 'LOADING', 'an old MOCK cannot expose the input to the new credential');
  current.resolve(status(404)); await settle();
  assert.equal(state(h.controller).askCapability.status, 'OFF');
  h.controller.retryAskCapability();
  assert.equal(h.has('/ask/capabilities'), false, 'OFF is not retried');

  for (const [first, second] of [[status(401), capabilityResponse()], [status(403), capabilityResponse()], [json({}, 500), capabilityResponse()]] as const) {
    const s = harness();
    s.controller.connect(A);
    s.take('/clients').resolve(json(CLIENTS)); await settle();
    const stale = s.take('/ask/capabilities');
    s.controller.disconnect('DISCONNECTED');
    s.controller.connect(B);
    s.take('/clients').resolve(json(CLIENTS)); await settle();
    stale.resolve(first); await settle();
    assert.deepEqual([state(s.controller).session, state(s.controller).askCapability.status, s.has('/clients')], ['READY', 'LOADING', false], `stale ${first.status}`);
    s.take('/ask/capabilities').resolve(second); await settle();
    assert.equal(state(s.controller).askCapability.status, 'MOCK');
  }

  const failing = harness();
  await connected(failing, A, askError('ASK_BUSY', 429));
  assert.deepEqual([state(failing.controller).askCapability.status, state(failing.controller).askCapability.failure?.ask?.code], ['ERROR', 'ASK_BUSY']);
  failing.controller.retryAskCapability();
  failing.take('/ask/capabilities').resolve(capabilityResponse()); await settle();
  assert.equal(state(failing.controller).askCapability.status, 'MOCK');

  const unauthorized = harness();
  await connected(unauthorized, A, status(401));
  assert.deepEqual([state(unauthorized.controller).session, state(unauthorized.controller).notice], ['DISCONNECTED', 'UNAUTHORIZED']);

  const forbidden = harness();
  forbidden.controller.connect(A);
  forbidden.take('/clients').resolve(json(CLIENTS)); await settle();
  const cap = forbidden.take('/ask/capabilities');
  await ready(forbidden);
  cap.resolve(status(403)); await settle();
  assert.deepEqual([state(forbidden.controller).selection, state(forbidden.controller).scopeDenied, state(forbidden.controller).askCapability.status], [null, true, 'ERROR']);
  forbidden.take('/clients').resolve(json(CLIENTS)); await settle();
  assert.equal(forbidden.has('/ask/capabilities'), false, 'the one picker refresh does not ask again (no loop)');
  assert.equal(forbidden.sent.filter(p => p.path === '/clients').length, 2);
  assert.equal(state(forbidden.controller).selection, null, 'no automatic selection');
}));

test('submit: only for MOCK + current validated context; exact body, fresh UUID, exact focus; local refusals send nothing; double submit sends once', async () => {
  const h = harness();
  h.controller.connect(A);
  h.take('/clients').resolve(json(CLIENTS)); await settle();
  assert.equal(h.controller.askQuestion('What needs attention?', false), false, 'capability unknown');
  h.take('/ask/capabilities').resolve(capabilityResponse()); await settle();
  assert.equal(h.controller.askQuestion('What needs attention?', false), false, 'no client');
  h.controller.select('c-db');
  assert.equal(h.controller.askQuestion('What needs attention?', false), false, 'context not yet validated');
  h.take('/clients/c-db/overview').resolve(json(dbContext('c-db', WS))); await settle();
  // The context is valid; the queue may still be loading: a question without focus is allowed.
  const generation = state(h.controller).ask.inputGeneration;
  for (const [question, refusal] of [['', 'EMPTY'], [' \n\t ', 'EMPTY'], ['a'.repeat(2001), 'TOO_LONG'], ['bell\u0007', 'INVALID'], ['\ud83d', 'INVALID']] as const) {
    assert.equal(h.controller.askQuestion(question, false), false);
    assert.deepEqual([state(h.controller).ask.status, state(h.controller).ask.refusal, state(h.controller).ask.inputGeneration], ['REFUSED', refusal, generation],
      'a refusal keeps the typed input');
  }
  assert.equal(h.controller.askQuestion('Why is this urgent?', true), false);
  assert.equal(state(h.controller).ask.refusal, 'NO_FOCUS');
  assert.equal(h.has(ASK), false, 'nothing sent');
  h.take('/clients/c-db/observations').resolve(json(page(journeyItems()))); await settle();
  h.controller.selectObservation('obs-crit');
  const question = '  Why is this urgent?  ';
  assert.equal(h.controller.askQuestion(question, true), true);
  assert.equal(state(h.controller).ask.status, 'PENDING');
  assert.ok(state(h.controller).ask.inputGeneration > generation, 'the input is cleared on send');
  assert.equal(h.controller.askQuestion('What needs attention?', false), false, 'a second submit while pending sends nothing');
  const first = h.take(ASK);
  assert.equal(h.has(ASK), false);
  const body = JSON.parse(first.body!);
  assert.deepEqual(Object.keys(body), ['contractVersion', 'requestId', 'question', 'observationId']);
  assert.deepEqual([body.contractVersion, body.question, body.observationId, first.method], ['AskRequestV1', question, 'obs-crit', 'POST']);
  assert.match(body.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  first.resolve(reply(first)); await settle();
  const answered = state(h.controller).ask;
  assert.deepEqual([answered.status, answered.answer?.status, answered.answer?.claims[0]?.code], ['READY', 'ANSWER', 'SOURCE_URGENT']);
  // Manual retry: a deliberate new question, fresh UUID, the previous answer cleared before anything is sent.
  assert.equal(h.controller.askQuestion('Why is this urgent?', true), true);
  assert.deepEqual([state(h.controller).ask.status, state(h.controller).ask.answer], ['PENDING', null]);
  const second = JSON.parse(h.take(ASK).body!);
  assert.notEqual(second.requestId, body.requestId);
  assert.equal(h.controller.askQuestion('What needs attention?', true), false);
});

/**
 * Runs `body` with AbortController.abort disabled: aborts are then never delivered (not to fetch, not to the transport's own
 * race), so late responses genuinely reach the completion and only the captured generations can reject them.
 */
async function withoutAbort(body: () => Promise<void>): Promise<void> {
  const original = AbortController.prototype.abort;
  AbortController.prototype.abort = function ignored() { /* abort is only a courtesy */ };
  try { await body(); } finally { AbortController.prototype.abort = original; }
}

test('every scope change invalidates and clears synchronously; late success, error, 401 and 403 of the old question change nothing', async () => {
  for (const abortDelivered of [true, false]) await (abortDelivered ? (f: () => Promise<void>) => f() : withoutAbort)(() => scopeChanges(abortDelivered));
});
async function scopeChanges(abortDelivered: boolean): Promise<void> {
  const changes: [string, (c: Controller) => void][] = [
    ['client switch', c => c.select('c-two')], ['context refresh', c => c.refreshContext()], ['queue refresh', c => c.refreshQueue()],
    ['filter', c => c.applyQueue(['OPEN'], ['CRITICAL'], 25)], ['next page', c => c.nextPage()], ['first page', c => c.firstPage()],
    ['observation', c => c.selectObservation('obs-ticket')]
  ];
  for (const [name, change] of changes) {
    for (const late of ['success', 'error', '401', '403'] as const) {
      const h = harness();
      h.controller.connect(A);
      h.take('/clients').resolve(json(CLIENTS)); await settle();
      h.take('/ask/capabilities').resolve(capabilityResponse()); await settle();
      h.controller.select('c-db');
      h.take('/clients/c-db/overview').resolve(json(dbContext('c-db', WS))); await settle();
      h.take('/clients/c-db/observations').resolve(json(page(journeyItems(), { nextCursor: 'opaque-cursor_2', truncated: true }))); await settle();
      h.controller.selectObservation('obs-alert');
      assert.equal(h.controller.askQuestion('Which device is confirmed?', true), true);
      const pending = h.take(ASK);
      const generation = state(h.controller).ask.inputGeneration;
      change(h.controller);
      assert.deepEqual([state(h.controller).ask.status, state(h.controller).ask.answer], ['IDLE', null], `${name}: cleared synchronously`);
      assert.ok(state(h.controller).ask.inputGeneration > generation, `${name}: input cleared`);
      const before = state(h.controller);
      pending.resolve(late === 'success' ? reply(pending) : late === 'error' ? askError('ASK_BUSY', 429) : status(Number(late))); await settle();
      const after = state(h.controller);
      assert.deepEqual([after.session, after.ask.status, after.ask.answer, after.selection?.clientId ?? null, after.scopeDenied],
        [before.session, 'IDLE', null, before.selection?.clientId ?? null, false], `${name}: stale ${late}`);
      assert.equal(h.sent.filter(p => p.path === '/clients').length, 1, `${name}: no stale picker refresh (abort delivered: ${abortDelivered})`);
    }
  }
}

test('credential replacement and disconnect: a late 401 cannot disconnect the new session, a late answer cannot appear', () => withoutAbort(async () => {
  for (const late of ['success', '401', '403'] as const) {
    const h = harness();
    await connected(h);
    await ready(h);
    assert.equal(h.controller.askQuestion('What needs attention?', false), true);
    const pending = h.take(ASK);
    h.controller.disconnect('DISCONNECTED');
    assert.deepEqual([state(h.controller).ask.status, state(h.controller).askCapability.status], ['IDLE', 'IDLE']);
    await connected(h, B);
    await ready(h);
    pending.resolve(late === 'success' ? reply(pending) : status(Number(late))); await settle();
    assert.deepEqual([state(h.controller).session, state(h.controller).selection?.clientId, state(h.controller).ask.status, state(h.controller).askCapability.status],
      ['READY', 'c-db', 'IDLE', 'MOCK'], late);
  }
}));

test('current 401 disconnects; current 403 is a full scope reset with one picker refresh; 404/409/503 are fixed errors without retry', async () => {
  const h = harness();
  await connected(h); await ready(h);
  h.controller.askQuestion('What needs attention?', false);
  h.take(ASK).resolve(askError('ASK_AUTHENTICATION_FAILED', 401)); await settle();
  assert.deepEqual([state(h.controller).session, state(h.controller).notice], ['DISCONNECTED', 'UNAUTHORIZED']);

  const f = harness();
  await connected(f); await ready(f);
  f.controller.selectObservation('obs-crit');
  f.controller.askQuestion('Why is this urgent?', true);
  f.take(ASK).resolve(askError('ASK_SCOPE_DENIED', 403)); await settle();
  assert.deepEqual([state(f.controller).selection, state(f.controller).scopeDenied, state(f.controller).context.status, state(f.controller).ask.status],
    [null, true, 'IDLE', 'IDLE']);
  f.take('/clients').resolve(json(CLIENTS)); await settle();
  assert.deepEqual([f.pending.length, state(f.controller).selection], [0, null], 'exactly one picker refresh, no selection, no capability re-query');

  for (const [response, code, askCode] of [[askError('ASK_CONTEXT_UNAVAILABLE', 404), 'HTTP_ERROR', 'ASK_CONTEXT_UNAVAILABLE'], [status(404), 'HTTP_ERROR', null],
    [askError('ASK_SCOPE_CHANGED', 409), 'HTTP_ERROR', 'ASK_SCOPE_CHANGED'], [askError('ASK_AUDIT_FAILED', 503), 'HTTP_ERROR', 'ASK_AUDIT_FAILED'],
    [json({ contractVersion: 'AskAnswerV1' }), 'RESPONSE_INVALID', null]] as const) {
    const e = harness();
    await connected(e); await ready(e);
    e.controller.askQuestion('What needs attention?', false);
    e.take(ASK).resolve(response); await settle();
    const ask = state(e.controller).ask;
    assert.deepEqual([ask.status, ask.answer, ask.failure?.code, ask.failure?.ask?.code ?? null], ['ERROR', null, code, askCode]);
    await settle();
    assert.equal(e.pending.length, 0, 'never retried');
  }
});

test('an answer never changes context, queue, selection, detail, evidence or urgency state', async () => {
  const h = harness();
  await connected(h); await ready(h);
  h.controller.selectObservation('obs-alert');
  const before = state(h.controller);
  h.controller.askQuestion('What needs attention?', true);
  const pending = h.take(ASK);
  pending.resolve(reply(pending)); await settle();
  const after = state(h.controller);
  assert.equal(after.ask.status, 'READY');
  for (const key of ['session', 'clients', 'selection', 'context', 'queueQuery', 'queuePosition', 'queue', 'observationId', 'evidence', 'askCapability'] as const) {
    assert.equal(after[key], before[key], key);
  }
});
