import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPERATOR_CSP } from '../../apps/api/src/operator/http.ts';
import { newToken } from '../../packages/reval/eval-wire.ts';
import { askPath, browserHeaders, evalSandbox, handoffPath, post, startEvalServer } from '../support/reval-eval-server.ts';
import type { EvalServer, Sandbox } from '../support/reval-eval-server.ts';

// RS-C-C server side (rs-c brief C §1.2/§1.5b): the measured bridge S serves ONLY the sealed measured console at /operator/ (exact
// assets from the build manifest) and — review rc1 F1 — applies the accepted console boundary to EVERY request (exact Host before any
// static/API dispatch, security headers on every response), missing/inconsistent console assets exit 44 before listening, and the
// evaluation header follows the
// RS-C-A review N1 rule: unrecognized routes stay the ordinary 404, HEAD/OPTIONS on Ask paths stay ordinary, a recognized
// non-Ask route (and the console) answers the fixed 400. In-process built production composition; real PG17; loopback only.
const skip = !process.env.ATLAS_PG_ADMIN_URL;
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
let sb: Sandbox; let srv: EvalServer;
before(async () => { if (skip) return; sb = await evalSandbox(); srv = await startEvalServer(sb); });
after(async () => { await srv?.close(); await sb?.ns.cleanup(); });
const get = (path: string, headers: Record<string, string> = {}, method = 'GET') => post(srv.port, path, null, { host: `127.0.0.1:${srv.port}`, ...headers }, method);
const session = () => ({ 'x-atlas-evaluation-session': newToken() });

test('the bridge S serves exactly the sealed measured console (never the ordinary entry) with the accepted console boundary on every path', { skip }, async () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'dist/operator-measured/manifest.json'), 'utf8')) as { files: { path: string; bytes: number }[] };
  const index = await get('/operator/');
  assert.equal(index.status, 200);
  assert.match(String(index.headers['content-security-policy']), /^default-src 'none'; script-src 'self'/);
  assert.match(index.body, /main-measured\.js/); assert.doesNotMatch(index.body, /src="main\.js"/);
  for (const f of manifest.files.filter(x => x.path !== 'index.html')) {
    const r = await get(`/operator/${f.path}`);
    assert.deepEqual([r.status, Buffer.byteLength(r.body)], [200, f.bytes], f.path);
  }
  assert.equal((await get('/operator/main.js')).status, 404, 'the ordinary entry is not part of the measured build');
  assert.equal((await get('/operator/manifest.json')).status, 404, 'the manifest itself is never an asset');
  assert.equal((await post(srv.port, '/operator/', null, { host: 'localhost' }, 'GET')).status, 421, 'console Host gate');
  // rc1 F1: the accepted console boundary covers the API too — security headers on API answers, and a DNS-rebinding Host is refused
  // (421) before any dispatch: no client list, no PAIR, and no Ask ingress counted by the evaluation gate.
  const clients = await get('/clients', { authorization: `Bearer ${sb.tokens.actor}` });
  assert.deepEqual([clients.status, clients.headers['cache-control'], typeof clients.headers['content-security-policy']], [200, 'no-store', 'string']);
  const rebind = { host: `rebind.example:${srv.port}` };
  assert.equal((await post(srv.port, '/clients', null, { ...rebind, authorization: `Bearer ${sb.tokens.actor}` }, 'GET')).status, 421);
  const pair = await post(srv.port, handoffPath, JSON.stringify({ contractVersion: 'RevalBrowserHandoffV1', operation: 'PAIR', pairingNonce: newToken() }),
    { ...browserHeaders(srv.port, sb.tokens.actor), ...rebind });
  assert.equal(pair.status, 421);
  const before = { ...srv.runtime.state.counters };
  const ask = await post(srv.port, askPath, '{}', { ...browserHeaders(srv.port, sb.tokens.actor), ...rebind });
  assert.equal(ask.status, 421);
  assert.deepEqual(srv.runtime.state.counters, before, 'a rebinding page never reaches the measured ingress counters');
});

test('N1: with the evaluation header an unrecognized route stays 404 and HEAD/OPTIONS on Ask stay ordinary; a recognized route or the console is a fixed 400', { skip }, async () => {
  for (const [path, method] of [['/no-such-route', 'GET'], ['/clients/x/nothing', 'POST'], [askPath, 'HEAD'], [askPath, 'OPTIONS']] as const) {
    const plain = await get(path, {}, method); const withHeader = await get(path, session(), method);
    assert.deepEqual([withHeader.status, plain.status], [404, 404], `${method} ${path}`);
  }
  for (const path of ['/clients', '/operator/', '/operator/main-measured.js']) {
    const r = await get(path, { authorization: `Bearer ${sb.tokens.actor}`, ...session() });
    assert.equal(r.status, 400, path);
    const body = JSON.parse(r.body);
    assert.deepEqual([body.contractVersion, body.code, r.headers['x-atlas-correlation-id'], r.headers['cache-control']],
      ['AskErrorV1', 'ASK_REQUEST_INVALID', body.correlationId, 'no-store'], path);
  }
  assert.notEqual((await get('/clients', { authorization: `Bearer ${sb.tokens.actor}` })).status, 400, 'without the header the route is unchanged');
  // RS-D-C (RS-C-C review N2): on a console path the header refusal carries the console's security headers, and a rebinding Host is
  // 421 there too (the console boundary first), never the 400.
  for (const path of ['/operator/', '/operator/main-measured.js']) {
    const r = await get(path, session());
    assert.deepEqual([r.status, r.headers['content-security-policy'], r.headers['x-content-type-options'], r.headers['x-frame-options'], r.headers['referrer-policy']],
      [400, OPERATOR_CSP, 'nosniff', 'DENY', 'no-referrer'], path);
    assert.equal((await post(srv.port, path, null, { host: `rebind.example:${srv.port}`, ...session() }, 'GET')).status, 421, `${path}: rebinding Host`);
    const raw = await new Promise<string>((resolve, reject) => { // two Host lines, written byte-exact (the HTTP client would refuse)
      const c = connect(srv.port, '127.0.0.1', () => c.end(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${srv.port}\r\nHost: 127.0.0.1:${srv.port}\r\n`
        + `x-atlas-evaluation-session: ${newToken()}\r\nConnection: close\r\n\r\n`));
      let out = ''; c.on('data', d => { out += String(d); }); c.on('end', () => resolve(out)); c.on('error', reject);
    });
    assert.match(raw, /^HTTP\/1\.1 421 /, `${path}: a duplicated Host (Node passes both lines on; the boundary refuses)`);
  }
});

test('missing measured console assets: the bridge composition exits 44 (CONSOLE) before anything else', { skip }, () => {
  const empty = mkdtempSync(join(tmpdir(), 'reval-console-'));
  const entry = new URL('../../dist/apps/api/src/reval/evaluation.js', import.meta.url).href;
  let status: number | null = null;
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e',
      `const m = await import(${JSON.stringify(entry)}); await m.composeEvaluation({ app: {}, db: {}, bridge: { launch: {} }, port: 1, consoleDir: ${JSON.stringify(empty)} });`],
    { stdio: 'ignore', env: { PATH: process.env.PATH ?? '' } });
    status = 0;
  } catch (e) { status = (e as { status: number }).status; }
  assert.equal(status, 44);
});
