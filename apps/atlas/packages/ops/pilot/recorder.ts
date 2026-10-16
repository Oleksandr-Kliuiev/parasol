import { performance } from 'node:perf_hooks';
import { AtlasError } from '../../core/contracts.ts';
import type { HttpTransport } from '../../../connectors/http.ts';
import type { AuthTransport, GraphTransport } from '../../../connectors/microsoft365/http.ts';
import { classifyDispatch, ENDPOINT_CLASSES } from './classify.ts';
import type { DispatchMethod, EndpointClass, TransportKind } from './classify.ts';
import { REFUSAL_REASONS } from './receipts.ts';
import type { CompletionOutcome, ReceiptSink, RefusalReason } from './receipts.ts';

/**
 * Fail-closed metadata recorder of the S2-LIVE pilot (operational brief RC5 §L4). Three transports with the accepted shapes
 * wrap ONE private dispatch function (the driver's captured native fetch; a loopback/in-memory function in tests only):
 *   1. a halted recorder refuses (zero dispatch);
 *   2. the destination/method is classified in memory (classify.ts); a refusal halts the run (zero dispatch);
 *   3. the dispatch receipt (seq, class, method, start) is written and fsynced — if that fails: halt, zero dispatch;
 *   4. exactly one dispatch, never retried here. Stage 1 gets the accepted GET init plus `redirect: 'error'` (no automatic
 *      redirect hop); Graph/auth inits are passed unchanged (they already refuse redirects);
 *   5. the completion receipt (HTTP status or null for a thrown dispatch, duration, fixed outcome). If it cannot be written
 *      the run is incomplete and halted: the Response of the call already made is still returned unchanged to the accepted
 *      service, and every later dispatch is refused.
 * The Response body is never read, cloned or cancelled here; a thrown dispatch error is rethrown as is so the accepted
 * service maps it to its own safe code. Nothing from the URL, headers, body or error is retained.
 */
export type Dispatch = (url: string, init: RequestInit) => Promise<Response>;
export type IncompleteReason = 'PRE_DISPATCH_RECORD_FAILED' | 'COMPLETION_RECORD_FAILED' | 'COMPLETION_MISSING' | 'REFUSAL_RECORD_FAILED' | RefusalReason;
export interface ClassCounts { dispatches: number; completions: number; httpStatuses: Record<string, number>; outcomes: Record<string, number> }
export interface RecorderSnapshot {
  complete: boolean; halted: boolean; incompleteReasons: IncompleteReason[];
  dispatches: number; completions: number; pending: number;
  refusals: { destination: number; method: number; unrecordedFetch: number; callback: number };
  perClass: Partial<Record<EndpointClass, ClassCounts>>;
}
export interface Recorder {
  readonly stage1: HttpTransport; readonly graph: GraphTransport; readonly auth: AuthTransport;
  /** Marks the run incomplete and refuses every later dispatch; a refusal reason is also counted and receipted. */
  halt(reason: IncompleteReason): void;
  snapshot(): RecorderSnapshot;
}
export interface RecorderOptions { sink: ReceiptSink; dispatch: Dispatch; now?: () => Date; monotonic?: () => number }

export const recorderHalted = () => new AtlasError('PILOT_RECORDER_HALTED', 'PERMANENT');
export const recorderFailed = () => new AtlasError('PILOT_RECORDER_FAILED', 'PERMANENT');

export function createRecorder(options: RecorderOptions): Recorder {
  const { sink, dispatch } = options;
  const now = options.now ?? (() => new Date());
  const monotonic = options.monotonic ?? (() => performance.now());
  const reasons = new Set<IncompleteReason>();
  const pending = new Set<number>();
  const refusals = { destination: 0, method: 0, unrecordedFetch: 0, callback: 0 };
  const perClass = new Map<EndpointClass, ClassCounts>();
  let seq = 0; let completions = 0;

  const mark = (reason: IncompleteReason) => { reasons.add(reason); };
  const refuse = (reason: RefusalReason) => {
    if (reason === 'DESTINATION_REFUSED') refusals.destination++;
    else if (reason === 'METHOD_REFUSED') refusals.method++;
    else if (reason === 'UNRECORDED_FETCH') refusals.unrecordedFetch++;
    else refusals.callback++;
    mark(reason);
    // Best effort: the refusal itself already made zero dispatches; a sink failure here only adds to incompleteness.
    try { sink.append({ v: 1, kind: 'refusal', at: now().toISOString(), reason }); } catch { mark('REFUSAL_RECORD_FAILED'); }
  };
  const counts = (cls: EndpointClass): ClassCounts => {
    let c = perClass.get(cls);
    if (!c) { c = { dispatches: 0, completions: 0, httpStatuses: {}, outcomes: {} }; perClass.set(cls, c); }
    return c;
  };
  const complete = (n: number, cls: EndpointClass, method: DispatchMethod, httpStatus: number | null, outcome: CompletionOutcome, started: number): boolean => {
    const durationMs = Math.min(86_400_000, Math.max(0, Math.round(monotonic() - started)));
    try { sink.append({ v: 1, kind: 'completion', seq: n, endpointClass: cls, method, httpStatus, durationMs, outcome }); }
    catch { mark('COMPLETION_RECORD_FAILED'); return false; }
    pending.delete(n); completions++;
    const c = counts(cls); c.completions++;
    c.outcomes[outcome] = (c.outcomes[outcome] ?? 0) + 1;
    if (httpStatus !== null) c.httpStatuses[String(httpStatus)] = (c.httpStatuses[String(httpStatus)] ?? 0) + 1;
    return true;
  };

  async function record(kind: TransportKind, url: string, method: unknown, init: RequestInit): Promise<Response> {
    if (reasons.size > 0) throw recorderHalted();
    // A Graph/auth init without `redirect: 'error'` is not the accepted composition: refused like an unknown destination.
    if (init.redirect !== 'error') { refuse('DESTINATION_REFUSED'); throw new AtlasError('PILOT_DESTINATION_REFUSED', 'PERMANENT'); }
    let decided: { endpointClass: EndpointClass; method: DispatchMethod };
    try { decided = classifyDispatch(kind, url, method); }
    catch (error) {
      refuse(error instanceof AtlasError && error.code === 'PILOT_METHOD_REFUSED' ? 'METHOD_REFUSED' : 'DESTINATION_REFUSED');
      throw error instanceof AtlasError ? error : new AtlasError('PILOT_DESTINATION_REFUSED', 'PERMANENT');
    }
    const { endpointClass: cls } = decided;
    const n = seq + 1;
    try { sink.append({ v: 1, kind: 'dispatch', seq: n, endpointClass: cls, method: decided.method, startedAt: now().toISOString() }); }
    catch { mark('PRE_DISPATCH_RECORD_FAILED'); throw recorderFailed(); }
    seq = n; pending.add(n); counts(cls).dispatches++;
    const started = monotonic();
    let response: Response;
    try { response = await dispatch(url, init); }
    catch (error) {
      const name = (error as { name?: unknown } | null)?.name;
      complete(n, cls, decided.method, null, name === 'TimeoutError' || name === 'AbortError' ? 'DISPATCH_TIMEOUT' : 'DISPATCH_FAILED', started);
      throw error;
    }
    complete(n, cls, decided.method, response.status, 'RESPONDED', started);
    return response;
  }

  const stage1: HttpTransport = (url, init) => record('stage1', url, init.method,
    { method: 'GET', headers: init.headers, signal: init.signal, redirect: 'error' });
  const graph: GraphTransport = (url, init) => record('graph', url, init.method, init);
  const auth: AuthTransport = (url, init) => record('auth', url, init.method, init);

  const halt = (reason: IncompleteReason) => {
    if ((REFUSAL_REASONS as readonly string[]).includes(reason)) refuse(reason as RefusalReason); else mark(reason);
  };
  return Object.freeze({
    stage1, graph, auth, halt,
    snapshot(): RecorderSnapshot {
      const incompleteReasons = [...reasons];
      if (pending.size > 0 && !reasons.has('COMPLETION_RECORD_FAILED')) incompleteReasons.push('COMPLETION_MISSING');
      const ordered = Object.fromEntries(ENDPOINT_CLASSES.filter(c => perClass.has(c)).map(c => {
        const x = perClass.get(c)!;
        return [c, { dispatches: x.dispatches, completions: x.completions, httpStatuses: { ...x.httpStatuses }, outcomes: { ...x.outcomes } }];
      }));
      return { complete: incompleteReasons.length === 0, halted: reasons.size > 0, incompleteReasons, dispatches: seq, completions, pending: pending.size,
        refusals: { ...refusals }, perClass: ordered };
    },
  });
}
