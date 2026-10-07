import type { Classification, DecisionMode, NormalizedEvent, Provider, Route, Severity } from '../core/contracts.ts';
import { AtlasError, errorDetails, priorityOf, routes, safeErrorCode } from '../core/contracts.ts';
import type { DecisionConfig, DecisionProvider } from '../decisions/provider.ts';
import { rulesBaseline } from '../decisions/provider.ts';

/**
 * Decision steps shared by the in-memory reference pipeline and the durable worker (task 1.6), so both route exactly alike.
 * The provider is called outside any database transaction; its runs are drafted here and persisted by the caller as NOT
 * applied. The deterministic rules after the model append reasons in order and never overwrite one another.
 */
export interface ProviderCall { result: Classification | null; error: string | null; details: Record<string, string>; latencyMs: number }

/** One provider call. An answer with a route outside the set or a confidence outside [0, 1] is a failure, never a route. */
export async function callProvider(provider: DecisionProvider, event: NormalizedEvent): Promise<ProviderCall> {
  const started = Date.now();
  try {
    const result = await provider.classify(event);
    if (!Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1 || !routes.includes(result.route)) {
      throw new AtlasError('INVALID_CLASSIFICATION', 'PERMANENT', { requestedModel: result.requestedModel ?? '', responseModel: result.responseModel ?? '' });
    }
    return { result, error: null, details: {}, latencyMs: Date.now() - started };
  } catch (error) {
    return { result: null, error: safeErrorCode(error), details: errorDetails(error), latencyMs: Date.now() - started };
  }
}

export interface RunDraft { provider: Provider; mode: DecisionMode; result: Classification | null; error: string | null; latencyMs: number; details: Record<string, string> }
export interface DecisionDraft { classification: Classification; runs: RunDraft[]; appliedRun: number; shadowPending: boolean }

/**
 * Shadow: the rules baseline is the applied decision at once (urgent evidence never waits for an experiment) and the AI
 * call follows separately. Otherwise the provider decides; if it fails, the advisory contract (docs/04) applies: a FAILED
 * run plus an applied rules run routing to HUMAN_REVIEW — never a silent rules route.
 */
export async function draftDecision(provider: DecisionProvider, config: DecisionConfig, event: NormalizedEvent): Promise<DecisionDraft> {
  if (provider.mode === 'shadow') {
    const baseline = rulesBaseline(event, config.promptVersion);
    return { classification: baseline, runs: [{ provider: 'rules', mode: 'shadow', result: baseline, error: null, latencyMs: 0, details: {} }], appliedRun: 0, shadowPending: true };
  }
  const call = await callProvider(provider, event);
  const modelRun: RunDraft = { provider: provider.provider, mode: provider.mode, result: call.result, error: call.error, latencyMs: call.latencyMs, details: call.details };
  if (call.result) return { classification: call.result, runs: [modelRun], appliedRun: 0, shadowPending: false };
  const fallback: Classification = { route: 'HUMAN_REVIEW', confidence: 0, provider: 'rules', promptVersion: config.promptVersion,
    reasonCodes: ['PROVIDER_UNAVAILABLE_OR_INVALID', call.error ?? 'UNKNOWN'] };
  return { classification: fallback, runs: [modelRun, { provider: 'rules', mode: provider.mode, result: fallback, error: null, latencyMs: 0, details: {} }],
    appliedRun: 1, shadowPending: false };
}

export interface RouteInputs {
  classification: Classification; entityId: string | null; linkConflictCode: string | null; conflictOfEventKey: string | null;
  sourceSeverity: Severity; confidenceThreshold: number;
}
/** Deterministic rules after the model, in order: conflicts → low confidence → unresolved device → source urgency floor. */
export function finalRoute(input: RouteInputs): { route: Route; reasonCodes: string[] } {
  const reasonCodes: string[] = [];
  if (input.conflictOfEventKey) reasonCodes.push('REVISION_PAYLOAD_CONFLICT');
  if (input.linkConflictCode) reasonCodes.push(input.linkConflictCode);
  reasonCodes.push(...input.classification.reasonCodes);
  let route = input.classification.route;
  if (input.classification.provider !== 'rules' && input.classification.confidence < input.confidenceThreshold) { route = 'HUMAN_REVIEW'; reasonCodes.push('LOW_CONFIDENCE'); }
  if (input.conflictOfEventKey || input.linkConflictCode) route = 'HUMAN_REVIEW';
  else if (!input.entityId) { route = 'HUMAN_REVIEW'; reasonCodes.push('UNRESOLVED_DEVICE'); }
  if (priorityOf(input.sourceSeverity) === 'URGENT') { route = 'HUMAN_REVIEW'; reasonCodes.push('SOURCE_URGENCY_FLOOR'); }
  return { route, reasonCodes };
}
