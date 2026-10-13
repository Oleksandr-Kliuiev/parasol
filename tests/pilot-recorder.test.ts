import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { AtlasError } from '../packages/core/contracts.ts';
import { getJson } from '../connectors/http.ts';
import { ClientCredentialsTokenProvider } from '../connectors/microsoft365/auth.ts';
import { directoryUrl, organizationUrl, signInsUrl, tokenEndpoint } from '../connectors/microsoft365/contract.ts';
import { graphGet, nextLinkOf } from '../connectors/microsoft365/http.ts';
import { classifyDispatch } from '../packages/ops/pilot/classify.ts';
import { openFileSink, receiptLine } from '../packages/ops/pilot/receipts.ts';
import type { Receipt } from '../packages/ops/pilot/receipts.ts';
import { createRecorder } from '../packages/ops/pilot/recorder.ts';
import { CANARY, jsonResponse, memorySink, scriptedDispatch, tempDir } from './support/pilot-support.ts';

// S2-LIVE recorder (operational brief RC5 §L4): in-memory classification before dispatch, durable receipts before/after each
// call, fail-closed halting, unchanged production method/headers/body/signal and Response, no retry. Synthetic dispatch only.
const failsWith = (code: string) => (error: unknown) => error instanceof AtlasError && error.code === code;
const G = 'https://graph.microsoft.com/v1.0';

test('classification admits exactly the fixed production origins, paths and methods; the class is fixed vocabulary', () => {
  const ok: [Parameters<typeof classifyDispatch>, string][] = [
    [['auth', tokenEndpoint(CANARY.tenant), 'POST'], 'm365.token'],
    [['graph', organizationUrl(), 'GET'], 'graph.organization'],
    [['graph', directoryUrl('users'), 'GET'], 'graph.users'],
    [['graph', `${directoryUrl('devices')}&$skiptoken=${CANARY.nextLinkMarker}`, 'GET'], 'graph.devices'],
    [['graph', signInsUrl(new Date('2026-10-08T00:00:00Z'), new Date('2026-10-08T01:00:00Z')), 'GET'], 'graph.signIns'],
    [['stage1', 'https://app.atera.com/api/v3/customers/5001', 'GET'], 'atera.customer'],
    [['stage1', 'https://app.atera.com/api/v3/tickets?customerId=5001&ticketStatus=Open&page=1&itemsInPage=50', 'GET'], 'atera.tickets'],
    [['stage1', 'https://app.atera.com/api/v3/agents/customer/5001?page=2&itemsInPage=50', 'GET'], 'atera.agents'],
    [['stage1', 'https://api.huntress.io/v1/organizations/7001', 'GET'], 'huntress.organization'],
    [['stage1', 'https://api.huntress.io/v1/incident_reports?organization_id=7001&limit=100&status=sent&page_token=abc', 'GET'], 'huntress.incidents'],
    [['stage1', 'https://api.huntress.io/v1/agents?organization_id=7001&limit=100', 'GET'], 'huntress.agents'],
  ];
  for (const [args, cls] of ok) assert.equal(classifyDispatch(...args).endpointClass, cls, String(args[1]));
  const destination: [Parameters<typeof classifyDispatch>[0], string][] = [
    ['graph', 'https://user:pw@graph.microsoft.com/v1.0/users?$top=1'], ['graph', 'https://graph.microsoft.com:443/v1.0/users?$top=1'],
    ['graph', 'https://graph.microsoft.com/v1.0/users?$top=1#frag'], ['graph', 'http://graph.microsoft.com/v1.0/users?$top=1'],
    ['graph', 'https://graph.microsoft.com/beta/users?$top=1'], ['graph', 'https://graph.microsoft.com/v1.0/groups?$top=1'],
    ['graph', 'https://graph.microsoft.com/v1.0/users'], ['graph', 'https://GRAPH.microsoft.com/v1.0/users?$top=1'],
    ['graph', 'https://api.openai.com/v1/responses?x=1'], ['graph', `${G}/users/../groups?$top=1`], ['graph', `${G}/users?$top=1 `],
    ['auth', `https://login.microsoftonline.com/${CANARY.tenant}/oauth2/v2.0/token?x=1`], ['auth', 'https://login.microsoftonline.com/common/oauth2/v2.0/token'],
    ['auth', `https://login.microsoftonline.us/${CANARY.tenant}/oauth2/v2.0/token`], ['auth', `https://login.microsoftonline.com:8443/${CANARY.tenant}/oauth2/v2.0/token`],
    ['stage1', 'https://app.atera.com/api/v3/alerts'], ['stage1', 'https://app.atera.com/api/v3/tickets?page=1'],
    ['stage1', 'https://app.atera.com/api/v3/tickets?customerId=5001&customerId=6001'], ['stage1', 'https://app.atera.com/api/v3/customers/5001?x=1'],
    ['stage1', 'https://api.huntress.io/v1/agents?limit=100'], ['stage1', 'https://api.huntress.io/v1/organizations/7001\\..'],
    ['stage1', 'https://evil.example/v1/agents?organization_id=7001'], ['stage1', 'https://api.huntress.io.evil.example/v1/agents?organization_id=7001'],
    ['stage1', 'https://127.0.0.1/v1/agents?organization_id=7001'], ['stage1', `${G}/users?$top=1`],
  ];
  for (const [kind, url] of destination) assert.throws(() => classifyDispatch(kind, url, kind === 'auth' ? 'POST' : 'GET'), failsWith('PILOT_DESTINATION_REFUSED'), url);
  for (const [kind, method] of [['graph', 'POST'], ['graph', 'DELETE'], ['auth', 'GET'], ['stage1', 'POST'], ['stage1', 'PUT'], ['stage1', undefined]] as const) {
    assert.throws(() => classifyDispatch(kind, kind === 'auth' ? tokenEndpoint(CANARY.tenant) : 'https://api.huntress.io/v1/organizations/7001', method),
      failsWith('PILOT_METHOD_REFUSED'), `${kind} ${method}`);
  }
});

test('an unknown destination or method is refused BEFORE dispatch, receipted without the URL, and halts every later call', async () => {
  const mem = memorySink();
  const fake = scriptedDispatch(() => jsonResponse(200, {}));
  const recorder = createRecorder({ sink: mem.sink, dispatch: fake.dispatch });
  const signal = AbortSignal.timeout(1000);
  await assert.rejects(recorder.graph(`https://graph.microsoft.com/v1.0/groups?$filter=${CANARY.upn}`, { method: 'GET', headers: {}, redirect: 'error', signal }),
    failsWith('PILOT_DESTINATION_REFUSED'));
  await assert.rejects(recorder.stage1('https://api.huntress.io/v1/organizations/7001', { method: 'POST' as 'GET', headers: {}, signal }), failsWith('PILOT_RECORDER_HALTED'));
  assert.equal(fake.calls.length, 0, 'zero dispatch');
  const second = createRecorder({ sink: memorySink().sink, dispatch: fake.dispatch });
  await assert.rejects(second.stage1('https://api.huntress.io/v1/organizations/7001', { method: 'POST' as 'GET', headers: {}, signal }), failsWith('PILOT_METHOD_REFUSED'));
  await assert.rejects(second.graph(organizationUrl(), { method: 'GET', headers: {}, redirect: 'follow' as 'error', signal }), failsWith('PILOT_RECORDER_HALTED'));
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(second.snapshot().refusals, { destination: 0, method: 1, unrecordedFetch: 0, callback: 0 });
  const third = createRecorder({ sink: memorySink().sink, dispatch: fake.dispatch });
  await assert.rejects(third.graph(organizationUrl(), { method: 'GET', headers: {}, redirect: 'follow' as 'error', signal }), failsWith('PILOT_DESTINATION_REFUSED'));
  assert.equal(fake.calls.length, 0, 'a Graph init that would follow redirects is refused');
  assert.deepEqual(mem.receipts.map(r => [r.kind, (r as { reason?: string }).reason]), [['refusal', 'DESTINATION_REFUSED']]);
  assert.ok(!mem.lines.join('').includes(CANARY.upn) && !mem.lines.join('').includes('groups'));
  const snap = recorder.snapshot();
  assert.deepEqual([snap.complete, snap.dispatches, snap.incompleteReasons], [false, 0, ['DESTINATION_REFUSED']]);
});

test('pre-dispatch receipt failure: zero dispatch, PILOT_RECORDER_FAILED, run incomplete and halted', async () => {
  const mem = memorySink(); mem.failWhen(r => r.kind === 'dispatch');
  const fake = scriptedDispatch(() => jsonResponse(200, { value: [] }));
  const recorder = createRecorder({ sink: mem.sink, dispatch: fake.dispatch });
  await assert.rejects(graphGet(recorder.graph, 'users', directoryUrl('users'), CANARY.token, Date.now), failsWith('M365_UPSTREAM_UNAVAILABLE'),
    'the accepted Graph boundary maps the refusal to its own safe code');
  mem.failWhen(null);
  await assert.rejects(getJson(recorder.stage1, new URL('https://api.huntress.io/v1/organizations/7001'), {}), failsWith('UPSTREAM_UNAVAILABLE'));
  assert.equal(fake.calls.length, 0);
  assert.deepEqual([recorder.snapshot().complete, recorder.snapshot().incompleteReasons, mem.receipts.length], [false, ['PRE_DISPATCH_RECORD_FAILED'], 0]);
});

test('completion receipt failure after an actual call: the Response is returned untouched, the run is incomplete, later calls make zero dispatches', async () => {
  const mem = memorySink(); mem.failWhen(r => r.kind === 'completion');
  const body = { value: [{ id: CANARY.tenant }] };
  const fake = scriptedDispatch(() => jsonResponse(200, body));
  const recorder = createRecorder({ sink: mem.sink, dispatch: fake.dispatch });
  const response = await recorder.graph(organizationUrl(), { method: 'GET', headers: { Authorization: `Bearer ${CANARY.token}` }, redirect: 'error', signal: AbortSignal.timeout(1000) });
  assert.equal(response.bodyUsed, false);
  assert.deepEqual(await response.json(), body, 'the accepted service still reads the body itself');
  await assert.rejects(recorder.graph(directoryUrl('users'), { method: 'GET', headers: {}, redirect: 'error', signal: AbortSignal.timeout(1000) }),
    failsWith('PILOT_RECORDER_HALTED'));
  assert.equal(fake.calls.length, 1);
  const snap = recorder.snapshot();
  assert.deepEqual([snap.complete, snap.incompleteReasons, snap.dispatches, snap.completions, snap.pending], [false, ['COMPLETION_RECORD_FAILED'], 1, 0, 1]);
  assert.deepEqual(mem.receipts.map(r => r.kind), ['dispatch']);
});

test('thrown dispatch and timeout: one call, null status with a fixed outcome, the original error reaches the accepted service mapping', async () => {
  const mem = memorySink();
  const thrown = new TypeError(`fetch failed: ${CANARY.errorBody} https://graph.microsoft.com/v1.0/users?x=${CANARY.nextLinkMarker}`);
  let n = 0;
  const recorder = createRecorder({ sink: mem.sink, dispatch: async () => {
    n++;
    if (n === 1) throw thrown;
    throw Object.assign(new Error(CANARY.errorBody), { name: 'TimeoutError' });
  } });
  await assert.rejects(graphGet(recorder.graph, 'users', directoryUrl('users'), CANARY.token, Date.now), failsWith('M365_UPSTREAM_UNAVAILABLE'));
  await assert.rejects(getJson(recorder.stage1, new URL('https://app.atera.com/api/v3/customers/5001'), { Authorization: `Bearer ${CANARY.token}` }),
    failsWith('UPSTREAM_TIMEOUT'), 'the TimeoutError name is preserved for the accepted Stage 1 mapping');
  assert.equal(n, 2, 'exactly one dispatch per request, never retried by the recorder');
  const completions = mem.receipts.filter(r => r.kind === 'completion').map(r => r.kind === 'completion' && [r.endpointClass, r.httpStatus, r.outcome]);
  assert.deepEqual(completions, [['graph.users', null, 'DISPATCH_FAILED'], ['atera.customer', null, 'DISPATCH_TIMEOUT']]);
  assert.equal(recorder.snapshot().complete, true, 'a thrown upstream call is a recorded outcome, not a recording failure');
  const all = mem.lines.join('');
  for (const canary of [CANARY.errorBody, CANARY.nextLinkMarker, CANARY.token, 'fetch failed', 'https:']) assert.ok(!all.includes(canary), canary);
});

test('production composition is preserved: Stage 1 gets the accepted GET init plus redirect:error; Graph/auth inits and Responses pass unchanged', async () => {
  const mem = memorySink();
  const responses: Response[] = [];
  const fake = scriptedDispatch(url => {
    const r = url.pathname.endsWith('/token') ? jsonResponse(200, { token_type: 'Bearer', access_token: CANARY.token, expires_in: 3600 })
      : url.pathname === '/v1.0/users' ? jsonResponse(200, { value: [{ id: CANARY.app, displayName: CANARY.name }], '@odata.nextLink': `${directoryUrl('users')}&$skiptoken=${CANARY.nextLinkMarker}` })
      : jsonResponse(200, { organization: { id: 7001 } });
    responses.push(r); return r;
  });
  const recorder = createRecorder({ sink: mem.sink, dispatch: fake.dispatch });
  const token = await new ClientCredentialsTokenProvider(recorder.auth).acquire(CANARY.tenant, { applicationId: CANARY.app, clientSecret: CANARY.secret });
  assert.equal(token.value, CANARY.token);
  const auth = fake.calls[0]!;
  assert.deepEqual([auth.url, auth.init.method, auth.init.redirect, (auth.init.headers as Record<string, string>)['Content-Type']],
    [tokenEndpoint(CANARY.tenant), 'POST', 'error', 'application/x-www-form-urlencoded']);
  assert.ok(String(auth.init.body).includes(`client_secret=${CANARY.secret}`), 'the form body reaches the authority unchanged');
  const page = await graphGet(recorder.graph, 'users', directoryUrl('users'), token.value, Date.now);
  assert.equal(nextLinkOf(page, 'users'), `${directoryUrl('users')}&$skiptoken=${CANARY.nextLinkMarker}`, 'accepted nextLink validation unchanged');
  assert.equal((fake.calls[1]!.init.headers as Record<string, string>).Authorization, `Bearer ${CANARY.token}`);
  const headers = { Authorization: 'Basic synthetic' }; const signal = AbortSignal.timeout(5000);
  const stage1 = await recorder.stage1('https://api.huntress.io/v1/organizations/7001', { method: 'GET', headers, signal });
  const init = fake.calls[2]!.init;
  assert.deepEqual(Object.keys(init).sort(), ['headers', 'method', 'redirect', 'signal']);
  assert.ok(init.headers === headers && init.signal === signal && init.method === 'GET' && init.redirect === 'error', 'exact headers/signal object, explicit redirect:error');
  assert.ok(stage1 === responses[2] && stage1.bodyUsed === false, 'the very Response, body unread');
  assert.deepEqual(mem.receipts.filter(r => r.kind === 'dispatch').map(r => r.kind === 'dispatch' && `${r.method} ${r.endpointClass}`),
    ['POST m365.token', 'GET graph.users', 'GET huntress.organization']);
  const snap = recorder.snapshot();
  assert.deepEqual([snap.complete, snap.dispatches, snap.completions, Object.keys(snap.perClass)], [true, 3, 3, ['m365.token', 'graph.users', 'huntress.organization']]);
  const all = mem.lines.join('');
  for (const canary of Object.values(CANARY)) assert.ok(!all.includes(canary), canary);
  for (const line of mem.lines) {
    const r = JSON.parse(line) as Record<string, unknown>;
    assert.deepEqual(Object.keys(r), r.kind === 'dispatch' ? ['v', 'kind', 'seq', 'endpointClass', 'method', 'startedAt']
      : ['v', 'kind', 'seq', 'endpointClass', 'method', 'httpStatus', 'durationMs', 'outcome']);
  }
});

test('receipts are an exact allowlist; the file sink creates a new 0600 file, fsyncs each line and never overwrites', () => {
  const at = new Date().toISOString();
  const valid: Receipt = { v: 1, kind: 'dispatch', seq: 1, endpointClass: 'graph.users', method: 'GET', startedAt: at };
  assert.match(receiptLine(valid), /^\{"v":1,"kind":"dispatch","seq":1,"endpointClass":"graph.users","method":"GET","startedAt":"[^"]+"\}\n$/);
  for (const bad of [{ ...valid, url: 'https://graph.microsoft.com' }, { ...valid, endpointClass: 'graph.groups' }, { ...valid, method: 'DELETE' },
    { ...valid, startedAt: CANARY.name }, { ...valid, v: 2 }, { v: 1, kind: 'refusal', at, reason: CANARY.errorBody },
    { v: 1, kind: 'completion', seq: 1, endpointClass: 'graph.users', method: 'GET', httpStatus: 200, durationMs: 1, outcome: 'OK', error: 'x' }]) {
    assert.throws(() => receiptLine(bad as Receipt), failsWith('PILOT_RECEIPT_INVALID'));
  }
  const tmp = tempDir();
  try {
    const path = tmp.path('receipts.jsonl');
    const sink = openFileSink(path);
    sink.append(valid); sink.close();
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(readFileSync(path, 'utf8'), receiptLine(valid));
    writeFileSync(tmp.path('existing.jsonl'), 'previous report\n');
    assert.throws(() => openFileSink(tmp.path('existing.jsonl')), failsWith('PILOT_OUTPUT_EXISTS'));
    assert.equal(readFileSync(tmp.path('existing.jsonl'), 'utf8'), 'previous report\n', 'never overwritten');
    assert.throws(() => openFileSink('relative/receipts.jsonl'), failsWith('PILOT_OUTPUT_INVALID'));
  } finally { tmp.close(); }
});
