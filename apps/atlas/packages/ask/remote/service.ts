import { askErrorBody, askFailure } from '../contracts.ts';
import type { AskStatus } from '../contracts.ts';
import { project } from '../projection.ts';
import type { AskProjection } from '../projection.ts';
import { AskStopped } from '../service.ts';
import type { AskIdentity, AskReply, AskRun, QuestionInput } from '../service.ts';
import type { AskCredential } from '../credential.ts';
import type { PauseReason } from './budget.ts';
import { PROVIDER_PHASE_MS, PUBLICATION_FLOOR_MS, EGRESS_FLOOR_MS, capabilityV2, decidedCode, remoteStatus } from './contracts.ts';
import type { AskRequestV2, RemoteAuditOutcome, RemoteReplyCode } from './contracts.ts';
import { RemoteCircuit } from './circuit.ts';
import { askRemoteRequest } from './input.ts';
import { preparePayload } from './payload.ts';
import { bindTaskDeadline, capabilityAttempt, dispatchIntent, proveNoDispatch } from './dispatch.ts';
import type { DispatchCapability, ProviderVerdict } from './dispatch.ts';
import { remoteAnswer } from './answer.ts';
import type { RemoteAdmission, RemoteAskPort } from './db.ts';
import type { RemoteSeams } from './secret.ts';
import type { EvaluationFault, EvaluationTask } from './evaluation.ts';
import { EgressUnknown, SettlementUnknown } from './db.ts';

/**
 * ASK-REMOTE orchestration of one request (docs/stage5/ask/remote/02/03/04), on the SAME ingress-owned AskRun/AskOwner and
 * original 8 s deadline as MOCK: private authentication 401 → exact AskRequestV2 400 (V1 refused) → bind 429 → phase1
 * (all-of context:read+ask:remote, consent tuple, active admission, local circuit, rolling charge, source read) → finalized
 * bank → immutable question-only payload (≤16 KiB, 413) → egress COMMIT (mints the private dispatch capability) → terminal/
 * floor/circuit check immediately before consumption (else proven no-dispatch) → ONE provider phase → financial settlement
 * on its own clock (pre-publication wait ≤ remaining − 500 ms; the transaction itself drains held by the owner) → phase2
 * current authority/policy + final audit → V2 answer or fixed AskErrorV1. A configuration fault (model/tier/usage mismatch,
 * upstream 401/403) closes the local circuit at detection; the durable pause runs after phase2 (or at once when nothing is
 * published), held by the owner. A deadline after phase1 publishes 504 without a new final transaction (as MOCK); terminal
 * publishes nothing. No retry, fallback to MOCK/phrases or UNSUPPORTED substitution on any failure.
 */
export interface RemoteDeps { readonly port: RemoteAskPort; readonly seams: RemoteSeams; readonly circuit: RemoteCircuit }

const reply = (run: AskRun, code: RemoteReplyCode, unexpected = false): AskReply =>
  ({ status: remoteStatus(code), json: JSON.stringify(askErrorBody(code as never, run.correlationId)), ...(unexpected ? { unexpected: true as const } : {}) });
function failureReply(run: AskRun, error: unknown): AskReply {
  if (error instanceof AskStopped) throw error;
  const code = decidedCode(error);
  return code === null ? reply(run, 'ASK_RUNTIME_NOT_READY', true) : reply(run, code);
}
async function step<T>(run: AskRun, work: () => Promise<T>): Promise<T> {
  run.check();
  const value = await work();
  run.check();
  return value;
}
const required = <T>(value: T | null): T => value === null ? askFailure('ASK_AUTHENTICATION_FAILED') : value;

/** GET /ask/capabilities in REMOTE: same ingress/auth/actor ownership, then the bounded workspace-policy read only. */
export async function runRemoteCapability(run: AskRun, deps: RemoteDeps, authorization: unknown): Promise<AskReply> {
  try {
    run.check();
    const credential = required(deps.port.credential(authorization));
    const identity = required(await step(run, () => deps.port.authenticate(run, credential)));
    if (run.owner.bind(identity.workspaceId, identity.actorId, false) !== 'BOUND') askFailure('ASK_BUSY');
    const tuple = await step(run, () => deps.port.capability(run, identity, credential));
    return { status: 200, json: JSON.stringify(capabilityV2(tuple.admissionId, tuple.policyVersion)) };
  } catch (error) { return failureReply(run, error); }
}

type Candidate = { readonly json: string; readonly status: AskStatus } | { readonly code: RemoteReplyCode };
interface Fault { readonly reason: PauseReason }
/** Public code and configuration fault of a provider verdict (never derived from upstream text). */
function verdictCode(verdict: ProviderVerdict): { code: RemoteReplyCode | null; fault: Fault | null } {
  switch (verdict.kind) {
    case 'INTENT': return { code: null, fault: null };
    case 'MODEL_MISMATCH': return { code: 'ASK_REMOTE_MODEL_MISMATCH', fault: { reason: 'MODEL_MISMATCH' } };
    case 'USAGE_INVALID': return { code: 'ASK_REMOTE_USAGE_INVALID', fault: { reason: 'USAGE_INVALID' } };
    case 'UPSTREAM': return { code: 'ASK_REMOTE_UNAVAILABLE', fault: verdict.auth ? { reason: 'UPSTREAM_AUTH' } : null };
    case 'INVALID': case 'MALFORMED': case 'OVERFLOW': return { code: 'ASK_REMOTE_INVALID', fault: null };
    // RC2 R1: the original floor (or terminal) reached at the consumption gate is a deadline, not an unavailable provider.
    case 'NOT_SENT': return { code: verdict.reason === 'KEY' ? 'ASK_REMOTE_UNAVAILABLE' : 'ASK_DEADLINE', fault: null };
    default: return { code: 'ASK_REMOTE_UNAVAILABLE', fault: null };
  }
}

interface Flow { readonly run: AskRun; readonly deps: RemoteDeps; readonly identity: AskIdentity; readonly credential: AskCredential;
  readonly request: AskRequestV2; readonly admission: RemoteAdmission; readonly projection: AskProjection; readonly evaluation?: EvaluationTask }
/** R-EVAL RS-C-A: the fixed detected fault of a decided verdict (06 terminal observation); generic UNAVAILABLE is none. */
/** RS-C-A rc2 (review F10): an evaluation OBSERVATION hook can never alter the accepted flow (settlement, pause, circuit, reply). */
const observe = (fn: () => void): void => { try { fn(); } catch { /* bookkeeping only: the accepted path continues unchanged */ } };
function evaluationFault(code: RemoteReplyCode | null, fault: Fault | null): EvaluationFault | null {
  if (fault?.reason === 'MODEL_MISMATCH') return 'MODEL_OR_TIER_MISMATCH';
  if (fault?.reason === 'USAGE_INVALID') return 'USAGE_INVALID';
  if (fault?.reason === 'UPSTREAM_AUTH') return 'UPSTREAM_AUTH';
  return code === 'ASK_REMOTE_INVALID' ? 'UPSTREAM_INVALID' : null;
}

/** Settlement drains on its own clock; the caller waits at most remaining − 500 ms (none once terminal). Never retried. */
async function settle(flow: Flow, capability: DispatchCapability): Promise<void> {
  const { run, deps } = flow;
  const work = deps.port.settle(work => run.owner.hold(work), capability);
  const evaluation = flow.evaluation;
  if (evaluation) void work.then(() => observe(() => evaluation.settlement('CONFIRMED')),
    e => observe(() => evaluation.settlement(e instanceof SettlementUnknown ? 'COMMIT_UNKNOWN' : 'FAILED_KNOWN')));
  run.owner.hold(work.catch(() => undefined));
  const wait = run.terminal ? 0 : Math.floor(run.deadline.remaining() - PUBLICATION_FLOOR_MS);
  if (wait < 1) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([work.catch(() => undefined), new Promise<void>(resolve => { timer = setTimeout(resolve, wait); })]);
  clearTimeout(timer);
}

/** Dispatch (or proven no-dispatch), circuit, settlement; returns the candidate and any configuration fault. */
async function provide(flow: Flow, capability: DispatchCapability): Promise<{ candidate: Candidate; fault: Fault | null; stopped: boolean }> {
  const { run, deps, admission, projection, request } = flow;
  const attempt = capabilityAttempt(capability)!;
  let verdict: ProviderVerdict = { kind: 'NOT_SENT', reason: 'FLOOR' };
  let early: RemoteReplyCode | null = null;
  // Before dispatch: terminal, original floor and the local circuit; otherwise proven no-dispatch. dispatchIntent re-checks
  // terminal and the original floor (task-bound) after key resolution, immediately before consumption (RC2 R1).
  if (run.terminal || run.deadline.remaining() < EGRESS_FLOOR_MS || !deps.circuit.allows(attempt.workspaceId, BigInt(attempt.policyVersion))) {
    early = run.terminal || run.deadline.remaining() < EGRESS_FLOOR_MS ? 'ASK_DEADLINE' : 'ASK_REMOTE_UNAVAILABLE';
    proveNoDispatch(capability);
  } else {
    try {
      verdict = await dispatchIntent(deps.seams, capability, run.signal, run.deadline.phase(PROVIDER_PHASE_MS), work => run.owner.hold(work));
    } catch { verdict = { kind: 'UNKNOWN' }; }
  }
  const mapped = early === null ? verdictCode(verdict) : { code: early, fault: null };
  if (mapped.fault !== null) deps.circuit.trip(attempt.workspaceId, BigInt(attempt.policyVersion));
  // R-EVAL RS-C-A: latch the detected fault synchronously at the verdict, before settlement/publication/pause are awaited.
  const detected = early === null ? evaluationFault(mapped.code, mapped.fault) : null;
  if (detected !== null) { const ev = flow.evaluation; if (ev) observe(() => ev.fault(detected)); }
  await settle(flow, capability);
  if (run.terminal) return { candidate: { code: 'ASK_DEADLINE' }, fault: mapped.fault, stopped: true };
  if (mapped.code !== null || verdict.kind !== 'INTENT') return { candidate: { code: mapped.code ?? 'ASK_REMOTE_INVALID' }, fault: mapped.fault, stopped: false };
  try {
    const compiled = remoteAnswer(verdict.intent, { requestId: request.requestId, correlationId: run.correlationId, workspaceId: admission.scope.workspaceId,
      clientId: admission.scope.clientId, sourceMode: 'db', focusObservationId: request.observationId, generatedAt: new Date().toISOString() },
    projection, request.observationId);
    return { candidate: compiled, fault: null, stopped: false };
  } catch (error) { return { candidate: { code: decidedCode(error) ?? 'ASK_PLANNER_INVALID' }, fault: null, stopped: false }; }
}

/** POST /clients/:id/ask in REMOTE. Resolves with the reply to publish, or throws AskStopped after the terminal state. */
export async function runRemoteQuestion(run: AskRun, deps: RemoteDeps, input: QuestionInput & { readonly evaluation?: EvaluationTask }): Promise<AskReply> {
  let flow: Flow;
  const evaluation = input.evaluation;
  try {
    run.check();
    const credential = required(deps.port.credential(input.authorization));
    const identity = required(await step(run, () => deps.port.authenticate(run, credential)));
    // R-EVAL RS-C-A (04 step 4): exact registered workspace/client/actor equality BEFORE phase1/source/reservation.
    evaluation?.authenticated(identity, input.clientId, run.correlationId);
    const request = askRemoteRequest(input.body);
    evaluation?.request(request, input.body);
    if (run.owner.bind(identity.workspaceId, identity.actorId, true) !== 'BOUND') askFailure('ASK_BUSY');
    const admission = await step(run, () => deps.port.admit(run, identity, credential, input.clientId, request.observationId, request.acknowledgement,
      (workspaceId, version) => deps.circuit.allows(workspaceId, version), evaluation?.phases));
    const projection = project(admission.source);
    run.check();
    flow = { run, deps, identity, credential, request, admission, projection, ...(evaluation ? { evaluation } : {}) };
  } catch (error) { return failureReply(run, error); }

  let candidate: Candidate;
  let fault: Fault | null = null;
  let attempt = null;
  try {
    // The ORIGINAL deadline becomes task-bound dispatch authority before any egress (dispatch.ts, RC2 R1).
    bindTaskDeadline(run.signal, run.deadline);
    const prepared = preparePayload({ question: flow.request.question, hasFocus: flow.projection.focusRef !== null });
    let capability: DispatchCapability;
    try { capability = await deps.port.egress(run, flow.identity, flow.credential, flow.admission, prepared, evaluation?.phases); }
    catch (error) { if (error instanceof EgressUnknown && evaluation) observe(() => evaluation.reservation('COMMIT_UNKNOWN', null)); throw error; }
    attempt = capabilityAttempt(capability);
    const attemptId = attempt?.attemptId ?? null;
    if (evaluation) observe(() => evaluation.reservation('COMMITTED', attemptId));
    const provided = await provide(flow, capability);
    fault = provided.fault;
    candidate = provided.candidate;
    if (provided.stopped) throw new AskStopped();
  } catch (error) {
    if (error instanceof AskStopped) { pauseLater(flow, attempt, fault); throw error; }
    candidate = { code: decidedCode(error) ?? 'ASK_REMOTE_UNAVAILABLE' };
  }
  // An exhausted/floored original budget publishes 504 with no new final transaction (accepted MOCK rule).
  if ('code' in candidate && candidate.code === 'ASK_DEADLINE') { pauseLater(flow, attempt, fault); return reply(run, 'ASK_DEADLINE'); }
  const itemCount = flow.projection.bank.length;
  const outcome: RemoteAuditOutcome = 'json' in candidate ? { event: 'completed', status: candidate.status, itemCount }
    : { event: 'failed', code: candidate.code, itemCount };
  try {
    await step(run, () => deps.port.publish(run, flow.identity, flow.credential, flow.admission, outcome, evaluation?.phases));
  } catch (error) {
    pauseLater(flow, attempt, fault);
    return failureReply(run, error);
  }
  pauseLater(flow, attempt, fault);
  return 'json' in candidate ? { status: 200, json: candidate.json } : reply(run, candidate.code);
}

/** The durable fence-first pause of a configuration fault: separate own-clock transaction, held by the owner; no retry. */
function pauseLater(flow: Flow, attempt: ReturnType<typeof capabilityAttempt>, fault: Fault | null): void {
  if (fault === null || attempt === null) return;
  const { run, deps } = flow;
  const work = deps.port.pause(w => run.owner.hold(w), attempt, fault.reason).then(version => deps.circuit.paused(attempt.workspaceId, version), () => undefined);
  run.owner.hold(work);
}
