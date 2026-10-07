import type { Classification, NormalizedEvent, DecisionMode, Provider } from '../core/contracts.ts';
export interface DecisionProvider {
  readonly provider: Provider;
  readonly mode: DecisionMode;
  classify(event: NormalizedEvent): Promise<Classification>;
}
/**
 * Versioned decision configuration (task 1.7). Production loads it from config/decisions.json (packages/decisions/config.ts)
 * and records configVersion in every DecisionRun. The values are test settings, not measured guarantees (docs/04).
 */
export interface DecisionConfig {
  /** Version of the configuration document; a run is traceable to the exact model, allowlist, deadline and threshold. */
  configVersion: string;
  /** Mode the provider is built for: fixture | rules | shadow | advisory. */
  mode: DecisionMode;
  promptVersion: string;
  /** Deadline for one provider call; it holds for every call, retries included. */
  deadlineMs: number;
  /** Provisional threshold below which a model route is replaced by HUMAN_REVIEW. Not a calibrated probability. */
  confidenceThreshold: number;
  /** Model requested from the provider. */
  model: string;
  /** Exact model identifiers accepted in a response. No automatic suffix matching. */
  allowedResponseModels: string[];
  /** Provider calls one event may cost (each shadow attempt is one call), and calls per minute across events. */
  budget: { maxProviderCallsPerEvent: number; maxProviderCallsPerMinute: number };
  /** Consecutive provider failures that open the circuit, and how long it stays open before one probe call. */
  circuitBreaker: { failureThreshold: number; openMs: number };
}
/** Built-in settings for tests and the in-memory reference pipeline; production uses config/decisions.json. */
export const defaultDecisionConfig: DecisionConfig = {
  configVersion: 'builtin-test-default', mode: 'shadow', promptVersion: 'event-route-v1', deadlineMs: 2500, confidenceThreshold: 0.8,
  model: 'gpt-6-luna', allowedResponseModels: ['gpt-6-luna'],
  budget: { maxProviderCallsPerEvent: 3, maxProviderCallsPerMinute: 60 }, circuitBreaker: { failureThreshold: 5, openMs: 60_000 }
};
/**
 * Deterministic baseline from verified source facts only. It is the applied decision in shadow mode and the fallback when a
 * provider fails. It never looks at free text.
 */
export function rulesBaseline(event: NormalizedEvent, promptVersion: string = defaultDecisionConfig.promptVersion): Classification {
  const route: Classification['route'] = event.sourceSeverity === 'HIGH' || event.sourceSeverity === 'CRITICAL' ? 'HUMAN_REVIEW'
    : event.kind === 'SECURITY_INCIDENT' ? 'INVESTIGATE' : 'MONITOR';
  return { route, confidence: 1, provider: 'rules', reasonCodes: ['RULES_BASELINE'], promptVersion };
}
/**
 * The local providers record the prompt version of the configuration they run under (createDecisionRuntime passes it), so
 * a run made under a new configuration never carries the old version; the default serves tests and the reference only.
 */
export class RulesDecisionProvider implements DecisionProvider {
  readonly provider: Provider = 'rules';
  readonly mode: DecisionMode = 'rules';
  readonly #promptVersion: string;
  constructor(promptVersion: string = defaultDecisionConfig.promptVersion) { this.#promptVersion = promptVersion; }
  async classify(event: NormalizedEvent): Promise<Classification> { return rulesBaseline(event, this.#promptVersion); }
}
export class FixtureDecisionProvider implements DecisionProvider {
  readonly provider: Provider = 'fixture';
  readonly mode: DecisionMode = 'fixture';
  readonly #promptVersion: string;
  constructor(promptVersion: string = defaultDecisionConfig.promptVersion) { this.#promptVersion = promptVersion; }
  async classify(event: NormalizedEvent): Promise<Classification> {
    return { route: event.kind === 'SECURITY_INCIDENT' ? 'INVESTIGATE' : 'MONITOR', confidence: 1, provider: 'fixture',
      reasonCodes: ['SYNTHETIC_FIXTURE_ONLY'], promptVersion: this.#promptVersion };
  }
}
