import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCredentialHolder } from '../apps/operator/src/credential.ts';
import type { FetchLike } from '../apps/operator/src/credential.ts';
import { askBody, askRemoteBody } from '../apps/operator/src/operations.ts';
import type { AskRemoteOperation } from '../apps/operator/src/operations.ts';
import { fetchAskCapability, sendAskQuestion, sendAskRemoteQuestion } from '../apps/operator/src/ask-transport.ts';
import type { AskExpectation } from '../apps/operator/src/validate-ask.ts';
import { askRemoteRequest } from '../packages/ask/remote/input.ts';
import { askRequest } from '../packages/ask/input.ts';
import { observation, WS } from './support/operator-journey.ts';
import { askError, askHeaders, askResponse, dbRead } from './support/operator-ask.ts';
import { ADMISSION, BIG_VERSION, acknowledgement, remoteCapabilityBody, remoteCapabilityResponse, remoteCompiled } from './support/operator-ask-remote.ts';

// ASK-REMOTE R-C fixed operation and bounded transport: the exact five-key AskRequestV2 built only from a closed operation
// carrying the captured acknowledgement (never defaulted), accepted unchanged by the R-B server parser; the same holder
// closure/options; capability V2 vs 404 OFF vs 503 NOT_ADMITTED; the whole AskAnswerV2; remote error codes; and the SAME
// 256 KiB cap, fatal UTF-8 and one original 10 s budget. The fake fetch ignores AbortSignal unless stated otherwise.
const TOKEN = 'synthetic-console-token-0123456789';
const CL = 'c-db';
interface Call { path: string; init: RequestInit }
function holderWith(respond: (call: Call) => Promise<Response> | Response) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (path, init) => { const call = { path, init }; calls.push(call); return respond(call); };
  const holder = createCredentialHolder(fetchImpl);
  holder.replace(TOKEN);
  return { holder, calls };
}
const never = () => new AbortController().signal;
const op = (patch: Partial<AskRemoteOperation> = {}): AskRemoteOperation =>
  ({ clientId: CL, requestId: randomUUID(), question: 'What needs attention?', observationId: null, acknowledgement: acknowledgement() as AskRemoteOperation['acknowledgement'], ...patch });
const expectation = (requestId: string, focus: string | null = null): AskExpectation => ({ requestId, workspaceId: WS, clientId: CL, sourceMode: 'db', focusObservationId: focus });
function answerFor(requestId: string, focus: string | null = null, intent: 'SUMMARY' | 'WHY_URGENT' = 'SUMMARY') {
  const { source, focusId } = dbRead({ workspaceId: WS, clientId: CL, page: [observation('obs-1', { severity: 'HIGH' })], focus: focus ? { id: focus } : null });
  return remoteCompiled(source, intent, focusId, { workspaceId: WS, clientId: CL, requestId });
}
function controlledClock() { let t = 1000; return { now: () => t, advance: (ms: number) => { t += ms; } }; }

test('AskRequestV2: exact five keys and four-key acknowledgement, question unchanged; the R-B server parser accepts every body built', () => {
  for (const question of ['What needs attention?', '  leading and trailing  ', 'tab\there\nnew line\r\n', 'Почему это срочно?', '😀'.repeat(2000), '"quoted" \\ back']) {
    for (const observationId of [null, 'obs-1', 'x'.repeat(256)]) {
      for (const policyVersion of ['1', BIG_VERSION, '9223372036854775807']) {
        const operation = op({ question, observationId, acknowledgement: acknowledgement(ADMISSION, policyVersion) as AskRemoteOperation['acknowledgement'] });
        const body = askRemoteBody(operation);
        assert.ok(body !== null);
        const parsed = JSON.parse(body!);
        assert.deepEqual(Object.keys(parsed), ['contractVersion', 'requestId', 'question', 'observationId', 'acknowledgement']);
        assert.deepEqual(Object.keys(parsed.acknowledgement), ['contractVersion', 'admissionId', 'policyVersion', 'questionDataClass']);
        assert.equal(parsed.contractVersion, 'AskRequestV2');
        assert.equal(typeof parsed.acknowledgement.policyVersion, 'string');
        assert.deepEqual(askRemoteRequest(parsed), { requestId: operation.requestId, question, observationId, acknowledgement: { admissionId: ADMISSION, policyVersion } });
        assert.ok(new TextEncoder().encode(body!).byteLength <= 16 * 1024);
      }
    }
  }
  const ack = acknowledgement();
  for (const bad of [{ acknowledgement: undefined }, { acknowledgement: null }, { acknowledgement: {} }, { acknowledgement: { ...ack, extra: 1 } },
    { acknowledgement: { ...ack, contractVersion: 'AskRemoteDisclosureV2' } }, { acknowledgement: { ...ack, questionDataClass: 'CUSTOMER' } },
    { acknowledgement: { ...ack, admissionId: ADMISSION.toUpperCase() } }, { acknowledgement: { ...ack, policyVersion: 1 } },
    { acknowledgement: { ...ack, policyVersion: '0' } }, { acknowledgement: { ...ack, policyVersion: '9223372036854775808' } },
    { acknowledgement: (({ questionDataClass: _q, ...rest }) => rest)(ack) }, { acknowledgement: [ack] },
    { requestId: randomUUID().toUpperCase() }, { question: '' }, { question: 'a'.repeat(2001) }, { question: 'nul\u0000' }, { observationId: '' }, { observationId: 'x'.repeat(257) }]) {
    assert.equal(askRemoteBody(op(bad as never)), null, JSON.stringify(bad).slice(0, 80));
  }
  // The V1 builder is unchanged: four keys, never an acknowledgement, and the server's V1 parser accepts it as before.
  const v1 = JSON.parse(askBody({ clientId: CL, requestId: randomUUID(), question: 'q', observationId: null })!);
  assert.deepEqual(Object.keys(v1), ['contractVersion', 'requestId', 'question', 'observationId']);
  assert.deepEqual(askRequest(v1), { requestId: v1.requestId, question: 'q', observationId: null });
  assert.throws(() => askRemoteRequest(v1), 'a V1 body is refused by the remote server parser');
});

test('holder.askRemote: one same-origin POST with fixed options and bearer; no acknowledgement, a bad one or no credential sends nothing', async () => {
  const { holder, calls } = holderWith(() => new Response('{}'));
  const operation = op();
  await holder.askRemote(operation, never());
  assert.equal(calls.length, 1);
  const { path, init } = calls[0]!;
  assert.equal(path, `/clients/${CL}/ask`);
  assert.deepEqual([init.method, init.credentials, init.redirect, init.cache, init.mode, init.referrerPolicy], ['POST', 'omit', 'error', 'no-store', 'same-origin', 'no-referrer']);
  assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${TOKEN}`);
  assert.equal(init.body, askRemoteBody(operation));
  for (const bad of [{ acknowledgement: undefined }, { acknowledgement: { ...acknowledgement(), policyVersion: 'x' } }, { clientId: '../audit' }]) {
    await assert.rejects(holder.askRemote(op(bad as never), never()));
  }
  // The V1 operation cannot carry an acknowledgement onto the wire, and askRemote never sends a V1 body.
  await holder.ask({ clientId: CL, requestId: randomUUID(), question: 'q', observationId: null }, never());
  assert.equal(JSON.parse(calls[1]!.init.body as string).contractVersion, 'AskRequestV1');
  assert.equal(calls.length, 2);
  holder.clear();
  await assert.rejects(holder.askRemote(op(), never()));
  assert.equal(calls.length, 2);
});

test('capability: exact V2 is REMOTE with its tuple; 503 ASK_REMOTE_NOT_ADMITTED is a fixed error, never OFF; malformed V2 is RESPONSE_INVALID', async () => {
  assert.deepEqual(await fetchAskCapability(holderWith(() => remoteCapabilityResponse()).holder, never()),
    { ok: true, value: { kind: 'ok', value: { mode: 'remote', disclosure: { admissionId: ADMISSION, policyVersion: BIG_VERSION } } } });
  const id = randomUUID();
  assert.deepEqual(await fetchAskCapability(holderWith(() => askError('ASK_REMOTE_NOT_ADMITTED', 503, id)).holder, never()),
    { ok: true, value: { kind: 'error', status: 503, error: { code: 'ASK_REMOTE_NOT_ADMITTED', correlationId: id } } });
  assert.deepEqual(await fetchAskCapability(holderWith(() => new Response('', { status: 404 })).holder, never()), { ok: true, value: { kind: 'error', status: 404, error: null } });
  const body = remoteCapabilityBody() as any;
  body.disclosure.reserveMicroUsd = 1;
  assert.deepEqual(await fetchAskCapability(holderWith(() => askResponse(body)).holder, never()), { ok: false, code: 'RESPONSE_INVALID' });
  const mixed = { ...remoteCapabilityBody(), contractVersion: 'AskCapabilityV1' };
  assert.deepEqual(await fetchAskCapability(holderWith(() => askResponse(mixed)).holder, never()), { ok: false, code: 'RESPONSE_INVALID' }, 'V1 version with V2 body');
});

test('remote question: exact V2 answer for the captured request; V1 answer, remote errors and upstream-class 503 are never success or auth', async () => {
  const requestId = randomUUID();
  const answer = answerFor(requestId, 'obs-1', 'WHY_URGENT');
  const operation = op({ requestId, question: 'Why is this urgent?', observationId: 'obs-1' });
  const ok = await sendAskRemoteQuestion(holderWith(() => askResponse(answer)).holder, operation, expectation(requestId, 'obs-1'), never());
  assert.ok(ok.ok && ok.value.kind === 'ok' && ok.value.value.mode === 'remote' && ok.value.value.status === 'ANSWER');
  assert.deepEqual(await sendAskRemoteQuestion(holderWith(() => askResponse(answer)).holder, operation, expectation(randomUUID(), 'obs-1'), never()),
    { ok: false, code: 'RESPONSE_INVALID' }, 'another request');
  const v1 = { ...answer, contractVersion: 'AskAnswerV1', mode: 'mock' } as any;
  delete v1.provenance;
  assert.deepEqual(await sendAskRemoteQuestion(holderWith(() => askResponse(v1)).holder, operation, expectation(requestId, 'obs-1'), never()), { ok: false, code: 'RESPONSE_INVALID' });
  assert.deepEqual(await sendAskQuestion(holderWith(() => askResponse(answer)).holder, operation, expectation(requestId, 'obs-1'), never()), { ok: false, code: 'RESPONSE_INVALID' },
    'a MOCK exchange never accepts a V2 answer');
  for (const [code, status] of [['ASK_REMOTE_NOT_ADMITTED', 503], ['ASK_REMOTE_POLICY_CHANGED', 409], ['ASK_REMOTE_BUDGET', 429], ['ASK_REMOTE_UNAVAILABLE', 503],
    ['ASK_REMOTE_INVALID', 503], ['ASK_REMOTE_MODEL_MISMATCH', 503], ['ASK_REMOTE_USAGE_INVALID', 503], ['ASK_DEADLINE', 504], ['ASK_REQUEST_INVALID', 400]] as const) {
    const id = randomUUID();
    assert.deepEqual(await sendAskRemoteQuestion(holderWith(() => askError(code, status, id)).holder, operation, expectation(requestId, 'obs-1'), never()),
      { ok: true, value: { kind: 'error', status, error: { code, correlationId: id } } }, code);
  }
  assert.deepEqual(await sendAskQuestion(holderWith(() => askError('ASK_REMOTE_UNAVAILABLE', 503)).holder, operation, expectation(requestId, 'obs-1'), never()),
    { ok: true, value: { kind: 'error', status: 503, error: null } }, 'MOCK exchange: a remote code is not trusted');
  for (const status of [401, 403]) {
    assert.deepEqual(await sendAskRemoteQuestion(holderWith(() => askError(status === 401 ? 'ASK_AUTHENTICATION_FAILED' : 'ASK_SCOPE_DENIED', status)).holder, operation,
      expectation(requestId, 'obs-1'), never()), { ok: false, code: status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN' }, 'actual browser 401/403 stay status-only');
  }
  const text = JSON.stringify(answer);
  for (const [name, response] of [['truncated JSON', new Response(text.slice(0, -10), { headers: askHeaders(answer.correlationId) })],
    ['bad UTF-8', new Response(new Uint8Array([0x7b, 0xff, 0x7d]), { headers: askHeaders(answer.correlationId) })],
    ['text/html', new Response(text, { headers: { 'content-type': 'text/html', 'x-atlas-correlation-id': answer.correlationId } })]] as const) {
    assert.deepEqual(await sendAskRemoteQuestion(holderWith(() => response).holder, operation, expectation(requestId, 'obs-1'), never()), { ok: false, code: 'RESPONSE_INVALID' }, name);
  }
  // No acknowledgement: nothing reaches fetch; the outcome is a local NETWORK refusal, never a V1 send.
  const empty = holderWith(() => askResponse(answer));
  assert.deepEqual(await sendAskRemoteQuestion(empty.holder, op({ acknowledgement: undefined } as never), expectation(requestId), never()), { ok: false, code: 'NETWORK' });
  assert.equal(empty.calls.length, 0);
});

test('remote: 256 KiB cap (declared and streamed) and the one original 10 s deadline incl. synchronous validation', async () => {
  const requestId = randomUUID();
  const operation = op({ requestId });
  const answer = answerFor(requestId);
  const padded = JSON.stringify(answer).replace('"evidence":', `"pad":"${'x'.repeat(256 * 1024)}","evidence":`);
  assert.deepEqual(await sendAskRemoteQuestion(holderWith(() => new Response(padded, { headers: askHeaders(answer.correlationId) })).holder, operation, expectation(requestId), never()),
    { ok: false, code: 'RESPONSE_TOO_LARGE' });
  let chunks = 0;
  const stream = new Response(new ReadableStream({ pull(c) { chunks += 1; c.enqueue(new Uint8Array(64 * 1024).fill(0x20)); if (chunks > 20) c.close(); } }), { headers: askHeaders(answer.correlationId) });
  assert.deepEqual(await sendAskRemoteQuestion(holderWith(() => stream).holder, operation, expectation(requestId), never()), { ok: false, code: 'RESPONSE_TOO_LARGE' });
  assert.ok(chunks <= 6, 'reading stops once the cap is crossed');
  const exact = JSON.stringify(answer);
  for (const [arrival, stall, expected] of [[9_990, 5, 'OK'], [9_990, 20, 'TIMEOUT'], [0, 10_000, 'TIMEOUT'], [10_000, 0, 'TIMEOUT']] as const) {
    const clock = controlledClock();
    const headers = askHeaders(answer.correlationId);
    const slow = { get: (name: string) => { if (name === 'x-atlas-correlation-id') clock.advance(stall); return headers.get(name); } };
    const response = { status: 200, redirected: false, headers: slow, body: new Response(exact).body } as unknown as Response;
    const { holder } = holderWith(() => { clock.advance(arrival); return response; });
    const result = await sendAskRemoteQuestion(holder, operation, expectation(requestId), never(), { now: clock.now });
    assert.equal(result.ok ? 'OK' : result.code, expected, `${arrival}+${stall}`);
  }
  const deaf = holderWith(() => new Promise<Response>(() => undefined)).holder;
  assert.deepEqual(await sendAskRemoteQuestion(deaf, operation, expectation(requestId), never(), { deadlineMs: 30 }), { ok: false, code: 'TIMEOUT' });
  const late = controlledClock();
  assert.deepEqual(await sendAskRemoteQuestion(holderWith(() => { late.advance(10_000); return askResponse(answer); }).holder, operation, expectation(requestId), never(), { now: late.now }),
    { ok: false, code: 'TIMEOUT' });
});
