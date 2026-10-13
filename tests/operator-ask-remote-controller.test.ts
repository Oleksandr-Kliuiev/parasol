import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCredentialHolder } from '../apps/operator/src/credential.ts';
import { createController } from '../apps/operator/src/controller.ts';
import type { Controller } from '../apps/operator/src/controller.ts';
import type { ConsoleState } from '../apps/operator/src/state.ts';
import { dbContext, fixtureContext } from './support/operator-fixtures.ts';
import { journeyItems, page, WS } from './support/operator-journey.ts';
import { askError, capabilityResponse } from './support/operator-ask.ts';
import { ADMISSION, BIG_VERSION, journeyRemoteAnswer, remoteCapabilityResponse } from './support/operator-ask-remote.ts';

// ASK-REMOTE R-C controller isolation (docs/stage5/ask/remote/02 "Consent and generation isolation") with deferred responses
// whose fake fetch IGNORES AbortSignal and with AbortController.abort disabled: every manual REMOTE submit needs the current
// consent (state AND the box as shown), captures the disclosure tuple, question and focus before clearing input and consent,
// and sends one exact AskRequestV2 with a fresh UUIDv4. Edit (REMOTE only), focus (both directions), credential, client,
// context, queue, page, filter, observation, disconnect and capability refresh are boundaries: consent false, older work
// stale. A current policy 409 clears and marks unavailable with only a manual refresh. MOCK typing is unchanged.
const A = 'synthetic-console-token-aaaaaaaaaaaa';
const B = 'synthetic-console-token-bbbbbbbbbbbb';
const CL = 'c-db';
const CLIENTS = [{ id: CL, name: 'DB (synthetic)' }, { id: 'c-two', name: 'Two (synthetic)' }, { id: 'demo-gasta', name: 'Fixture (synthetic)' }];
const ASK = `/clients/${CL}/ask`;
interface Pending { method: string; path: string; body: string | null; resolve(response: Response): void }

function harness(ids: string[] = []) {
  const pending: Pending[] = [];
  const sent: Pending[] = [];
  const holder = createCredentialHolder((path, init) => new Promise<Response>(resolve => {
    const p = { method: init.method ?? 'GET', path, body: typeof init.body === 'string' ? init.body : null, resolve };
    pending.push(p); sent.push(p);
  }));
  const next = ids.length ? () => ids.shift()! : undefined;
  const controller = createController(holder, () => undefined, { deadlineMs: 2000, ...(next ? { askRequestId: next } : {}) });
  const take = (prefix: string): Pending => {
    const index = pending.findLastIndex(p => p.path.split('?')[0] === prefix);
    assert.ok(index >= 0, `request ${prefix}`);
    return pending.splice(index, 1)[0]!;
  };
  const has = (prefix: string) => pending.some(p => p.path.split('?')[0] === prefix);
  const posts = () => sent.filter(p => p.method === 'POST' && p.path === ASK).map(p => JSON.parse(p.body!));
  return { holder, controller, pending, sent, take, has, posts };
}
type H = ReturnType<typeof harness>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const status = (code: number) => new Response('', { status: code });
const settle = () => new Promise(resolve => setTimeout(resolve, 10));
const s = (c: Controller): ConsoleState => c.state();
async function withoutAbort(body: () => Promise<void>): Promise<void> {
  const original = AbortController.prototype.abort;
  AbortController.prototype.abort = function ignored() { /* never delivered */ };
  try { await body(); } finally { AbortController.prototype.abort = original; }
}
/** The R-B answer for a recorded V2 body; the scripted interpreter picks `intent`. */
const reply = (p: Pending, intent: 'SUMMARY' | 'WHY_URGENT' | 'UNSUPPORTED' = 'SUMMARY', clientId = CL) => {
  const body = JSON.parse(p.body!);
  const answer = journeyRemoteAnswer(body, intent, clientId);
  return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json', 'x-atlas-correlation-id': answer.correlationId } });
};
const lateOf = (kind: string, p: Pending) => kind === 'success' ? reply(p) : kind === 'error' ? askError('ASK_REMOTE_UNAVAILABLE', 503)
  : kind === '409' ? askError('ASK_REMOTE_POLICY_CHANGED', 409) : status(Number(kind));
const LATE = ['success', 'error', '409', '401', '403'] as const;

async function connected(h: H, token = A, capability: Response = remoteCapabilityResponse()) {
  h.controller.connect(token);
  h.take('/clients').resolve(json(CLIENTS)); await settle();
  h.take('/ask/capabilities').resolve(capability); await settle();
}
async function ready(h: H, client = CL, capability?: Response) {
  if (s(h.controller).session !== 'READY') await connected(h, A, capability);
  h.controller.select(client);
  h.take(`/clients/${client}/overview`).resolve(json(dbContext(client, WS))); await settle();
  h.take(`/clients/${client}/observations`).resolve(json(page(journeyItems().map(o => ({ ...o, clientId: client }))))); await settle();
}
/** The operator's manual consent then the Ask button with the box as shown (checked). */
const consentAndAsk = (h: H, question: string, useFocus = false) => { h.controller.askConsentChanged(true); return h.controller.askQuestion(question, useFocus, true); };

test('capability: exact V2 → REMOTE with the tuple; 503 NOT_ADMITTED is unavailable (never OFF, no disconnect); fixture contexts cannot ask', async () => {
  const h = harness();
  await connected(h);
  assert.deepEqual([s(h.controller).askCapability.status, s(h.controller).askCapability.disclosure], ['REMOTE', { admissionId: ADMISSION, policyVersion: BIG_VERSION }]);
  const off = harness();
  await connected(off, A, askError('ASK_REMOTE_NOT_ADMITTED', 503));
  const cap = s(off.controller).askCapability;
  assert.deepEqual([cap.status, cap.failure?.ask?.code, cap.disclosure, s(off.controller).session], ['ERROR', 'ASK_REMOTE_NOT_ADMITTED', null, 'READY']);
  assert.equal(off.controller.askQuestion('What needs attention?', false, true), false);
  off.controller.retryAskCapability();
  off.take('/ask/capabilities').resolve(remoteCapabilityResponse()); await settle();
  assert.equal(s(off.controller).askCapability.status, 'REMOTE');
  // REMOTE answers are DB-only: a fixture context is never offered the remote form and sends nothing.
  const fx = harness();
  await connected(fx);
  fx.controller.select('demo-gasta');
  fx.take('/clients/demo-gasta/overview').resolve(json(await fixtureContext())); await settle();
  assert.equal(s(fx.controller).context.status, 'READY');
  fx.controller.askConsentChanged(true);
  assert.equal(fx.controller.askQuestion('What needs attention?', false, true), false);
  assert.equal(fx.posts().length, 0);
});

test('no consent sends NOTHING: unchecked, box/state disagreement, consent before an edit, consent of a previous question', async () => {
  const h = harness();
  await ready(h);
  assert.equal(h.controller.askQuestion('What needs attention?', false, false), false);
  assert.deepEqual([s(h.controller).ask.status, s(h.controller).ask.refusal], ['REFUSED', 'CONSENT']);
  assert.equal(h.controller.askQuestion('What needs attention?', false, true), false, 'a box shown checked without the consent state');
  h.controller.askConsentChanged(true);
  assert.equal(h.controller.askQuestion('What needs attention?', false, false), false, 'consent state with the box shown unchecked');
  h.controller.askConsentChanged(true);
  h.controller.askQuestionEdited();
  assert.equal(s(h.controller).ask.consent, false, 'an edit clears consent');
  assert.equal(h.controller.askQuestion('What needs attention? (edited)', false, true), false);
  assert.equal(h.posts().length, 0);
  assert.equal(consentAndAsk(h, 'What needs attention?'), true);
  const p = h.take(ASK); p.resolve(reply(p)); await settle();
  assert.equal(s(h.controller).ask.status, 'READY');
  assert.equal(h.controller.askQuestion('Why is this urgent?', false, true), false, 'consent never carries to the next question');
  assert.equal(h.posts().length, 1);
});

test('submit captures the exact question, focus and disclosure tuple, then clears input and consent synchronously; fresh UUID; one pending', async () => {
  const ids = [randomUUID(), randomUUID(), 'NOT-A-UUID'];
  const h = harness([...ids]);
  await ready(h);
  h.controller.selectObservation('obs-crit');
  h.controller.askFocusChanged(true);
  const before = s(h.controller).ask.inputGeneration;
  const question = '  Why is THIS urgent?\n😀 "q" ';
  assert.equal(consentAndAsk(h, question, true), true);
  const a = s(h.controller).ask;
  assert.deepEqual([a.status, a.consent, a.useFocus, a.focus, a.inputGeneration > before], ['PENDING', false, true, 'obs-crit', true]);
  assert.equal(JSON.stringify(a).includes('THIS urgent'), false, 'no question in state');
  assert.equal(h.controller.askQuestion(question, true, true), false, 'a second submit while pending sends nothing');
  const [body] = h.posts();
  assert.deepEqual(body, { contractVersion: 'AskRequestV2', requestId: ids[0], question, observationId: 'obs-crit',
    acknowledgement: { contractVersion: 'AskRemoteDisclosureV1', admissionId: ADMISSION, policyVersion: BIG_VERSION, questionDataClass: 'SYNTHETIC' } });
  const p = h.take(ASK); p.resolve(reply(p, 'WHY_URGENT')); await settle();
  assert.deepEqual([s(h.controller).ask.status, s(h.controller).ask.answer?.mode, s(h.controller).ask.answer?.requestId, s(h.controller).ask.useFocus], ['READY', 'remote', ids[0], true]);
  assert.equal(consentAndAsk(h, 'What needs attention?', true), true);
  const q = h.take(ASK); q.resolve(reply(q, 'SUMMARY')); await settle();
  assert.equal(consentAndAsk(h, 'What needs attention?'), false, 'no canonical UUID: nothing sent');
  assert.equal(s(h.controller).ask.refusal, 'REQUEST_ID');
  assert.deepEqual(h.posts().map(b => b.requestId), ids.slice(0, 2));
  // The MOCK capability keeps sending exact V1 (no acknowledgement) and ignores the consent argument.
  const mock = harness();
  await ready(mock, CL, capabilityResponse());
  assert.equal(mock.controller.askQuestion('What needs attention?', false), true);
  assert.deepEqual(Object.keys(mock.posts()[0]), ['contractVersion', 'requestId', 'question', 'observationId']);
});

test('REMOTE edit: invalidates the pending question (late success/error/409/401/403 ignored), clears consent/answer, keeps the draft; MOCK typing unchanged', () => withoutAbort(async () => {
  for (const late of LATE) {
    const h = harness();
    await ready(h);
    assert.equal(consentAndAsk(h, 'What needs attention?'), true);
    const old = h.take(ASK);
    const generation = s(h.controller).ask.inputGeneration;
    h.controller.askQuestionEdited();
    assert.deepEqual([s(h.controller).ask.status, s(h.controller).ask.inputGeneration, s(h.controller).ask.consent], ['IDLE', generation, false], 'spinner cleared, draft kept');
    old.resolve(lateOf(late, old)); await settle();
    const st = s(h.controller);
    assert.deepEqual([st.session, st.selection?.clientId, st.scopeDenied, st.askCapability.status, st.ask.status, st.ask.answer, st.ask.inputGeneration],
      ['READY', CL, false, 'REMOTE', 'IDLE', null, generation], late);
    assert.equal(h.sent.filter(p => p.path === '/clients').length, 1, 'no picker refresh');
  }
  const h = harness();
  await ready(h);
  consentAndAsk(h, 'What needs attention?');
  const p = h.take(ASK); p.resolve(reply(p)); await settle();
  h.controller.askConsentChanged(true);
  h.controller.askQuestionEdited();
  assert.deepEqual([s(h.controller).ask.status, s(h.controller).ask.answer, s(h.controller).ask.consent], ['IDLE', null, false], 'edit clears the old answer and consent');
  // MOCK: typing during a pending question changes nothing; the answer still arrives and the draft is never cleared by it.
  const m = harness();
  await ready(m, CL, capabilityResponse());
  m.controller.askQuestion('What needs attention?', false);
  const pendingState = s(m.controller).ask;
  m.controller.askQuestionEdited();
  m.controller.askConsentChanged(true);
  assert.equal(s(m.controller).ask, pendingState, 'MOCK: the edit and consent hooks are no-ops');
  const mp = m.take(ASK);
  const body = JSON.parse(mp.body!);
  const { compiledAnswer, dbRead } = await import('./support/operator-ask.ts');
  const { source } = dbRead({ workspaceId: WS, clientId: CL, page: journeyItems() });
  const v1 = compiledAnswer(source, body.question, null, { requestId: body.requestId, workspaceId: WS, clientId: CL });
  mp.resolve(new Response(JSON.stringify(v1), { headers: { 'content-type': 'application/json', 'x-atlas-correlation-id': v1.correlationId } })); await settle();
  assert.deepEqual([s(m.controller).ask.status, s(m.controller).ask.inputGeneration], ['READY', pendingState.inputGeneration]);
}));

test('both focus directions in READY and PENDING clear draft/answer/consent; late outcomes of the old question never render or reset auth', () => withoutAbort(async () => {
  for (const [first, change] of [[false, true], [true, false]] as const) {
    const ready1 = harness();
    await ready(ready1);
    ready1.controller.selectObservation('obs-crit');
    if (first) ready1.controller.askFocusChanged(true);
    consentAndAsk(ready1, 'Why is this urgent?', first);
    const r = ready1.take(ASK); r.resolve(reply(r, first ? 'WHY_URGENT' : 'SUMMARY')); await settle();
    ready1.controller.askConsentChanged(true);
    const generation = s(ready1.controller).ask.inputGeneration;
    ready1.controller.askFocusChanged(change);
    const a = s(ready1.controller).ask;
    assert.deepEqual([a.status, a.answer, a.consent, a.useFocus, a.inputGeneration > generation], ['IDLE', null, false, change, true], `READY ${first}→${change}`);
    for (const late of LATE) {
      const h = harness();
      await ready(h);
      h.controller.selectObservation('obs-crit');
      if (first) h.controller.askFocusChanged(true);
      consentAndAsk(h, 'Why is this urgent?', first);
      const old = h.take(ASK);
      h.controller.askFocusChanged(change);
      assert.deepEqual([s(h.controller).ask.status, s(h.controller).ask.consent], ['IDLE', false]);
      // A newer pending question (new consent, new UUID) keeps its spinner against the old outcome.
      assert.equal(consentAndAsk(h, 'What needs attention?', change), true);
      old.resolve(lateOf(late, old)); await settle();
      const st = s(h.controller);
      assert.deepEqual([st.session, st.selection?.clientId, st.askCapability.status, st.ask.status], ['READY', CL, 'REMOTE', 'PENDING'], `PENDING ${first}→${change} ${late}`);
      const fresh = h.take(ASK);
      assert.notEqual(JSON.parse(fresh.body!).requestId, JSON.parse(old.body!).requestId);
      fresh.resolve(reply(fresh)); await settle();
      assert.equal(s(h.controller).ask.status, 'READY');
    }
  }
}));

test('every reset boundary clears consent and makes the pending remote question stale: credential, client, context, queue, page, filter, observation, disconnect', () => withoutAbort(async () => {
  const boundaries: [string, (h: H) => Promise<void> | void][] = [
    ['credential', async h => { h.controller.connect(B); h.take('/clients').resolve(json(CLIENTS)); await settle(); h.take('/ask/capabilities').resolve(remoteCapabilityResponse()); await settle(); await ready(h); }],
    ['client', async h => { h.controller.select('c-two'); }],
    ['context', h => { h.controller.refreshContext(); }],
    ['queue', h => { h.controller.refreshQueue(); }],
    ['page', h => { h.controller.firstPage(); }],
    ['filter', h => { h.controller.applyQueue(['OPEN'], ['HIGH', 'CRITICAL'], 25); }],
    ['observation', h => { h.controller.selectObservation('obs-alert'); }],
    ['disconnect', h => { h.controller.disconnect('PAGE_HIDDEN'); }]
  ];
  for (const [name, change] of boundaries) {
    for (const late of LATE) {
      const h = harness();
      await ready(h);
      h.controller.selectObservation('obs-crit');
      consentAndAsk(h, 'What needs attention?');
      const old = h.take(ASK);
      h.controller.askConsentChanged(true);
      await change(h);
      assert.equal(s(h.controller).ask.consent, false, `${name}: consent cleared`);
      const before = s(h.controller);
      old.resolve(lateOf(late, old)); await settle();
      const after = s(h.controller);
      assert.deepEqual([after.session, after.selection?.clientId ?? null, after.scopeDenied, after.ask.status, after.ask.answer, after.askCapability.status],
        [before.session, before.selection?.clientId ?? null, before.scopeDenied, before.ask.status, null, before.askCapability.status], `${name} ← late ${late}`);
    }
  }
}));

test('current policy 409: clears input/answer/consent, unavailable with only a manual refresh; refresh needs new consent and sends a new UUID with the new version', () => withoutAbort(async () => {
  const h = harness();
  await ready(h);
  consentAndAsk(h, 'What needs attention?');
  const p = h.take(ASK);
  const generation = s(h.controller).ask.inputGeneration;
  p.resolve(askError('ASK_REMOTE_POLICY_CHANGED', 409)); await settle();
  let st = s(h.controller);
  assert.deepEqual([st.askCapability.status, st.askCapability.failure?.ask?.code, st.askCapability.disclosure, st.ask.status, st.ask.failure?.ask?.code, st.ask.consent,
    st.ask.answer, st.ask.inputGeneration > generation, st.session, st.selection?.clientId], ['ERROR', 'ASK_REMOTE_POLICY_CHANGED', null, 'ERROR', 'ASK_REMOTE_POLICY_CHANGED',
    false, null, true, 'READY', CL]);
  await settle();
  assert.deepEqual([h.has('/ask/capabilities'), h.has(ASK)], [false, false], 'no automatic refresh or resubmission');
  assert.equal(consentAndAsk(h, 'What needs attention?'), false, 'unavailable until refreshed');
  h.controller.retryAskCapability();
  assert.deepEqual([s(h.controller).askCapability.status, s(h.controller).ask.status], ['LOADING', 'IDLE']);
  h.take('/ask/capabilities').resolve(remoteCapabilityResponse(ADMISSION, '9007199254740994')); await settle();
  st = s(h.controller);
  assert.deepEqual([st.askCapability.status, st.askCapability.disclosure?.policyVersion, st.ask.consent], ['REMOTE', '9007199254740994', false]);
  assert.equal(h.controller.askQuestion('What needs attention?', false, true), false, 'the old consent is gone');
  assert.equal(consentAndAsk(h, 'What needs attention?'), true);
  const [first, second] = h.posts();
  assert.notEqual(second.requestId, first.requestId);
  assert.deepEqual([first.acknowledgement.policyVersion, second.acknowledgement.policyVersion], [BIG_VERSION, '9007199254740994']);
  // A capability refresh that returns the SAME tuple still invalidates consent and the draft.
  const same = harness();
  await ready(same);
  consentAndAsk(same, 'What needs attention?');
  same.take(ASK).resolve(askError('ASK_REMOTE_POLICY_CHANGED', 409)); await settle();
  same.controller.retryAskCapability();
  same.controller.askConsentChanged(true);
  assert.equal(s(same.controller).ask.consent, false, 'no consent while the disclosure is loading');
  same.take('/ask/capabilities').resolve(remoteCapabilityResponse()); await settle();
  assert.equal(s(same.controller).ask.consent, false);
  // A STALE 409 (after a newer context) changes nothing: the capability stays REMOTE.
  const stale = harness();
  await ready(stale);
  consentAndAsk(stale, 'What needs attention?');
  const old = stale.take(ASK);
  stale.controller.refreshQueue();
  old.resolve(askError('ASK_REMOTE_POLICY_CHANGED', 409)); await settle();
  assert.deepEqual([s(stale.controller).askCapability.status, s(stale.controller).ask.status], ['REMOTE', 'IDLE']);
}));

test('current outcomes: upstream-class 503/429 are errors keeping session, scope and REMOTE; actual browser 401 disconnects and 403 resets once', async () => {
  for (const [code, http] of [['ASK_REMOTE_UNAVAILABLE', 503], ['ASK_REMOTE_INVALID', 503], ['ASK_REMOTE_MODEL_MISMATCH', 503], ['ASK_REMOTE_USAGE_INVALID', 503],
    ['ASK_REMOTE_BUDGET', 429], ['ASK_REMOTE_NOT_ADMITTED', 503], ['ASK_DEADLINE', 504]] as const) {
    const h = harness();
    await ready(h);
    consentAndAsk(h, 'What needs attention?');
    h.take(ASK).resolve(askError(code, http)); await settle();
    const st = s(h.controller);
    assert.deepEqual([st.session, st.selection?.clientId, st.scopeDenied, st.askCapability.status, st.ask.status, st.ask.failure?.ask?.code, st.ask.answer],
      ['READY', CL, false, 'REMOTE', 'ERROR', code, null], code);
    await settle();
    assert.equal(h.pending.length, 0, `${code}: no retry, refresh or fallback`);
  }
  const unauthorized = harness();
  await ready(unauthorized);
  consentAndAsk(unauthorized, 'What needs attention?');
  unauthorized.take(ASK).resolve(status(401)); await settle();
  assert.deepEqual([s(unauthorized.controller).session, s(unauthorized.controller).notice, s(unauthorized.controller).askCapability.status], ['DISCONNECTED', 'UNAUTHORIZED', 'IDLE']);
  const forbidden = harness();
  await ready(forbidden);
  consentAndAsk(forbidden, 'What needs attention?');
  forbidden.take(ASK).resolve(status(403)); await settle();
  assert.deepEqual([s(forbidden.controller).selection, s(forbidden.controller).scopeDenied, forbidden.has('/clients')], [null, true, true]);
  // Malformed/wrong-version answers are discarded whole; nothing partial is kept.
  const malformed = harness();
  await ready(malformed);
  consentAndAsk(malformed, 'What needs attention?');
  const m = malformed.take(ASK);
  const body = JSON.parse(m.body!);
  const v2 = journeyRemoteAnswer(body, 'SUMMARY', CL) as any;
  v2.mode = 'mock';
  m.resolve(new Response(JSON.stringify(v2), { headers: { 'content-type': 'application/json', 'x-atlas-correlation-id': v2.correlationId } })); await settle();
  assert.deepEqual([s(malformed.controller).ask.status, s(malformed.controller).ask.failure?.code, s(malformed.controller).ask.answer], ['ERROR', 'RESPONSE_INVALID', null]);
});
