import { readFileSync } from 'node:fs';
import type { DecisionMode } from '../core/contracts.ts';
import { AtlasError } from '../core/contracts.ts';
import type { DecisionConfig } from './provider.ts';

/**
 * Versioned decision configuration (task 1.7, docs/04): config/decisions.json, validated strictly — unknown keys, missing
 * values or values outside their bounds stop the start (DECISION_CONFIG_INVALID names the field, never the value).
 * Mode, model and allowlist may be overridden from the environment (ATLAS_DECISIONS_MODE, OPENAI_DECISIONS_MODEL,
 * OPENAI_DECISIONS_ALLOWED_MODELS); when that changes anything, the effective version gets the suffix `-env`, so runs made
 * under overrides are told apart from runs made under the file as reviewed.
 */
export const DECISION_CONFIG_FILE = new URL('../../config/decisions.json', import.meta.url);
const VERSION = /^[a-z0-9][a-z0-9._-]{0,59}$/;
const PROMPT_VERSION = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const MODES: readonly DecisionMode[] = ['fixture', 'rules', 'shadow', 'advisory'];
const KEYS = ['configVersion', 'notes', 'mode', 'promptVersion', 'model', 'allowedResponseModels', 'deadlineMs', 'confidenceThreshold', 'budget', 'circuitBreaker'];

const invalid = (field: string) => new AtlasError('DECISION_CONFIG_INVALID', 'PERMANENT', { field });
function object(value: unknown, field: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(field);
  const unknownKey = Object.keys(value).find(k => !keys.includes(k));
  if (unknownKey !== undefined) throw invalid(`${field}.${unknownKey.slice(0, 40)}`);
  return value as Record<string, unknown>;
}
function integer(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw invalid(field);
  return value;
}
function text(value: unknown, field: string, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw invalid(field);
  return value;
}

export function parseDecisionConfig(raw: unknown): DecisionConfig {
  const c = object(raw, 'root', KEYS);
  if (c.notes !== undefined && (typeof c.notes !== 'string' || c.notes.length > 1000)) throw invalid('notes');
  if (!MODES.includes(c.mode as DecisionMode)) throw invalid('mode');
  const threshold = c.confidenceThreshold;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold <= 0 || threshold > 1) throw invalid('confidenceThreshold');
  const allowed = c.allowedResponseModels;
  if (!Array.isArray(allowed) || allowed.length === 0 || allowed.length > 10 || new Set(allowed).size !== allowed.length) throw invalid('allowedResponseModels');
  const budget = object(c.budget, 'budget', ['maxProviderCallsPerEvent', 'maxProviderCallsPerMinute']);
  const breaker = object(c.circuitBreaker, 'circuitBreaker', ['failureThreshold', 'openMs']);
  return {
    configVersion: text(c.configVersion, 'configVersion', VERSION), mode: c.mode as DecisionMode,
    promptVersion: text(c.promptVersion, 'promptVersion', PROMPT_VERSION), model: text(c.model, 'model', MODEL),
    allowedResponseModels: allowed.map((m, i) => text(m, `allowedResponseModels.${i}`, MODEL)),
    deadlineMs: integer(c.deadlineMs, 'deadlineMs', 100, 30_000), confidenceThreshold: threshold,
    budget: { maxProviderCallsPerEvent: integer(budget.maxProviderCallsPerEvent, 'budget.maxProviderCallsPerEvent', 1, 10),
      maxProviderCallsPerMinute: integer(budget.maxProviderCallsPerMinute, 'budget.maxProviderCallsPerMinute', 1, 10_000) },
    circuitBreaker: { failureThreshold: integer(breaker.failureThreshold, 'circuitBreaker.failureThreshold', 1, 100),
      openMs: integer(breaker.openMs, 'circuitBreaker.openMs', 1_000, 3_600_000) },
  };
}

/** The configuration as reviewed in the file, with the documented environment overrides applied and marked. */
export function loadDecisionConfig(options: { file?: URL | string; env?: NodeJS.ProcessEnv } = {}): DecisionConfig {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(options.file ?? DECISION_CONFIG_FILE, 'utf8')); } catch { throw invalid('file'); }
  const config = parseDecisionConfig(raw);
  const env = options.env ?? process.env;
  const mode = env.ATLAS_DECISIONS_MODE?.trim();
  const model = env.OPENAI_DECISIONS_MODEL?.trim();
  const allowed = (env.OPENAI_DECISIONS_ALLOWED_MODELS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (!mode && !model && !allowed.length) return config;
  // Overrides pass the same validation as the file; the version says that they were applied
  const effective = parseDecisionConfig({ ...config, ...(mode ? { mode } : {}), ...(model ? { model } : {}),
    allowedResponseModels: allowed.length ? allowed : model ? [model] : config.allowedResponseModels });
  const same = effective.mode === config.mode && effective.model === config.model
    && JSON.stringify(effective.allowedResponseModels) === JSON.stringify(config.allowedResponseModels);
  return same ? config : { ...effective, configVersion: `${config.configVersion}-env` };
}
