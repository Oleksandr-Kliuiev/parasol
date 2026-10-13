import { performance } from 'node:perf_hooks';
import { UUID_V4 } from '../contracts.ts';
import type { SettlementOutcome, Usage } from './budget.ts';
import { EGRESS_FLOOR_MS } from './contracts.ts';
import { validateEnvelope } from './envelope.ts';
import type { EnvelopeVerdict } from './envelope.ts';
import { preparedBytes } from './payload.ts';
import type { PreparedPayload } from './payload.ts';
import type { RemoteSeams } from './secret.ts';
import type { TransportCall, TransportResult } from './transport.ts';

/**
 * Private one-task/one-use dispatch authority and the in-process dispatch/refund proof (docs/stage5/ask/remote/04 "Egress
 * is a separate current authority boundary"; the R-A SQL trusts its caller's NO_DISPATCH, so the proof lives HERE).
 *
 * A DispatchCapability is an opaque frozen object whose whole state lives in this module's WeakMap. It is minted ONLY by
 * admitEgress after the caller's egress transaction promise FULFILS (confirmed COMMIT); a rollback, a refusal or an unknown
 * commit (rejection, timeout) mints nothing, so nothing can ever be dispatched or refunded for it. It is bound to the
 * minting task's AbortSignal, to the prepared bytes and to the committed attempt identity; an object of the same shape, a
 * cast, an attempt/correlation ID, another task's signal, a second use, a restart (empty WeakMap) or a reconnection carries
 * no authority. Consumption happens synchronously immediately before the transport call. NO_DISPATCH is proven only while
 * the capability is still MINTED in this process; the proof revokes it in the same synchronous step, so it can never be
 * consumed afterwards. Settlement inputs come from this private state only (usage solely when validated before the
 * provider-phase end / task terminal), and are taken at most once.
 *
 * RC2 R1: the ORIGINAL request deadline is task-bound authority too. The orchestration binds the task's AbortSignal to its
 * original AskDeadline once (first binding wins; never replaced or loosened), admitEgress refuses to mint for a task without
 * that binding and captures it in the private state, and dispatchIntent re-checks the original 4500 ms floor on it AFTER
 * secret resolution and prepared-byte work, synchronously immediately before consumption and the transport call. No caller
 * argument, clock or reconstructed object can supply or relax it.
 */
export interface AttemptRef {
  readonly workspaceId: string; readonly clientId: string; readonly attemptId: string; readonly correlationId: string;
  readonly admissionId: string; readonly policyVersion: string;
}
export interface Committed { readonly attempt: AttemptRef; readonly secretRef: string }
export interface DispatchCapability { readonly kind: 'AskRemoteDispatch' }
/** Why nothing was sent: FLOOR/TERMINAL are the original deadline or the public terminal state (504/stop); KEY is no resolvable key. */
export type NotSentReason = 'FLOOR' | 'TERMINAL' | 'KEY';
export type ProviderVerdict = EnvelopeVerdict | { readonly kind: 'OVERFLOW' } | { readonly kind: 'UNKNOWN' }
  | { readonly kind: 'NOT_SENT'; readonly reason: NotSentReason };
/** The original request deadline (AskDeadline): whole remaining milliseconds of the ORIGINAL budget. */
export interface OriginalDeadline { remaining(): number }
interface State {
  readonly attempt: AttemptRef; readonly prepared: PreparedPayload; readonly secretRef: string; readonly task: AbortSignal;
  readonly deadline: OriginalDeadline;
  status: 'MINTED' | 'CONSUMED' | 'NO_DISPATCH'; verdict: ProviderVerdict | null; settlementTaken: boolean;
}
const states = new WeakMap<DispatchCapability, State>();
const taskDeadlines = new WeakMap<AbortSignal, OriginalDeadline>();

/** Binds a task (its AbortSignal) to its ORIGINAL deadline once; a different second binding is refused, never applied. */
export function bindTaskDeadline(task: AbortSignal, deadline: OriginalDeadline): void {
  const bound = taskDeadlines.get(task);
  if (bound !== undefined && bound !== deadline) throw new Error('ASK_REMOTE_TASK_REBOUND');
  if (typeof deadline?.remaining !== 'function') throw new Error('ASK_REMOTE_DEADLINE_INVALID');
  taskDeadlines.set(task, deadline);
}

const validAttempt = (a: AttemptRef): boolean => typeof a === 'object' && a !== null && [a.attemptId, a.correlationId, a.admissionId].every(v => typeof v === 'string' && UUID_V4.test(v))
  && typeof a.workspaceId === 'string' && typeof a.clientId === 'string' && typeof a.policyVersion === 'string';

/** Runs the egress commit and mints the capability only when that promise fulfils with a committed attempt. */
export async function admitEgress(commit: () => Promise<Committed>, prepared: PreparedPayload, task: AbortSignal): Promise<DispatchCapability> {
  if (preparedBytes(prepared) === null) throw new Error('ASK_REMOTE_PREPARED_INVALID');
  const deadline = taskDeadlines.get(task);
  if (deadline === undefined) throw new Error('ASK_REMOTE_TASK_UNBOUND');
  const committed = await commit();
  if (!validAttempt(committed.attempt) || typeof committed.secretRef !== 'string') throw new Error('ASK_REMOTE_COMMIT_INVALID');
  const a = committed.attempt;
  const attempt: AttemptRef = Object.freeze({ workspaceId: a.workspaceId, clientId: a.clientId, attemptId: a.attemptId, correlationId: a.correlationId,
    admissionId: a.admissionId, policyVersion: a.policyVersion });
  const capability: DispatchCapability = Object.freeze({ kind: 'AskRemoteDispatch' as const });
  states.set(capability, { attempt, prepared, secretRef: committed.secretRef, task, deadline, status: 'MINTED', verdict: null, settlementTaken: false });
  return capability;
}

/** The committed attempt of a capability issued here (for settlement scope and the circuit), else null. */
export const capabilityAttempt = (capability: DispatchCapability): AttemptRef | null => states.get(capability)?.attempt ?? null;

/** Proven in-process no-dispatch: true only for a live MINTED capability, which is revoked in the same synchronous step. */
export function proveNoDispatch(capability: DispatchCapability): boolean {
  const state = states.get(capability);
  if (!state || state.status !== 'MINTED') return false;
  state.status = 'NO_DISPATCH';
  return true;
}

const settled = () => undefined;
/**
 * The ONE provider phase: its absolute end (min(2 s, original remaining), `phaseMs`) is fixed BEFORE key resolution and
 * consumption and never restarted; it covers the wire, the capped incremental read and the whole local validation. A result
 * arriving or validated after the end or after the task's terminal abort is discarded (UNKNOWN), never parsed into a refund
 * or answer. A key that cannot be resolved leaves the capability MINTED (nothing left the process). The physical call is
 * held via `hold` until it actually settles; there is no retry or fallback. The last gate before consumption (after key
 * resolution and the byte copy, with no await in between) is: terminal, then the ORIGINAL floor (≥4500 ms on the captured
 * task deadline; exactly 4500 passes), then the key, then the provider-phase end.
 */
export async function dispatchIntent(seams: RemoteSeams, capability: DispatchCapability, task: AbortSignal, phaseMs: number,
  hold: (work: Promise<unknown>) => void, now: () => number = () => performance.now()): Promise<ProviderVerdict> {
  const state = states.get(capability);
  if (!state || state.task !== task || state.status !== 'MINTED') throw new Error('ASK_REMOTE_DISPATCH_REFUSED');
  const end = now() + phaseMs;
  if (task.aborted) return { kind: 'NOT_SENT', reason: 'TERMINAL' };
  if (phaseMs < 1 || state.deadline.remaining() < EGRESS_FLOOR_MS) return { kind: 'NOT_SENT', reason: 'FLOOR' };
  let key: string | null;
  try { key = seams.resolveSecret(state.secretRef); } catch { key = null; }
  const bytes = preparedBytes(state.prepared);
  // Immediately before consumption and the transport call (synchronous from here): resolution/copy time counts.
  if (task.aborted) return { kind: 'NOT_SENT', reason: 'TERMINAL' };
  if (state.deadline.remaining() < EGRESS_FLOOR_MS || now() >= end) return { kind: 'NOT_SENT', reason: 'FLOOR' };
  if (key === null || bytes === null) return { kind: 'NOT_SENT', reason: 'KEY' };
  state.status = 'CONSUMED';
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let stop = () => controller.abort();
  // The phase ends at its absolute end OR at the task's terminal abort, whichever is first; an ignored abort keeps only the
  // physical call (held below), never the caller.
  const expired = new Promise<'EXPIRED'>(resolve => {
    stop = () => { controller.abort(); resolve('EXPIRED'); };
    timer = setTimeout(stop, Math.max(0, end - now()));
  });
  task.addEventListener('abort', stop, { once: true });
  const late = () => task.aborted || now() >= end;
  let verdict: ProviderVerdict = { kind: 'UNKNOWN' };
  try {
    let call: TransportCall;
    try { call = seams.transport(bytes, key, controller.signal); } catch { return verdict; }
    hold(Promise.all([call.result.then(settled, settled), call.settled.then(settled, settled)]));
    const first = await Promise.race([call.result.then((r): TransportResult => r, (): TransportResult => ({ kind: 'ERROR' })), expired]);
    if (first === 'EXPIRED' || late()) return verdict;
    if (first.kind === 'OVERFLOW') verdict = { kind: 'OVERFLOW' };
    else if (first.kind === 'RESPONSE') {
      const checked = validateEnvelope(first.status, first.contentType, first.body);
      if (!late()) verdict = checked;
    }
    return verdict;
  } finally {
    clearTimeout(timer);
    task.removeEventListener('abort', stop);
    controller.abort();
    state.verdict = verdict;
  }
}

export interface Settlement { readonly attempt: AttemptRef; readonly outcome: SettlementOutcome; readonly usage: Usage | null }
/**
 * The settlement inputs of a capability, taken at most once, from private state only. Still MINTED (never consumed): proven
 * NO_DISPATCH in this process (and revoked). Consumed: USAGE_VERIFIED with usage validated inside the phase (also for invalid
 * content/refusal), MODEL_MISMATCH / USAGE_INVALID / UPSTREAM_REJECTED for faults, otherwise DELIVERY_UNKNOWN (whole reserve).
 */
export function takeSettlement(capability: DispatchCapability): Settlement | null {
  const state = states.get(capability);
  if (!state || state.settlementTaken) return null;
  state.settlementTaken = true;
  if (state.status === 'MINTED') state.status = 'NO_DISPATCH';
  if (state.status === 'NO_DISPATCH') return { attempt: state.attempt, outcome: 'NO_DISPATCH', usage: null };
  const v = state.verdict;
  if (v?.kind === 'INTENT' || v?.kind === 'INVALID') return { attempt: state.attempt, outcome: 'USAGE_VERIFIED', usage: v.usage };
  if (v?.kind === 'MODEL_MISMATCH') return { attempt: state.attempt, outcome: 'MODEL_MISMATCH', usage: null };
  if (v?.kind === 'USAGE_INVALID') return { attempt: state.attempt, outcome: 'USAGE_INVALID', usage: null };
  if (v?.kind === 'UPSTREAM') return { attempt: state.attempt, outcome: 'UPSTREAM_REJECTED', usage: null };
  return { attempt: state.attempt, outcome: 'DELIVERY_UNKNOWN', usage: null };
}
