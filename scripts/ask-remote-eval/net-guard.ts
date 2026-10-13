// OFFLINE-ONLY fail-closed process network guard for the R-EVAL offline package. Installed BEFORE any project module is
// imported (cli.ts installs it, then loads everything else with a dynamic import; the eval tests import this module
// first). Every outbound native network entry point is replaced by a function that records a fixed label in memory and
// throws OFFLINE_EGRESS_BLOCKED before any I/O: global fetch/WebSocket/EventSource, http/https/http2 request/get/connect,
// net/tls connect, net.Socket#connect, dgram sockets and DNS lookup/resolve (callback and promise APIs). ESM named
// bindings of the built-ins are re-synchronised (syncBuiltinESMExports), so `import { request } from 'node:https'` is
// covered too. There is no allowlist, no loopback exception, no environment switch and no uninstall: this package has
// no live mode. It never reads environment variables. Production code never imports this module.
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';

export const BLOCKED_CODE = 'OFFLINE_EGRESS_BLOCKED';
const attempts: string[] = [];
let installed = false;

function blocked(label: string): never {
  attempts.push(label);
  const error = new Error(BLOCKED_CODE) as Error & { code: string };
  error.code = BLOCKED_CODE;
  throw error;
}
function replace(target: Record<string, unknown>, key: string, label: string): void {
  Object.defineProperty(target, key, { configurable: false, enumerable: true, writable: false,
    value: function offlineBlocked() { return blocked(label); } });
}
function replaceClass(target: Record<string, unknown>, key: string, label: string): void {
  if (!(key in target)) return;
  Object.defineProperty(target, key, { configurable: false, enumerable: false, writable: false,
    value: class OfflineBlocked { constructor() { blocked(label); } } });
}

const DNS_FUNCTIONS = ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx',
  'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse'];

/** Idempotent. Returns true when this call installed the guard. */
export function installNetworkGuard(): boolean {
  if (installed) return false;
  const g = globalThis as unknown as Record<string, unknown>;
  replace(g, 'fetch', 'fetch');
  replaceClass(g, 'WebSocket', 'WebSocket');
  replaceClass(g, 'EventSource', 'EventSource');
  for (const [mod, name] of [[http, 'http'], [https, 'https']] as const) {
    replace(mod as unknown as Record<string, unknown>, 'request', `${name}.request`);
    replace(mod as unknown as Record<string, unknown>, 'get', `${name}.get`);
  }
  replace(http2 as unknown as Record<string, unknown>, 'connect', 'http2.connect');
  replace(net as unknown as Record<string, unknown>, 'connect', 'net.connect');
  replace(net as unknown as Record<string, unknown>, 'createConnection', 'net.createConnection');
  replace(tls as unknown as Record<string, unknown>, 'connect', 'tls.connect');
  replace(net.Socket.prototype as unknown as Record<string, unknown>, 'connect', 'net.Socket.connect');
  replace(dgram as unknown as Record<string, unknown>, 'createSocket', 'dgram.createSocket');
  for (const fn of DNS_FUNCTIONS) {
    if (typeof (dns as unknown as Record<string, unknown>)[fn] === 'function') replace(dns as unknown as Record<string, unknown>, fn, `dns.${fn}`);
    if (typeof (dns.promises as unknown as Record<string, unknown>)[fn] === 'function') replace(dns.promises as unknown as Record<string, unknown>, fn, `dns.promises.${fn}`);
  }
  replaceClass(dns as unknown as Record<string, unknown>, 'Resolver', 'dns.Resolver');
  replaceClass(dns.promises as unknown as Record<string, unknown>, 'Resolver', 'dns.promises.Resolver');
  syncBuiltinESMExports();
  installed = true;
  return true;
}

export const networkGuardInstalled = (): boolean => installed;
/** Copy of the fixed labels of every blocked attempt in this process (never targets, URLs or arguments). */
export const blockedAttempts = (): readonly string[] => [...attempts];
