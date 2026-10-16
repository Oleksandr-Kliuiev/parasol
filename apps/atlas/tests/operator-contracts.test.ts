import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import * as browser from '../apps/operator/src/contracts.ts';
import { BEARER_TOKEN_PATTERN, generateToken, parseBearerToken } from '../packages/auth/token.ts';
import { SCOPE_ID_PATTERN } from '../packages/graph/scope-context.ts';
import { EXTERNAL_ID_PATTERN } from '../packages/graph/mapping.ts';
import { activeObservationStatuses, observationStatuses, routes, severities } from '../packages/core/contracts.ts';
import { isConsoleLocation } from '../apps/operator/src/origin.ts';
import { operationPath } from '../apps/operator/src/operations.ts';

// S5-A parity: the browser keeps DOM-free copies of accepted server contracts (docs/stage5/04_ARCHITECTURE_AND_UX.md).
// These tests fail when either side changes without the other.

test('browser bearer, scope and source ID patterns are the accepted server patterns', () => {
  assert.equal(browser.BEARER_TOKEN_PATTERN.source, BEARER_TOKEN_PATTERN.source);
  assert.equal(browser.BEARER_TOKEN_PATTERN.flags, BEARER_TOKEN_PATTERN.flags);
  assert.equal(browser.SCOPE_ID_PATTERN.source, SCOPE_ID_PATTERN.source);
  assert.equal(browser.EXTERNAL_ID_PATTERN.source, EXTERNAL_ID_PATTERN.source);
  const samples = ['a'.repeat(19), 'a'.repeat(20), 'a'.repeat(256), 'a'.repeat(257), `${'a'.repeat(20)}==`, `${'a'.repeat(20)}===`,
    ` ${'a'.repeat(20)}`, `${'a'.repeat(20)} `, `${'a'.repeat(20)}\n`, `${'a'.repeat(19)}!`, 'Bearer abcdefghijklmnopqrstu', generateToken(),
    `${'a'.repeat(10)}é${'a'.repeat(10)}`];
  for (const sample of samples) {
    assert.equal(browser.BEARER_TOKEN_PATTERN.test(sample), parseBearerToken(`Bearer ${sample}`) === sample, JSON.stringify(sample.slice(0, 24)));
  }
});

test('fixture and console journey tokens satisfy the browser bearer pattern (fixture equality guard unchanged)', async () => {
  // Existing fixture-mode test tokens: tests/pg/m365-api.pg.test.ts literal, scripts/api-smoke.ts and tests/ui random hex.
  for (const token of ['synthetic-demo-token-for-api-tests', randomBytes(24).toString('hex'), generateToken()]) {
    assert.ok(browser.BEARER_TOKEN_PATTERN.test(token));
  }
  const smoke = await readFile(new URL('../scripts/api-smoke.ts', import.meta.url), 'utf8');
  assert.match(smoke, /const token = randomBytes\(24\)\.toString\('hex'\);/);
  const guard = await readFile(new URL('../apps/api/src/atlas.module.ts', import.meta.url), 'utf8');
  assert.match(guard, /timingSafeEqual\(a, b\)/, 'the fixture equality guard is unchanged');
});

test('browser enums are copies of the accepted core enums', () => {
  assert.deepEqual([...browser.SEVERITIES], [...severities]);
  assert.deepEqual([...browser.ROUTES], [...routes]);
  assert.deepEqual([...browser.OBSERVATION_STATUSES], [...observationStatuses]);
  assert.deepEqual([...browser.ACTIVE_OBSERVATION_STATUSES], [...activeObservationStatuses]);
  // Union types without runtime arrays in core: compare against the literal union text of packages/core/contracts.ts.
  return readFile(new URL('../packages/core/contracts.ts', import.meta.url), 'utf8').then(core => {
    const union = (name: string) => {
      const match = new RegExp(`export type ${name} = ([^;]+);`).exec(core);
      assert.ok(match, name);
      return [...match[1]!.matchAll(/'([^']+)'/g)].map(m => m[1]);
    };
    assert.deepEqual([...browser.SYSTEMS], union('System'));
    assert.deepEqual([...browser.PRIORITIES], union('Priority'));
    assert.deepEqual([...browser.EVENT_KINDS], union('EventKind'));
    assert.deepEqual([...browser.DOMAINS], union('Domain'));
    assert.deepEqual([...browser.ENTITY_KINDS], union('EntityKind'));
    assert.deepEqual([...browser.PROVIDERS], union('Provider'));
    assert.deepEqual([...browser.RESOURCE_STATUSES], union('ResourceStatus'));
    assert.deepEqual([...browser.CONTEXT_RESOURCE_TYPES], union('ResourceType'));
    assert.deepEqual([...browser.CONTEXT_SYSTEMS], union('System').filter(s => s !== 'microsoft365'));
  });
});

test('fixed operations: encoded relative paths only, malformed IDs never become a request', () => {
  assert.equal(operationPath({ kind: 'clients' }), '/clients');
  assert.equal(operationPath({ kind: 'overview', clientId: 'demo-gasta' }), '/clients/demo-gasta/overview');
  assert.equal(operationPath({ kind: 'overview', clientId: 'a:b.c_d-e' }), '/clients/a%3Ab.c_d-e/overview');
  for (const bad of ['../audit', 'a/b', '', '-x', 'a?b', 'a#b', 'a%2Fb', 'x'.repeat(129), 'http://evil']) {
    assert.equal(operationPath({ kind: 'overview', clientId: bad }), null, bad);
  }
  assert.equal(operationPath({ kind: 'audit' } as never), null);
});

test('token entry is offered only on the exact HTTP loopback console location', () => {
  assert.ok(isConsoleLocation('http://127.0.0.1:3100', '/operator/'));
  for (const [origin, path] of [['http://localhost:3100', '/operator/'], ['https://127.0.0.1:3100', '/operator/'], ['http://127.0.0.1', '/operator/'],
    ['http://127.0.0.1:80', '/operator/'], ['http://127.0.0.2:3100', '/operator/'], ['http://[::1]:3100', '/operator/'], ['http://127.0.0.1:3100', '/operator'],
    ['http://127.0.0.1:3100', '/operator/index.html'], ['http://127.0.0.1.nip.io:3100', '/operator/'], ['null', '/operator/'], ['http://127.0.0.1:99999', '/operator/']]) {
    assert.equal(isConsoleLocation(origin!, path!), false, `${origin}${path}`);
  }
});

test('modules shared with Node tests stay DOM-free; only dom/view*/main touch the document', async () => {
  const shared = ['contracts', 'validate-core', 'validate-clients', 'validate-context', 'validate-observations', 'validate-resources',
    'validate-evidence', 'queue-query', 'evidence-plan', 'entities', 'operations', 'origin', 'credential', 'transport', 'panels', 'controller',
    'controller-queue', 'controller-evidence', 'state', 'messages',
    // ASK-B (docs/stage5/ask): Ask contracts, validation, transport, state, controller and fixed messages are shared too.
    'ask-contracts', 'validate-ask-facts', 'validate-ask', 'ask-transport', 'ask-state', 'controller-ask', 'ask-messages'];
  const dom = ['dom', 'view', 'view-parts', 'view-clients', 'view-scope', 'view-context', 'view-queue', 'view-detail', 'view-evidence', 'main',
    'view-ask', 'view-ask-answer'];
  const actual = (await readdir(new URL('../apps/operator/src/', import.meta.url))).map(n => n.replace(/\.ts$/, '')).sort();
  assert.deepEqual(actual, [...shared, ...dom].sort(), 'every browser module is classified as shared (DOM-free) or DOM');
  for (const name of shared) {
    const code = await readFile(new URL(`../apps/operator/src/${name}.ts`, import.meta.url), 'utf8');
    const imports = [...code.matchAll(/from '([^']+)'/g)].map(m => m[1]!);
    assert.ok(imports.every(i => /^\.\/[a-z-]+\.ts$/.test(i) && shared.includes(i.slice(2, -3))), `${name} imports only shared modules`);
    assert.equal(/\b(document|window|location|navigator|HTMLElement|localStorage|sessionStorage)\b/.test(code.replace(/\/\/.*$/gm, '')), false, name);
  }
  // The DOM layer renders state only: it cannot reach the credential holder, the transport or a fetch.
  for (const name of dom) {
    const code = await readFile(new URL(`../apps/operator/src/${name}.ts`, import.meta.url), 'utf8');
    const imports = [...code.matchAll(/from '([^']+)'/g)].map(m => m[1]!);
    if (name !== 'main') assert.deepEqual(imports.filter(i => /\/(credential|transport)\.ts$/.test(i)), [], `${name} imports no credential/transport`);
  }
});

test('S5-B parity: request ID pattern, evidence tool/parameter names and queue page sizes match the accepted server', async () => {
  const { REQUEST_ID_PATTERN } = await import('../apps/api/src/http-boundary.ts');
  const { stage1Tools, TOOL_OBSERVATION_DEFAULT_LIMIT } = await import('../packages/tools/registry.ts');
  assert.equal(browser.REQUEST_ID_PATTERN.source, REQUEST_ID_PATTERN.source);
  assert.ok(browser.REQUEST_ID_PATTERN.test(crypto.randomUUID()), 'crypto.randomUUID is an accepted request ID');
  const expected: Record<string, string[]> = { 'atera.alert.list': ['connectionId'], 'atera.ticket.get': ['connectionId', 'ticketId'], 'huntress.incident.get': ['connectionId', 'incidentId'] };
  assert.deepEqual([...browser.EVIDENCE_TOOLS].sort(), Object.keys(expected).sort());
  for (const name of browser.EVIDENCE_TOOLS) {
    const tool = stage1Tools.find(t => t.name === name)!;
    assert.deepEqual([tool.sideEffect, tool.risk, Object.keys(tool.parameters).sort()], ['NONE', 0, [...expected[name]!].sort()], name);
  }
  assert.equal(browser.QUEUE_PAGE_SIZES[0], TOOL_OBSERVATION_DEFAULT_LIMIT);
  assert.ok(browser.QUEUE_PAGE_SIZES.every(n => Number.isInteger(n) && n >= 1 && n <= browser.LIMITS.queueItems));
  assert.deepEqual([...browser.URGENT_SEVERITIES], ['HIGH', 'CRITICAL']);
});

test('ASK-B parity: Ask codes/statuses, UUID pattern, limits, enums, MOCK examples and question rules match packages/ask', async () => {
  const server = await import('../packages/ask/contracts.ts');
  const { validQuestion } = await import('../packages/ask/input.ts');
  const { MOCK_PHRASES, mockIntent } = await import('../packages/ask/planner.ts');
  const ask = await import('../apps/operator/src/ask-contracts.ts');
  assert.deepEqual([...ask.ASK_ERROR_CODES], [...server.ASK_ERROR_CODES]);
  assert.deepEqual({ ...ask.ASK_HTTP_STATUS }, { ...server.ASK_HTTP_STATUS });
  assert.equal(ask.UUID_V4.source, server.UUID_V4.source);
  assert.deepEqual([...ask.ASK_SOURCES], [...server.ASK_SOURCES]);
  assert.deepEqual([...ask.ASK_INTENTS], [...server.ASK_INTENTS]);
  assert.deepEqual([...ask.CLAIM_CODES], [...server.CLAIM_CODES]);
  const s = server.ASK_LIMITS; const b = ask.ASK_LIMITS;
  assert.deepEqual([b.questionCodePoints, b.requestBytes, b.responseBytes, b.observationIdLength, b.observationLimit, b.bankLimit, b.bankObservations,
    b.bankResources, b.claims, b.reasonCodes, b.displayCodePoints, b.resourcesRead],
  [s.questionCodePoints, s.rawBodyBytes, s.responseBytes, s.observationIdLength, s.observationPage, s.bankFacts, s.bankObservations, s.bankResources,
    s.planRefs, s.reasonCodes, s.displayCodePoints, s.resources]);
  assert.equal(server.ASK_CAPABILITY.questionMaxCodepoints, b.questionCodePoints);
  assert.ok(ask.UUID_V4.test(crypto.randomUUID()), 'crypto.randomUUID is a canonical lowercase UUIDv4');
  // Every shown MOCK example is recognized by the accepted planner as its labelled intent, and every server phrase is shown.
  const shown = ask.MOCK_EXAMPLES.flatMap(e => [[e.en, e.intent], [e.ru, e.intent]] as const);
  for (const [text, intent] of shown) assert.equal(mockIntent(text), intent, text);
  assert.deepEqual(shown.map(([text]) => text.toLowerCase().replace(/\?$/, '')).sort(), Object.keys(MOCK_PHRASES).sort());
  assert.equal(mockIntent('What is the root cause?'), 'UNSUPPORTED');
  for (const sample of ['q', ' q ', '\tq\n', '', ' ', '\n\t', 'a'.repeat(2000), 'a'.repeat(2001), '😀'.repeat(2000), '😀'.repeat(2001), 'x\u0000', 'x\u0007',
    'x\u001f', 'x\u007f', 'x\u0085', 'x\ud800', '\udc00x', '😀', 'x\r\ny', ' ', '　q']) {
    assert.equal(ask.questionProblem(sample) === null, validQuestion(sample), JSON.stringify(sample.slice(0, 12)));
  }
});
