import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DecisionGuard } from '../packages/decisions/guard.ts';
import { inputTokensOf, OpenAIDecisionProvider } from '../packages/decisions/openai.ts';
import { AtlasError } from '../packages/core/contracts.ts';
import type { NormalizedEvent } from '../packages/core/contracts.ts';
import { defaultDecisionConfig } from '../packages/decisions/provider.ts';

// Task 1.7 without a database: circuit breaker and call budget with an explicit clock, and the input-token telemetry of
// the OpenAI adapter (mocked transport only).
const limits = { budget: { maxProviderCallsPerEvent: 3, maxProviderCallsPerMinute: 100 }, circuitBreaker: { failureThreshold: 3, openMs: 60_000 } };
function clock() { let now = Date.UTC(2026, 9, 7, 8); return { now: () => now, advance: (ms: number) => { now += ms; } }; }
const admitted = (guard: DecisionGuard) => { const a = guard.admit(); return a.allowed ? 'ALLOWED' : a.reason; };

test('consecutive failures open the circuit; an answer (a refusal included) resets the count', () => {
  const t = clock(); const guard = new DecisionGuard(limits, t.now);
  for (const code of ['DECISION_TIMEOUT', 'DECISION_HTTP_503']) { assert.equal(admitted(guard), 'ALLOWED'); guard.record(code); }
  guard.admit(); guard.record('DECISION_REFUSED');
  assert.equal(guard.snapshot().consecutiveFailures, 0, 'a refusal is an answer from a working provider');
  for (let i = 0; i < 3; i++) { assert.equal(admitted(guard), 'ALLOWED'); guard.record('MODEL_MISMATCH'); }
  assert.deepEqual([guard.snapshot().state, guard.snapshot().timesOpened, admitted(guard)], ['OPEN', 1, 'PROVIDER_CIRCUIT_OPEN']);
  t.advance(59_999);
  assert.equal(admitted(guard), 'PROVIDER_CIRCUIT_OPEN');
});

test('after openMs one probe call: an answer closes the circuit, a failure opens it again, a probe that never reports expires', () => {
  const t = clock(); const guard = new DecisionGuard(limits, t.now);
  for (let i = 0; i < 3; i++) { guard.admit(); guard.record('DECISION_TIMEOUT'); }
  t.advance(60_000);
  assert.deepEqual([admitted(guard), admitted(guard)], ['ALLOWED', 'PROVIDER_CIRCUIT_OPEN'], 'one probe at a time');
  guard.record('DECISION_TIMEOUT');
  assert.deepEqual([guard.snapshot().state, guard.snapshot().timesOpened], ['OPEN', 2]);
  t.advance(60_000);
  assert.equal(admitted(guard), 'ALLOWED');
  t.advance(60_000); // the probe never reported back
  assert.equal(admitted(guard), 'ALLOWED', 'an abandoned probe expires after openMs');
  guard.record(null);
  assert.deepEqual([guard.snapshot().state, guard.snapshot().consecutiveFailures, admitted(guard)], ['CLOSED', 0, 'ALLOWED']);
});

test('the call budget admits at most maxProviderCallsPerMinute calls in any 60-second window', () => {
  const t = clock(); const guard = new DecisionGuard({ ...limits, budget: { maxProviderCallsPerEvent: 3, maxProviderCallsPerMinute: 2 } }, t.now);
  assert.deepEqual([admitted(guard), admitted(guard), admitted(guard)], ['ALLOWED', 'ALLOWED', 'PROVIDER_BUDGET_EXHAUSTED']);
  t.advance(59_999);
  assert.equal(admitted(guard), 'PROVIDER_BUDGET_EXHAUSTED');
  t.advance(1);
  assert.deepEqual([admitted(guard), guard.snapshot().callsInWindow], ['ALLOWED', 1]);
});

test('input tokens are taken from usage.input_tokens when present; any other usage shape is ignored, never a failure', async () => {
  assert.deepEqual([inputTokensOf({ usage: { input_tokens: 42, output_tokens: 3, future_field: {} } }), inputTokensOf({ usage: { input_tokens: -1 } }),
    inputTokensOf({ usage: { input_tokens: '42' } }), inputTokensOf({ usage: null }), inputTokensOf({}), inputTokensOf(null)], [42, null, null, null, null, null]);
  const event: NormalizedEvent = { workspaceId: 'w', clientId: 'c', source: 'atera', connectionId: 'conn', resourceType: 'alert', externalEventId: '1', revision: '1',
    externalDevice: null, occurredAt: '2026-10-07T08:00:00.000Z', receivedAt: '2026-10-07T08:00:00.000Z', kind: 'DISK_CAPACITY', sourceSeverity: 'LOW',
    summary: 'Synthetic', facts: { diskPercent: 91 } };
  const probabilities = [{ value: 'MONITOR', probability: 0.9 }, { value: 'INVESTIGATE', probability: 0.05 }, { value: 'HUMAN_REVIEW', probability: 0.05 }];
  const reply = (model: string) => async () => new Response(JSON.stringify({ model, usage: { input_tokens: 57 },
    answers: [{ type: 'choice', name: 'route', choice: 'MONITOR', confidence: 0.9, probabilities }] }));
  const ok = await new OpenAIDecisionProvider('mock-not-a-key', defaultDecisionConfig, reply('gpt-6-luna'), 'advisory').classify(event);
  assert.deepEqual([ok.route, ok.inputTokens, ok.requestedModel, ok.responseModel], ['MONITOR', 57, 'gpt-6-luna', 'gpt-6-luna']);
  await assert.rejects(new OpenAIDecisionProvider('mock-not-a-key', defaultDecisionConfig, reply('gpt-6-luna-preview'), 'advisory').classify(event),
    (e: unknown) => e instanceof AtlasError && e.code === 'MODEL_MISMATCH' && e.details.inputTokens === '57'
      && e.details.requestedModel === 'gpt-6-luna' && e.details.responseModel === 'gpt-6-luna-preview');
});
