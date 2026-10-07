import type { Classification, NormalizedEvent, DecisionMode, Provider } from '../core/contracts.ts';
export interface DecisionProvider {
  readonly provider: Provider;
  readonly mode: DecisionMode;
  classify(event: NormalizedEvent): Promise<Classification>;
}
/**
 * Versioned decision configuration. These values are test settings, not measured guarantees; the DB version reads them
 * from configuration and records the version used in each DecisionRun.
 */
export interface DecisionConfig {
  promptVersion: string;
  /** Deadline for one provider call. */
  deadlineMs: number;
  /** Provisional threshold below which a model route is replaced by HUMAN_REVIEW. Not a calibrated probability. */
  confidenceThreshold: number;
  /** Model requested from the provider. */
  model: string;
  /** Exact model identifiers accepted in a response. No automatic suffix matching. */
  allowedResponseModels: string[];
}
export const defaultDecisionConfig: DecisionConfig = {
  promptVersion: 'event-route-v1', deadlineMs: 2500, confidenceThreshold: 0.8,
  model: 'gpt-6-luna', allowedResponseModels: ['gpt-6-luna']
};
export function decisionConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DecisionConfig {
  const model = env.OPENAI_DECISIONS_MODEL?.trim() || defaultDecisionConfig.model;
  const allowed = (env.OPENAI_DECISIONS_ALLOWED_MODELS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return { ...defaultDecisionConfig, model, allowedResponseModels: allowed.length ? allowed : [model] };
}
/**
 * Deterministic baseline from verified source facts only. It is the applied decision in shadow mode and the fallback when a
 * provider fails. It never looks at free text.
 */
export function rulesBaseline(event: NormalizedEvent, promptVersion: string = defaultDecisionConfig.promptVersion): Classification {
  const route: Classification['route'] = event.sourceSeverity === 'HIGH' || event.sourceSeverity === 'CRITICAL' ? 'HUMAN_REVIEW'
    : event.kind === 'SECURITY_INCIDENT' ? 'INVESTIGATE' : 'MONITOR';
  return { route, confidence: 1, provider: 'rules', reasonCodes: ['RULES_BASELINE'], promptVersion };
}
export class RulesDecisionProvider implements DecisionProvider {
  readonly provider: Provider = 'rules';
  readonly mode: DecisionMode = 'rules';
  async classify(event: NormalizedEvent): Promise<Classification> { return rulesBaseline(event); }
}
export class FixtureDecisionProvider implements DecisionProvider {
  readonly provider: Provider = 'fixture';
  readonly mode: DecisionMode = 'fixture';
  async classify(event: NormalizedEvent): Promise<Classification> {
    return { route: event.kind === 'SECURITY_INCIDENT' ? 'INVESTIGATE' : 'MONITOR', confidence: 1, provider: 'fixture',
      reasonCodes: ['SYNTHETIC_FIXTURE_ONLY'], promptVersion: defaultDecisionConfig.promptVersion };
  }
}
