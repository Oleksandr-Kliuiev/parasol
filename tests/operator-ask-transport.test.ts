import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCredentialHolder } from '../apps/operator/src/credential.ts';
import type { FetchLike } from '../apps/operator/src/credential.ts';
import { askBody, askPath, operationPath } from '../apps/operator/src/operations.ts';
import { fetchAskCapability, sendAskQuestion } from '../apps/operator/src/ask-transport.ts';
import type { AskExpectation } from '../apps/operator/src/validate-ask.ts';
import { askRequest } from '../packages/ask/input.ts';
import { observation, WS } from './support/operator-journey.ts';
import { askError, askHeaders, askResponse, capabilityResponse, compiledAnswer, dbRead } from './support/operator-ask.ts';

// ASK-B fixed operations and bounded Ask transport (Q1/Q6/Q7): exact request shape (same origin, bearer closure,
// omit/no-store/redirect:error/no-referrer, exact AskRequestV1), refusals without a request, success exactly 200, status-only
// 401/403 and capability 404, validated AskErrorV1, 256 KiB cap, fatal UTF-8 and ONE original 10 s budget that includes
// synchronous parse/validation. The fake fetch ignores AbortSignal unless stated otherwise.
const TOKEN = 'synthetic-console-token-0123456789';
interface Call { path: string; init: RequestInit }
function holderWith(respond: (call: Call) => Promise<Response> | Response) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (path, init) => { const call = { path, init }; calls.push(call); return respond(call); };
  const holder = createCredentialHolder(fetchImpl);
  holder.replace(TOKEN);
  return { holder, calls };
}
const never = () => new AbortController().signal;
const CL = 'c-db';
function answerFor(question: string, requestId: string, focus: string | null = null) {
  const { source, focusId } = dbRead({ workspaceId: WS, clientId: CL, page: [observation('obs-1', { severity: 'HIGH' })], focus: focus ? { id: focus } : null });
  return compiledAnswer(source, question, focusId, { workspaceId: WS, clientId: CL, requestId });
}
const expectation = (requestId: string, focus: string | null = null): AskExpectation => ({ requestId, workspaceId: WS, clientId: CL, sourceMode: 'db', focusObservationId: focus });
function controlledClock() { let t = 1000; return { now: () => t, advance: (ms: number) => { t += ms; } }; }

test('AskRequestV1: exact four keys, the question unchanged, fresh lowercase UUIDv4, the server accepts every body the browser builds', () => {
  for (const question of ['What needs attention?', '  leading and trailing  ', 'tab\there\nnew line\r\n', 'Почему это срочно?', '😀'.repeat(2000), '"quoted" \\ back']) {
    for (const observationId of [null, 'obs-1', 'x'.repeat(256), 'é'.repeat(256)]) {
      const requestId = randomUUID();
      const body = askBody({ clientId: CL, requestId, question, observationId });
      assert.ok(body !== null);
      const parsed = JSON.parse(body!);
      assert.deepEqual(Object.keys(parsed), ['contractVersion', 'requestId', 'question', 'observationId']);
      assert.deepEqual(askRequest(parsed), { requestId, question, observationId }, 'the accepted server semantics accept it unchanged');
      assert.ok(new TextEncoder().encode(body!).byteLength <= 16 * 1024);
    }
  }
  const ok = { clientId: CL, requestId: randomUUID(), question: 'What needs attention?', observationId: null };
  for (const bad of [{ requestId: randomUUID().toUpperCase() }, { requestId: 'req-0001-synthetic' }, { requestId: ((id: string) => `${id.slice(0, 14)}1${id.slice(15)}`)(randomUUID()) /* version digit 1, not 4 */ },
    { question: '' }, { question: '   \n' }, { question: 'a'.repeat(2001) }, { question: '😀'.repeat(2001) }, { question: 'nul\u0000' },
    { question: 'del\u007f' }, { question: 'bell\u0007' }, { question: 'lone \ud800 surrogate' }, { observationId: '' }, { observationId: 'x'.repeat(257) }]) {
    assert.equal(askBody({ ...ok, ...bad } as never), null, JSON.stringify(bad).slice(0, 60));
  }
  assert.equal(askPath('demo-gasta'), '/clients/demo-gasta/ask');
  assert.equal(askPath('a:b'), '/clients/a%3Ab/ask');
  for (const bad of ['../x', 'a/b', '', 'x'.repeat(129), 'a?b', '%2F']) assert.equal(askPath(bad), null, bad);
  assert.equal(operationPath({ kind: 'askCapability' }), '/ask/capabilities');
});

test('holder.ask: one same-origin POST with fixed options and bearer; malformed input or no credential sends nothing', async () => {
  const requestId = randomUUID();
  const { holder, calls } = holderWith(() => askResponse(answerFor('What needs attention?', requestId)));
  await holder.ask({ clientId: CL, requestId, question: 'What needs attention?', observationId: null }, never());
  const { path, init } = calls[0]!;
  assert.equal(path, '/clients/c-db/ask');
  assert.deepEqual([init.method, init.credentials, init.redirect, init.cache, init.mode, init.referrerPolicy], ['POST', 'omit', 'error', 'no-store', 'same-origin', 'no-referrer']);
  const headers = new Headers(init.headers);
  assert.deepEqual([headers.get('authorization'), headers.get('content-type'), headers.get('accept')], [`Bearer ${TOKEN}`, 'application/json', 'application/json']);
  assert.equal(String(init.body).includes(TOKEN), false);
  for (const bad of [{ clientId: '../audit' }, { requestId: 'nope' }, { question: '' }, { observationId: 'x'.repeat(257) }]) {
    await assert.rejects(holder.ask({ clientId: CL, requestId, question: 'q', observationId: null, ...bad }, never()));
  }
  holder.clear();
  await assert.rejects(holder.ask({ clientId: CL, requestId, question: 'q', observationId: null }, never()));
  assert.equal(calls.length, 1);
  const cap = holderWith(() => capabilityResponse());
  await cap.holder.get({ kind: 'askCapability' }, never());
  assert.deepEqual([cap.calls[0]!.path, cap.calls[0]!.init.method, cap.calls[0]!.init.body], ['/ask/capabilities', 'GET', undefined]);
});

test('capability: exact 200 is MOCK; 404 is status-only OFF (body never read); 401/403 status-only; other statuses keep the fixed AskErrorV1 code', async () => {
  assert.deepEqual(await fetchAskCapability(holderWith(() => capabilityResponse()).holder, never()), { ok: true, value: { kind: 'ok', value: 'mock' } });
  let pulls = 0; let cancelled = false;
  const off = new Response(new ReadableStream({ pull(c) { pulls += 1; c.enqueue(new TextEncoder().encode('{"x":1}')); }, cancel() { cancelled = true; } }), { status: 404 });
  assert.deepEqual(await fetchAskCapability(holderWith(() => off).holder, never()), { ok: true, value: { kind: 'error', status: 404, error: null } });
  assert.deepEqual([pulls <= 1, cancelled], [true, true], 'the OFF body is cancelled, never read');
  assert.deepEqual(await fetchAskCapability(holderWith(() => new Response('', { status: 401 })).holder, never()), { ok: false, code: 'UNAUTHORIZED' });
  assert.deepEqual(await fetchAskCapability(holderWith(() => askError('ASK_SCOPE_DENIED', 403)).holder, never()), { ok: false, code: 'FORBIDDEN' });
  const busy = randomUUID();
  assert.deepEqual(await fetchAskCapability(holderWith(() => askError('ASK_BUSY', 429, busy)).holder, never()),
    { ok: true, value: { kind: 'error', status: 429, error: { code: 'ASK_BUSY', correlationId: busy } } });
  assert.deepEqual(await fetchAskCapability(holderWith(() => new Response('SERVER-DETAIL-SENTINEL', { status: 500 })).holder, never()),
    { ok: true, value: { kind: 'error', status: 500, error: null } });
  const correlation = { 'x-atlas-correlation-id': randomUUID() };
  for (const response of [new Response(JSON.stringify({ contractVersion: 'AskCapabilityV1', mode: 'mock', questionMaxCodepoints: 2000 }), { status: 201, headers: askHeaders(randomUUID()) }),
    new Response('{"contractVersion":"AskCapabilityV1"}', { status: 200, headers: { 'content-type': 'text/plain', ...correlation } })]) {
    const result = await fetchAskCapability(holderWith(() => response).holder, never());
    assert.ok(!result.ok || result.value.kind === 'error', 'never MOCK');
  }
  assert.deepEqual(await fetchAskCapability(holderWith(() => new Response(JSON.stringify({ contractVersion: 'AskCapabilityV1', mode: 'mock', questionMaxCodepoints: 2000 }),
    { status: 200, headers: { 'content-type': 'application/json' } })).holder, never()), { ok: false, code: 'RESPONSE_INVALID' }, 'no correlation header');
});

test('question: 200 answer validated for the captured request; AskErrorV1 statuses; 201/partial/mismatched bodies are never an answer', async () => {
  const requestId = randomUUID();
  const answer = answerFor('Why is this urgent?', requestId, 'obs-1');
  const op = { clientId: CL, requestId, question: 'Why is this urgent?', observationId: 'obs-1' };
  const ok = await sendAskQuestion(holderWith(() => askResponse(answer)).holder, op, expectation(requestId, 'obs-1'), never());
  assert.ok(ok.ok && ok.value.kind === 'ok' && ok.value.value.status === 'ANSWER');
  assert.deepEqual(await sendAskQuestion(holderWith(() => askResponse(answer)).holder, op, expectation(randomUUID(), 'obs-1'), never()), { ok: false, code: 'RESPONSE_INVALID' });
  assert.deepEqual(await sendAskQuestion(holderWith(() => askResponse(answer, 201)).holder, op, expectation(requestId, 'obs-1'), never()),
    { ok: true, value: { kind: 'error', status: 201, error: null } }, 'only exactly 200 is success');
  for (const [code, status] of [['ASK_REQUEST_INVALID', 400], ['ASK_CONTEXT_UNAVAILABLE', 404], ['ASK_TOO_LARGE', 413], ['ASK_SCOPE_CHANGED', 409], ['ASK_BUSY', 429],
    ['ASK_PLANNER_INVALID', 503], ['ASK_AUDIT_FAILED', 503], ['ASK_DEADLINE', 504]] as const) {
    const id = randomUUID();
    assert.deepEqual(await sendAskQuestion(holderWith(() => askError(code, status, id)).holder, op, expectation(requestId, 'obs-1'), never()),
      { ok: true, value: { kind: 'error', status, error: { code, correlationId: id } } }, code);
  }
  assert.deepEqual(await sendAskQuestion(holderWith(() => askError('ASK_BUSY', 503)).holder, op, expectation(requestId, 'obs-1'), never()),
    { ok: true, value: { kind: 'error', status: 503, error: null } }, 'a code with the wrong status is not trusted');
  assert.deepEqual(await sendAskQuestion(holderWith(() => new Response(JSON.stringify({ message: 'Not Found', statusCode: 404 }), { status: 404, headers: { 'content-type': 'application/json' } })).holder,
    op, expectation(requestId, 'obs-1'), never()), { ok: true, value: { kind: 'error', status: 404, error: null } }, 'OFF route 404 for a question');
  for (const status of [401, 403]) {
    assert.deepEqual(await sendAskQuestion(holderWith(() => askError(status === 401 ? 'ASK_AUTHENTICATION_FAILED' : 'ASK_SCOPE_DENIED', status)).holder, op,
      expectation(requestId, 'obs-1'), never()), { ok: false, code: status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN' });
  }
  const text = JSON.stringify(answer);
  for (const [name, response] of [['truncated JSON', new Response(text.slice(0, -10), { headers: askHeaders(answer.correlationId) })],
    ['bad UTF-8', new Response(new Uint8Array([0x7b, 0xff, 0x7d]), { headers: askHeaders(answer.correlationId) })],
    ['text/html', new Response(text, { headers: { 'content-type': 'text/html', 'x-atlas-correlation-id': answer.correlationId } })]] as const) {
    assert.deepEqual(await sendAskQuestion(holderWith(() => response).holder, op, expectation(requestId, 'obs-1'), never()), { ok: false, code: 'RESPONSE_INVALID' }, name);
  }
});

test('256 KiB response cap (declared and streamed) and one original deadline incl. synchronous parse/validation; no phase reset', async () => {
  const requestId = randomUUID();
  const op = { clientId: CL, requestId, question: 'What needs attention?', observationId: null };
  const answer = answerFor('What needs attention?', requestId);
  const padded = JSON.stringify({ ...answer }).replace('"evidence":', `"pad":"${'x'.repeat(256 * 1024)}","evidence":`);
  assert.deepEqual(await sendAskQuestion(holderWith(() => new Response(padded, { headers: askHeaders(answer.correlationId) })).holder, op, expectation(requestId), never()),
    { ok: false, code: 'RESPONSE_TOO_LARGE' });
  let chunks = 0;
  const stream = new Response(new ReadableStream({ pull(c) { chunks += 1; c.enqueue(new Uint8Array(64 * 1024).fill(0x20)); if (chunks > 20) c.close(); } }), { headers: askHeaders(answer.correlationId) });
  assert.deepEqual(await sendAskQuestion(holderWith(() => stream).holder, op, expectation(requestId), never()), { ok: false, code: 'RESPONSE_TOO_LARGE' });
  assert.ok(chunks <= 6, 'reading stops once the cap is crossed');
  const exact = JSON.stringify(answer);
  assert.ok(exact.length < 256 * 1024);
  // Synchronous validation (here: reading the correlation header inside validateAnswer) that crosses the original budget.
  for (const [arrival, stall, expected] of [[9_990, 5, 'OK'], [9_990, 20, 'TIMEOUT'], [0, 10_000, 'TIMEOUT'], [10_000, 0, 'TIMEOUT']] as const) {
    const clock = controlledClock();
    const headers = askHeaders(answer.correlationId);
    const slow = { get: (name: string) => { if (name === 'x-atlas-correlation-id') clock.advance(stall); return headers.get(name); } };
    const response = { status: 200, redirected: false, headers: slow, body: new Response(exact).body } as unknown as Response;
    const { holder } = holderWith(() => { clock.advance(arrival); return response; });
    const result = await sendAskQuestion(holder, op, expectation(requestId), never(), { now: clock.now });
    assert.equal(result.ok ? 'OK' : result.code, expected, `${arrival}+${stall}`);
  }
  // A fetch that never settles and ignores abort: TIMEOUT from the one deadline; the caller's abort is NETWORK.
  const deaf = holderWith(() => new Promise<Response>(() => undefined)).holder;
  assert.deepEqual(await sendAskQuestion(deaf, op, expectation(requestId), never(), { deadlineMs: 30 }), { ok: false, code: 'TIMEOUT' });
  const abort = new AbortController();
  const aborted = sendAskQuestion(deaf, op, expectation(requestId), abort.signal);
  abort.abort();
  assert.deepEqual(await aborted, { ok: false, code: 'NETWORK' });
  // The body arrives in slices whose total crosses the budget: TIMEOUT, not a fresh budget per phase.
  const clock = controlledClock();
  const sliced = new Response(new ReadableStream({ pull(c) { clock.advance(4_000); c.enqueue(new TextEncoder().encode(' ')); } }), { headers: askHeaders(answer.correlationId) });
  assert.deepEqual(await sendAskQuestion(holderWith(() => { clock.advance(3_000); return sliced; }).holder, op, expectation(requestId), never(), { now: clock.now }),
    { ok: false, code: 'TIMEOUT' });
  // The request body is built inside the budget: a fetch that only returns after the expiry is TIMEOUT.
  const late = controlledClock();
  assert.deepEqual(await sendAskQuestion(holderWith(() => { late.advance(10_000); return askResponse(answer); }).holder, op, expectation(requestId), never(), { now: late.now }),
    { ok: false, code: 'TIMEOUT' });
});
