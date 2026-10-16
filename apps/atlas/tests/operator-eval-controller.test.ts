import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createMeasuredHolder } from '../apps/operator/measured/credential-measured.ts';
import { askError, askHeaders } from './support/operator-ask.ts';
import { ASK, HANDOFF, TOKEN_A, answered, askNow, evalHarness, focusOf, json, newToken, pair200, paired, readyConsole, settle } from './support/operator-eval.ts';
import type { EvalHarness } from './support/operator-eval.ts';
import { journeyItems } from './support/operator-journey.ts';

// RS-C-C measured evaluation pane (04 "Pairing and arm", "Synthetic evaluation focus choice" — the EXACT transition table — and
// "The server must bind the actual values"; rs-c brief C §3/§4) on the ACCEPTED console controller with a fake fetch that ignores
// AbortSignal: manual pairing only, one fixed choice, consent only for the current tuple, submit captures then clears without
// self-invalidating, stale completions change nothing, external invalidations clear the form (and the pair when its basis changes),
// one manual RESPONSE of the exact exchanged values. Synthetic values only.
const ui = (h: EvalHarness) => h.evaluation.state();
const lastAsk = (h: EvalHarness) => h.sent.filter(p => p.path === ASK).at(-1)!;

test('measured holder: no token/session exposure; the evaluation Ask alone carries the session header; nothing without a session/credential', async () => {
  const seen: { path: string; init: RequestInit }[] = [];
  const holder = createMeasuredHolder(async (path, init) => { seen.push({ path, init }); return new Response(null, { status: 204 }); });
  const session = newToken();
  assert.equal(holder.adoptSession(session, holder.epoch()), false, 'no credential: nothing kept');
  assert.equal(holder.replace(TOKEN_A), true);
  assert.equal(holder.adoptSession('not-a-token', holder.epoch()), false);
  assert.equal(holder.adoptSession(session, holder.epoch() - 1), false, 'a stale credential epoch keeps nothing');
  assert.equal(holder.adoptSession(session, holder.epoch()), true);
  const text = `${JSON.stringify(holder)} ${Object.keys(holder).join(',')} ${String(holder)}`;
  assert.ok(!text.includes(TOKEN_A) && !text.includes(session), 'no getter, field or serialization exposes a secret');
  const op = { clientId: 'c-db', requestId: randomUUID(), question: 'Q?', observationId: null,
    acknowledgement: { contractVersion: 'AskRemoteDisclosureV1' as const, admissionId: randomUUID(), policyVersion: '3', questionDataClass: 'SYNTHETIC' as const } };
  await holder.askRemote(op, new AbortController().signal);
  await holder.askEvaluation(op, new AbortController().signal);
  const [plain, evaluation] = seen.map(s => new Headers(s.init.headers));
  assert.equal(plain!.get('x-atlas-evaluation-session'), null, 'the ordinary REMOTE operation never carries the session header');
  assert.equal(evaluation!.get('x-atlas-evaluation-session'), session);
  assert.equal(seen[1]!.init.body, seen[0]!.init.body, 'the same exact AskRequestV2 body');
  assert.deepEqual([seen[1]!.init.credentials, seen[1]!.init.redirect, seen[1]!.init.mode], ['omit', 'error', 'same-origin']);
  holder.replace(TOKEN_A);
  assert.equal(holder.paired(), false, 'a credential replacement drops the session');
  await assert.rejects(holder.askEvaluation(op, new AbortController().signal));
  await assert.rejects(holder.respond('c-db', { pairId: randomUUID(), receiptNonce: newToken(), request: {}, response: { status: 200, correlationId: randomUUID(), body: {} } },
    new AbortController().signal));
});

test('pairing is manual and exact: unregistered server (404) and malformed PAIR200 are failures; a valid PAIR200 shows the empty pane with ONE fixed choice', async () => {
  const h = evalHarness();
  await readyConsole(h);
  assert.equal(ui(h).pairStatus, 'IDLE'); assert.equal(h.has(HANDOFF), false, 'no automatic PAIR probe');
  h.evaluation.pair(newToken());
  h.take(HANDOFF).resolve(new Response('Not Found', { status: 404 })); await settle();
  assert.deepEqual([ui(h).pairStatus, ui(h).pairFailure?.status], ['ERROR', 404]);
  h.evaluation.pair(newToken());
  h.take(HANDOFF).resolve(json({ ...pair200(focusOf('NONE')), extra: 1 })); await settle();
  assert.deepEqual([ui(h).pairStatus, ui(h).pairFailure?.code, h.holder.paired()], ['ERROR', 'RESPONSE_INVALID', false]);
  const body = await paired(h, focusOf('MISSING', 'syn-obs-not-found'));
  assert.deepEqual([ui(h).pair?.pairId, ui(h).pair?.focus.focusState, ui(h).choice, ui(h).consent, ui(h).status], [body.pairId, 'MISSING', false, false, 'IDLE']);
  assert.ok(!JSON.stringify(ui(h)).includes(body.sessionToken), 'the session token never enters state');
  assert.equal(new Headers(h.sent.at(-1)!.headers).get('x-atlas-evaluation-session'), null, 'PAIR itself carries no session header');
});

test('04 table: typing keeps the draft; choice keeps draft+choice; edit after choice clears choice+consent; consent only for the current tuple', async () => {
  const h = evalHarness();
  await readyConsole(h); await paired(h);
  const g0 = ui(h).formGeneration;
  h.evaluation.questionEdited(); h.evaluation.questionEdited();
  assert.equal(ui(h).formGeneration, g0, 'repeated typing never clears the newly typed draft');
  h.evaluation.consentChanged(true, 'What needs attention?');
  assert.equal(ui(h).consent, false, 'no consent without the deliberate choice');
  h.evaluation.choose();
  assert.deepEqual([ui(h).choice, ui(h).formGeneration], [true, g0], 'selection retains the draft and the new choice');
  h.evaluation.consentChanged(true, '');
  assert.equal(ui(h).consent, false, 'no consent for an empty draft');
  h.evaluation.consentChanged(true, 'What needs attention?');
  assert.equal(ui(h).consent, true);
  h.evaluation.questionEdited();
  assert.deepEqual([ui(h).choice, ui(h).consent, ui(h).formGeneration], [false, false, g0], 'an edit after selection clears choice and consent, keeps the draft');
  assert.equal(h.evaluation.submit('What needs attention?', true, true), false, 'the box shown checked without the state sends nothing');
  assert.equal(ui(h).refusal, 'NO_CHOICE');
  h.evaluation.choose(); h.evaluation.consentChanged(true, 'What needs attention?');
  assert.equal(h.evaluation.submit('What needs attention?', true, false), false, 'consent state with the box shown unchecked');
  assert.equal(h.sent.filter(p => p.path === ASK).length, 0);
});

test('submit captures the exact tuple then clears the form WITHOUT invalidating itself; the completion shows the answer and offers ONE manual send of the exact values', async () => {
  const h = evalHarness();
  await readyConsole(h);
  const focusId = journeyItems()[0]!.id as string;
  const pair = await paired(h, focusOf('FOUND', focusId));
  const g0 = ui(h).formGeneration;
  assert.equal(askNow(h), true);
  assert.deepEqual([ui(h).status, ui(h).choice, ui(h).consent, ui(h).formGeneration], ['PENDING', false, false, g0 + 1], 'cleared synchronously after capture');
  const p = lastAsk(h);
  const request = JSON.parse(p.body!);
  assert.deepEqual([request.observationId, request.question, new Headers(p.headers).get('x-atlas-evaluation-session')], [focusId, 'What needs attention for this client right now?', pair.sessionToken]);
  const receipt = newToken();
  const response = answered(h.take(ASK), receipt);
  const answerBody = JSON.parse(await response.clone().text());
  p.resolve(response); await settle();
  assert.deepEqual([ui(h).status, ui(h).send, ui(h).answer?.focusObservationId], ['READY', 'AVAILABLE', focusId], 'the just-captured request completes (form clearing did not invalidate it)');
  h.evaluation.sendEvidence();
  assert.equal(ui(h).send, 'SENDING');
  const r = h.take(HANDOFF);
  const sentBody = JSON.parse(r.body!);
  assert.deepEqual(sentBody, { contractVersion: 'RevalBrowserHandoffV1', operation: 'RESPONSE', pairId: pair.pairId, receiptNonce: receipt, request,
    response: { status: 200, correlationId: answerBody.correlationId, body: answerBody } }, 'exactly what was submitted and received');
  assert.equal(new Headers(r.headers).get('x-atlas-evaluation-session'), pair.sessionToken);
  h.evaluation.sendEvidence();
  assert.equal(h.sent.filter(x => x.path === HANDOFF && x.method === 'POST' && x.body?.includes('RESPONSE')).length, 1, 'never a second send');
  r.resolve(new Response(null, { status: 204 })); await settle();
  assert.equal(ui(h).send, 'SENT');
});

test('stale completions change nothing: an edit, a choice or an external invalidation (queue refresh) retires the pending request; its late answer/error/401 is ignored', async () => {
  for (const boundary of ['edit', 'choose', 'queue'] as const) {
    for (const late of ['answer', 'error', '401'] as const) {
      const h = evalHarness();
      await readyConsole(h); await paired(h);
      assert.equal(askNow(h), true);
      const p = h.take(ASK);
      if (boundary === 'edit') h.evaluation.questionEdited();
      else if (boundary === 'choose') h.evaluation.choose();
      else { h.controller.refreshQueue(); h.take('/clients/c-db/observations'); }
      const before = JSON.stringify(ui(h));
      p.resolve(late === 'answer' ? answered(p) : late === 'error' ? askError('ASK_REMOTE_UNAVAILABLE', 503) : new Response('', { status: 401 })); await settle();
      assert.equal(JSON.stringify(ui(h)), before, `${boundary}/${late}: no state change`);
      assert.equal(h.unauthorized(), 0, 'a stale 401 never disconnects');
      assert.equal(ui(h).pairStatus, 'PAIRED', 'context/queue invalidations keep the pair');
    }
  }
});

test('external invalidations: queue refresh clears draft+choice (pair kept); capability/client/credential change ends the pair; pagehide ends everything', async () => {
  const h = evalHarness();
  await readyConsole(h); await paired(h);
  h.evaluation.choose(); h.evaluation.consentChanged(true, 'Q?');
  const g = ui(h).formGeneration;
  h.controller.refreshQueue(); await settle();
  assert.deepEqual([ui(h).choice, ui(h).consent, ui(h).formGeneration, ui(h).pairStatus], [false, false, g + 1, 'PAIRED']);
  h.take('/clients/c-db/observations');
  const state = h.controller.state();
  h.evaluation.observe({ ...state, askCapability: { ...state.askCapability, disclosure: { admissionId: randomUUID(), policyVersion: '4' } } });
  assert.deepEqual([ui(h).pairStatus, ui(h).pair, h.holder.paired()], ['IDLE', null, false], 'a capability/policy change ends the pair (fresh pairing)');
  h.evaluation.observe(state);
  await paired(h);
  h.controller.select('c-two'); await settle();
  assert.deepEqual([ui(h).pair, h.holder.paired()], [null, false], 'another client ends the pair');
  const c = evalHarness(); await readyConsole(c); await paired(c);
  c.controller.connect(TOKEN_A); await settle();
  assert.deepEqual([ui(c).pair, c.holder.paired()], [null, false], 'a credential replacement ends the pair');
  const k = evalHarness(); await readyConsole(k); await paired(k);
  k.evaluation.pageHidden();
  assert.deepEqual([ui(k).pair, k.holder.paired(), ui(k).status], [null, false, 'IDLE']);
});

test('a 503 ASK_REMOTE_NOT_ADMITTED without a receipt ends the pair; an eligible error with a receipt is offered for the one manual send', async () => {
  const h = evalHarness();
  await readyConsole(h); await paired(h);
  askNow(h);
  let p = h.take(ASK); p.resolve(askError('ASK_REMOTE_NOT_ADMITTED', 503)); await settle();
  assert.deepEqual([ui(h).status, ui(h).pair, h.holder.paired()], ['ERROR', null, false], 'pair ended, the refusal stays visible (rc2 F3)');
  await paired(h);
  askNow(h);
  p = h.take(ASK);
  const correlationId = randomUUID();
  const headers = askHeaders(correlationId); headers.set('x-atlas-evaluation-receipt', newToken());
  p.resolve(new Response(JSON.stringify({ contractVersion: 'AskErrorV1', code: 'ASK_REMOTE_UNAVAILABLE', correlationId }), { status: 503, headers })); await settle();
  assert.deepEqual([ui(h).status, ui(h).failure?.ask?.code, ui(h).send, ui(h).pairStatus], ['ERROR', 'ASK_REMOTE_UNAVAILABLE', 'AVAILABLE', 'PAIRED']);
});
