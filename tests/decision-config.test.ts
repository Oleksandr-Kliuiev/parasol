import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AtlasError } from '../packages/core/contracts.ts';
import { DECISION_CONFIG_FILE, loadDecisionConfig, parseDecisionConfig } from '../packages/decisions/config.ts';
import { createDecisionRuntime } from '../packages/decisions/runtime.ts';
import { DecisionGuard } from '../packages/decisions/guard.ts';

// Task 1.7 without a database: the versioned decision configuration as shipped, its strict validation, the documented
// environment overrides, and the runtime built from it.
const shipped = JSON.parse(readFileSync(DECISION_CONFIG_FILE, 'utf8')) as Record<string, unknown>;
const invalidField = (fn: () => unknown, field: string) => assert.throws(fn, (e: unknown) =>
  e instanceof AtlasError && e.code === 'DECISION_CONFIG_INVALID' && e.details.field === field && !e.message.includes('secret'));

test('the shipped config/decisions.json is valid, versioned and carries the documented test settings', () => {
  const config = loadDecisionConfig({ env: {} });
  assert.deepEqual(config, { configVersion: 'decisions-2026-10-07.1', mode: 'shadow', promptVersion: 'event-route-v1', model: 'gpt-6-luna',
    allowedResponseModels: ['gpt-6-luna'], deadlineMs: 2500, confidenceThreshold: 0.8,
    budget: { maxProviderCallsPerEvent: 3, maxProviderCallsPerMinute: 60 }, circuitBreaker: { failureThreshold: 5, openMs: 60_000 } });
});

test('invalid configurations stop the start and name the field, never the value', () => {
  const variant = (patch: Record<string, unknown>) => () => parseDecisionConfig({ ...shipped, ...patch });
  invalidField(variant({ secretKey: 'secret' }), 'root.secretKey');
  invalidField(variant({ mode: 'auto' }), 'mode');
  invalidField(variant({ confidenceThreshold: 0 }), 'confidenceThreshold');
  invalidField(variant({ confidenceThreshold: 1.5 }), 'confidenceThreshold');
  invalidField(variant({ allowedResponseModels: [] }), 'allowedResponseModels');
  invalidField(variant({ allowedResponseModels: ['gpt-6-luna', 'gpt-6-luna'] }), 'allowedResponseModels');
  invalidField(variant({ allowedResponseModels: ['gpt 6 luna'] }), 'allowedResponseModels.0');
  invalidField(variant({ deadlineMs: 50 }), 'deadlineMs');
  invalidField(variant({ configVersion: 'Decisions v1' }), 'configVersion');
  invalidField(variant({ budget: { maxProviderCallsPerEvent: 0, maxProviderCallsPerMinute: 60 } }), 'budget.maxProviderCallsPerEvent');
  invalidField(variant({ budget: { maxProviderCallsPerEvent: 1, maxProviderCallsPerMinute: 60, perDay: 5 } }), 'budget.perDay');
  invalidField(variant({ circuitBreaker: undefined }), 'circuitBreaker');
  invalidField(() => loadDecisionConfig({ file: new URL('./missing-decisions.json', import.meta.url), env: {} }), 'file');
});

test('environment overrides of mode, model and allowlist are validated and mark the effective version', () => {
  assert.deepEqual([loadDecisionConfig({ env: { ATLAS_DECISIONS_MODE: 'rules' } })].map(c => [c.mode, c.configVersion]), [['rules', 'decisions-2026-10-07.1-env']]);
  const model = loadDecisionConfig({ env: { OPENAI_DECISIONS_MODEL: 'gpt-6-luna-2026-10' } });
  assert.deepEqual([model.model, model.allowedResponseModels], ['gpt-6-luna-2026-10', ['gpt-6-luna-2026-10']], 'no suffix matching: the allowlist is exactly the model');
  const allowed = loadDecisionConfig({ env: { OPENAI_DECISIONS_ALLOWED_MODELS: 'gpt-6-luna, gpt-6-luna-2026-10' } });
  assert.deepEqual(allowed.allowedResponseModels, ['gpt-6-luna', 'gpt-6-luna-2026-10']);
  invalidField(() => loadDecisionConfig({ env: { ATLAS_DECISIONS_MODE: 'auto' } }), 'mode');
  assert.equal(loadDecisionConfig({ env: { ATLAS_DECISIONS_MODE: 'shadow', OPENAI_DECISIONS_MODEL: 'gpt-6-luna' } }).configVersion, 'decisions-2026-10-07.1',
    'an override equal to the file changes nothing and marks nothing');
});

test('the runtime builds the provider for the configured mode; OpenAI modes need the key, rules and fixture never reach a vendor', () => {
  const config = loadDecisionConfig({ env: {} });
  const rules = createDecisionRuntime({ ...config, mode: 'rules' }, { apiKey: '' });
  assert.deepEqual([rules.provider.provider, rules.provider.mode, rules.guard instanceof DecisionGuard], ['rules', 'rules', true]);
  assert.equal(createDecisionRuntime({ ...config, mode: 'fixture' }, { apiKey: '' }).provider.provider, 'fixture');
  assert.throws(() => createDecisionRuntime(config, { apiKey: '' }), (e: unknown) => e instanceof AtlasError && e.code === 'OPENAI_KEY_REQUIRED');
  const shadow = createDecisionRuntime(config, { apiKey: 'mock-not-a-key', fetch: async () => new Response('{}') });
  assert.deepEqual([shadow.provider.provider, shadow.provider.mode], ['openai', 'shadow']);
});
