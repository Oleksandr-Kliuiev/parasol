import type { DecisionConfig, DecisionProvider } from './provider.ts';
import { FixtureDecisionProvider, RulesDecisionProvider } from './provider.ts';
import { OpenAIDecisionProvider } from './openai.ts';
import { DecisionGuard } from './guard.ts';

/**
 * Decision runtime of a worker process (task 1.7): the provider for the configured mode and its guard (circuit breaker,
 * call budget). shadow and advisory use OpenAI and need its key, read from the environment only here; rules and fixture
 * never reach a vendor. The worker and the shadow job runner share the one guard.
 */
export interface DecisionRuntime { config: DecisionConfig; provider: DecisionProvider; guard: DecisionGuard }
export function createDecisionRuntime(config: DecisionConfig, deps: { apiKey?: string; fetch?: typeof fetch; now?: () => number } = {}): DecisionRuntime {
  const provider: DecisionProvider = config.mode === 'rules' ? new RulesDecisionProvider(config.promptVersion)
    : config.mode === 'fixture' ? new FixtureDecisionProvider(config.promptVersion)
    : new OpenAIDecisionProvider(deps.apiKey ?? process.env.OPENAI_API_KEY ?? '', config, deps.fetch ?? fetch, config.mode);
  return { config, provider, guard: new DecisionGuard(config, deps.now) };
}
