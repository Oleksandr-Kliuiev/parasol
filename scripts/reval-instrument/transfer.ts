// The instrument side of the exact transient transfer (06 "Exact transient transfer and acknowledgements"; rs-c brief B §5).
// At most one TRANSFER per READY. The frame must answer THIS instrument's READY (challenge, readySequence) and its Binding must
// equal every READY field and the handoff connection (a self-consistent foreign frame is WRONG_BINDING, rs-c-a carried item);
// the accepted RC5 validators are rerun on the exact values and the closed SafeResult is derived (observed intent stays
// transient). The PENDING summary is saved BEFORE the ACK (a save failure is a REJECTED METADATA_PERSIST_FAILED ACK); only the
// matching COMMIT frame plus a saved COMMITTED summary is success; anything else is UNVERIFIED with its fixed code. The raw values
// are returned to the caller's memory for the case outcome and never enter a summary or the persistence API. rc2 F3: after a
// REJECTED ACK the COMMIT(FAILED) that S answers is read within the same 2 s window, so it can never be taken for a later frame.
// rc2 F4: COMMIT and READY_ACK frames are bounded at 4 KiB (06 caps) besides the strict decoders.
import { randomUUID } from 'node:crypto';
import type { FailureCode } from '../../packages/reval/codes.ts';
import { ACK_V1, decodeCommit, decodeHandoffSummary, decodeSafeResult, decodeTransfer, SUMMARY_V1 } from '../../packages/reval/eval-transient.ts';
import type { HandoffSummary, SafeResult, Transfer, WireResponse } from '../../packages/reval/eval-transient.ts';
import type { Binding } from '../../packages/reval/eval-wire.ts';
import { checkRequest, checkResponse } from '../ask-remote-eval-execution/transient.ts';
import type { CaseContext, Tuple } from '../ask-remote-eval-execution/transient.ts';

export interface ReadySent {
  readonly sequence: string; readonly challenge: string; readonly registrationId: string; readonly serverBootId: string; readonly pairId: string;
  readonly armId: string; readonly caseId: string; readonly fixtureId: string; readonly fixtureGeneration: string; readonly admissionId: string;
  readonly policyVersion: string; readonly preSnapshotId: string;
}
export interface HandoffPort { readonly connectionId: string; send(frame: Record<string, unknown>): string; next(ms: number): Promise<Record<string, unknown>> }
/** The exact values S transferred (memory only, for the case outcome). */
export interface TransferValues { readonly request: unknown; readonly response: WireResponse }
export type TransferResult =
  | { readonly state: 'COMMITTED'; readonly summary: HandoffSummary; readonly values: TransferValues; readonly arrivedMono: number }
  | { readonly state: 'UNVERIFIED'; readonly code: FailureCode; readonly summary: HandoffSummary | null; readonly values: TransferValues | null; readonly arrivedMono: number | null };

/** 06 caps of the small S frames (READY_ACK, COMMIT); measured on the decoded frame's canonical JSON. */
export const SMALL_FRAME_CAP = 4 * 1024;
export const withinCap = (frame: unknown, cap = SMALL_FRAME_CAP): boolean => Buffer.byteLength(JSON.stringify(frame), 'utf8') <= cap;
const BINDING_FROM_READY = ['registrationId', 'serverBootId', 'pairId', 'armId', 'caseId', 'fixtureId', 'fixtureGeneration', 'admissionId', 'policyVersion', 'preSnapshotId'] as const;
/** The Binding answers exactly this READY on this handoff connection. */
export function bindingMatchesReady(b: Binding, r: ReadySent, handoffConnectionId: string): boolean {
  return b.handoffConnectionId === handoffConnectionId && BINDING_FROM_READY.every(k => b[k] === r[k]);
}
/** The closed SafeResult of the exact transferred values (null = whole validation failed: no SafeResult is constructed). */
export function safeResultOf(t: Pick<Transfer, 'request' | 'response'>, ctx: CaseContext, tuple: Tuple): SafeResult | null {
  try {
    const req = checkRequest(JSON.stringify(t.request), ctx, tuple);
    const obs = checkResponse({ status: t.response.status, correlationHeader: t.response.correlationId, body: JSON.stringify(t.response.body) }, ctx, req.requestId);
    if (obs.kind === 'LOCAL_HANDOFF_UNVERIFIED' || obs.correlationId !== t.response.correlationId) return null;
    const matches = req.parsed && !req.deviation;
    const result = obs.kind === 'ANSWER'
      ? { requestMatchesFrozen: matches, semantic: matches ? (obs.observedIntent === ctx.frozen.expectedIntent ? 'MATCH' : 'MISMATCH') : 'NOT_EVALUATED', schema: true,
        claims: obs.truth.claims, coverage: obs.truth.coverage, urgency: obs.truth.urgency, publicOutcome: 'ANSWER', publicErrorCode: null }
      : { requestMatchesFrozen: matches, semantic: 'NOT_EVALUATED', schema: true, claims: null, coverage: null, urgency: null, publicOutcome: 'ERROR', publicErrorCode: obs.code };
    return decodeSafeResult(result);
  } catch { return null; }
}
const summary = (binding: Binding, transferId: string, state: HandoffSummary['state'], result: SafeResult | null, failureCode: FailureCode | null): HandoffSummary =>
  decodeHandoffSummary({ contractVersion: SUMMARY_V1, binding, transferId, state, result, failureCode });

/**
 * Waits for the one TRANSFER until `untilMono`, then validates, saves PENDING, ACKs and awaits the COMMIT within 2 s of the TRANSFER.
 * `persist` saves a summary atomically (false = failed); `onArrive` runs synchronously at the TRANSFER receipt instant (the
 * server-bound arrival for the case latency); once `abandoned()` is true a late frame is only drained (no ACK, nothing saved). Never throws.
 */
export async function receiveTransfer(h: HandoffPort, ready: ReadySent, ctx: CaseContext, tuple: Tuple, untilMono: number,
  persist: (s: HandoffSummary) => boolean, now: () => number = () => performance.now(), onArrive: () => void = () => undefined,
  abandoned: () => boolean = () => false): Promise<TransferResult> {
  let frame: Record<string, unknown>;
  try { frame = await h.next(untilMono - now()); }
  catch (e) { return { state: 'UNVERIFIED', code: (e as { code?: string }).code === 'IPC_TIMEOUT' ? 'RAW_EXPIRED' : 'IPC_LOST', summary: null, values: null, arrivedMono: null }; }
  const arrivedMono = now();
  // The operator abandoned the handoff: a late frame is drained and never acknowledged or saved (06: no expired frame is ACKed).
  if (abandoned()) return { state: 'UNVERIFIED', code: 'RAW_EXPIRED', summary: null, values: null, arrivedMono: null };
  try { onArrive(); } catch { /* the arrival instant is bookkeeping only */ }
  let t: Transfer;
  try { t = decodeTransfer(frame); } catch { return { state: 'UNVERIFIED', code: 'PROTOCOL_INVALID', summary: null, values: null, arrivedMono }; }
  if (t.challenge !== ready.challenge || t.readySequence !== ready.sequence) return { state: 'UNVERIFIED', code: 'PROTOCOL_INVALID', summary: null, values: null, arrivedMono };
  const values: TransferValues = { request: t.request, response: t.response };
  const ack = (disposition: 'ACCEPTED' | 'REJECTED', result: SafeResult | null, failureCode: FailureCode | null) => {
    const commitChallenge = randomUUID();
    const sequence = h.send({ contractVersion: ACK_V1, challenge: t.ackChallenge, transferSequence: t.sequence, transferId: t.transferId, binding: t.binding,
      commitChallenge, disposition, result, failureCode });
    return { commitChallenge, sequence };
  };
  const reject = async (code: FailureCode): Promise<TransferResult> => {
    try {
      ack('REJECTED', null, code);
      // S answers a REJECTED ACK with COMMIT(FAILED); drain it inside the same window (any frame or none: still UNVERIFIED).
      await h.next(arrivedMono + 2000 - now());
    } catch { /* lost, late or out of sequence (the client closes the connection): still UNVERIFIED */ }
    return { state: 'UNVERIFIED', code, summary: null, values: code === 'WRONG_BINDING' ? null : values, arrivedMono };
  };
  if (!bindingMatchesReady(t.binding, ready, h.connectionId)) return reject('WRONG_BINDING');
  const result = safeResultOf(t, ctx, tuple);
  if (result === null) return reject('VALUE_VALIDATION_FAILED');
  const pending = summary(t.binding, t.transferId, 'PENDING', result, null);
  if (!persist(pending)) return reject('METADATA_PERSIST_FAILED');
  let sent: { commitChallenge: string; sequence: string };
  try { sent = ack('ACCEPTED', result, null); } catch { return unverified(t, result, 'IPC_LOST', values, arrivedMono, persist); }
  let commit;
  try { const f = await h.next(arrivedMono + 2000 - now()); if (!withinCap(f)) throw Object.assign(new Error('cap'), { code: 'FRAME_TOO_LARGE' }); commit = decodeCommit(f); }
  catch (e) {
    const c = (e as { code?: string }).code;
    return unverified(t, result, c === 'IPC_TIMEOUT' ? 'ACK_TIMEOUT' : c === 'IPC_LOST' ? 'IPC_LOST' : c === 'FRAME_TOO_LARGE' ? 'FRAME_TOO_LARGE' : 'PROTOCOL_INVALID', values, arrivedMono, persist);
  }
  if (commit.challenge !== sent.commitChallenge || commit.ackSequence !== sent.sequence || commit.transferId !== t.transferId
    || JSON.stringify(commit.binding) !== JSON.stringify(t.binding)) return unverified(t, result, 'PROTOCOL_INVALID', values, arrivedMono, persist);
  if (commit.disposition !== 'COMMITTED') return unverified(t, result, commit.failureCode ?? 'ACK_INVALID', values, arrivedMono, persist);
  const committed = summary(t.binding, t.transferId, 'COMMITTED', result, null);
  if (!persist(committed)) return unverified(t, result, 'METADATA_PERSIST_FAILED', values, arrivedMono, persist);
  return { state: 'COMMITTED', summary: committed, values, arrivedMono };
}
function unverified(t: Transfer, result: SafeResult, code: FailureCode, values: TransferValues, arrivedMono: number, persist: (s: HandoffSummary) => boolean): TransferResult {
  const s = summary(t.binding, t.transferId, 'UNVERIFIED', result, code);
  persist(s);
  return { state: 'UNVERIFIED', code, summary: s, values, arrivedMono };
}
