import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askMode } from '../packages/ask/config.ts';
import { askRequest, askTarget, jsonContentType, storableId, validQuestion } from '../packages/ask/input.ts';
import { AskFailure } from '../packages/ask/contracts.ts';
import { SCOPE_ID_PATTERN } from '../packages/graph/scope-context.ts';

// ASK-A Q1 (pure part): ATLAS_ASK_MODE, route classification independent of scope-ID validity, raw header checks and the
// exact AskRequestV1 semantics. HTTP behavior of the same rules is proven on the actual process in tests/pg/ask-http.pg.test.ts.

// ASK-REMOTE R-B (approved amendment docs/stage5/ask/remote/01 "Admission and compatibility"): `remote` becomes a recognized
// DB-only, policy-gated value; every other value still refuses with one fixed message (the message names the new value).
test('ATLAS_ASK_MODE: unset/off → off, mock → mock, remote → remote, anything else refuses with a fixed message (no value echo)', () => {
  assert.equal(askMode(undefined), 'off');
  assert.equal(askMode('off'), 'off');
  assert.equal(askMode('mock'), 'mock');
  assert.equal(askMode('remote'), 'remote');
  for (const value of ['', 'MOCK', 'live', 'on', ' mock', 'REMOTE', 'remote ', 'openai']) {
    assert.throws(() => askMode(value), (e: Error) => e.message === 'ATLAS_ASK_MODE must be unset, off, mock or remote');
  }
});

test('classification covers every Express alias of both Ask routes, including malformed client segments', () => {
  const capability = ['/ask/capabilities', '/ASK/Capabilities', '/ask/capabilities/', '/ask/capabilities//', '/%61sk/capabilitie%73',
    'http://x/ask/capabilities', '/ask/capabilities?x=1', '/ask/capabilities#f'];
  for (const url of capability) assert.equal(askTarget('GET', url)?.action, 'intercept', url);
  const question = ['/clients/a/ask', '/CLIENTS/a/ASK', '/clients/a/ask/', '/clients/a%2Fb/ask', '/clients/%E0%A4%A/ask', '/clients/..%2F/ask',
    '/clients/a%00/ask', '/clients/./ask', '/clients/%2e%2e/ask', 'http://x/clients/a/ask', '/clients/a/Ask?q=1', '/clients/a/%61sk',
    `/clients/${'x'.repeat(500)}/ask`];
  for (const url of question) assert.equal(askTarget('POST', url)?.action, 'intercept', url);
  // rc2 (R4): an undecodable segment stays in the Ask boundary; its Ask-owned client ID is the raw text (never pattern-valid)
  // and only its routing path is re-encoded so Express delivers it to the Ask controller instead of a parameter error.
  assert.deepEqual(askTarget('POST', '/clients/%E0%A4%A/ask'),
    { action: 'intercept', shape: 'question', hasQuery: false, clientId: '%E0%A4%A', routePath: '/clients/%25E0%25A4%25A/ask' });
  assert.equal(SCOPE_ID_PATTERN.test('%E0%A4%A'), false);
  assert.deepEqual(askTarget('POST', '/CLIENTS/demo%2Dgasta/ASK/'), { action: 'intercept', shape: 'question', hasQuery: false, clientId: 'demo-gasta', routePath: null });
  assert.deepEqual(askTarget('POST', '/clients/%E0%A4%A/ask?x=1'),
    { action: 'intercept', shape: 'question', hasQuery: true, clientId: '%E0%A4%A', routePath: '/clients/%25E0%25A4%25A/ask' });
  assert.equal(askTarget('POST', '/clients/%25E0%25A4%25A/ask')?.action, 'intercept', 'the routing path is still an Ask shape');
  assert.deepEqual(askTarget('GET', '/ask/capabilities?x'), { action: 'intercept', shape: 'capability', hasQuery: true, clientId: null, routePath: null });
  for (const method of ['HEAD', 'OPTIONS']) {
    for (const url of [...capability, ...question]) assert.deepEqual(askTarget(method, url), { action: 'reject' }, `${method} ${url}`);
  }
  // Other methods on an Ask path reach no Ask controller: they keep the generic parsers and the ordinary Nest 404.
  for (const [method, url] of [['POST', '/ask/capabilities'], ['GET', '/clients/a/ask'], ['PUT', '/clients/a/ask'], ['DELETE', '/ask/capabilities']]) {
    assert.equal(askTarget(method, url), null, `${method} ${url}`);
  }
  for (const url of ['/clients//ask', '/clients/a/b/ask', '//ask/capabilities', '/ask//capabilities', '/clients/a/ask%2F', '/ask/capabilities.json',
    '/clients/a/overview', '/tools/execute', '*', '', '/operator/ask/capabilities']) {
    assert.equal(askTarget('POST', url), null, url); assert.equal(askTarget('GET', url), null, url);
  }
});

test('POST content type: application/json with at most charset=utf-8', () => {
  for (const ok of ['application/json', 'Application/JSON', 'application/json; charset=utf-8', 'application/json;charset=UTF-8', 'application/json; charset="utf-8"']) {
    assert.equal(jsonContentType(ok), true, ok);
  }
  for (const bad of [undefined, '', 'text/plain', 'application/json; charset=latin1', 'application/json; charset=utf-16', 'application/x-www-form-urlencoded',
    'application/json; charset=utf-8; x=1', 'application/jsonx', 'application/json; boundary=x', ['application/json']]) {
    assert.equal(jsonContentType(bad), false, String(bad));
  }
});

test('question: 1..2000 code points, a non-whitespace character, no NUL/C0 (except TAB/LF/CR)/DEL/lone surrogate, never truncated', () => {
  assert.equal(validQuestion('What needs attention?'), true);
  assert.equal(validQuestion('a\tb\nc\rd'), true);
  assert.equal(validQuestion('😀'.repeat(2000)), true, '2000 astral code points (4000 UTF-16 units) are allowed');
  assert.equal(validQuestion('😀'.repeat(2001)), false);
  assert.equal(validQuestion('x'.repeat(2000)), true);
  assert.equal(validQuestion('x'.repeat(2001)), false);
  for (const bad of ['', '   ', '\t\n', '　', 'a\u0000b', 'a\u0007', 'a\u007f', 'a\u001b', 'a\ud800', '\udc00a', 42, null]) {
    assert.equal(validQuestion(bad), false, JSON.stringify(bad));
  }
});

const valid = { contractVersion: 'AskRequestV1', requestId: '0b8f2a8e-6f1d-4c7e-9a3b-1c2d3e4f5a6b', question: 'Why is this urgent?', observationId: null };
const rejects = (body: unknown) => assert.throws(() => askRequest(body), (e: unknown) => e instanceof AskFailure && e.code === 'ASK_REQUEST_INVALID' && e.message === 'ASK_REQUEST_INVALID');

test('AskRequestV1: exactly four keys, canonical lowercase UUIDv4, validated question, nonempty ≤256 observation ID (no charset rule)', () => {
  assert.deepEqual(askRequest(valid), { requestId: valid.requestId, question: valid.question, observationId: null });
  assert.deepEqual(askRequest({ ...valid, observationId: 'x'.repeat(256) }).observationId, 'x'.repeat(256));
  assert.equal(askRequest({ ...valid, observationId: 'any text / with spaces ✓' }).observationId, 'any text / with spaces ✓');
  assert.equal(askRequest({ ...valid, question: '  padded  ' }).question, '  padded  ', 'never trimmed');
  for (const body of [null, [], 'x', 1, { ...valid, extra: 1 }, (({ observationId: _o, ...rest }) => rest)(valid),
    { ...valid, contractVersion: 'AskRequestV2' }, { ...valid, requestId: '0B8F2A8E-6F1D-4C7E-9A3B-1C2D3E4F5A6B' },
    { ...valid, requestId: '0b8f2a8e-6f1d-1c7e-9a3b-1c2d3e4f5a6b' }, { ...valid, requestId: '0b8f2a8e-6f1d-4c7e-7a3b-1c2d3e4f5a6b' },
    { ...valid, observationId: '' }, { ...valid, observationId: 'x'.repeat(257) }, { ...valid, observationId: 7 }, { ...valid, question: '' },
    { ...valid, question: 'x'.repeat(2001) }, { ...valid, question: 'a\u0000' }, { ...valid, workspaceId: 'w' }, { ...valid, tool: 'x' }]) rejects(body);
  rejects(JSON.parse(`{"contractVersion":"AskRequestV1","requestId":"${valid.requestId}","question":"q","observationId":null,"__proto__":{}}`));
});

test('an observation ID that PostgreSQL text cannot hold exactly is never queried (missing focus, not a near match)', () => {
  assert.equal(storableId('obs-1'), true);
  assert.equal(storableId('a\u0000b'), false);
  assert.equal(storableId('a\ud800'), false);
  assert.equal(storableId('😀'), true);
});
