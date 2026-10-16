import https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { ENDPOINT, UPSTREAM_RESPONSE_MAX_BYTES } from './profile.ts';

/**
 * The private provider transport (docs/stage5/ask/remote/03 "Wire profile"). Production is ONE direct Node HTTPS POST to
 * the fixed EU endpoint: port 443, TLS with Node's default trust store and hostname verification (servername = host), a
 * dedicated non-keep-alive Agent created per call without proxyEnv (environment proxies ignored even when Node's env-proxy
 * support is on), no redirect following (any 3xx is a non-200 result), no retry, no SDK, no custom URL/CA/lookup. Headers are
 * exactly Authorization (the dedicated key, only inside this call), Content-Type/Accept application/json, Content-Length and
 * Connection: close (Node adds Host). The response is read incrementally and stops at 64 KiB (OVERFLOW) before any
 * unbounded buffering. RC2 R2: a non-200 status is final at the response HEADERS — it is decided at once as RESPONSE(status)
 * with no body (never derived from, or lost through, an oversized/stalled/failed/aborted body) and the body read is stopped
 * (response and request destroyed); the provider phase decides whether that decision arrived in time. Abort destroys the
 * request; `settled` resolves only when the request AND any response stream have actually closed, so the request owner
 * keeps its slot until the physical work is over (also when a destroy is ignored). Nothing is logged; failures carry no detail.
 *
 * `requestFn` is the offline test seam (an in-process stand-in for https.request reached only by direct construction in
 * tests); production composition always uses https.request. No configuration, environment variable or HTTP input selects it.
 */
export type TransportResult =
  | { readonly kind: 'RESPONSE'; readonly status: number; readonly contentType: string | undefined; readonly body: Buffer }
  | { readonly kind: 'OVERFLOW' }
  | { readonly kind: 'ERROR' };
export interface TransportCall { readonly result: Promise<TransportResult>; readonly settled: Promise<void> }
/** One call: the prepared bytes, the resolved key (never retained) and the provider-phase abort signal. */
export type Transport = (bytes: Buffer, key: string, signal: AbortSignal) => TransportCall;
export type RequestFn = (options: https.RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;

/** Exact request options of the profile (also asserted by the offline tests). */
export function requestOptions(bytes: Buffer, key: string, agent: https.Agent): https.RequestOptions {
  return {
    protocol: 'https:', host: ENDPOINT.host, servername: ENDPOINT.host, port: ENDPOINT.port, path: ENDPOINT.path, method: ENDPOINT.method, agent,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json', 'Content-Length': String(bytes.length),
      Connection: 'close' }
  };
}
export const transportAgent = (): https.Agent => new https.Agent({ keepAlive: false, maxSockets: 1 });

export function createDirectTransport(requestFn: RequestFn = https.request): Transport {
  return (bytes, key, signal) => {
    let resolveResult!: (result: TransportResult) => void;
    let resolveSettled!: () => void;
    const result = new Promise<TransportResult>(resolve => { resolveResult = resolve; });
    const settled = new Promise<void>(resolve => { resolveSettled = resolve; });
    let decided = false;
    const decide = (value: TransportResult) => { if (!decided) { decided = true; resolveResult(value); } };
    // Physical settlement: the request has closed AND any response stream has closed (no callback can still run).
    let responseOpen = false;
    let requestClosed = false;
    const maybeSettle = () => { if (requestClosed && !responseOpen) { decide({ kind: 'ERROR' }); resolveSettled(); } };
    let request: ClientRequest | undefined;
    try {
      request = requestFn(requestOptions(bytes, key, transportAgent()), response => {
        responseOpen = true;
        response.on('error', () => decide({ kind: 'ERROR' }));
        response.on('close', () => { responseOpen = false; maybeSettle(); });
        const status = response.statusCode ?? 0;
        if (status !== 200) {
          decide({ kind: 'RESPONSE', status, contentType: response.headers['content-type'], body: Buffer.alloc(0) });
          response.destroy();
          queueMicrotask(() => request?.destroy());
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          if (decided) return;
          size += chunk.length;
          if (size > UPSTREAM_RESPONSE_MAX_BYTES) { decide({ kind: 'OVERFLOW' }); request?.destroy(); return; }
          chunks.push(chunk);
        });
        response.on('end', () => decide({ kind: 'RESPONSE', status, contentType: response.headers['content-type'], body: Buffer.concat(chunks, size) }));
      });
    } catch {
      decide({ kind: 'ERROR' });
      resolveSettled();
      return { result, settled };
    }
    const abort = () => { decide({ kind: 'ERROR' }); request.destroy(); };
    request.on('error', () => decide({ kind: 'ERROR' }));
    request.on('close', () => { requestClosed = true; signal.removeEventListener('abort', abort); maybeSettle(); });
    if (signal.aborted) abort(); else { signal.addEventListener('abort', abort, { once: true }); request.end(bytes); }
    return { result, settled };
  };
}
