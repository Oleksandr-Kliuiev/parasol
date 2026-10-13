// TEST-ONLY Node preload for actual action CLI subprocesses (Stage 3 S3-C, acceptance C8), loaded as
//   node --experimental-strip-types --import ./tests/support/action-network-trap.ts scripts/ops.ts action-…
// Every native network entry point of the child — net/tls sockets, http/https requests, DNS lookups and the global fetch —
// is replaced by a recorder that appends its label to ATLAS_TEST_NETWORK_TRAP_FILE and throws before any I/O. Prisma's
// query engine is native code and opens its own database connection; any Node-level network use by the action path would
// be recorded here. Production code never imports this module; it adds no transport, endpoint or bypass.
import { appendFileSync } from 'node:fs';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

const file = process.env.ATLAS_TEST_NETWORK_TRAP_FILE;
if (!file) throw new Error('action-network-trap: ATLAS_TEST_NETWORK_TRAP_FILE is required (test-only preload)');
const trap = (target: any, key: string, label: string) => {
  target[key] = function trapped() { appendFileSync(file, `${label}\n`); throw new Error(`network trap: ${label}`); };
};
trap(net.Socket.prototype, 'connect', 'net.Socket.connect'); trap(net, 'connect', 'net.connect'); trap(net, 'createConnection', 'net.createConnection');
trap(tls, 'connect', 'tls.connect'); trap(http, 'request', 'http.request'); trap(http, 'get', 'http.get'); trap(https, 'request', 'https.request');
trap(https, 'get', 'https.get'); trap(dns, 'lookup', 'dns.lookup'); trap(dns.promises, 'lookup', 'dns.promises.lookup'); trap(globalThis, 'fetch', 'fetch');
