import { AtlasError } from '../../core/contracts.ts';
import type { Dispatch } from './recorder.ts';

/**
 * Global fetch guard of the S2-LIVE pilot process (operational brief RC5 §L4). The native fetch is captured in this
 * closure, then globalThis.fetch is replaced by a guard: any unwrapped call (an accepted production transport that was not
 * swapped, a provider, a stray library) makes zero network calls, reports the bypass (the driver halts the recorder: run
 * incomplete) and rejects with a safe code. The captured function is reachable only through `dispatch`, which the driver
 * hands to createRecorder and nothing else; it is never exported from this module or put into a command context.
 * `restore()` puts the native fetch back (only if the guard is still installed) and is idempotent.
 */
export interface FetchGuard { readonly dispatch: Dispatch; restore(): void }
export const unrecordedFetch = () => new AtlasError('PILOT_UNRECORDED_FETCH_REFUSED', 'PERMANENT');

export function installFetchGuard(onBypass: () => void): FetchGuard {
  const native = globalThis.fetch;
  if (typeof native !== 'function') throw new AtlasError('PILOT_FETCH_UNAVAILABLE', 'PERMANENT');
  const guard = function guardedFetch(): Promise<Response> {
    try { onBypass(); } catch { /* the rejection below is the refusal either way */ }
    return Promise.reject(unrecordedFetch());
  };
  globalThis.fetch = guard as typeof fetch;
  let installed = true;
  return Object.freeze({
    dispatch: (url: string, init: RequestInit) => Reflect.apply(native, globalThis, [url, init]) as Promise<Response>,
    restore() {
      if (!installed) return;
      installed = false;
      if (globalThis.fetch === (guard as typeof fetch)) globalThis.fetch = native;
    },
  });
}
