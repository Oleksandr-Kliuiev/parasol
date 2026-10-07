import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AtlasError } from '../packages/core/contracts.ts';
import { loadDecisionConfig } from '../packages/decisions/config.ts';
import { OPERATOR_COMMANDS, decisionsSmoke, liveReadPassed, parseInvocation } from '../packages/ops/commands.ts';
import type { LiveReadSummary } from '../packages/ops/live-read.ts';
import { refused, routed, scriptedFetch } from './support/decision-fixtures.ts';

// Task 1.10 without a database: the ops CLI argument grammar, the live-read verdict, and the Decisions smoke test against a
// scripted endpoint (no network). The commands themselves run in tests/pg/e2e.pg.test.ts, the process in ops-cli.pg.test.ts.
const failsWith = (code: string) => (e: unknown) => e instanceof AtlasError && e.code === code;

test('arguments: a known command, only its flags, each once with a value; nothing inherited from Object.prototype', () => {
  assert.deepEqual(parseInvocation(['bind', '--client', 'demo-gasta', '--connection', 'gasta-atera', '--system', 'atera', '--tenant', '5001', '--secret-ref', 'env://ATERA_GASTA']),
    { command: 'bind', flags: { client: 'demo-gasta', connection: 'gasta-atera', system: 'atera', tenant: '5001', 'secret-ref': 'env://ATERA_GASTA' } });
  assert.deepEqual(parseInvocation(['worker-once']), { command: 'worker-once', flags: {} });
  assert.deepEqual(parseInvocation(['shadow-once']), { command: 'shadow-once', flags: {} });
  assert.deepEqual(parseInvocation(['reject-link', '--client', 'c', '--link', 'l', '--reason', 'WRONG_DEVICE']).flags, { client: 'c', link: 'l', reason: 'WRONG_DEVICE' });
  for (const argv of [[], ['__proto__'], ['constructor'], ['toString', '--client', 'x'], ['bind', '--client', 'demo-gasta'], ['mapping'],
    ['mapping', '--client', 'a', '--client', 'b'], ['mapping', '--client', 'demo-gasta', '--link', 'x'], ['mapping', '--client'], ['mapping', '--client', '--link'],
    ['mapping', '--client', ''], ['mapping', '-client', 'x'], ['mapping', '--Client', 'x'], ['mapping', '--client', 'x'.repeat(257)], ['worker-once', '--client', 'x'], ['shadow-once', '--client', 'x'],
    ['decisions-smoke', '--model', 'x']]) {
    assert.throws(() => parseInvocation(argv), failsWith('INVALID_ARGUMENTS'), argv.join(' '));
  }
  assert.deepEqual(OPERATOR_COMMANDS, ['bind', 'live-read', 'mapping', 'confirm-link', 'reject-link', 'inbox', 'requeue', 'triage', 'telemetry', 'worker-once',
    'shadow-once', 'decisions-smoke']);
});

test('live-read verdict: active, healthy, identities read, every resource read or explicitly unavailable upstream', () => {
  const passed: LiveReadSummary = { connectionId: 'gasta-atera', system: 'atera', activation: { status: 'ACTIVE' }, health: { status: 'OK', safeErrorCode: null },
    identities: { status: 'OK', registered: 1, candidates: 1, ambiguous: 0, safeErrorCode: null },
    resources: [{ resourceType: 'ticket', status: 'OK', itemCount: 2, eventsStored: 0, safeErrorCode: null, retryAfterSeconds: null },
      { resourceType: 'alert', status: 'UNAVAILABLE', itemCount: null, eventsStored: 0, safeErrorCode: 'UPSTREAM_TENANT_FILTER_UNAVAILABLE', retryAfterSeconds: null }] };
  assert.equal(liveReadPassed(passed), true);
  for (const failed of [
    { ...passed, resources: [{ ...passed.resources[0]!, status: 'ERROR', itemCount: null, safeErrorCode: 'UPSTREAM_RATE_LIMITED', retryAfterSeconds: '30' }] },
    { ...passed, identities: { ...passed.identities!, status: 'ERROR', safeErrorCode: 'UPSTREAM_UNAVAILABLE' } },
    { ...passed, health: { status: 'ERROR', safeErrorCode: 'UPSTREAM_UNAUTHORIZED' }, identities: null, resources: [] },
    { ...passed, system: null, activation: { status: 'DISABLED' as const, safeErrorCode: 'SECRET_NOT_FOUND' }, health: null, identities: null, resources: [] },
  ]) assert.equal(liveReadPassed(failed), false, JSON.stringify(failed).slice(0, 120));
});

test('Decisions smoke test: one compact synthetic call; a refusal is a failed check with its code; without a key nothing is sent', async () => {
  const config = loadDecisionConfig({ env: {} });
  const answered = scriptedFetch([routed('MONITOR', 0.9)]);
  const passed = await decisionsSmoke(config, 'test-key-not-a-credential', answered.fetch);
  assert.deepEqual({ ...passed, output: { ...passed.output, latencyMs: 0 } }, { ok: true, output: { configVersion: config.configVersion, route: 'MONITOR', confidence: 0.9,
    requestedModel: 'gpt-6-luna', responseModel: 'gpt-6-luna', inputTokens: 42, latencyMs: 0, safeErrorCode: null } });
  assert.deepEqual(JSON.parse((answered.calls.bodies[0] as { input: string }).input), { source: 'atera', kind: 'DISK_CAPACITY', sourceSeverity: 'MEDIUM', diskPercent: 93 });
  const failed = await decisionsSmoke(config, 'test-key-not-a-credential', scriptedFetch([refused]).fetch);
  assert.deepEqual([failed.ok, failed.output.route, failed.output.requestedModel, failed.output.safeErrorCode], [false, null, 'gpt-6-luna', 'DECISION_REFUSED']);
  const none = scriptedFetch([]);
  await assert.rejects(decisionsSmoke(config, '', none.fetch), failsWith('OPENAI_KEY_REQUIRED'));
  assert.equal(none.calls.count, 0);
});
