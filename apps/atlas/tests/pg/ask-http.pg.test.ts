import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startApiExpectingRefusal } from '../support/api-process.ts';
import { CLIENT, MARKERS, askBody, askDatabase, rawHttp, startAskProcess } from '../support/ask-pg.ts';
import type { AskDb, AskProcess } from '../support/ask-pg.ts';
import { OPERATOR_CSP } from '../../apps/api/src/operator/http.ts';

// ASK-A Q1/Q9 on the compiled API process in fixture and DB mode: OFF adds nothing, invalid mode refuses to start, exact
// MOCK DTOs/headers, the raw Ask boundary (type, encoding, declared/actual/chunked size, fatal UTF-8, escape expansion,
// query, capability body), precedence, every routed alias through the private boundary, unchanged non-Ask JSON/urlencoded
// parser behavior OFF vs MOCK (tools/execute 201), the Host gate ahead of parsing, and no input in any log.

let db: AskDb;
const fixtureToken = randomBytes(24).toString('hex');
const procs: Record<'fOff' | 'fMock' | 'dOff' | 'dMock' | 'ui', AskProcess> = {} as never;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
before(async () => {
  db = await askDatabase();
  const fixture = { ATLAS_MODE: 'fixture', ATLAS_DEMO_TOKEN: fixtureToken };
  const dbEnv = { ATLAS_MODE: 'db', ATLAS_RUNTIME_DATABASE_URL: db.pgdb.runtimeUrl };
  [procs.fOff, procs.fMock, procs.dOff, procs.dMock, procs.ui] = await Promise.all([startAskProcess(fixture), startAskProcess({ ...fixture, ATLAS_ASK_MODE: 'mock' }),
    startAskProcess({ ...dbEnv, ATLAS_ASK_MODE: 'off' }), startAskProcess({ ...dbEnv, ATLAS_ASK_MODE: 'mock' }),
    startAskProcess({ ...fixture, ATLAS_ASK_MODE: 'mock', ATLAS_OPERATOR_UI: '1' })]);
});
after(async () => { await Promise.all(Object.values(procs).map(p => p?.stop())); await db?.pgdb.drop(); });

const tokenOf = (p: AskProcess) => p === procs.dMock || p === procs.dOff ? db.tech : fixtureToken;
const mocks = () => [procs.fMock, procs.dMock];
const raw = (p: AskProcess, request: string | Buffer) => rawHttp(p.port, request);
/** One POST to the Ask route on a fresh socket with an exact byte body (no client-side normalization). */
function post(p: AskProcess, body: string | Buffer, headers: Record<string, string> = {}, path = `/clients/${CLIENT}/ask`) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const all = { Host: `127.0.0.1:${p.port}`, Authorization: `Bearer ${tokenOf(p)}`, 'Content-Type': 'application/json', 'Content-Length': String(bytes.length), Connection: 'close', ...headers };
  const head = Object.entries(all).filter(([, v]) => v !== '').map(([k, v]) => `${k}: ${v}`).join('\r\n');
  return raw(p, Buffer.concat([Buffer.from(`POST ${path} HTTP/1.1\r\n${head}\r\n\r\n`), bytes]));
}
const header = (head: string, name: string) => new RegExp(`^${name}: (.*)$`, 'im').exec(head)?.[1]?.trim() ?? null;
/** Exact AskErrorV1 with the fixed headers; the body never contains `secret`. */
function askError(r: { status: number; head: string; body: string }, status: number, code: string, secret?: string) {
  assert.equal(r.status, status, `${code}: ${r.body.slice(0, 200)}`);
  const json = JSON.parse(r.body);
  assert.deepEqual(Object.keys(json), ['contractVersion', 'code', 'correlationId']);
  assert.equal(json.contractVersion, 'AskErrorV1'); assert.equal(json.code, code); assert.match(json.correlationId, UUID);
  assert.equal(header(r.head, 'x-atlas-correlation-id'), json.correlationId);
  assert.equal(header(r.head, 'cache-control'), 'no-store'); assert.equal(header(r.head, 'content-type'), 'application/json; charset=utf-8');
  if (secret) assert.equal(r.body.includes(secret), false);
}
const validJson = (question = 'What needs attention?', focus: string | null = null) => JSON.stringify(askBody(question, focus));

test('OFF (default and explicit) adds no Ask route: ordinary Nest 404; invalid ATLAS_ASK_MODE refuses to start with a fixed message', async () => {
  for (const p of [procs.fOff, procs.dOff]) {
    const cap = await fetch(`${p.base}/ask/capabilities`, { headers: { Authorization: `Bearer ${tokenOf(p)}` } });
    assert.equal(cap.status, 404); assert.equal(cap.headers.get('x-atlas-correlation-id'), null);
    assert.deepEqual(await cap.json(), { message: 'Cannot GET /ask/capabilities', error: 'Not Found', statusCode: 404 });
    const q = await fetch(`${p.base}/clients/${CLIENT}/ask`, { method: 'POST', headers: { Authorization: `Bearer ${tokenOf(p)}`, 'Content-Type': 'application/json' }, body: validJson() });
    assert.equal(q.status, 404); assert.equal((await q.json()).error, 'Not Found');
  }
  for (const value of ['', 'MOCK', 'live', 'bogus-ask-mode-7f3']) {
    const refused = await startApiExpectingRefusal({ ATLAS_MODE: 'fixture', ATLAS_DEMO_TOKEN: fixtureToken, ATLAS_ASK_MODE: value });
    assert.notEqual(refused.code, 0); assert.match(refused.stderr, /ATLAS_ASK_MODE must be unset, off, mock or remote/);
    assert.equal(refused.stderr.includes('bogus-ask-mode-7f3'), false);
  }
  assert.match(procs.fMock.output(), /Ask Atlas: local synthetic MOCK; no external model/);
  assert.doesNotMatch(procs.fOff.output(), /Ask Atlas/);
});

test('MOCK: exact capability DTO and answer DTO with fixed headers; guard failures are AskErrorV1 too (fixture and DB)', async () => {
  for (const p of mocks()) {
    const cap = await raw(p, `GET /ask/capabilities HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${tokenOf(p)}\r\nConnection: close\r\n\r\n`);
    assert.equal(cap.status, 200); assert.equal(cap.body, '{"contractVersion":"AskCapabilityV1","mode":"mock","questionMaxCodepoints":2000}');
    assert.match(header(cap.head, 'x-atlas-correlation-id') ?? '', UUID); assert.equal(header(cap.head, 'cache-control'), 'no-store');
    askError(await raw(p, `GET /ask/capabilities HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`), 401, 'ASK_AUTHENTICATION_FAILED');
    askError(await post(p, validJson(), { Authorization: 'Bearer not-a-valid-token-at-all-000000000' }), 401, 'ASK_AUTHENTICATION_FAILED');
    const ok = await post(p, validJson());
    assert.equal(ok.status, 200, ok.body.slice(0, 200));
    const answer = JSON.parse(ok.body);
    assert.equal(header(ok.head, 'x-atlas-correlation-id'), answer.correlationId); assert.equal(answer.status, 'ANSWER');
    assert.equal(answer.sourceMode, p === procs.dMock ? 'db' : 'fixture');
  }
});

test('raw boundary goldens: type/charset/encoding/size/chunked/UTF-8/BOM/syntax/escape expansion/query/capability body — fixed codes, no echo', async () => {
  for (const p of mocks()) {
    askError(await post(p, validJson(), { 'Content-Type': 'text/plain' }), 400, 'ASK_REQUEST_INVALID');
    askError(await post(p, validJson(), { 'Content-Type': 'application/json; charset=latin1' }), 400, 'ASK_REQUEST_INVALID');
    askError(await post(p, validJson(), { 'Content-Type': '' }), 400, 'ASK_REQUEST_INVALID');
    askError(await post(p, validJson(), { 'Content-Encoding': 'gzip' }), 400, 'ASK_REQUEST_INVALID');
    assert.equal((await post(p, validJson(), { 'Content-Type': 'application/json; charset=UTF-8' })).status, 200);
    askError(await raw(p, `POST /clients/${CLIENT}/ask HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${tokenOf(p)}\r\nContent-Type: application/json\r\nContent-Length: 16385\r\n\r\n`), 413, 'ASK_TOO_LARGE');
    const exact = validJson(); const padded = exact + ' '.repeat(16384 - Buffer.byteLength(exact));
    assert.equal((await post(p, padded)).status, 200, 'exactly 16 KiB is accepted');
    askError(await post(p, padded + ' '), 413, 'ASK_TOO_LARGE');
    const chunks = (text: string, size: number) => {
      let out = ''; for (let i = 0; i < text.length; i += size) { const part = text.slice(i, i + size); out += `${Buffer.byteLength(part).toString(16)}\r\n${part}\r\n`; }
      return `${out}0\r\n\r\n`;
    };
    const chunked = (text: string) => raw(p, `POST /clients/${CLIENT}/ask HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${tokenOf(p)}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${chunks(text, 1000)}`);
    assert.equal((await chunked(validJson())).status, 200);
    askError(await chunked(padded + '   '), 413, 'ASK_TOO_LARGE');
    askError(await post(p, Buffer.concat([Buffer.from('{"contractVersion":"AskRequestV1","requestId":"0b8f2a8e-6f1d-4c7e-9a3b-1c2d3e4f5a6b","question":"bad \xc3'), Buffer.from([0xc3, 0x28]), Buffer.from('","observationId":null}')])), 400, 'ASK_REQUEST_INVALID');
    askError(await post(p, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(validJson())])), 400, 'ASK_REQUEST_INVALID');
    askError(await post(p, `{"question":"${MARKERS.question}",`), 400, 'ASK_REQUEST_INVALID', MARKERS.question);
    askError(await post(p, '"just a string"'), 400, 'ASK_REQUEST_INVALID');
    assert.equal((await post(p, JSON.stringify(askBody('é'.repeat(2000))).replaceAll('é', '\\u00e9'))).status, 200, '2000 code points as 12000 escape bytes');
    askError(await post(p, JSON.stringify(askBody('😀'.repeat(2000))).replace(/😀/gu, '\\ud83d\\ude00')), 413, 'ASK_TOO_LARGE');
    askError(await post(p, JSON.stringify(askBody('x'.repeat(2001)))), 400, 'ASK_REQUEST_INVALID');
    askError(await post(p, validJson(), {}, `/clients/${CLIENT}/ask?trace=1`), 400, 'ASK_REQUEST_INVALID');
    askError(await raw(p, `GET /ask/capabilities?x=1 HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${tokenOf(p)}\r\nConnection: close\r\n\r\n`), 400, 'ASK_REQUEST_INVALID');
    askError(await raw(p, `GET /ask/capabilities HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${tokenOf(p)}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`), 400, 'ASK_REQUEST_INVALID');
    askError(await raw(p, `GET /ask/capabilities HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${tokenOf(p)}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n`), 400, 'ASK_REQUEST_INVALID');
  }
});

test('precedence: raw syntax before authentication, authentication before body semantics, semantics before scope (malformed path IDs are authenticated 403)', async () => {
  for (const p of mocks()) {
    const noAuth = { Authorization: '' };
    askError(await post(p, '{"x":', noAuth), 400, 'ASK_REQUEST_INVALID');
    askError(await post(p, '{"x":1}', noAuth), 401, 'ASK_AUTHENTICATION_FAILED');
    askError(await post(p, '{"x":1}'), 400, 'ASK_REQUEST_INVALID');
    askError(await post(p, '{"x":1}', {}, '/clients/bad%20id/ask'), 400, 'ASK_REQUEST_INVALID');
    askError(await post(p, validJson(), {}, '/clients/bad%20id/ask'), 403, 'ASK_SCOPE_DENIED');
    askError(await post(p, validJson(), {}, '/clients/other-client/ask'), 403, 'ASK_SCOPE_DENIED');
    askError(await post(p, validJson(), noAuth, '/clients/bad%20id/ask'), 401, 'ASK_AUTHENTICATION_FAILED');
    askError(await post(p, validJson(), noAuth, '/clients/%E0%A4%A/ask'), 401, 'ASK_AUTHENTICATION_FAILED');
  }
});

test('every alias that reaches an Ask controller passes the private boundary (never the generic parser); HEAD/OPTIONS are ordinary 404', async () => {
  for (const p of mocks()) {
    // The fixture has one synthetic actor (10 admitted questions per 60 s): two spellings also answer; all prove the boundary.
    for (const path of [`/CLIENTS/${CLIENT}/ASK`, `/clients/${CLIENT}/ask/`, `/Clients/${CLIENT}/Ask/`, '/clients/demo%2Dgasta/ask', `http://x/clients/${CLIENT}/ask`]) {
      askError(await post(p, '{"broken":', {}, path), 400, 'ASK_REQUEST_INVALID');
      askError(await post(p, '{"contractVersion":"AskRequestV1"}', {}, path), 400, 'ASK_REQUEST_INVALID');
    }
    for (const path of [`/Clients/${CLIENT}/Ask/`, `http://x/clients/demo%2Dgasta/ask`]) {
      const ok = await post(p, validJson(), {}, path);
      assert.equal(ok.status, 200, path); assert.equal(JSON.parse(ok.body).clientId, CLIENT);
    }
    for (const path of ['/clients/a%2Fb/ask', '/clients/..%2F/ask', '/clients/%2e%2e/ask', '/clients/a%00/ask', '/clients/./ask']) {
      askError(await post(p, '{"broken":', {}, path), 400, 'ASK_REQUEST_INVALID');
      askError(await post(p, validJson(), {}, path), 403, 'ASK_SCOPE_DENIED');
    }
    for (const path of ['/ASK/Capabilities', '/ask/capabilities/', `http://x/ask/capabilities`]) {
      const r = await raw(p, `GET ${path} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${tokenOf(p)}\r\nConnection: close\r\n\r\n`);
      assert.equal(r.status, 200, path); assert.match(header(r.head, 'x-atlas-correlation-id') ?? '', UUID);
    }
    for (const [method, path] of [['HEAD', '/ask/capabilities'], ['OPTIONS', '/ask/capabilities'], ['OPTIONS', `/clients/${CLIENT}/ask`], ['HEAD', `/clients/${CLIENT}/ask`]]) {
      const r = await raw(p, `${method} ${path} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${tokenOf(p)}\r\nConnection: close\r\n\r\n`);
      assert.equal(r.status, 404, `${method} ${path}`); assert.equal(header(r.head, 'allow'), null); assert.equal(header(r.head, 'x-atlas-correlation-id'), null);
    }
  }
});

test('non-Ask JSON/urlencoded parser behavior is unchanged OFF vs MOCK (fixture and DB): 100kb, strict, syntax, type, tools/execute 201', async () => {
  // The accepted smoke call (scripts/api-smoke.ts); DB names the connection because this database has two Atera connections.
  let tool = () => '';
  const big = JSON.stringify({ clientId: CLIENT, tool: 'atera.ticket.get', pad: 'x'.repeat(102_400) });
  const requests: [string, string, string, string | Buffer][] = [
    ['POST', '/tools/execute', 'application/json', tool()], ['POST', '/tools/execute', 'application/json', big],
    ['POST', '/tools/execute', 'application/json', '"top-level string"'], ['POST', '/tools/execute', 'application/json', '{"clientId":'],
    ['POST', '/tools/execute', 'text/plain', tool()], ['POST', '/tools/execute', 'application/x-www-form-urlencoded', `clientId=${CLIENT}&tool=atera.ticket.get&parameters[ticketId]=1`],
    ['POST', '/tools/execute', 'application/x-www-form-urlencoded', `clientId=${'y'.repeat(102_400)}`], ['POST', '/tools/execute', 'application/json; charset=latin1', tool()],
    ['GET', `/clients/${CLIENT}/ask`, 'application/json', '{"x":'], ['POST', '/ask/capabilities', 'application/json', '{"x":'], ['PUT', `/clients/${CLIENT}/ask`, 'application/json', '{}']];
  for (const [off, mock] of [[procs.fOff, procs.fMock], [procs.dOff, procs.dMock]] as const) {
    tool = () => JSON.stringify({ version: '1', clientId: CLIENT, tool: 'atera.ticket.list', ...(off === procs.dOff ? { parameters: { connectionId: 'demo-atera-connection' } } : {}) });
    requests[0]![3] = tool(); requests[4]![3] = tool(); requests[7]![3] = tool();
    for (const [method, path, type, body] of requests) {
      const send = (p: AskProcess) => raw(p, Buffer.concat([Buffer.from(`${method} ${path} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${tokenOf(p)}\r\nContent-Type: ${type}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n`), Buffer.from(body)]));
      const [a, b] = [await send(off), await send(mock)];
      assert.equal(b.status, a.status, `${method} ${path} ${type}`);
      if (a.status !== 201) assert.equal(b.body, a.body, `${method} ${path} ${type}`);
      assert.equal(header(b.head, 'content-type'), header(a.head, 'content-type'));
    }
    const statuses = await Promise.all([off, mock].map(p => Promise.all([tool(), big, '"top-level string"', '{"clientId":'].map(async body =>
      (await raw(p, `POST /tools/execute HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${tokenOf(p)}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)).status))));
    assert.deepEqual(statuses, [[201, 413, 400, 400], [201, 413, 400, 400]]);
  }
});

test('operator console + Ask MOCK: Host gate stays ahead of Ask parsing; console headers on Ask replies', async () => {
  const p = procs.ui;
  const misdirected = await raw(p, `POST /clients/${CLIENT}/ask HTTP/1.1\r\nHost: localhost:${p.port}\r\nAuthorization: Bearer ${fixtureToken}\r\nContent-Type: application/json\r\nContent-Length: 5\r\nConnection: close\r\n\r\n{"x":`);
  assert.equal(misdirected.status, 421);
  const absolute = await raw(p, `GET http://127.0.0.1:${p.port}/ask/capabilities HTTP/1.1\r\nHost: 127.0.0.1:${p.port}\r\nAuthorization: Bearer ${fixtureToken}\r\nConnection: close\r\n\r\n`);
  assert.equal(absolute.status, 421, 'absolute-form targets are refused by the Host gate first');
  const ok = await raw(p, `GET /ask/capabilities HTTP/1.1\r\nHost: 127.0.0.1:${p.port}\r\nAuthorization: Bearer ${fixtureToken}\r\nConnection: close\r\n\r\n`);
  assert.equal(ok.status, 200); assert.equal(header(ok.head, 'content-security-policy'), OPERATOR_CSP); assert.equal(header(ok.head, 'x-frame-options'), 'DENY');
  const page = await raw(p, `GET /operator/ HTTP/1.1\r\nHost: 127.0.0.1:${p.port}\r\nConnection: close\r\n\r\n`);
  assert.equal(page.status, 200, 'console assets unchanged');
});

test('logs: no question, body, credential or marker text in any output; Ask traffic logs nothing beyond what OFF logs for the same non-Ask requests', async () => {
  const startup = /^(Atlas (synthetic fixture|PostgreSQL) API: http:\/\/127\.0\.0\.1:\d+|Local operator console: http:\/\/127\.0\.0\.1:\d+\/operator\/|Ask Atlas: local synthetic MOCK; no external model)$/;
  // Pre-existing Nest ExceptionsHandler entries of generic parser errors (with their stack/properties) are compared by their
  // header lines only: the frames legitimately differ because the generic parser now runs inside the classification wrapper.
  const lines = (p: AskProcess) => p.output().replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter(Boolean).filter(l => !startup.test(l) && !/^\s|^[}{]$/.test(l))
    .map(l => l.replace(/^\[Nest\] \d+ +- .*? (ERROR|WARN) /, '$1 ')).sort();
  for (const p of Object.values(procs)) {
    const out = p.output();
    for (const secret of [MARKERS.question, 'What needs attention', fixtureToken, db.tech, '{"broken"', 'just a string', 'top-level string', 'AskRequestV1']) {
      assert.equal(out.includes(secret), false, secret.slice(0, 12));
    }
  }
  assert.deepEqual(lines(procs.fMock), lines(procs.fOff), 'fixture: only the accepted non-Ask parser error lines, identical to OFF');
  assert.deepEqual(lines(procs.dMock), lines(procs.dOff), 'DB: only the accepted non-Ask parser error lines, identical to OFF');
  assert.deepEqual(lines(procs.ui), [], 'Ask-only traffic logs nothing');
});

test('rc2 R4: undecodable client segments stay inside the Ask boundary — raw 400/413 first, then 401, then body 400, then authenticated 403 + one denial', async () => {
  const denials = async (p: AskProcess, requested: string) => {
    const r = await fetch(`${p.base}/audit/security`, { headers: { Authorization: `Bearer ${tokenOf(p)}` } });
    assert.equal(r.status, 200);
    return ((await r.json()) as { eventType: string; requestedClientId: string; reasonCode: string; metadata: unknown }[])
      .filter(e => e.eventType === 'ask.scope_denied' && e.requestedClientId === requested);
  };
  for (const p of mocks()) {
    for (const [path, segment] of [['/clients/%E0%A4%A/ask', '%E0%A4%A'], ['/clients/%ZZ/ask', '%ZZ'], ['/CLIENTS/%/ASK/', '%'], ['/clients/%C3%28/ask', '%C3%28']]) {
      const before = (await denials(p, segment)).length;
      askError(await post(p, '{"broken":', { Authorization: '' }, path), 400, 'ASK_REQUEST_INVALID');
      askError(await raw(p, `POST ${path} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 16385\r\n\r\n`), 413, 'ASK_TOO_LARGE');
      askError(await post(p, validJson(), { Authorization: '' }, path), 401, 'ASK_AUTHENTICATION_FAILED');
      askError(await post(p, validJson(), { Authorization: 'Bearer atl_wellformed_but_unknown_0000000000000000' }, path), 401, 'ASK_AUTHENTICATION_FAILED');
      askError(await post(p, '{"contractVersion":"AskRequestV1"}', {}, path), 400, 'ASK_REQUEST_INVALID');
      assert.equal((await denials(p, segment)).length, before, `${path}: no denial before an authenticated, semantically valid request`);
      askError(await post(p, validJson(), {}, path), 403, 'ASK_SCOPE_DENIED', segment);
      const after = await denials(p, segment);
      assert.equal(after.length, before + 1, `${path}: exactly one workspace denial`);
      assert.deepEqual([after.at(-1)!.reasonCode, after.at(-1)!.metadata], ['SCOPE_DENIED', {}]);
      for (const method of ['HEAD', 'OPTIONS']) {
        const r = await raw(p, `${method} ${path} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${tokenOf(p)}\r\nConnection: close\r\n\r\n`);
        assert.equal(r.status, 404, `${method} ${path}`); assert.equal(header(r.head, 'x-atlas-correlation-id'), null);
      }
    }
  }
});
