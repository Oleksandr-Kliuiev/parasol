import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { receiptLine } from '../../packages/ops/pilot/receipts.ts';
import type { Receipt, ReceiptSink } from '../../packages/ops/pilot/receipts.ts';
import type { Dispatch } from '../../packages/ops/pilot/recorder.ts';

/**
 * Synthetic test mechanisms of the S2-LIVE pilot recorder tests ONLY: an in-memory receipt sink with programmable failure,
 * a scripted in-memory dispatch, loopback HTTP servers and a dispatch that maps a production origin onto a loopback server
 * for the native-fetch redirect tests, plus private temp config files. None of this is reachable from the driver's
 * configuration: the entry point never passes a dispatch, so production always uses the captured native fetch.
 */
export interface MemorySink { sink: ReceiptSink; receipts: Receipt[]; lines: string[]; failWhen(predicate: ((r: Receipt) => boolean) | null): void }
export function memorySink(): MemorySink {
  const receipts: Receipt[] = []; const lines: string[] = [];
  let fail: ((r: Receipt) => boolean) | null = null;
  return {
    receipts, lines, failWhen: p => { fail = p; },
    sink: {
      append(r) {
        if (fail?.(r)) throw new Error('synthetic sink failure');
        lines.push(receiptLine(r)); receipts.push(r);
      },
      close() {},
    },
  };
}
/** Wraps a real sink and fails the receipts matching `predicate` (once each), for the driver tests. */
export function failingSink(predicate: (r: Receipt) => boolean): (sink: ReceiptSink) => ReceiptSink {
  return sink => ({ append(r) { if (predicate(r)) throw new Error('synthetic sink failure'); sink.append(r); }, close() { sink.close(); } });
}

export interface DispatchCall { url: string; init: RequestInit }
export function scriptedDispatch(answer: (url: URL, init: RequestInit, n: number) => Response | Promise<Response>): { dispatch: Dispatch; calls: DispatchCall[] } {
  const calls: DispatchCall[] = [];
  return { calls, dispatch: async (url, init) => { calls.push({ url, init }); return answer(new URL(url), init, calls.length - 1); } };
}
export const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export interface Loopback { port: number; origin: string; hits: { method: string; path: string }[]; close(): Promise<void> }
export async function loopback(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Loopback> {
  const hits: { method: string; path: string }[] = [];
  const server = createServer((req, res) => { hits.push({ method: req.method ?? '', path: req.url ?? '' }); req.resume(); handler(req, res); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { port, origin: `http://127.0.0.1:${port}`, hits,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
/**
 * Test-only: the recorder classifies the PRODUCTION URL, then this dispatch sends the same request (same init object) with
 * the given native fetch to the loopback origin — so native redirect handling is exercised without any external network.
 */
export function loopbackDispatch(nativeFetch: typeof fetch, origin: string): { dispatch: Dispatch; inits: RequestInit[] } {
  const inits: RequestInit[] = [];
  return { inits, dispatch: (url, init) => { inits.push(init); const u = new URL(url); return nativeFetch(`${origin}${u.pathname}${u.search}`, init); } };
}

export interface TempDir { dir: string; path(name: string): string; write(name: string, value: unknown): string; close(): void }
export function tempDir(prefix = 'atlas-pilot-'): TempDir {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, path: name => join(dir, name),
    write: (name, value) => { const p = join(dir, name); writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 }); return p; },
    close: () => rmSync(dir, { recursive: true, force: true }) };
}
export function pilotConfig(command: string, flags: Record<string, string>, connections: string[], receipts: string, extra: Record<string, unknown> = {}) {
  return { version: 1, command, flags, scope: { client: flags.client, connections }, output: { receipts, ...extra } };
}

/** A synthetic tenant/application and canary values that must never appear in any receipt, summary or error output. */
export const CANARY = {
  tenant: '1c2a7e11-3b5d-4f6a-8b7c-9d0e1f2a3b4c', app: '2d3b8f22-4c6e-4a7b-9c8d-0e1f2a3b4c5d', secret: 'CanarySecret-do-not-print-7b1f',
  token: 'CanaryAccessToken.eyJ-do-not-print', name: 'Canary Personname', upn: 'canary.person@example.invalid',
  nextLinkMarker: 'canary-skiptoken-e5f1', errorBody: 'canary-error-body-91aa',
};
