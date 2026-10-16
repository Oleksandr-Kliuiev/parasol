import { randomUUID } from 'node:crypto';
import { ASK_CAPABILITY, ASK_HTTP_STATUS, ASK_LIMITS, AskFailure, askErrorBody, askFailure, isAskFailure } from './contracts.ts';
import type { AskErrorCode, AskStatus, SourceMode } from './contracts.ts';
import { AskDeadline } from './budget.ts';
import type { AskOwner } from './budget.ts';
import type { AskCredential } from './credential.ts';
import type { AskAuditOutcome } from './audit.ts';
import { askRequest } from './input.ts';
import { project } from './projection.ts';
import type { AskProjection } from './projection.ts';
import { validatePlan } from './planner.ts';
import type { AskPlanner } from './planner.ts';
import { answer, compile } from './compiler.ts';
import type { AskSourceRead, Scope } from './source.ts';

/**
 * Orchestration of one enabled Ask request (docs/stage5/ask/03 order and terminal-outcome matrix), shared by the fixture
 * and the DB ports. Order: [ingress owner + raw parse, apps/api/src/ask-http.ts] → private authentication 401 → POST
 * exact body 400 → bind the SAME owner to the actor 429 → phase1 fenced current authority (401/403/404/429, source read) →
 * projection → planner (≤2 s, abort is courtesy) → whole-plan validation + compile + bounded pre-serialization →
 * phase2 fenced re-admission + final audit → publish. The same original deadline is checked before and after every step;
 * a late result is discarded. Once the run is terminal (public timeout/disconnect), no new phase, read or audit starts.
 */
export class AskStopped extends Error { constructor() { super('ASK_STOPPED'); this.name = 'AskStopped'; } }

export class AskRun {
  readonly owner: AskOwner;
  readonly deadline: AskDeadline;
  readonly correlationId: string = randomUUID();
  readonly #abort = new AbortController();
  #terminal = false;
  constructor(owner: AskOwner, deadline: AskDeadline = new AskDeadline()) { this.owner = owner; this.deadline = deadline; }
  get terminal(): boolean { return this.#terminal; }
  get signal(): AbortSignal { return this.#abort.signal; }
  /** Public terminal state (published, timed out or disconnected): every later step stops; underlying work drains. */
  end(): void {
    if (this.#terminal) return;
    this.#terminal = true;
    this.#abort.abort();
  }
  check(): void {
    if (this.#terminal) throw new AskStopped();
    if (this.deadline.expired()) askFailure('ASK_DEADLINE');
  }
}

export interface AskIdentity { readonly workspaceId: string; readonly actorId: string }
export interface AskAdmission { readonly scope: Scope; readonly epoch: string; readonly source: AskSourceRead }
/** One authority/source implementation (DB or synthetic fixture). Every method throws AskFailure codes only. */
export interface AskPort {
  readonly sourceMode: SourceMode;
  credential(authorization: unknown): AskCredential | null;
  authenticate(run: AskRun, credential: AskCredential): Promise<AskIdentity | null>;
  admit(run: AskRun, identity: AskIdentity, credential: AskCredential, clientId: string, focusId: string | null): Promise<AskAdmission>;
  publish(run: AskRun, identity: AskIdentity, credential: AskCredential, admission: AskAdmission, outcome: AskAuditOutcome): Promise<void>;
}
export interface AskReply { readonly status: number; readonly json: string; readonly unexpected?: true }

const errorReply = (run: AskRun, code: AskErrorCode, unexpected = false): AskReply =>
  ({ status: ASK_HTTP_STATUS[code], json: JSON.stringify(askErrorBody(code, run.correlationId)), ...(unexpected ? { unexpected: true as const } : {}) });
/** Fixed reply of a failure; AskStopped propagates (nothing is published after the terminal state). */
function failureReply(run: AskRun, error: unknown): AskReply {
  if (error instanceof AskStopped) throw error;
  return isAskFailure(error) ? errorReply(run, error.code) : errorReply(run, 'ASK_RUNTIME_NOT_READY', true);
}
async function step<T>(run: AskRun, work: () => Promise<T>): Promise<T> {
  run.check();
  const value = await work();
  run.check();
  return value;
}
const required = <T>(value: T | null, code: AskErrorCode): T => value === null ? askFailure(code) : value;

/** GET /ask/capabilities: same ingress/raw/auth/actor ownership path; no phase1, source or audit; never charges a question. */
export async function runCapability(run: AskRun, port: AskPort, authorization: unknown): Promise<AskReply> {
  try {
    run.check();
    const credential = required(port.credential(authorization), 'ASK_AUTHENTICATION_FAILED');
    const identity = required(await step(run, () => port.authenticate(run, credential)), 'ASK_AUTHENTICATION_FAILED');
    if (run.owner.bind(identity.workspaceId, identity.actorId, false) !== 'BOUND') askFailure('ASK_BUSY');
    run.check();
    return { status: 200, json: JSON.stringify(ASK_CAPABILITY) };
  } catch (error) { return failureReply(run, error); }
}

type Planned = { readonly plan: unknown } | { readonly code: AskErrorCode };
/** ≤2 s and the remaining budget; the planner promise stays held by the owner until it actually settles. */
async function runPlanner(run: AskRun, planner: AskPlanner, question: string, projection: AskProjection): Promise<Planned> {
  run.check();
  const ms = run.deadline.phase(ASK_LIMITS.plannerMs);
  const controller = new AbortController();
  const stop = () => controller.abort();
  run.signal.addEventListener('abort', stop, { once: true });
  const input = Object.freeze({ question, focusRef: projection.focusRef, focusResourceRef: projection.focusResourceRef,
    focusEntityRef: projection.focusEntityRef, bank: Object.freeze(projection.descriptors.map(d => Object.freeze({ ...d }))) });
  const work = Promise.resolve().then(() => planner.plan(input, controller.signal));
  run.owner.hold(work);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Planned>(resolve => { timer = setTimeout(() => resolve({ code: 'ASK_DEADLINE' }), ms); });
  try {
    const result = await Promise.race([work.then((plan): Planned => ({ plan }), (): Planned => ({ code: 'ASK_PLANNER_INVALID' })), timeout]);
    if ('code' in result && result.code === 'ASK_DEADLINE') controller.abort();
    return result;
  } finally {
    clearTimeout(timer);
    run.signal.removeEventListener('abort', stop);
  }
}

export interface QuestionInput { readonly authorization: unknown; readonly clientId: string; readonly body: unknown }
type Candidate = { readonly json: string; readonly status: AskStatus } | { readonly code: AskErrorCode };

/** POST /clients/:id/ask. Always resolves with the reply to publish, or throws AskStopped after the terminal state. */
export async function runQuestion(run: AskRun, port: AskPort, planner: AskPlanner, input: QuestionInput): Promise<AskReply> {
  let identity, credential, request, admission, projection;
  try {
    run.check();
    credential = required(port.credential(input.authorization), 'ASK_AUTHENTICATION_FAILED');
    const authenticated = credential;
    identity = required(await step(run, () => port.authenticate(run, authenticated)), 'ASK_AUTHENTICATION_FAILED');
    request = askRequest(input.body);
    if (run.owner.bind(identity.workspaceId, identity.actorId, true) !== 'BOUND') askFailure('ASK_BUSY');
    const admitted = identity; const focus = request.observationId;
    admission = await step(run, () => port.admit(run, admitted, authenticated, input.clientId, focus));
    projection = project(admission.source);
    run.check();
  } catch (error) { return failureReply(run, error); }

  let candidate: Candidate;
  try {
    const planned = await runPlanner(run, planner, request.question, projection);
    run.check(); // an exhausted original budget publishes 504 with no new final transaction
    if ('code' in planned) candidate = { code: planned.code };
    else {
      const plan = validatePlan(planned.plan, new Set(projection.bank.map(f => f.ref)));
      const compiled = compile(plan, projection, request.observationId);
      const body = answer({ requestId: request.requestId, correlationId: run.correlationId, workspaceId: admission.scope.workspaceId,
        clientId: admission.scope.clientId, sourceMode: port.sourceMode, focusObservationId: request.observationId,
        generatedAt: new Date().toISOString() }, compiled, projection);
      const json = JSON.stringify(body);
      candidate = Buffer.byteLength(json, 'utf8') > ASK_LIMITS.responseBytes ? { code: 'ASK_TOO_LARGE' } : { json, status: compiled.status };
    }
    run.check();
  } catch (error) {
    if (error instanceof AskStopped || (error instanceof AskFailure && error.code === 'ASK_DEADLINE')) return failureReply(run, error);
    candidate = { code: isAskFailure(error) ? error.code : 'ASK_PLANNER_INVALID' };
  }

  const itemCount = projection.bank.length;
  const outcome: AskAuditOutcome = 'json' in candidate ? { event: 'completed', status: candidate.status, itemCount } : { event: 'failed', code: candidate.code, itemCount };
  try {
    const [who, key, admitted] = [identity, credential, admission];
    await step(run, () => port.publish(run, who, key, admitted, outcome));
  } catch (error) { return failureReply(run, error); }
  return 'json' in candidate ? { status: 200, json: candidate.json } : errorReply(run, candidate.code);
}
