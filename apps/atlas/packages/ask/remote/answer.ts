import { ASK_LIMITS, askFailure } from '../contracts.ts';
import type { AskIntent } from '../contracts.ts';
import { answer, compile } from '../compiler.ts';
import type { AnswerFrame } from '../compiler.ts';
import { validatePlan } from '../planner.ts';
import type { AskProjection } from '../projection.ts';
import { selectRefs } from '../selector.ts';
import { ASK_REMOTE_PROVENANCE } from './contracts.ts';
import type { AskAnswerV2 } from './contracts.ts';

/**
 * Local facts of a remote answer (docs/stage5/ask/remote/03 "Deterministic local selection", 02 "Remote answer"). The
 * provider supplied ONLY the five-enum intent: references come from the shared deterministic selector over this request's
 * validated descriptors and server focus refs, then the unchanged whole-plan validator and claim compiler decide claims,
 * coverage, all-bank urgency and evidence exactly as for MOCK. The V2 answer is the exact 15 V1 keys (contractVersion
 * AskAnswerV2, mode remote, sourceMode db) plus the fixed provenance; no upstream model string, usage or text exists here.
 */
export function remoteAnswer(intent: AskIntent, frame: AnswerFrame, projection: AskProjection, requestedFocus: string | null): { json: string; status: AskAnswerV2['status'] } {
  if (frame.sourceMode !== 'db') return askFailure('ASK_RUNTIME_NOT_READY');
  // The same selection input the MOCK planner receives: server focus refs and the enum-only descriptors of this bank.
  const selection = { focusRef: projection.focusRef, focusResourceRef: projection.focusResourceRef, focusEntityRef: projection.focusEntityRef,
    bank: projection.descriptors };
  const plan = validatePlan({ version: 'AskPlanV1', intent, refs: selectRefs(intent, selection) }, new Set(projection.bank.map(f => f.ref)));
  const compiled = compile(plan, projection, requestedFocus);
  const v1 = answer(frame, compiled, projection);
  const v2: AskAnswerV2 = { contractVersion: 'AskAnswerV2', requestId: v1.requestId, correlationId: v1.correlationId, workspaceId: v1.workspaceId,
    clientId: v1.clientId, mode: 'remote', sourceMode: v1.sourceMode, status: v1.status, intent: v1.intent, generatedAt: v1.generatedAt,
    focusObservationId: v1.focusObservationId, coverage: v1.coverage, urgentRefs: v1.urgentRefs, claims: v1.claims, evidence: v1.evidence,
    provenance: { ...ASK_REMOTE_PROVENANCE } };
  const json = JSON.stringify(v2);
  if (Buffer.byteLength(json, 'utf8') > ASK_LIMITS.responseBytes) return askFailure('ASK_TOO_LARGE');
  return { json, status: compiled.status };
}
