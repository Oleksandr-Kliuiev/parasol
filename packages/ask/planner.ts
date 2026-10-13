import { ASK_INTENTS, ASK_LIMITS, askFailure } from './contracts.ts';
import type { AskIntent } from './contracts.ts';
import type { AskDescriptor } from './projection.ts';
import { selectRefs } from './selector.ts';

/**
 * Private planner contract (docs/stage5/ask/02_CONTRACTS.md "Local planner and answer compiler"). The planner sees the
 * original question (local MOCK only), server-derived eligibility refs and enum-only descriptors; it has no DB, network,
 * credential, Gateway or registry, and its output is untrusted until validatePlan accepts it as a whole. The question is
 * never authority or an instruction. In-process DI may replace the MOCK planner for synthetic tests (ASK_PLANNER token);
 * there is no HTTP switch, environment-selected module or public registry.
 */
export interface AskPlannerInputV1 {
  readonly question: string;
  readonly focusRef: string | null;
  readonly focusResourceRef: string | null;
  readonly focusEntityRef: string | null;
  readonly bank: readonly AskDescriptor[];
}
export interface AskPlanV1 { readonly version: 'AskPlanV1'; readonly intent: AskIntent; readonly refs: readonly string[] }
export interface AskPlanner { plan(input: AskPlannerInputV1, signal: AbortSignal): Promise<unknown> }
/** Nest injection token of the planner; the API binds MOCK_PLANNER unless an in-process test module supplies another. */
export const ASK_PLANNER = 'atlas.ask.planner';

/** Documented RU/EN MOCK phrases: exact case-insensitive match after trim and optional removal of one final '?'. */
export const MOCK_PHRASES: Readonly<Record<string, AskIntent>> = Object.freeze({
  'what needs attention': 'SUMMARY', 'что требует внимания': 'SUMMARY',
  'why is this urgent': 'WHY_URGENT', 'почему это срочно': 'WHY_URGENT',
  'how fresh is the evidence': 'SOURCE_STATE', 'насколько свежи данные': 'SOURCE_STATE',
  'which device is confirmed': 'ENTITY', 'какое устройство подтверждено': 'ENTITY'
});
export function mockIntent(question: string): AskIntent {
  let phrase = question.trim().toLowerCase();
  if (phrase.endsWith('?')) phrase = phrase.slice(0, -1);
  return Object.hasOwn(MOCK_PHRASES, phrase) ? MOCK_PHRASES[phrase]! : 'UNSUPPORTED';
}

/** Deterministic MOCK selection: SUMMARY first ≤8 observations (else ≤8 resources); focus intents their one server ref or []. */
export function mockPlan(input: AskPlannerInputV1): AskPlanV1 {
  const intent = mockIntent(input.question);
  return { version: 'AskPlanV1', intent, refs: selectRefs(intent, input) };
}
export const MOCK_PLANNER: AskPlanner = Object.freeze({ plan: async (input: AskPlannerInputV1) => mockPlan(input) });

const PLAN_KEYS = ['intent', 'refs', 'version'];
/**
 * Whole-plan acceptance: a plain object with exactly version/intent/refs, a known intent, ≤8 unique refs of THIS request's
 * bank. Unknown version/enum/ref, wrong type, duplicate or any extra key (prose, URL, tool, parameters) → ASK_PLANNER_INVALID.
 * The result is a fresh frozen copy; nothing of the planner's object is retained.
 */
export function validatePlan(raw: unknown, bankRefs: ReadonlySet<string>): AskPlanV1 {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return askFailure('ASK_PLANNER_INVALID');
  const keys = Object.keys(raw).sort();
  if (keys.length !== PLAN_KEYS.length || keys.some((key, i) => key !== PLAN_KEYS[i])) return askFailure('ASK_PLANNER_INVALID');
  const { version, intent, refs } = raw as Record<string, unknown>;
  if (version !== 'AskPlanV1' || typeof intent !== 'string' || !(ASK_INTENTS as readonly string[]).includes(intent) || !Array.isArray(refs)
    || refs.length > ASK_LIMITS.planRefs) return askFailure('ASK_PLANNER_INVALID');
  const copy: string[] = [];
  for (let i = 0; i < refs.length; i += 1) {
    const ref: unknown = refs[i];
    if (typeof ref !== 'string' || !bankRefs.has(ref) || copy.includes(ref)) return askFailure('ASK_PLANNER_INVALID');
    copy.push(ref);
  }
  return Object.freeze({ version: 'AskPlanV1', intent: intent as AskIntent, refs: Object.freeze(copy) });
}
