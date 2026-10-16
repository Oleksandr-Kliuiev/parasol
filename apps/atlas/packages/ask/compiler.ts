import { askFailure } from './contracts.ts';
import type { AskAnswerV1, AskClaim, AskIntent, AskStatus, BankFact, ClaimCode, SourceMode } from './contracts.ts';
import { isUrgent } from './projection.ts';
import type { AskProjection } from './projection.ts';
import type { AskPlanV1 } from './planner.ts';

/**
 * The compiler alone derives claims (docs/stage5/ask/02_CONTRACTS.md matrix). It re-checks every predicate on the fact
 * DATA itself — never trusting that a ref merely equals a server eligibility ref:
 *   SUMMARY       1..8 OBSERVATION/RESOURCE_STATE → OBSERVATION_RECORDED / RESOURCE_RECORDED, one per ref, plan order;
 *   WHY_URGENT    exactly one OBSERVATION whose observationId is the requested focus → SOURCE_URGENT iff HIGH/CRITICAL,
 *                 else SOURCE_NOT_URGENT_IN_READ;
 *   SOURCE_STATE  exactly one RESOURCE_STATE with the focus observation's source/resourceType/non-null connectionId;
 *   ENTITY        exactly one ENTITY whose observationId is the requested focus → ENTITY_<validated state>;
 *   UNSUPPORTED   exactly zero refs.
 * A supported intent with empty refs is INSUFFICIENT (0 claims). Anything else is ASK_PLANNER_INVALID: wrong kind, extra
 * refs, an unrelated ref in place of a missing focus fact, or nonempty UNSUPPORTED. No free text exists to compile.
 */
export interface Compiled { readonly status: AskStatus; readonly intent: AskIntent; readonly claims: readonly AskClaim[] }

function invalidPlan(): never { return askFailure('ASK_PLANNER_INVALID'); }
const single = (refs: readonly string[]): string => refs.length === 1 ? refs[0]! : invalidPlan();

export function compile(plan: AskPlanV1, projection: AskProjection, requestedFocus: string | null): Compiled {
  const facts = new Map(projection.bank.map(f => [f.ref, f] as const));
  const fact = (ref: string): BankFact => facts.get(ref) ?? invalidPlan();
  const claim = (code: ClaimCode, ref: string): AskClaim => ({ code, refs: [ref] });
  if (plan.intent === 'UNSUPPORTED') {
    if (plan.refs.length !== 0) invalidPlan();
    return { status: 'UNSUPPORTED', intent: 'UNSUPPORTED', claims: [] };
  }
  if (plan.refs.length === 0) return { status: 'INSUFFICIENT', intent: plan.intent, claims: [] };
  const focusObservation = requestedFocus === null ? undefined
    : projection.bank.find(f => f.kind === 'OBSERVATION' && f.data.observationId === requestedFocus);
  let claims: AskClaim[];
  if (plan.intent === 'SUMMARY') {
    if (plan.refs.length > 8) invalidPlan();
    claims = plan.refs.map(ref => {
      const f = fact(ref);
      if (f.kind === 'OBSERVATION') return claim('OBSERVATION_RECORDED', ref);
      if (f.kind === 'RESOURCE_STATE') return claim('RESOURCE_RECORDED', ref);
      return invalidPlan();
    });
  } else if (plan.intent === 'WHY_URGENT') {
    const ref = single(plan.refs); const f = fact(ref);
    if (f.kind !== 'OBSERVATION' || requestedFocus === null || f.data.observationId !== requestedFocus) invalidPlan();
    claims = [claim(isUrgent(f.data.severity) ? 'SOURCE_URGENT' : 'SOURCE_NOT_URGENT_IN_READ', ref)];
  } else if (plan.intent === 'SOURCE_STATE') {
    const ref = single(plan.refs); const f = fact(ref);
    if (f.kind !== 'RESOURCE_STATE' || !focusObservation || focusObservation.kind !== 'OBSERVATION') invalidPlan();
    const o = focusObservation.data;
    if (f.data.source !== o.source || f.data.resourceType !== o.resourceType || f.data.connectionId !== o.connectionId) invalidPlan();
    claims = [claim('RESOURCE_RECORDED', ref)];
  } else {
    const ref = single(plan.refs); const f = fact(ref);
    if (f.kind !== 'ENTITY' || requestedFocus === null || f.data.observationId !== requestedFocus) invalidPlan();
    claims = [claim(f.data.state === 'CONFIRMED' ? 'ENTITY_CONFIRMED' : f.data.state === 'UNAVAILABLE' ? 'ENTITY_UNAVAILABLE' : 'ENTITY_UNRESOLVED', ref)];
  }
  if (claims.length !== plan.refs.length || new Set(claims.map(c => c.refs[0])).size !== claims.length) invalidPlan();
  return { status: 'ANSWER', intent: plan.intent, claims };
}

/** Independent mandatory urgency notice: exactly every HIGH/CRITICAL observation fact of the bank, in bank order. */
export const urgentRefs = (bank: readonly BankFact[]): string[] =>
  bank.filter(f => f.kind === 'OBSERVATION' && isUrgent(f.data.severity)).map(f => f.ref);

export interface AnswerFrame {
  readonly requestId: string; readonly correlationId: string; readonly workspaceId: string; readonly clientId: string;
  readonly sourceMode: SourceMode; readonly focusObservationId: string | null; readonly generatedAt: string;
}
/** The exact AskAnswerV1 projection (fresh object, contract key order). Evidence/coverage/urgency for EVERY status. */
export function answer(frame: AnswerFrame, compiled: Compiled, projection: AskProjection): AskAnswerV1 {
  return {
    contractVersion: 'AskAnswerV1', requestId: frame.requestId, correlationId: frame.correlationId, workspaceId: frame.workspaceId,
    clientId: frame.clientId, mode: 'mock', sourceMode: frame.sourceMode, status: compiled.status, intent: compiled.intent,
    generatedAt: frame.generatedAt, focusObservationId: frame.focusObservationId, coverage: { ...projection.coverage },
    urgentRefs: urgentRefs(projection.bank), claims: compiled.claims.map(c => ({ code: c.code, refs: [c.refs[0]] })),
    evidence: projection.bank.map(f => structuredClone(f))
  };
}
