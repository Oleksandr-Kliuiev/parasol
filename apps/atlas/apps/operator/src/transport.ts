// Bounded request/response handling (docs/stage5/02_CONTRACTS.md). DOM-free: fetch, streams, timers and a monotonic clock.
// One original deadline covers the request, the incremental body read, decoding, JSON parsing and validation: an absolute
// expiry is fixed when the operation starts and checked at every phase boundary and before any result is returned, so
// synchronous work that crosses it (which no timer can interrupt) still ends as TIMEOUT. The timer settles blocked
// asynchronous work locally, even when the underlying fetch ignores its AbortSignal. No retry; no body is ever echoed.
import { LIMITS } from './contracts.ts';
import type { FailureCode } from './contracts.ts';
import type { CredentialHolder } from './credential.ts';
import type { EvidenceOperation, GetOperation } from './operations.ts';
import { Invalid } from './validate-core.ts';

export type TransportResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: FailureCode };
export interface TransportOptions {
  readonly deadlineMs?: number; readonly maxBytes?: number;
  /** Monotonic milliseconds (default performance.now). Tests inject a controlled clock; never a wall clock. */
  readonly now?: () => number;
}

export const failure = <T>(code: FailureCode): TransportResult<T> => ({ ok: false, code });
/** The original budget of one operation: fixed once, never reset between phases. */
export interface Budget { expired(): boolean }
class Expired extends Error {}
/** Best-effort release of a body that will not be read; never delays the result. */
const release = (response: Response) => { void response.body?.cancel().catch(() => undefined); };

/** Reads at most maxBytes, cancelling the stream as soon as the cap is crossed or the budget has elapsed (Expired). */
async function readCapped(response: Response, maxBytes: number, budget: Budget): Promise<Uint8Array | null> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) { await response.body?.cancel().catch(() => undefined); return null; }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (budget.expired()) { void reader.cancel().catch(() => undefined); throw new Expired(); }
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** Sends one fixed operation with the combined signal. `success` is that operation's only accepted status (no other 2xx). */
interface Exchange { send(signal: AbortSignal): Promise<Response>; readonly success: 200 | 201 }

/** Sends one operation; a rejected send is NETWORK, or TIMEOUT once the original budget has elapsed. */
export async function sendWithin(send: (signal: AbortSignal) => Promise<Response>, signal: AbortSignal, budget: Budget): Promise<TransportResult<Response>> {
  let response: Response;
  try { response = await send(signal); } catch { return failure(budget.expired() ? 'TIMEOUT' : 'NETWORK'); }
  if (budget.expired()) { release(response); return failure('TIMEOUT'); }
  return { ok: true, value: response };
}

/**
 * The JSON body of a received response under the same budget: application/json only (no redirect), incremental read capped
 * at maxBytes, fatal UTF-8 decoding, JSON.parse. Each synchronous phase is checked when it returns; a phase that ran past
 * the expiry yields TIMEOUT, never its result.
 */
export async function readJson(response: Response, maxBytes: number, budget: Budget): Promise<TransportResult<unknown>> {
  if (response.redirected || !/^application\/json(;|$)/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel().catch(() => undefined);
    return failure('RESPONSE_INVALID');
  }
  let bytes: Uint8Array | null;
  try { bytes = await readCapped(response, maxBytes, budget); }
  catch (error) { return failure(error instanceof Expired || budget.expired() ? 'TIMEOUT' : 'NETWORK'); }
  if (bytes === null) return failure('RESPONSE_TOO_LARGE');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return failure(budget.expired() ? 'TIMEOUT' : 'RESPONSE_INVALID'); }
  if (budget.expired()) return failure('TIMEOUT');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return failure(budget.expired() ? 'TIMEOUT' : 'RESPONSE_INVALID'); }
  if (budget.expired()) return failure('TIMEOUT');
  return { ok: true, value: parsed };
}

/** Runs a whole-response validator; Invalid becomes the fixed code, and a validator that ran past the expiry is TIMEOUT. */
export function validated<T>(validate: () => T, budget: Budget): TransportResult<T> {
  let result: TransportResult<T>;
  try { result = { ok: true, value: validate() }; }
  catch (error) { result = failure(error instanceof Invalid && error.tooLarge ? 'RESPONSE_TOO_LARGE' : 'RESPONSE_INVALID'); }
  return budget.expired() ? failure('TIMEOUT') : result;
}

async function exchange<T>(operation: Exchange, signal: AbortSignal, maxBytes: number,
  validate: (value: unknown, headers: Headers) => T, budget: Budget): Promise<TransportResult<T>> {
  const sent = await sendWithin(s => operation.send(s), signal, budget);
  if (!sent.ok) return sent;
  const response = sent.value;
  if (response.status !== operation.success) {
    await response.body?.cancel().catch(() => undefined);
    return failure(response.status === 401 ? 'UNAUTHORIZED' : response.status === 403 ? 'FORBIDDEN' : 'HTTP_ERROR');
  }
  const body = await readJson(response, maxBytes, budget);
  if (!body.ok) return body;
  return validated(() => validate(body.value, response.headers), budget);
}

function run<T>(operation: Exchange, signal: AbortSignal, validate: (value: unknown, headers: Headers) => T,
  options: TransportOptions): Promise<TransportResult<T>> {
  const maxBytes = options.maxBytes ?? LIMITS.responseBytes;
  return bounded(signal, options, (combined, budget) => exchange(operation, combined, maxBytes, validate, budget));
}

/**
 * One original deadline around `attempt`: an absolute expiry on a monotonic clock fixed here, a local timer that settles
 * blocked asynchronous work (even a fetch that ignores its AbortSignal) as TIMEOUT, the caller's abort as NETWORK, and a
 * final boundary that turns any outcome reached at or after the expiry into TIMEOUT. No phase resets it; no retry.
 */
export function bounded<T>(signal: AbortSignal, options: TransportOptions,
  attempt: (signal: AbortSignal, budget: Budget) => Promise<TransportResult<T>>): Promise<TransportResult<T>> {
  const now = options.now ?? (() => performance.now());
  const expiresAt = now() + (options.deadlineMs ?? LIMITS.requestDeadlineMs);
  const budget: Budget = { expired: () => now() >= expiresAt };
  const local = new AbortController();
  const combined = AbortSignal.any([signal, local.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<TransportResult<T>>(resolve => {
    timer = setTimeout(() => { local.abort(); resolve(failure('TIMEOUT')); }, Math.max(0, expiresAt - now()));
  });
  const aborted = new Promise<TransportResult<T>>(resolve => {
    onAbort = () => resolve(failure('NETWORK'));
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([attempt(combined, budget), deadline, aborted])
    // Final boundary before the caller can commit anything: an outcome that arrives past the original expiry is TIMEOUT.
    .then(result => (budget.expired() ? failure<T>('TIMEOUT') : result))
    .finally(() => {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      local.abort();
    });
}

/**
 * GET one fixed operation and validate the JSON body before returning it; only HTTP 200 is success. `signal` is the
 * caller's scope/panel abort. The deadline is one absolute expiry on a monotonic clock, fixed here; any outcome reached at
 * or after it is TIMEOUT. Expiry aborts the browser request locally; it does not claim server-side cancellation.
 */
export function getValidated<T>(holder: CredentialHolder, operation: GetOperation, signal: AbortSignal, validate: (value: unknown) => T,
  options: TransportOptions = {}): Promise<TransportResult<T>> {
  return run({ send: s => holder.get(operation, s), success: 200 }, signal, value => validate(value), options);
}

/**
 * One deliberate evidence read (POST /tools/execute) with the same deadline, cap and guards; only the existing controllers'
 * HTTP 201 is success. The validator also receives the response headers for the optional opaque diagnostic IDs. No retry:
 * a timeout or abort may still have a server-side ToolExecution/audit outcome.
 */
export function executeValidated<T>(holder: CredentialHolder, operation: EvidenceOperation, signal: AbortSignal,
  validate: (value: unknown, headers: Headers) => T, options: TransportOptions = {}): Promise<TransportResult<T>> {
  return run({ send: s => holder.execute(operation, s), success: 201 }, signal, validate, options);
}
