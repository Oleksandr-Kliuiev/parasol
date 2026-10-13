import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { AtlasError } from '../packages/core/contracts.ts';
import { fetchTransport, getJson } from '../connectors/http.ts';
import { ClientCredentialsTokenProvider } from '../connectors/microsoft365/auth.ts';
import { directoryUrl } from '../connectors/microsoft365/contract.ts';
import { fetchGraphTransport, graphGet } from '../connectors/microsoft365/http.ts';
import { installFetchGuard } from '../packages/ops/pilot/guard.ts';
import { createRecorder } from '../packages/ops/pilot/recorder.ts';
import { CANARY, loopback, loopbackDispatch, memorySink } from './support/pilot-support.ts';

// Native fetch against LOCAL loopback servers (synthetic; no external network): with the pilot's explicit redirect:'error',
// a same-origin or cross-origin redirect yields exactly one request at the source and zero at the target, for Stage 1,
// Graph and the token authority alike. The global fetch guard refuses any unwrapped call with zero network requests.
const nativeFetch = globalThis.fetch;
const failsWith = (code: string) => (error: unknown) => error instanceof AtlasError && error.code === code;
const target = await loopback((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"value":[]}'); });
const source = await loopback((req, res) => {
  if (req.url?.startsWith('/landing')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
  const cross = req.url?.includes('cross') || req.url?.includes('organizations/7002') || req.url?.includes('/token') || req.url?.includes('/devices');
  res.writeHead(req.method === 'POST' ? 307 : 302, { location: cross ? `${target.origin}/stolen?x=${CANARY.nextLinkMarker}` : `/landing?x=${CANARY.nextLinkMarker}` });
  res.end();
});
after(async () => { await source.close(); await target.close(); });
const reset = () => { source.hits.length = 0; target.hits.length = 0; };

test('Stage 1 through the recorder: same-origin and cross-origin redirects are refused by native fetch — 1 source request, 0 target requests', async () => {
  for (const [url, name] of [['https://api.huntress.io/v1/organizations/7001', 'same-origin'], ['https://api.huntress.io/v1/organizations/7002', 'cross-origin']]) {
    reset();
    const mem = memorySink();
    const loop = loopbackDispatch(nativeFetch, source.origin);
    const recorder = createRecorder({ sink: mem.sink, dispatch: loop.dispatch });
    await assert.rejects(getJson(recorder.stage1, new URL(url!), { Authorization: 'Basic synthetic' }), failsWith('UPSTREAM_UNAVAILABLE'), name);
    assert.deepEqual(source.hits.map(h => h.path), [new URL(url!).pathname], `${name}: exactly one source request`);
    assert.equal(target.hits.length, 0, `${name}: zero target requests`);
    assert.equal(loop.inits[0]!.redirect, 'error');
    assert.deepEqual(mem.receipts.map(r => r.kind === 'completion' ? `${r.endpointClass}:${r.httpStatus}:${r.outcome}` : r.kind),
      ['dispatch', 'huntress.organization:null:DISPATCH_FAILED'], 'no invented 3xx status or redirect diagnosis');
    assert.ok(!mem.lines.join('').includes(CANARY.nextLinkMarker) && !mem.lines.join('').includes('127.0.0.1'), 'no Location or URL retained');
  }
});

test('control: the accepted Stage 1 init WITHOUT the pilot restriction would follow the redirect (why the pilot never delegates to fetchTransport)', async () => {
  reset();
  const response = await nativeFetch(`${source.origin}/v1/organizations/7002`, { method: 'GET', headers: {}, signal: AbortSignal.timeout(5000) });
  await response.body?.cancel();
  assert.deepEqual([source.hits.length, target.hits.length], [1, 1], 'a following fetch reaches the redirect target');
});

test('Graph and the token authority through the recorder: redirects refused, 1 source request and 0 target requests each', async () => {
  reset();
  const loop = loopbackDispatch(nativeFetch, source.origin);
  const mem = memorySink();
  const recorder = createRecorder({ sink: mem.sink, dispatch: loop.dispatch });
  await assert.rejects(graphGet(recorder.graph, 'users', directoryUrl('users'), CANARY.token, Date.now), failsWith('M365_UPSTREAM_UNAVAILABLE'));
  await assert.rejects(graphGet(recorder.graph, 'devices', directoryUrl('devices'), CANARY.token, Date.now), failsWith('M365_UPSTREAM_UNAVAILABLE'));
  await assert.rejects(new ClientCredentialsTokenProvider(recorder.auth).acquire(CANARY.tenant, { applicationId: CANARY.app, clientSecret: CANARY.secret }),
    failsWith('M365_UPSTREAM_UNAVAILABLE'));
  assert.deepEqual(source.hits.map(h => `${h.method} ${h.path.split('?')[0]}`), ['GET /v1.0/users', 'GET /v1.0/devices', `POST /${CANARY.tenant}/oauth2/v2.0/token`]);
  assert.deepEqual([source.hits.filter(h => h.path.startsWith('/landing')).length, target.hits.length], [0, 0]);
  assert.deepEqual(mem.receipts.filter(r => r.kind === 'completion').map(r => r.kind === 'completion' && `${r.endpointClass}:${r.httpStatus}:${r.outcome}`),
    ['graph.users:null:DISPATCH_FAILED', 'graph.devices:null:DISPATCH_FAILED', 'm365.token:null:DISPATCH_FAILED']);
  const all = mem.lines.join('');
  for (const canary of [CANARY.tenant, CANARY.secret, CANARY.token, CANARY.nextLinkMarker, '127.0.0.1']) assert.ok(!all.includes(canary), canary);
});

test('global fetch guard: an unwrapped fetch (including the accepted production transports) makes zero requests, halts the run, and restore() is exact', async () => {
  reset();
  const mem = memorySink();
  let recorderRef: ReturnType<typeof createRecorder> | null = null;
  const guard = installFetchGuard(() => recorderRef?.halt('UNRECORDED_FETCH'));
  try {
    recorderRef = createRecorder({ sink: mem.sink, dispatch: loopbackDispatch(nativeFetch, target.origin).dispatch });
    assert.notEqual(globalThis.fetch, nativeFetch);
    await assert.rejects(fetch(`${target.origin}/direct`), failsWith('PILOT_UNRECORDED_FETCH_REFUSED'));
    await assert.rejects(fetchTransport(`${target.origin}/stage1`, { method: 'GET', headers: {}, signal: AbortSignal.timeout(1000) }), failsWith('PILOT_UNRECORDED_FETCH_REFUSED'));
    await assert.rejects(fetchGraphTransport(directoryUrl('users'), { method: 'GET', headers: {}, redirect: 'error', signal: AbortSignal.timeout(1000) }),
      failsWith('PILOT_UNRECORDED_FETCH_REFUSED'));
    assert.equal(target.hits.length, 0, 'zero network requests');
    const snap = recorderRef.snapshot();
    assert.deepEqual([snap.complete, snap.refusals.unrecordedFetch, snap.incompleteReasons], [false, 3, ['UNRECORDED_FETCH']]);
    await assert.rejects(graphGet(recorderRef.graph, 'users', directoryUrl('users'), CANARY.token, Date.now), failsWith('M365_UPSTREAM_UNAVAILABLE'));
    assert.equal(target.hits.length, 0, 'after a bypass attempt even recorded transports refuse: the run cannot become a success');
    assert.deepEqual(mem.receipts.map(r => r.kind === 'refusal' && r.reason), ['UNRECORDED_FETCH', 'UNRECORDED_FETCH', 'UNRECORDED_FETCH']);
    assert.ok(!Object.values(guard).includes(nativeFetch), 'the native function itself is never handed out');
  } finally { guard.restore(); }
  assert.equal(globalThis.fetch, nativeFetch, 'restored');
  guard.restore();
  assert.equal(globalThis.fetch, nativeFetch, 'idempotent');
});
