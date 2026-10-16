// Fail-closed process network guard of the instrument revision (rs-c brief B §1). Like the accepted offline guard
// (scripts/ask-remote-eval/net-guard.ts, unchanged), every native network entry point — global fetch/WebSocket/EventSource,
// http/https/http2 request/get/connect, tls connect, dgram and DNS (functions and Resolver classes) — throws before any I/O. The ONLY difference: the owner's two
// measured UNIX sockets may be connected, named once by `allowUnixSockets` (absolute paths, set once, then frozen). Any TCP host/
// port, any other path and any second allowlist call throw. Installed by cli.ts BEFORE any other module is imported.
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { isAbsolute } from 'node:path';
import tls from 'node:tls';

export const BLOCKED_CODE = 'INSTRUMENT_EGRESS_BLOCKED';
let installed = false;
let allowed: ReadonlySet<string> | null = null;
function blocked(): never { const e = new Error(BLOCKED_CODE) as Error & { code: string }; e.code = BLOCKED_CODE; throw e; }
function replace(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { configurable: false, enumerable: true, writable: false, value });
}
const block = () => blocked();
/** The unix path a connect call names, or null for anything else (TCP options, host/port, missing). */
function unixPath(args: unknown[]): string | null {
  const a = args[0];
  if (typeof a === 'string') return a;
  if (Array.isArray(a)) return unixPath(a);
  if (a !== null && typeof a === 'object' && typeof (a as { path?: unknown }).path === 'string' && (a as { port?: unknown }).port === undefined
    && (a as { host?: unknown }).host === undefined) return (a as { path: string }).path;
  return null;
}
const permitted = (args: unknown[]): boolean => { const p = unixPath(args); return p !== null && allowed !== null && allowed.has(p); };

/** Idempotent. Returns true when this call installed the guard. */
export function installInstrumentGuard(): boolean {
  if (installed) return false;
  const g = globalThis as unknown as Record<string, unknown>;
  replace(g, 'fetch', block);
  for (const k of ['WebSocket', 'EventSource']) if (k in g) replace(g, k, class Blocked { constructor() { blocked(); } });
  for (const mod of [http, https]) { replace(mod as unknown as Record<string, unknown>, 'request', block); replace(mod as unknown as Record<string, unknown>, 'get', block); }
  replace(http2 as unknown as Record<string, unknown>, 'connect', block);
  replace(tls as unknown as Record<string, unknown>, 'connect', block);
  replace(dgram as unknown as Record<string, unknown>, 'createSocket', block);
  for (const d of [dns as unknown as Record<string, unknown>, dns.promises as unknown as Record<string, unknown>]) {
    for (const [k, v] of Object.entries(d)) if (typeof v === 'function' && /^(lookup|lookupService|resolve|reverse)/.test(k)) replace(d, k, block);
    if ('Resolver' in d) replace(d, 'Resolver', class Blocked { constructor() { blocked(); } });
  }
  const socketConnect = net.Socket.prototype.connect;
  replace(net.Socket.prototype as unknown as Record<string, unknown>, 'connect', function guardedConnect(this: net.Socket, ...args: unknown[]) {
    if (!permitted(args)) blocked();
    return (socketConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  });
  const createConnection = net.createConnection;
  const guardedCreate = (...args: unknown[]) => { if (!permitted(args)) blocked(); return (createConnection as (...a: unknown[]) => net.Socket)(...args); };
  replace(net as unknown as Record<string, unknown>, 'createConnection', guardedCreate);
  replace(net as unknown as Record<string, unknown>, 'connect', guardedCreate);
  syncBuiltinESMExports();
  installed = true;
  return true;
}
/** Names the two owner sockets ONCE (absolute paths). A second call, a relative path or a guard not installed throws. */
export function allowUnixSockets(paths: readonly string[]): void {
  if (!installed || allowed !== null || paths.length !== 2 || !paths.every(p => typeof p === 'string' && isAbsolute(p))) blocked();
  allowed = Object.freeze(new Set(paths));
}
export const guardInstalled = (): boolean => installed;
