// TEST-ONLY Node preload for actual S4-C API/CLI child processes, loaded as
//   node --experimental-strip-types --import ./tests/support/poweroffice-net-trap.ts <entry>
// Every OUTBOUND native network entry point — net/tls socket connects, http/https requests, the global fetch and DNS
// lookups — is replaced by a recorder that appends its label to ATLAS_TEST_NETWORK_TRAP_FILE and throws before any I/O.
// One exception keeps a server able to listen: dns.lookup of the literal loopback 127.0.0.1 (Node's net.Server.listen
// resolves its host through dns.lookup) passes through, and is not network access. Prisma's query engine is native code
// opening only its database connection. Production code never imports this module; it adds no transport or bypass.
// S4-C RC3: the PowerOffice cleanup runner opens its ONE paired database connection through Node's `pg` client. When the
// test passes ATLAS_TEST_NETWORK_TRAP_DB=host:port (the paired runtime database endpoint), exactly that socket target (and
// a DNS lookup of exactly that host) passes through; every other target is still recorded and refused.
import { appendFileSync } from 'node:fs';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

const file = process.env.ATLAS_TEST_NETWORK_TRAP_FILE;
if (!file) throw new Error('poweroffice-net-trap: ATLAS_TEST_NETWORK_TRAP_FILE is required (test-only preload)');
const record = (label: string): never => { appendFileSync(file, `${label}\n`); throw new Error(`network trap: ${label}`); };
const trap = (target: any, key: string, label: string) => { target[key] = function trapped() { return record(label); }; };
const allowed = /^(.+):([0-9]{1,5})$/.exec(process.env.ATLAS_TEST_NETWORK_TRAP_DB ?? '');
const socketConnect = net.Socket.prototype.connect;
(net.Socket.prototype as any).connect = function guardedConnect(this: net.Socket, ...args: any[]) {
  const target = typeof args[0] === 'object' && args[0] !== null ? args[0] : { port: args[0], host: args[1] };
  if (allowed && String(target.port) === allowed[2] && target.host === allowed[1]) return (socketConnect as any).apply(this, args);
  return record('net.Socket.connect');
};
trap(net, 'connect', 'net.connect'); trap(net, 'createConnection', 'net.createConnection');
trap(tls, 'connect', 'tls.connect'); trap(http, 'request', 'http.request'); trap(http, 'get', 'http.get'); trap(https, 'request', 'https.request');
trap(https, 'get', 'https.get'); trap(dns.promises, 'lookup', 'dns.promises.lookup'); trap(globalThis, 'fetch', 'fetch');
const lookup = dns.lookup;
(dns as any).lookup = function guardedLookup(host: unknown, ...rest: unknown[]) {
  if (host === '127.0.0.1' || (allowed && host === allowed[1])) return (lookup as any).call(dns, host, ...rest);
  return record('dns.lookup');
};
