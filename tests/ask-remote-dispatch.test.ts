import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDirectTransport, requestOptions, transportAgent } from '../packages/ask/remote/transport.ts';
import type { RequestFn, Transport, TransportResult } from '../packages/ask/remote/transport.ts';
import { envSecretResolver } from '../packages/ask/remote/secret.ts';
import { preparePayload, preparedBytes } from '../packages/ask/remote/payload.ts';
import { admitEgress, bindTaskDeadline, capabilityAttempt, dispatchIntent, proveNoDispatch, takeSettlement } from '../packages/ask/remote/dispatch.ts';
import type { DispatchCapability } from '../packages/ask/remote/dispatch.ts';

// ASK-REMOTE R-B (in-process, offline): the direct transport's exact options and capped reads through an in-process stand-in
// for https.request (the real Node TLS socket is not exercised offline: QUALIFIED), the dedicated secret resolver and the
// private dispatch capability (mint only on a fulfilled commit, task-bound, one-use, proven no-dispatch, settlement inputs).

const KEY = 'sk-synthetic-ask-remote-key-0123456789abcdef';
const tick = () => new Promise(resolve => setImmediate(resolve));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** In-process ClientRequest stand-in: records options/body; `script` drives the response. destroy() closes like Node. */
function fakeRequestFn(script: (req: FakeRequest, respond: (status: number, type: string | undefined, chunks: Buffer[]) => void) => void, ignoreDestroy = false) {
  const calls: { options: https.RequestOptions; req: FakeRequest }[] = [];
  const fn: RequestFn = (options, callback) => {
    const req = new FakeRequest(ignoreDestroy);
    calls.push({ options, req });
    req.onEnd = () => script(req, (status, type, chunks) => {
      const res = new PassThrough() as PassThrough & { statusCode: number; headers: Record<string, string | undefined> };
      res.statusCode = status; res.headers = { 'content-type': type };
      req.res = res;
      res.on('close', () => setImmediate(() => req.close()));
      callback(res as never);
      (async () => { for (const c of chunks) { if (res.destroyed) return; res.write(c); await tick(); } if (!res.destroyed) res.end(); })();
    });
    return req as never;
  };
  return { fn, calls };
}
class FakeRequest extends EventEmitter {
  body: Buffer[] = []; destroyed = false; closed = false; res: PassThrough | null = null; onEnd: () => void = () => undefined;
  readonly ignoreDestroy: boolean;
  constructor(ignoreDestroy: boolean) { super(); this.ignoreDestroy = ignoreDestroy; }
  end(bytes: Buffer) { this.body.push(Buffer.from(bytes)); this.onEnd(); }
  destroy() {
    if (this.ignoreDestroy || this.destroyed) return;
    this.destroyed = true;
    if (this.res && !this.res.destroyed) this.res.destroy();
    setImmediate(() => { this.emit('error', new Error('destroyed')); this.close(); });
  }
  close() { if (!this.closed) { this.closed = true; this.emit('close'); } }
}

test('direct transport: exact fixed EU HTTPS options and headers, dedicated non-proxy agent, one call, no retry, body as prepared', async () => {
  const bytes = preparedBytes(preparePayload({ question: 'What needs attention?', hasFocus: false }))!;
  const { fn, calls } = fakeRequestFn((_req, respond) => respond(200, 'application/json', [Buffer.from('{"ok":true}')]));
  const call = createDirectTransport(fn)(bytes, KEY, new AbortController().signal);
  const result = await call.result;
  await call.settled;
  assert.equal(calls.length, 1);
  const o = calls[0]!.options;
  assert.deepEqual(Object.keys(o).sort(), ['agent', 'headers', 'host', 'method', 'path', 'port', 'protocol', 'servername']);
  assert.deepEqual([o.protocol, o.host, o.servername, o.port, o.path, o.method], ['https:', 'eu.api.openai.com', 'eu.api.openai.com', 443, '/v1/chat/completions', 'POST']);
  assert.deepEqual(o.headers, { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Accept: 'application/json', 'Content-Length': String(bytes.length), Connection: 'close' });
  const agent = o.agent as https.Agent & { options: Record<string, unknown>; keepAlive: boolean };
  assert.ok(agent instanceof https.Agent); assert.notEqual(agent, https.globalAgent);
  assert.equal(agent.keepAlive, false); assert.equal(agent.options.proxyEnv, undefined); assert.equal(agent.options.rejectUnauthorized, undefined);
  for (const forbidden of ['ca', 'rejectUnauthorized', 'lookup', 'family', 'localAddress', 'socketPath', 'checkServerIdentity', 'timeout', 'signal']) {
    assert.equal(Object.hasOwn(o, forbidden), false, forbidden);
  }
  assert.ok(Buffer.concat(calls[0]!.req.body).equals(bytes));
  assert.deepEqual(result, { kind: 'RESPONSE', status: 200, contentType: 'application/json', body: Buffer.from('{"ok":true}') });
  assert.deepEqual(requestOptions(bytes, KEY, agent).headers, o.headers);
});

test('direct transport: Node env-proxy support enabled in a child process still leaves the dedicated agent without a proxy', () => {
  const module = fileURLToPath(new URL('../packages/ask/remote/transport.ts', import.meta.url));
  const script = `import('${module}').then(m => { const sym = o => Object.getOwnPropertySymbols(o).filter(s => /proxy/i.test(String(s.description)) && o[s] != null).length;
    const https = require('node:https'); console.log(JSON.stringify({ global: sym(https.globalAgent), dedicated: sym(m.transportAgent()) })); })`;
  const out = spawnSync(process.execPath, ['--experimental-strip-types', '-e', script], { encoding: 'utf8',
    env: { PATH: process.env.PATH, NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9' } });
  assert.equal(out.status, 0, out.stderr.slice(0, 500));
  assert.deepEqual(JSON.parse(out.stdout.trim()), { global: 1, dedicated: 0 }, 'the global agent would proxy; the transport agent does not');
  assert.equal((transportAgent() as unknown as { keepAlive: boolean }).keepAlive, false);
});

test('direct transport: 64 KiB incremental cap, abort/error/throw → ERROR, physical settlement only after close, no retry', async () => {
  const bytes = Buffer.from('{}');
  const exact = fakeRequestFn((_r, respond) => respond(200, 'application/json', [Buffer.alloc(32 * 1024, 0x20), Buffer.alloc(32 * 1024, 0x20)]));
  const ok = await createDirectTransport(exact.fn)(bytes, KEY, new AbortController().signal).result;
  assert.equal(ok.kind, 'RESPONSE'); assert.equal((ok as { body: Buffer }).body.length, 64 * 1024);
  const over = fakeRequestFn((_r, respond) => respond(200, 'application/json', [Buffer.alloc(64 * 1024, 0x20), Buffer.alloc(1, 0x20), Buffer.alloc(1024 * 1024)]));
  const overCall = createDirectTransport(over.fn)(bytes, KEY, new AbortController().signal);
  assert.deepEqual(await overCall.result, { kind: 'OVERFLOW' });
  await overCall.settled;
  assert.equal(over.calls[0]!.req.destroyed, true);
  const hang = fakeRequestFn(() => undefined);
  const controller = new AbortController();
  const hangCall = createDirectTransport(hang.fn)(bytes, KEY, controller.signal);
  let settled = false; void hangCall.settled.then(() => { settled = true; });
  await sleep(20); assert.equal(settled, false);
  controller.abort();
  assert.deepEqual(await hangCall.result, { kind: 'ERROR' }); await hangCall.settled;
  assert.equal(hang.calls.length, 1); assert.equal(hang.calls[0]!.req.destroyed, true);
  const failing = fakeRequestFn(req => setImmediate(() => { req.emit('error', new Error('ECONNRESET')); req.close(); }));
  assert.deepEqual(await createDirectTransport(failing.fn)(bytes, KEY, new AbortController().signal).result, { kind: 'ERROR' });
  assert.equal(failing.calls.length, 1, 'never retried');
  const thrower: RequestFn = () => { throw new Error('boom'); };
  const thrown = createDirectTransport(thrower)(bytes, KEY, new AbortController().signal);
  assert.deepEqual(await thrown.result, { kind: 'ERROR' }); await thrown.settled;
  const ignoring = fakeRequestFn(() => undefined, true);
  const stubborn = new AbortController();
  const ignored = createDirectTransport(ignoring.fn)(bytes, KEY, stubborn.signal);
  stubborn.abort();
  assert.deepEqual(await ignored.result, { kind: 'ERROR' });
  let physical = false; void ignored.settled.then(() => { physical = true; });
  await sleep(30); assert.equal(physical, false, 'an ignored abort keeps the physical call unsettled');
});

test('dedicated secret resolver: env://ATLAS_ASK_REMOTE_* only; never OPENAI_API_KEY, vault, fixture or a malformed value', () => {
  const env = { ATLAS_ASK_REMOTE_OPENAI_KEY: KEY, OPENAI_API_KEY: KEY, ATLAS_ASK_REMOTE_BAD: 'has space value 0123456789', ATLAS_ASK_REMOTE_SHORT: 'short',
    ATLAS_ASK_REMOTE_NL: `${KEY}\nX-Injected: 1` };
  const resolve = envSecretResolver(env);
  assert.equal(resolve('env://ATLAS_ASK_REMOTE_OPENAI_KEY'), KEY);
  for (const ref of ['env://OPENAI_API_KEY', 'env://OPENAI_DECISIONS_MODEL', 'vault://ask/key', 'fixture://ask-remote/synthetic-key-ref', 'env://ATLAS_ASK_REMOTE_MISSING',
    'env://ATLAS_ASK_REMOTE_BAD', 'env://ATLAS_ASK_REMOTE_SHORT', 'env://ATLAS_ASK_REMOTE_NL', 'env://atlas_ask_remote_openai_key', 'ATLAS_ASK_REMOTE_OPENAI_KEY',
    'env://ATLAS_ASK_REMOTE_OPENAI_KEY/', '']) assert.equal(resolve(ref), null, ref);
});

const ENVELOPE = (patch: (e: any) => void = () => undefined) => {
  const e: any = { object: 'chat.completion', model: 'gpt-6-luna', service_tier: 'default', usage: { prompt_tokens: 400, completion_tokens: 10, total_tokens: 410 },
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"version":"AskRemoteIntentV1","intent":"WHY_URGENT"}' } }] };
  patch(e); return Buffer.from(JSON.stringify(e));
};
const attempt = { workspaceId: 'ws', clientId: 'client', attemptId: '0b8f2a8e-6f1d-4c7e-9a3b-1c2d3e4f5a6b', correlationId: '1b8f2a8e-6f1d-4c7e-9a3b-1c2d3e4f5a6b',
  admissionId: '2b8f2a8e-6f1d-4c7e-9a3b-1c2d3e4f5a6b', policyVersion: '7' };
/** A task bound to a generous original deadline (the R1 floor itself is exercised in ask-remote-floor-gate.test.ts). */
const ROOMY = { remaining: () => 8000 };
async function mint(task = new AbortController().signal): Promise<DispatchCapability> {
  bindTaskDeadline(task, ROOMY);
  return admitEgress(async () => ({ attempt, secretRef: 'env://ATLAS_ASK_REMOTE_OPENAI_KEY' }), preparePayload({ question: 'why?', hasFocus: true }), task);
}
function scripted(result: () => Promise<TransportResult> | TransportResult) {
  const seen: { bytes: Buffer; key: string; signal: AbortSignal }[] = [];
  const transport: Transport = (bytes, key, signal) => {
    seen.push({ bytes, key, signal });
    const r = Promise.resolve().then(result);
    return { result: r, settled: r.then(() => undefined, () => undefined) };
  };
  return { seams: { resolveSecret: (ref: string) => ref === 'env://ATLAS_ASK_REMOTE_OPENAI_KEY' ? KEY : null, transport }, seen };
}
const response = (body: Buffer, status = 200): TransportResult => ({ kind: 'RESPONSE', status, contentType: 'application/json', body });

test('dispatch capability: minted only by a fulfilled commit; opaque; task-bound; one use; forged/cast/replayed objects carry nothing', async () => {
  const held: Promise<unknown>[] = []; const hold = (w: Promise<unknown>) => { held.push(w); };
  const bound = (signal = new AbortController().signal) => { bindTaskDeadline(signal, ROOMY); return signal; };
  await assert.rejects(admitEgress(async () => ({ attempt, secretRef: 'x' }), preparePayload({ question: 'q', hasFocus: false }), new AbortController().signal),
    /TASK_UNBOUND/, 'a task without its original deadline binding is never minted');
  await assert.rejects(admitEgress(async () => { throw new Error('ROLLBACK'); }, preparePayload({ question: 'q', hasFocus: false }), bound()));
  await assert.rejects(admitEgress(async () => ({ attempt: { ...attempt, attemptId: 'not-a-uuid' }, secretRef: 'x' }), preparePayload({ question: 'q', hasFocus: false }),
    bound()), /COMMIT_INVALID/);
  const { seams, seen } = scripted(() => response(ENVELOPE()));
  const task = new AbortController();
  const capability = await mint(task.signal);
  assert.deepEqual(Object.keys(capability), ['kind']); assert.ok(Object.isFrozen(capability));
  const forged = { kind: 'AskRemoteDispatch' } as DispatchCapability;
  for (const fake of [forged, Object.assign(Object.create(Object.getPrototypeOf(capability)), capability), JSON.parse(JSON.stringify(capability)), structuredClone(capability)]) {
    await assert.rejects(dispatchIntent(seams, fake, task.signal, 2000, hold), /DISPATCH_REFUSED/);
    assert.equal(proveNoDispatch(fake), false); assert.equal(takeSettlement(fake), null); assert.equal(capabilityAttempt(fake), null);
  }
  await assert.rejects(dispatchIntent(seams, capability, new AbortController().signal, 2000, hold), /DISPATCH_REFUSED/, 'another task');
  assert.equal(seen.length, 0);
  const verdict = await dispatchIntent(seams, capability, task.signal, 2000, hold);
  assert.deepEqual(verdict, { kind: 'INTENT', intent: 'WHY_URGENT', usage: { promptTokens: 400, completionTokens: 10 } });
  assert.equal(seen.length, 1); assert.equal(seen[0]!.key, KEY);
  assert.equal(seen[0]!.bytes.toString(), preparedBytes(preparePayload({ question: 'why?', hasFocus: true }))!.toString());
  await assert.rejects(dispatchIntent(seams, capability, task.signal, 2000, hold), /DISPATCH_REFUSED/, 'one use');
  assert.equal(proveNoDispatch(capability), false, 'consumed: no-dispatch can never be claimed');
  assert.deepEqual(takeSettlement(capability), { attempt, outcome: 'USAGE_VERIFIED', usage: { promptTokens: 400, completionTokens: 10 } });
  assert.equal(takeSettlement(capability), null, 'settlement inputs are taken once');
  assert.equal(seen.length, 1);
});

test('dispatch capability: proven no-dispatch revokes; unresolvable key and exhausted phase leave it unconsumed; nothing sent', async () => {
  const hold = () => undefined;
  const { seams, seen } = scripted(() => response(ENVELOPE()));
  const task = new AbortController();
  const a = await mint(task.signal);
  assert.equal(proveNoDispatch(a), true); assert.equal(proveNoDispatch(a), false);
  await assert.rejects(dispatchIntent(seams, a, task.signal, 2000, hold), /DISPATCH_REFUSED/);
  assert.deepEqual(takeSettlement(a), { attempt, outcome: 'NO_DISPATCH', usage: null });
  const b = await mint(task.signal);
  assert.deepEqual(await dispatchIntent({ ...seams, resolveSecret: () => null }, b, task.signal, 2000, hold), { kind: 'NOT_SENT', reason: 'KEY' });
  assert.deepEqual(await dispatchIntent({ ...seams, resolveSecret: () => { throw new Error('vault down'); } }, b, task.signal, 2000, hold), { kind: 'NOT_SENT', reason: 'KEY' });
  assert.deepEqual(takeSettlement(b), { attempt, outcome: 'NO_DISPATCH', usage: null }, 'still MINTED: proven in-process no-dispatch');
  const c = await mint(task.signal);
  // The provider phase starts BEFORE key resolution: a resolver outlasting the phase leaves the capability unconsumed.
  const slow = { ...seams, resolveSecret: (ref: string) => { const end = Date.now() + 25; while (Date.now() < end) { /* busy */ } return seams.resolveSecret(ref); } };
  assert.deepEqual(await dispatchIntent(slow, c, task.signal, 10, hold), { kind: 'NOT_SENT', reason: 'FLOOR' });
  assert.equal(proveNoDispatch(c), true);
  const d = await mint(task.signal);
  task.abort();
  assert.deepEqual(await dispatchIntent(seams, d, task.signal, 2000, hold), { kind: 'NOT_SENT', reason: 'TERMINAL' }, 'terminal task: no dispatch');
  assert.equal(proveNoDispatch(d), true);
  assert.equal(seen.length, 0);
});

test('dispatch: faults map to fixed settlement outcomes; late/terminal results are discarded, never parsed; ignored abort stays held', async () => {
  const cases: [Buffer | TransportResult, string, string][] = [
    [ENVELOPE(e => { e.choices[0].message.refusal = 'no'; }), 'INVALID', 'USAGE_VERIFIED'], [ENVELOPE(e => { e.model = 'gpt-6-luna-2026-01-01'; }), 'MODEL_MISMATCH', 'MODEL_MISMATCH'],
    [ENVELOPE(e => { e.usage.total_tokens = 1; }), 'USAGE_INVALID', 'USAGE_INVALID'], [response(ENVELOPE(), 401), 'UPSTREAM', 'UPSTREAM_REJECTED'],
    [response(ENVELOPE(), 429), 'UPSTREAM', 'UPSTREAM_REJECTED'], [{ kind: 'OVERFLOW' }, 'OVERFLOW', 'DELIVERY_UNKNOWN'], [{ kind: 'ERROR' }, 'UNKNOWN', 'DELIVERY_UNKNOWN'],
    [Buffer.from('{"model":"gpt-6-luna","model":"gpt-6-luna"}'), 'MALFORMED', 'DELIVERY_UNKNOWN']];
  for (const [result, kind, outcome] of cases) {
    const { seams } = scripted(() => Buffer.isBuffer(result) ? response(result) : result);
    const task = new AbortController(); const cap = await mint(task.signal);
    assert.equal((await dispatchIntent(seams, cap, task.signal, 2000, () => undefined)).kind, kind);
    assert.equal(takeSettlement(cap)!.outcome, outcome, kind);
  }
  let parsed = false;
  const lateBody = () => { parsed = true; return ENVELOPE(); };
  const late = scripted(async () => { await sleep(60); return { kind: 'RESPONSE', status: 200, contentType: 'application/json', get body() { return lateBody(); } } as TransportResult; });
  const t1 = new AbortController(); const c1 = await mint(t1.signal);
  assert.deepEqual(await dispatchIntent(late.seams, c1, t1.signal, 20, () => undefined), { kind: 'UNKNOWN' });
  await sleep(80); assert.equal(parsed, false, 'a late success is never parsed');
  assert.equal(takeSettlement(c1)!.outcome, 'DELIVERY_UNKNOWN');
  assert.equal(late.seen[0]!.signal.aborted, true, 'the provider phase end aborts the transport');
  const t2 = new AbortController(); const c2 = await mint(t2.signal);
  const pending = dispatchIntent(late.seams, c2, t2.signal, 2000, () => undefined);
  setTimeout(() => t2.abort(), 10);
  assert.deepEqual(await pending, { kind: 'UNKNOWN' }, 'terminal during the provider phase');
  assert.equal(takeSettlement(c2)!.outcome, 'DELIVERY_UNKNOWN');
  const held: Promise<unknown>[] = [];
  const never: Transport = () => ({ result: new Promise(() => undefined), settled: new Promise(() => undefined) });
  const t3 = new AbortController(); const c3 = await mint(t3.signal);
  assert.deepEqual(await dispatchIntent({ resolveSecret: () => KEY, transport: never }, c3, t3.signal, 15, w => { held.push(w); }), { kind: 'UNKNOWN' });
  let released = false; void Promise.all(held).then(() => { released = true; });
  await sleep(30); assert.equal(held.length, 1); assert.equal(released, false, 'a never-settling transport keeps its owner hold');
  // A terminal task ends the provider phase at once even when the transport ignores the abort (the call stays held).
  const t4 = new AbortController(); const c4 = await mint(t4.signal);
  const started = Date.now();
  const stopped = dispatchIntent({ resolveSecret: () => KEY, transport: never }, c4, t4.signal, 2000, () => undefined);
  setTimeout(() => t4.abort(), 10);
  assert.deepEqual(await stopped, { kind: 'UNKNOWN' });
  assert.ok(Date.now() - started < 500, 'stopped by the terminal state, not by the 2 s phase end');
  assert.equal(takeSettlement(c4)!.outcome, 'DELIVERY_UNKNOWN');
});
