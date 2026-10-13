import { ASK_LIMITS } from './contracts.ts';
import type { AskIntent } from './contracts.ts';
import type { AskDescriptor } from './projection.ts';

/**
 * Deterministic local reference selection (docs/stage5/ask/02 "Local planner"; remote 03 "Deterministic local selection"),
 * extracted unchanged from the accepted MOCK planner and shared by MOCK and ASK-REMOTE. Input is the already validated
 * request-local descriptors and server focus refs; the intent is the only choice made elsewhere (MOCK phrase or remote
 * enum). SUMMARY: first ≤8 OBSERVATION refs, else first ≤8 RESOURCE_STATE refs; WHY_URGENT: the focus observation ref or [];
 * SOURCE_STATE: the focus resource ref or []; ENTITY: the focus entity ref or []; UNSUPPORTED: []. The whole-plan validator
 * and the claim compiler stay authoritative.
 */
export interface SelectionInput {
  readonly focusRef: string | null;
  readonly focusResourceRef: string | null;
  readonly focusEntityRef: string | null;
  readonly bank: readonly AskDescriptor[];
}

export function selectRefs(intent: AskIntent, input: SelectionInput): string[] {
  const one = (ref: string | null) => ref === null ? [] : [ref];
  if (intent === 'SUMMARY') {
    const observations = input.bank.filter(d => d.kind === 'OBSERVATION').map(d => d.ref);
    return (observations.length > 0 ? observations : input.bank.filter(d => d.kind === 'RESOURCE_STATE').map(d => d.ref)).slice(0, ASK_LIMITS.planRefs);
  }
  if (intent === 'WHY_URGENT') return one(input.focusRef);
  if (intent === 'SOURCE_STATE') return one(input.focusResourceRef);
  if (intent === 'ENTITY') return one(input.focusEntityRef);
  return [];
}
