import type { IncomingMessage, ServerResponse } from 'node:http';
import { askFailure } from '../ask/contracts.ts';
import { AskRemoteFailure } from '../ask/remote/contracts.ts';
import type { AskRequestV2 } from '../ask/remote/contracts.ts';
import type { EvaluationFault, EvaluationPhases, EvaluationTask } from '../ask/remote/evaluation.ts';
import type { AskIdentity } from '../ask/service.ts';
import type { GuardCensus } from './eval-census.ts';
import type { RegisteredScope } from './eval-db.ts';
import type { TerminalObserver } from './eval-observer.ts';
import type { EvaluationState } from './eval-state.ts';
import { isToken, newToken, PUBLIC_ERROR_STATUS } from './eval-wire.ts';
import type { Binding } from './eval-wire.ts';

/**
 * The registration-lifetime Ask ingress gate and the claimed task (04 "Registration lifetime and exact Ask ingress pipeline",
 * "The server must bind the actual values"). Synchronous header checks BEFORE body/bearer/DB/budget: the registered client's
 * question POST needs exactly one canonical evaluation-session header, exact same-origin Host/Origin and Fetch Metadata and
 * the accepted header-level request checks; then the token claims the pair's READY arm once. Capability or foreign-scope use
 * of the header is 400; OFF keeps its ordinary 404 (no gate exists). The claimed task enforces registered scope after
 * authentication, the arm's fixed focus after V2 validation and the arm's fixture generation in phase1/egress/phase2.
 */
export const SESSION_HEADER = 'x-atlas-evaluation-session';
export const RECEIPT_HEADER = 'X-Atlas-Evaluation-Receipt';
export interface GateContext {
  readonly reg: RegisteredScope; readonly serverBootId: string; readonly guardEpoch: string; readonly port: number;
  readonly state: EvaluationState; readonly observer: TerminalObserver;
  /** RS-D-A guard census: ingress at entry, publications, missing Bindings, reservations. */
  readonly census: GuardCensus;
  /** Frozen fixture facts of an armed case: requested focus (or null) of its fixture. */
  requestedFocus(fixtureId: string): string | null;
  phases(expectedGeneration: string): EvaluationPhases;
}
type Admission = { readonly kind: 'pass' } | { readonly kind: 'reject'; readonly code: string; readonly status: number }
  | { readonly kind: 'claimed'; readonly exchange: RegisteredTask };
const PASS = { kind: 'pass' } as const;
const notAdmitted = (): never => { throw new AskRemoteFailure('ASK_REMOTE_NOT_ADMITTED'); };
const reject = (code: 'ASK_REQUEST_INVALID' | 'ASK_REMOTE_NOT_ADMITTED' | 'ASK_TOO_LARGE'): Admission => ({ kind: 'reject', code, status: PUBLIC_ERROR_STATUS[code]! });
const single = (req: IncomingMessage, name: string): string | null | 'MULTIPLE' => {
  const all = (req as IncomingMessage & { headersDistinct?: Record<string, string[] | undefined> }).headersDistinct?.[name];
  if (!all || all.length === 0) return null;
  return all.length === 1 ? all[0]! : 'MULTIPLE';
};
const JSON_TYPE = /^application\/json(\s*;\s*charset=utf-8)?$/i;

/** Header-level problems of a registered question POST (bounded checks only; nothing is read or parsed). */
export function headerProblem(req: IncomingMessage, port: number, hasQuery: boolean): Admission | null {
  const origin = `http://127.0.0.1:${port}`;
  if (single(req, 'host') !== `127.0.0.1:${port}` || single(req, 'origin') !== origin || single(req, 'sec-fetch-site') !== 'same-origin') return reject('ASK_REQUEST_INVALID');
  if (hasQuery) return reject('ASK_REQUEST_INVALID');
  const type = single(req, 'content-type');
  if (typeof type !== 'string' || type === 'MULTIPLE' || !JSON_TYPE.test(type) || req.headers['content-encoding'] !== undefined) return reject('ASK_REQUEST_INVALID');
  const length = req.headers['content-length'];
  if (length !== undefined && !/^[0-9]{1,15}$/.test(length)) return reject('ASK_REQUEST_INVALID');
  if (length !== undefined && Number(length) > 16 * 1024) return reject('ASK_TOO_LARGE');
  return null;
}

export class EvaluationGate {
  readonly #c: GateContext;
  constructor(context: GateContext) { this.#c = context; }
  /**
   * RS-D-A: every capability/question entry is counted FIRST (05 "at entry to every Ask capability/submit path (including
   * rejected/unpaired calls)"); a gate-passed question's completed write is a publication; an unregistered-client question is
   * unattributed (it can never reach a registered Binding).
   */
  admit(req: IncomingMessage, shape: 'capability' | 'question', clientId: string | null, hasQuery: boolean, res?: ServerResponse): Admission {
    const { census } = this.#c;
    if (shape === 'capability') census.capabilityIngress(); else census.submitIngress();
    const header = single(req, SESSION_HEADER);
    if (shape === 'capability') return header === null ? PASS : reject('ASK_REQUEST_INVALID');
    const published = (a: Admission): Admission => { res?.once('finish', () => census.publication()); return a; };
    if (clientId !== this.#c.reg.clientId) {
      if (header !== null) return reject('ASK_REQUEST_INVALID');
      census.unattributed();
      return published(PASS);
    }
    const { state } = this.#c;
    state.counters.ingress += 1;
    const denied = (code: 'ASK_REQUEST_INVALID' | 'ASK_REMOTE_NOT_ADMITTED' | 'ASK_TOO_LARGE') => { state.counters.rejectedUnpairedCount += 1; return reject(code); };
    if (header === null) return denied('ASK_REMOTE_NOT_ADMITTED');
    if (header === 'MULTIPLE' || !isToken(header)) return denied('ASK_REQUEST_INVALID');
    const problem = headerProblem(req, this.#c.port, hasQuery);
    if (problem) { state.counters.rejectedUnpairedCount += 1; return problem; }
    if (state.integrityStopped) return denied('ASK_REMOTE_NOT_ADMITTED');
    const claimed = state.claim(header);
    if (!claimed) {
      // A second submit with the current session token after its claim: integrity stops; no new attempt is ever admitted.
      const arm = state.arm;
      if (state.isSessionToken(header) && arm && (arm.state === 'CLAIMED' || arm.state === 'DONE')) { state.counters.duplicateSubmit += 1; state.integrityStopped = true; }
      return denied('ASK_REMOTE_NOT_ADMITTED');
    }
    return published({ kind: 'claimed', exchange: new RegisteredTask(this.#c, claimed.armId, claimed.taskId) });
  }
}

/** One claimed registered task: scope/focus/generation enforcement, slot capture, terminal observation hooks. */
export class RegisteredTask {
  readonly #c: GateContext;
  readonly armId: string; readonly taskId: string;
  #binding: Binding | null = null;
  #published: { status: number; body: unknown } | null = null;
  readonly ask: EvaluationTask;
  constructor(c: GateContext, armId: string, taskId: string) {
    this.#c = c; this.armId = armId; this.taskId = taskId;
    const arm = c.state.arm!;
    const self = this;
    this.ask = Object.freeze({
      authenticated(identity: AskIdentity, clientId: string, correlationId: string) { self.#authenticated(identity, clientId, correlationId); },
      request(request: AskRequestV2, raw: unknown) { self.#request(request, raw); },
      phases: c.phases(arm.ack.fixtureGeneration),
      reservation(outcome: 'COMMITTED' | 'COMMIT_UNKNOWN', attemptId: string | null) {
        if (self.#binding) { c.census.reservation(outcome); c.observer.reservation(armId, outcome, attemptId); }
      },
      fault(fault: EvaluationFault) { if (self.#binding) c.observer.fault(armId, fault); },
      settlement(outcome: 'CONFIRMED' | 'FAILED_KNOWN' | 'COMMIT_UNKNOWN') { if (self.#binding) c.observer.settlement(armId, outcome); },
    } satisfies EvaluationTask);
  }
  get binding(): Binding | null { return this.#binding; }
  #authenticated(identity: AskIdentity, clientId: string, correlationId: string): void {
    const { reg, state, observer } = this.#c;
    if (identity.workspaceId !== reg.workspaceId || identity.actorId !== reg.actorId || clientId !== reg.clientId) {
      state.counters.scopeDenied += 1;
      askFailure('ASK_SCOPE_DENIED');
    }
    const arm = state.arm; const pair = state.pair; const slot = state.slot;
    if (!arm || arm.ack.armId !== this.armId || !pair || pair.pairId !== arm.pairId || !slot || slot.taskId !== this.taskId) return notAdmitted();
    const binding: Binding = Object.freeze({ registrationId: reg.registrationId, serverBootId: this.#c.serverBootId, guardEpoch: this.#c.guardEpoch,
      handoffConnectionId: pair.handoffConnectionId, pairId: pair.pairId, armId: this.armId, taskId: this.taskId, caseId: arm.ack.caseId,
      fixtureId: arm.ack.fixtureId, fixtureGeneration: arm.ack.fixtureGeneration, admissionId: arm.ack.admissionId, policyVersion: arm.ack.policyVersion,
      preSnapshotId: arm.ack.preSnapshotId, correlationId });
    if (!observer.create(binding)) notAdmitted();
    this.#binding = binding;
    // rc2 F5: a slot burned meanwhile (revocation, expiry) never takes values again; the task's safe observation continues.
    if (slot.state === 'BOUND') slot.binding = binding;
  }
  #request(request: AskRequestV2, raw: unknown): void {
    const arm = this.#c.state.arm; const slot = this.#c.state.slot;
    if (!this.#binding || !arm || !slot || slot.taskId !== this.taskId) return notAdmitted();
    if (request.observationId !== this.#c.requestedFocus(arm.ack.fixtureId)) askFailure('ASK_REQUEST_INVALID');
    // The exact wire body the server received and validated (a deep copy): the browser's RESPONSE must echo exactly this.
    // rc2 F5: only into a still BOUND slot (a burned slot keeps no raw value).
    if (slot.state === 'BOUND') slot.request = JSON.parse(JSON.stringify(raw)) as unknown;
  }
  /**
   * At HTTP write time (scoped tasks only): record the publication (PENDING) for the observation, bind the EXACT publication to
   * the slot and mint the one-use receipt nonce when the exact request was captured; otherwise the slot burns (no receipt).
   */
  publishing(status: number, json: string, correlationId: string): Readonly<Record<string, string>> {
    if (!this.#binding || correlationId !== this.#binding.correlationId) return {};
    let body: unknown = null;
    try { body = JSON.parse(json); } catch { body = null; }
    this.#published = { status, body };
    this.#c.observer.publication(this.armId, { state: 'PENDING', kind: 'NONE', status: null, code: null });
    const slot = this.#c.state.slot;
    if (!slot || slot.taskId !== this.taskId || slot.state !== 'BOUND' || body === null) return {};
    slot.publication = { status, correlationId, body };
    if (slot.request === null) { slot.state = 'BURNED'; return {}; } // e.g. a V2 failure: no exact request to compare with
    slot.receiptNonce = newToken();
    slot.state = 'AVAILABLE';
    return { [RECEIPT_HEADER]: slot.receiptNonce };
  }
  /** The response was completely written: SERVER_FINISHED with the fixed public status/code (anything else is FAILED). */
  finished(): void {
    if (!this.#binding) return;
    const pub = this.#published;
    const code = pub && pub.status !== 200 && typeof pub.body === 'object' && pub.body !== null ? (pub.body as { code?: unknown }).code : null;
    this.#c.observer.publication(this.armId, pub?.status === 200 ? { state: 'SERVER_FINISHED', kind: 'ANSWER', status: 200, code: null }
      : pub && typeof code === 'string' && PUBLIC_ERROR_STATUS[code] === pub.status ? { state: 'SERVER_FINISHED', kind: 'ERROR', status: pub.status, code }
        : { state: 'FAILED', kind: 'NONE', status: null, code: null });
  }
  aborted(): void {
    if (this.#binding) this.#c.observer.publication(this.armId, { state: 'FAILED', kind: 'NONE', status: null, code: null });
    const slot = this.#c.state.slot;
    if (slot && slot.taskId === this.taskId && slot.state !== 'COMMITTED') this.#c.state.burnSlot();
  }
  released(): void {
    if (this.#binding) this.#c.observer.released(this.armId); else this.#c.census.unattributed(); // RS-D-A: no Binding was ever reached
    this.#c.state.finishArm(this.armId);
  }
}
