import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCredentialHolder } from '../apps/operator/src/credential.ts';
import { createController } from '../apps/operator/src/controller.ts';
import type { Controller } from '../apps/operator/src/controller.ts';
import { ASK_INSUFFICIENT_NEUTRAL, ASK_INSUFFICIENT_NOTE, insufficientNotes } from '../apps/operator/src/ask-messages.ts';
import { validateAnswer } from '../apps/operator/src/validate-ask.ts';
import { dbContext } from './support/operator-fixtures.ts';
import { journeyItems, observation, page, WS } from './support/operator-journey.ts';
import { askError, askHeaders, askResponse, capabilityResponse, compiledAnswer, dbRead, emptyPlanAnswer, link, resource } from './support/operator-ask.ts';
import type { DbRead } from './support/operator-ask.ts';

// ASK-B RC2 repairs of the RC1 review (docs/stage5/reviews/ASTRA_S5ASKB_RC1.md):
//   R1 an INSUFFICIENT answer (no compiled claim) never asserts missing evidence/focus the validated answer does not show;
//   R2 a deliberate "Use selected observation" change is a generation boundary (answer + question cleared, older work void);
//   (R3 is in operator-ask-validate.test.ts). Fake fetch ignores AbortSignal; races also run with abort never delivered.
const CL = 'c-db';
const A = 'synthetic-console-token-aaaaaaaaaaaa';
const B = 'synthetic-console-token-bbbbbbbbbbbb';
const INTENTS = ['SUMMARY', 'WHY_URGENT', 'SOURCE_STATE', 'ENTITY'] as const;

function read(focus: DbRead['focus'], patch: Partial<DbRead> = {}) {
  return dbRead({ workspaceId: WS, clientId: CL, focus, page: journeyItems(), devices: [{ id: 'd-1', label: 'HOST-01' }],
    links: [link('d-1', 'DEVICE', 'atera', 'agent', 'conn-atera', 'agent-1')],
    resources: [resource('atera', 'alert', 'conn-atera', 'OK'), resource('huntress', 'incident', 'conn-huntress', 'STALE')], ...patch });
}
function notesOf(intent: typeof INTENTS[number], focus: DbRead['focus'], patch: Partial<DbRead> = {}) {
  const { source, focusId } = read(focus, patch);
  const answer = emptyPlanAnswer(source, intent, focusId, { workspaceId: WS, clientId: CL });
  const view = validateAnswer(JSON.parse(JSON.stringify(answer)), askHeaders(answer.correlationId),
    { requestId: answer.requestId, workspaceId: WS, clientId: CL, sourceMode: 'db', focusObservationId: focusId });
  return { view, notes: insufficientNotes(view) };
}

test('R1: valid empty plans of all four supported intents with eligible evidence and a present focus: INSUFFICIENT, no missing-evidence note', () => {
  for (const intent of INTENTS) {
    const { view, notes } = notesOf(intent, { id: 'obs-crit' });
    assert.deepEqual([view.status, view.intent, view.claims.length], ['INSUFFICIENT', intent, 0]);
    assert.ok(view.evidence.length >= 5 && view.evidence[0]!.kind === 'OBSERVATION' && view.evidence[0]!.data.observationId === 'obs-crit', 'focus present, eligible facts');
    assert.ok(view.evidence.some(f => f.kind === 'RESOURCE_STATE' && f.data.connectionId === 'conn-huntress'), 'the exact focus tuple read is present');
    assert.deepEqual(notes, [], `${intent}: nothing is asserted beyond the neutral no-claim sentence`);
    assert.deepEqual(view.urgentRefs, ['E1'], 'independent urgency retained');
  }
  for (const text of [ASK_INSUFFICIENT_NEUTRAL, ...Object.values(ASK_INSUFFICIENT_NOTE)]) {
    assert.doesNotMatch(text, /no observation or stored-read fact to summarize|This needs a selected observation|not found in this client/);
  }
  assert.match(ASK_INSUFFICIENT_NEUTRAL, /No supported claim was compiled/);
});

test('R1: only conditions established by the validated request/bank add a note', () => {
  for (const intent of ['WHY_URGENT', 'SOURCE_STATE', 'ENTITY'] as const) {
    assert.deepEqual(notesOf(intent, null).notes, ['ASKED_WITHOUT_FOCUS'], `${intent} asked without a focus`);
    assert.deepEqual(notesOf(intent, { missing: 'obs-gone' }).notes, [], `${intent}: missing focus is shown by the focus line only`);
  }
  assert.deepEqual(notesOf('SUMMARY', null).notes, [], 'SUMMARY needs no focus');
  assert.deepEqual(notesOf('SOURCE_STATE', { id: 'obs-ticket' }).notes, ['NO_EXACT_TUPLE_READ'], 'no atera/ticket/conn-atera read in the evidence');
  assert.deepEqual(notesOf('SUMMARY', null, { page: [], resources: [] }).notes, ['EMPTY_EVIDENCE']);
  assert.deepEqual(notesOf('WHY_URGENT', null, { page: [], resources: [] }).notes, ['EMPTY_EVIDENCE', 'ASKED_WITHOUT_FOCUS']);
  const real = compiledAnswer(read({ id: 'obs-ticket' }).source, 'How fresh is the evidence?', 'obs-ticket', { workspaceId: WS, clientId: CL });
  assert.deepEqual([real.status, real.claims.length], ['INSUFFICIENT', 0], 'the MOCK planner itself yields this case');
});

// ---- R2 controller ----
interface Pending { method: string; path: string; body: string | null; resolve(response: Response): void }
function harness() {
  const pending: Pending[] = [];
  const sent: Pending[] = [];
  const holder = createCredentialHolder((path, init) => new Promise<Response>(resolve => {
    const p = { method: init.method ?? 'GET', path, body: typeof init.body === 'string' ? init.body : null, resolve };
    pending.push(p); sent.push(p);
  }));
  const controller = createController(holder, () => undefined, { deadlineMs: 2000 });
  const take = (path: string): Pending => {
    const index = pending.findLastIndex(p => p.path.split('?')[0] === path);
    assert.ok(index >= 0, `request ${path}`);
    return pending.splice(index, 1)[0]!;
  };
  return { controller, pending, sent, take };
}
type H = ReturnType<typeof harness>;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const status = (code: number) => new Response('', { status: code });
const settle = () => new Promise(resolve => setTimeout(resolve, 10));
const ASK = `/clients/${CL}/ask`;
function reply(p: Pending): Response {
  const body = JSON.parse(p.body!);
  const { source, focusId } = read(body.observationId === null ? null : { id: body.observationId });
  return askResponse(compiledAnswer(source, body.question, focusId, { requestId: body.requestId, workspaceId: WS, clientId: CL }));
}
async function ready(h: H, token = A) {
  h.controller.connect(token);
  h.take('/clients').resolve(json([{ id: CL, name: 'DB (synthetic)' }])); await settle();
  h.take('/ask/capabilities').resolve(capabilityResponse()); await settle();
  h.controller.select(CL);
  h.take(`/clients/${CL}/overview`).resolve(json(dbContext(CL, WS))); await settle();
  h.take(`/clients/${CL}/observations`).resolve(json(page(journeyItems()))); await settle();
  h.controller.selectObservation('obs-crit');
}
async function withoutAbort(body: () => Promise<void>): Promise<void> {
  const original = AbortController.prototype.abort;
  AbortController.prototype.abort = function ignored() { /* never delivered */ };
  try { await body(); } finally { AbortController.prototype.abort = original; }
}
const ask = (c: Controller) => c.state().ask;

test('R2: a deliberate focus change on a READY answer (null→selected and selected→null) clears answer and question, keeps the choice', async () => {
  const h = harness();
  await ready(h);
  for (const [first, change] of [[false, true], [true, false]] as const) {
    assert.equal(h.controller.askQuestion('Why is this urgent?', first), true);
    const p = h.take(ASK); p.resolve(reply(p)); await settle();
    assert.equal(ask(h.controller).status, 'READY');
    assert.equal(ask(h.controller).useFocus, first, 'a send keeps the sent focus choice (not a focus change)');
    const generation = ask(h.controller).inputGeneration;
    h.controller.askFocusChanged(change);
    assert.deepEqual([ask(h.controller).status, ask(h.controller).answer, ask(h.controller).useFocus], ['IDLE', null, change]);
    assert.ok(ask(h.controller).inputGeneration > generation, 'the typed question is cleared');
    assert.equal(h.pending.length, 0, 'a focus change sends nothing');
  }
  const none = harness();
  await ready(none);
  none.controller.selectObservation('obs-alert');
  none.controller.askFocusChanged(true);
  assert.equal(ask(none.controller).useFocus, true);
  none.controller.refreshQueue();
  assert.equal(ask(none.controller).useFocus, false, 'a reset clears the choice');
});

test('R2: PENDING then a focus change (both directions): late success/error/401/403 of the old focus change nothing, even when abort is never delivered', () => withoutAbort(async () => {
  for (const useFocus of [false, true]) {
    for (const late of ['success', 'error', '401', '403'] as const) {
      const h = harness();
      await ready(h);
      assert.equal(h.controller.askQuestion('Why is this urgent?', useFocus), true);
      const old = h.take(ASK);
      h.controller.askFocusChanged(!useFocus);
      assert.deepEqual([ask(h.controller).status, ask(h.controller).useFocus], ['IDLE', !useFocus], 'spinner cleared synchronously');
      old.resolve(late === 'success' ? reply(old) : late === 'error' ? askError('ASK_BUSY', 429) : status(Number(late))); await settle();
      const s = h.controller.state();
      assert.deepEqual([s.session, s.selection?.clientId, s.scopeDenied, s.ask.status, s.ask.answer], ['READY', CL, false, 'IDLE', null], `${useFocus} → ${late}`);
      assert.equal(h.sent.filter(p => p.path === '/clients').length, 1, 'no stale picker refresh');
    }
  }
}));

test('R2: a newer pending question after a focus change keeps its spinner against the old outcome; fresh UUID; single submit', () => withoutAbort(async () => {
  for (const late of ['success', 'error', '401', '403'] as const) {
    const h = harness();
    await ready(h);
    h.controller.askQuestion('Why is this urgent?', false);
    const old = h.take(ASK);
    h.controller.askFocusChanged(true);
    assert.equal(h.controller.askQuestion('Why is this urgent?', true), true);
    assert.equal(h.controller.askQuestion('Why is this urgent?', true), false, 'single submit');
    const newer = h.take(ASK);
    assert.equal(h.pending.length, 0);
    const [o, n] = [JSON.parse(old.body!), JSON.parse(newer.body!)];
    assert.notEqual(o.requestId, n.requestId);
    assert.deepEqual([o.observationId, n.observationId], [null, 'obs-crit']);
    old.resolve(late === 'success' ? reply(old) : late === 'error' ? askError('ASK_BUSY', 429) : status(Number(late))); await settle();
    assert.deepEqual([h.controller.state().session, ask(h.controller).status, h.controller.state().selection?.clientId], ['READY', 'PENDING', CL], `old ${late} cannot clear the new spinner`);
    newer.resolve(reply(newer)); await settle();
    assert.deepEqual([ask(h.controller).status, ask(h.controller).answer?.focusObservationId, ask(h.controller).answer?.claims[0]?.code], ['READY', 'obs-crit', 'SOURCE_URGENT']);
  }
  // A late 401 of the old focus after a credential replacement cannot disconnect the new session.
  const h = harness();
  await ready(h);
  h.controller.askQuestion('Why is this urgent?', true);
  const old = h.take(ASK);
  h.controller.askFocusChanged(false);
  h.controller.disconnect('DISCONNECTED');
  await ready(h, B);
  old.resolve(status(401)); await settle();
  assert.equal(h.controller.state().session, 'READY');
}));

test('R2: the extra-focus answer path still works: an observation outside the page asked with focus is answered normally', async () => {
  const h = harness();
  await ready(h);
  h.controller.askFocusChanged(true);
  assert.equal(h.controller.askQuestion('Which device is confirmed?', true), true);
  const p = h.take(ASK);
  const body = JSON.parse(p.body!);
  const { source, focusId } = read({ extra: observation('obs-crit', { status: 'RESOLVED', resolvedAt: '2026-10-10T08:00:00.000Z' }) },
    { page: journeyItems().filter(o => o.id !== 'obs-crit') });
  p.resolve(askResponse(compiledAnswer(source, body.question, focusId, { requestId: body.requestId, workspaceId: WS, clientId: CL }))); await settle();
  assert.deepEqual([ask(h.controller).status, ask(h.controller).answer?.coverage.focusExtra], ['READY', true]);
});
