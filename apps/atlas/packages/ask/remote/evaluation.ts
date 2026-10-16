import type { PhaseSql } from '../phase.ts';
import type { AskIdentity } from '../service.ts';
import type { Scope } from '../source.ts';
import type { AskRequestV2 } from './contracts.ts';

/**
 * Optional hooks of ONE registered-sandbox evaluation task (R-EVAL RS-C-A, docs/stage5/ask/remote/reval-server/04/06,
 * rs-c/IMPLEMENTATION_BRIEF.md §4). They exist ONLY for a request whose measured evaluation arm was claimed at ingress in the
 * controller-launched bridge server; every ordinary OFF/MOCK/REMOTE request passes none and keeps its accepted behavior.
 * The hooks observe and refuse; they never supply authority, a permission, a scope, money or a provider call.
 */
export interface EvaluationPhases {
  /** phase1, inside the fenced scoped transaction before the source read: binding generation must equal the arm's; returns the
   *  pinned source-only reference used as `readDbSource`'s resource-age `now` (every other clock stays real). */
  phase1(sql: PhaseSql, scope: Scope): Promise<Date>;
  /** egress and phase2: the binding generation is still the arm's (else ASK_SCOPE_CHANGED). */
  recheck(sql: PhaseSql, scope: Scope): Promise<void>;
}
export type EvaluationFault = 'MODEL_OR_TIER_MISMATCH' | 'USAGE_INVALID' | 'UPSTREAM_AUTH' | 'UPSTREAM_INVALID';
export interface EvaluationTask {
  /** After ordinary authentication: exact registered workspace/client/actor equality (ASK_SCOPE_DENIED before phase1). */
  authenticated(identity: AskIdentity, clientId: string, correlationId: string): void;
  /** After exact V2 validation: the arm's fixed focus equality (ASK_REQUEST_INVALID) and capture of the EXACT parsed body the
   *  server received (`raw`, the wire form the browser must echo; never the normalized internal request). */
  request(request: AskRequestV2, raw: unknown): void;
  readonly phases: EvaluationPhases;
  reservation(outcome: 'COMMITTED' | 'COMMIT_UNKNOWN', attemptId: string | null): void;
  /** Called synchronously at the accepted verdict, BEFORE settlement/publication/pause are awaited. */
  fault(fault: EvaluationFault): void;
  settlement(outcome: 'CONFIRMED' | 'FAILED_KNOWN' | 'COMMIT_UNKNOWN'): void;
}
