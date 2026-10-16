import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCredentialHolder } from '../apps/operator/src/credential.ts';
import type { FetchLike } from '../apps/operator/src/credential.ts';
import { executeValidated, getValidated } from '../apps/operator/src/transport.ts';
import { validateClients } from '../apps/operator/src/validate-clients.ts';

// S5-A credential holder and bounded transport (A3/A5/A6) with a recorded fake fetch. Browser behaviour over real
// network/DOM is covered by tests/ui; these isolate the exact request shape, caps and deadline semantics.
const TOKEN = 'synthetic-console-token-0123456789';

interface Call { path: string; init: RequestInit }
function recorder(respond: (call: Call) => Promise<Response> | Response) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (path, init) => { const call = { path, init }; calls.push(call); return respond(call); };
  return { calls, fetchImpl };
}
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, ...init });
const never = () => new AbortController().signal;

test('holder: no getter or serialization exposes the token; malformed input is refused without a request', async () => {
  const { calls, fetchImpl } = recorder(() => json([]));
  const holder = createCredentialHolder(fetchImpl);
  assert.ok(Object.isFrozen(holder));
  // ASK-REMOTE R-C adds exactly one closed operation, askRemote (the AskRequestV2 POST); deployment adds useSession (the edge
  // sign-in session, no token — tests/deploy-edge.test.ts); the surface stays exact.
  assert.deepEqual(Object.keys(holder).sort(), ['ask', 'askRemote', 'clear', 'connected', 'epoch', 'execute', 'get', 'replace', 'useSession']);
  for (const bad of [` ${TOKEN}`, `${TOKEN} `, `${TOKEN}\n`, 'short', `Bearer ${TOKEN}`, `${TOKEN}!`, '']) {
    assert.equal(holder.replace(bad), false); assert.equal(holder.connected(), false);
  }
  const before = holder.epoch();
  assert.equal(holder.replace(TOKEN), true);
  assert.ok(holder.epoch() > before);
  assert.ok(!JSON.stringify(holder).includes(TOKEN) && !String(holder).includes(TOKEN) && !Object.values(holder).some(v => String(v).includes(TOKEN)));
  await holder.get({ kind: 'clients' }, never());
  assert.equal(calls.length, 1);
  const { init, path } = calls[0]!;
  assert.equal(path, '/clients');
  assert.deepEqual([init.method, init.credentials, init.redirect, init.cache, init.mode, init.referrerPolicy], ['GET', 'omit', 'error', 'no-store', 'same-origin', 'no-referrer']);
  assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${TOKEN}`);
  assert.equal(init.body, undefined);
  const epoch = holder.epoch();
  holder.clear();
  assert.ok(holder.epoch() > epoch); assert.equal(holder.connected(), false);
  await assert.rejects(holder.get({ kind: 'clients' }, never()));
  assert.equal(holder.replace(TOKEN), true);
  await assert.rejects(holder.get({ kind: 'overview', clientId: '../audit' }, never()));
  assert.equal(calls.length, 1, 'no request without a credential or for a malformed ID');
});

test('transport maps statuses to fixed codes without reading or echoing error bodies', async () => {
  const cases: [Response, string][] = [
    [new Response('<h1>secret detail</h1>', { status: 401 }), 'UNAUTHORIZED'], [new Response('{}', { status: 403 }), 'FORBIDDEN'],
    [new Response('boom', { status: 500 }), 'HTTP_ERROR'], [new Response('', { status: 302, headers: { location: '/x' } }), 'HTTP_ERROR'],
    [new Response('[]', { status: 200, headers: { 'content-type': 'text/html' } }), 'RESPONSE_INVALID'],
    [new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }), 'RESPONSE_INVALID'],
    [new Response(new Uint8Array([0x5b, 0xff, 0x5d]), { status: 200, headers: { 'content-type': 'application/json' } }), 'RESPONSE_INVALID'],
    [json([{ id: 'bad id', name: 'x' }]), 'RESPONSE_INVALID'], [json([{ id: 'a', name: 'A' }]), 'OK']
  ];
  for (const [response, expected] of cases) {
    const holder = createCredentialHolder(async () => response);
    holder.replace(TOKEN);
    const result = await getValidated(holder, { kind: 'clients' }, never(), validateClients);
    assert.equal(result.ok ? 'OK' : result.code, expected);
    assert.ok(!JSON.stringify(result).includes('secret detail'));
  }
  const rejected = createCredentialHolder(async () => { throw new TypeError('redirect mode is error'); });
  rejected.replace(TOKEN);
  assert.deepEqual(await getValidated(rejected, { kind: 'clients' }, never(), validateClients), { ok: false, code: 'NETWORK' });
});

test('response cap: declared or streamed bodies over the cap are cancelled and RESPONSE_TOO_LARGE', async () => {
  const declared = createCredentialHolder(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json', 'content-length': '5000' } }));
  declared.replace(TOKEN);
  assert.deepEqual(await getValidated(declared, { kind: 'clients' }, never(), validateClients, { maxBytes: 4096 }), { ok: false, code: 'RESPONSE_TOO_LARGE' });
  let pulled = 0; let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(1024).fill(0x20)); },
    cancel() { cancelled = true; }
  });
  const streamed = createCredentialHolder(async () => new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } }));
  streamed.replace(TOKEN);
  assert.deepEqual(await getValidated(streamed, { kind: 'clients' }, never(), validateClients, { maxBytes: 4096 }), { ok: false, code: 'RESPONSE_TOO_LARGE' });
  assert.ok(cancelled, 'the stream is cancelled at the cap'); assert.ok(pulled <= 8, `read stopped early (${pulled} chunks)`);
  const exact = createCredentialHolder(async () => new Response(`[${' '.repeat(4094)}]`, { status: 200, headers: { 'content-type': 'application/json' } }));
  exact.replace(TOKEN);
  assert.deepEqual(await getValidated(exact, { kind: 'clients' }, never(), validateClients, { maxBytes: 4096 }), { ok: true, value: [] });
});

test('one original deadline covers headers and body, and settles even when fetch ignores its signal', async () => {
  // Headers arrive in time, the body never completes: TIMEOUT from the original deadline, not a fresh one per phase.
  const slowBody = createCredentialHolder(async () => new Response(new ReadableStream({ start() { /* never enqueues */ } }),
    { status: 200, headers: { 'content-type': 'application/json' } }));
  slowBody.replace(TOKEN);
  const started = Date.now();
  assert.deepEqual(await getValidated(slowBody, { kind: 'clients' }, never(), validateClients, { deadlineMs: 150 }), { ok: false, code: 'TIMEOUT' });
  assert.ok(Date.now() - started < 1000);
  // A fetch that ignores AbortSignal entirely: the transport still settles locally (caller abort → NETWORK, deadline → TIMEOUT).
  let calls = 0;
  const deaf = createCredentialHolder(() => { calls += 1; return new Promise<Response>(() => undefined); });
  deaf.replace(TOKEN);
  const abort = new AbortController();
  const pending = getValidated(deaf, { kind: 'clients' }, abort.signal, validateClients, { deadlineMs: 5000 });
  abort.abort();
  assert.deepEqual(await pending, { ok: false, code: 'NETWORK' });
  assert.deepEqual(await getValidated(deaf, { kind: 'clients' }, never(), validateClients, { deadlineMs: 50 }), { ok: false, code: 'TIMEOUT' });
  assert.equal(calls, 2, 'no automatic retry');
});

// RC1 review R1: the original deadline is one absolute expiry on a monotonic clock. A controlled clock advanced by the
// stubs themselves makes each boundary deterministic: no real 10 s waits and no reliance on timer dispatch order.
function controlledClock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}
const bodyResponse = (body: BodyInit) => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
const LIST = [{ id: 'a', name: 'A' }];

test('R1: synchronous validation crossing the original default 10 s budget is TIMEOUT, never data', async () => {
  for (const [arrivalMs, stallMs, expected] of [[9_998, 30, 'TIMEOUT'], [9_998, 1, 'OK'], [9_999, 1, 'TIMEOUT'], [0, 9_999, 'OK'], [0, 10_000, 'TIMEOUT']] as const) {
    const clock = controlledClock();
    const holder = createCredentialHolder(async () => { clock.advance(arrivalMs); return json(LIST); });
    holder.replace(TOKEN);
    let validated = 0;
    const slowValidator = (value: unknown) => { validated += 1; clock.advance(stallMs); return validateClients(value); };
    const result = await getValidated(holder, { kind: 'clients' }, never(), slowValidator, { now: clock.now });
    assert.equal(result.ok ? 'OK' : result.code, expected, `arrival ${arrivalMs} + stall ${stallMs}`);
    assert.equal(validated, 1);
  }
});

test('R1: headers, body chunks, microtask stalls and decode share one budget that is never reset', async () => {
  // Headers at 6 + body at 6 of a 10 ms budget: each phase alone fits, together they do not.
  const clock = controlledClock();
  const split = createCredentialHolder(async () => {
    clock.advance(6);
    return bodyResponse(new ReadableStream({ pull(controller) { clock.advance(6); controller.enqueue(new TextEncoder().encode('[]')); controller.close(); } }));
  });
  split.replace(TOKEN);
  assert.deepEqual(await getValidated(split, { kind: 'clients' }, never(), validateClients, { deadlineMs: 10, now: clock.now }), { ok: false, code: 'TIMEOUT' });
  // Headers already past the expiry: TIMEOUT before any status mapping or body read.
  for (const status of [200, 401, 403, 500]) {
    const late = controlledClock();
    const holder = createCredentialHolder(async () => { late.advance(10); return new Response('[]', { status, headers: { 'content-type': 'application/json' } }); });
    holder.replace(TOKEN);
    assert.deepEqual(await getValidated(holder, { kind: 'clients' }, never(), validateClients, { deadlineMs: 10, now: late.now }), { ok: false, code: 'TIMEOUT' }, `late ${status}`);
  }
  // A stall in a queued microtask between body completion and decode/parse (no timer can run there).
  const micro = controlledClock();
  const stalled = createCredentialHolder(async () => bodyResponse(new ReadableStream({
    pull(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(LIST))); controller.close(); queueMicrotask(() => micro.advance(50)); }
  })));
  stalled.replace(TOKEN);
  assert.deepEqual(await getValidated(stalled, { kind: 'clients' }, never(), validateClients, { deadlineMs: 10, now: micro.now }), { ok: false, code: 'TIMEOUT' });
  // Within budget the same shapes succeed, and an invalid body still reports its own code before the expiry.
  const fine = controlledClock();
  const ok = createCredentialHolder(async () => { fine.advance(4); return json(LIST); });
  ok.replace(TOKEN);
  assert.deepEqual(await getValidated(ok, { kind: 'clients' }, never(), validateClients, { deadlineMs: 10, now: fine.now }), { ok: true, value: LIST });
  const bad = createCredentialHolder(async () => json([{ id: 'bad id', name: 'x' }]));
  bad.replace(TOKEN);
  assert.deepEqual(await getValidated(bad, { kind: 'clients' }, never(), validateClients, { deadlineMs: 10, now: controlledClock().now }), { ok: false, code: 'RESPONSE_INVALID' });
});

test('R1: a validation failure detected past the expiry is TIMEOUT; status, abort and no-retry semantics unchanged', async () => {
  const clock = controlledClock();
  const invalid = createCredentialHolder(async () => json([{ id: 'bad id', name: 'x' }]));
  invalid.replace(TOKEN);
  const failing = (value: unknown) => { clock.advance(20); return validateClients(value); };
  assert.deepEqual(await getValidated(invalid, { kind: 'clients' }, never(), failing, { deadlineMs: 10, now: clock.now }), { ok: false, code: 'TIMEOUT' });
  // Before the expiry: fixed status codes exactly as before.
  for (const [status, code] of [[401, 'UNAUTHORIZED'], [403, 'FORBIDDEN'], [502, 'HTTP_ERROR']] as const) {
    const holder = createCredentialHolder(async () => new Response('detail', { status }));
    holder.replace(TOKEN);
    assert.deepEqual(await getValidated(holder, { kind: 'clients' }, never(), validateClients, { deadlineMs: 10, now: controlledClock().now }), { ok: false, code });
  }
  // Caller abort before the expiry still settles NETWORK locally with exactly one request (no retry).
  let calls = 0;
  const deaf = createCredentialHolder(() => { calls += 1; return new Promise<Response>(() => undefined); });
  deaf.replace(TOKEN);
  const abort = new AbortController();
  const pending = getValidated(deaf, { kind: 'clients' }, abort.signal, validateClients, { deadlineMs: 10_000, now: controlledClock().now });
  abort.abort();
  assert.deepEqual(await pending, { ok: false, code: 'NETWORK' });
  assert.equal(calls, 1);
});

test('R1: the timer still settles blocked work and the request signal is aborted once the operation ends', async () => {
  let seen: AbortSignal | undefined;
  const blocked = createCredentialHolder((_path, init) => { seen = init.signal ?? undefined; return new Promise<Response>(() => undefined); });
  blocked.replace(TOKEN);
  const started = Date.now();
  assert.deepEqual(await getValidated(blocked, { kind: 'clients' }, never(), validateClients, { deadlineMs: 40 }), { ok: false, code: 'TIMEOUT' });
  assert.ok(Date.now() - started < 1000);
  assert.equal(seen?.aborted, true, 'the browser request is aborted at the deadline');
  const done = createCredentialHolder(async (_path, init) => { seen = init.signal ?? undefined; return json(LIST); });
  done.replace(TOKEN);
  assert.equal((await getValidated(done, { kind: 'clients' }, never(), validateClients)).ok, true);
  assert.equal(seen?.aborted, true, 'local cleanup after success releases the request');
});

// S5-B evidence POST: one closed operation through the same holder, guards, deadline and cap; success is exactly HTTP 201.
const EVIDENCE = { tool: 'atera.alert.list', clientId: 'c-db', connectionId: 'conn-atera', requestId: 'req-0001-abcd' } as const;
const created = (body: unknown, init: ResponseInit = {}) => json(body, { status: 201, ...init });
const VIEW = { source: 'atera', resourceType: 'alert', connectionId: 'conn-atera', status: 'OK', asOf: null, lastSuccessAt: null, safeErrorCode: null, truncated: false, items: [] };
const passThrough = (value: unknown) => value;

test('evidence POST: exact same-origin request with the private bearer; no caller URL, method, header or tool surface', async () => {
  const { calls, fetchImpl } = recorder(() => created(VIEW));
  const holder = createCredentialHolder(fetchImpl);
  await assert.rejects(holder.execute(EVIDENCE, never()), 'no credential, no request');
  holder.replace(TOKEN);
  const result = await executeValidated(holder, EVIDENCE, never(), passThrough);
  assert.deepEqual(result, { ok: true, value: VIEW });
  assert.equal(calls.length, 1);
  const { path, init } = calls[0]!;
  assert.equal(path, '/tools/execute');
  assert.deepEqual([init.method, init.credentials, init.redirect, init.cache, init.mode, init.referrerPolicy], ['POST', 'omit', 'error', 'no-store', 'same-origin', 'no-referrer']);
  const sent = new Headers(init.headers);
  assert.deepEqual([...sent.keys()].sort(), ['accept', 'authorization', 'content-type']);
  assert.deepEqual([sent.get('content-type'), sent.get('authorization')], ['application/json', `Bearer ${TOKEN}`]);
  assert.equal(init.body, '{"version":"1","clientId":"c-db","tool":"atera.alert.list","parameters":{"connectionId":"conn-atera"},"requestId":"req-0001-abcd"}');
  await assert.rejects(holder.execute({ ...EVIDENCE, clientId: '../audit' }, never()));
  await assert.rejects(holder.execute({ ...EVIDENCE, tool: 'atera.ticket.create' } as never, never()));
  assert.equal(calls.length, 1, 'a malformed operation is never sent');
});

test('operation-specific success: GET only 200, evidence POST only 201; other 2xx, 401, 403 and errors keep their fixed codes', async () => {
  for (const [status, expected] of [[201, 'OK'], [200, 'HTTP_ERROR'], [202, 'HTTP_ERROR'], [204, 'HTTP_ERROR'], [401, 'UNAUTHORIZED'], [403, 'FORBIDDEN'],
    [400, 'HTTP_ERROR'], [409, 'HTTP_ERROR'], [502, 'HTTP_ERROR']] as const) {
    const holder = createCredentialHolder(async () => new Response(status === 204 ? null : JSON.stringify(VIEW), { status, headers: { 'content-type': 'application/json' } }));
    holder.replace(TOKEN);
    const result = await executeValidated(holder, EVIDENCE, never(), passThrough);
    assert.equal(result.ok ? 'OK' : result.code, expected, `POST ${status}`);
  }
  // Focused GET regression: the accepted S5-A GET contract stays exactly HTTP 200.
  for (const [status, expected] of [[200, 'OK'], [201, 'HTTP_ERROR'], [203, 'HTTP_ERROR']] as const) {
    const holder = createCredentialHolder(async () => json([], { status }));
    holder.replace(TOKEN);
    const result = await getValidated(holder, { kind: 'clients' }, never(), validateClients);
    assert.equal(result.ok ? 'OK' : result.code, expected, `GET ${status}`);
  }
  const html = createCredentialHolder(async () => new Response('<b>x</b>', { status: 201, headers: { 'content-type': 'text/html' } }));
  html.replace(TOKEN);
  assert.deepEqual(await executeValidated(html, EVIDENCE, never(), passThrough), { ok: false, code: 'RESPONSE_INVALID' });
});

test('evidence POST shares the original deadline (incl. synchronous validation) and the incremental cap; no retry', async () => {
  const clock = controlledClock();
  let calls = 0;
  const late = createCredentialHolder(async () => { calls += 1; clock.advance(9_000); return created(VIEW); });
  late.replace(TOKEN);
  const slow = (value: unknown) => { clock.advance(1_000); return value; };
  assert.deepEqual(await executeValidated(late, EVIDENCE, never(), slow, { now: clock.now }), { ok: false, code: 'TIMEOUT' });
  assert.equal(calls, 1);
  const big = createCredentialHolder(async () => new Response(new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(1024).fill(0x20)); } }),
    { status: 201, headers: { 'content-type': 'application/json' } }));
  big.replace(TOKEN);
  assert.deepEqual(await executeValidated(big, EVIDENCE, never(), passThrough, { maxBytes: 4096 }), { ok: false, code: 'RESPONSE_TOO_LARGE' });
  const deaf = createCredentialHolder(() => new Promise<Response>(() => undefined));
  deaf.replace(TOKEN);
  assert.deepEqual(await executeValidated(deaf, EVIDENCE, never(), passThrough, { deadlineMs: 30 }), { ok: false, code: 'TIMEOUT' });
});
