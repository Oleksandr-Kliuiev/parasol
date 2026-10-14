import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operatorUiEnabled, prepareOperatorConsole } from '../apps/api/src/operator/console.ts';
import { loadOperatorAssets, ASSETS_UNAVAILABLE } from '../apps/api/src/operator/assets.ts';
import { operatorMiddleware, OPERATOR_CSP, OPERATOR_HEADERS } from '../apps/api/src/operator/http.ts';
import { MANIFEST_FORMAT } from '../apps/api/src/operator/manifest.ts';

// S5-A server boundary units (A1/A2): flag, fail-closed asset loading and the Host/header/static middleware over a real
// node:http server with raw requests. tests/pg/operator-http.pg.test.ts repeats the boundary on the compiled API process.
const dirs: string[] = [];
after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
async function assetDir(files: Record<string, string>, manifest?: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-operator-assets-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
  const entries = Object.entries(files).map(([path, body]) => ({ path, bytes: Buffer.byteLength(body), sha256: sha(body) }));
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest ?? { format: MANIFEST_FORMAT, files: entries }));
  return dir;
}
const BASIC = { 'index.html': '<!doctype html><title>t</title>', 'main.js': 'export {};', 'styles.css': 'body{}' };

test('ATLAS_OPERATOR_UI: unset or 0 disabled, 1 enabled, anything else refuses to start', () => {
  assert.equal(operatorUiEnabled(undefined), false);
  assert.equal(operatorUiEnabled('0'), false);
  assert.equal(operatorUiEnabled('1'), true);
  for (const bad of ['', 'true', 'yes', ' 1', '1 ', '01', 'on', '2']) assert.throws(() => operatorUiEnabled(bad), /ATLAS_OPERATOR_UI must be unset, 0 or 1/, bad);
});

test('disabled console needs no assets; enabled console with missing assets fails closed with the fixed code', async () => {
  assert.equal(await prepareOperatorConsole(undefined, 3100, '/nonexistent/operator'), null);
  assert.equal(await prepareOperatorConsole('0', 3100, '/nonexistent/operator'), null);
  await assert.rejects(prepareOperatorConsole('1', 3100, '/nonexistent/operator'), { message: ASSETS_UNAVAILABLE });
});

test('asset loader: only exact manifest entries, regular files inside the directory, matching size and hash', async () => {
  const assets = await loadOperatorAssets(await assetDir(BASIC));
  assert.deepEqual([...assets.keys()].sort(), ['/operator/', '/operator/main.js', '/operator/styles.css']);
  assert.equal(assets.get('/operator/main.js')!.contentType, 'text/javascript; charset=utf-8');
  // The brand logo is the one binary asset type: served as image/png (nosniff applies to every response).
  const withLogo = await loadOperatorAssets(await assetDir({ ...BASIC, 'vardahei-it-logo.png': '\u0089PNG' }));
  assert.equal(withLogo.get('/operator/vardahei-it-logo.png')!.contentType, 'image/png');
  const rejects = async (dir: Promise<string> | string, name: string) =>
    assert.rejects(loadOperatorAssets(await dir), { message: ASSETS_UNAVAILABLE }, name);
  const entry = (path: string, body = 'x') => ({ path, bytes: Buffer.byteLength(body), sha256: sha(body) });
  for (const path of ['logo.svg', 'logo.jpg', 'font.woff2', 'logo.PNG']) {
    await rejects(assetDir(BASIC, { format: MANIFEST_FORMAT, files: [entry('index.html', BASIC['index.html']), entry(path)] }), path);
  }
  await rejects(assetDir(BASIC, { format: 'other', files: [entry('index.html')] }), 'format');
  await rejects(assetDir(BASIC, { format: MANIFEST_FORMAT, files: [] }), 'empty');
  await rejects(assetDir({ 'main.js': 'x' }), 'no index');
  for (const path of ['../package.json', 'sub/main.js', '.env', 'manifest.json', 'Main.js', 'main.ts', 'main.js.map', '%2e%2e.js', 'main.js\u0000']) {
    await rejects(assetDir(BASIC, { format: MANIFEST_FORMAT, files: [entry('index.html', BASIC['index.html']), entry(path)] }), path);
  }
  await rejects(assetDir(BASIC, { format: MANIFEST_FORMAT, files: [{ ...entry('index.html', BASIC['index.html']), sha256: sha('other') }] }), 'hash');
  await rejects(assetDir(BASIC, { format: MANIFEST_FORMAT, files: [{ ...entry('index.html', BASIC['index.html']), bytes: 1 }] }), 'size');
  // A symlinked asset (even to a file with the right content) and a symlinked manifest are refused.
  const outside = await mkdtemp(join(tmpdir(), 'atlas-operator-outside-')); dirs.push(outside);
  await writeFile(join(outside, 'main.js'), BASIC['main.js']);
  const linked = await assetDir(BASIC);
  await rm(join(linked, 'main.js')); await symlink(join(outside, 'main.js'), join(linked, 'main.js'));
  await rejects(linked, 'symlinked asset');
  const manifestLink = await assetDir(BASIC);
  await writeFile(join(outside, 'manifest.json'), JSON.stringify({ format: MANIFEST_FORMAT, files: [entry('index.html', BASIC['index.html'])] }));
  await rm(join(manifestLink, 'manifest.json')); await symlink(join(outside, 'manifest.json'), join(manifestLink, 'manifest.json'));
  await rejects(manifestLink, 'symlinked manifest');
  const withExtra = { format: MANIFEST_FORMAT, files: [entry('index.html', BASIC['index.html']), entry('extra.js')] };
  await rejects(assetDir(BASIC, withExtra), 'listed file missing');
  const dirEntry = await assetDir(BASIC, withExtra);
  await mkdir(join(dirEntry, 'extra.js'));
  await rejects(dirEntry, 'listed entry is a directory');
});

async function serve(port: number): Promise<{ server: Server; port: number }> {
  const assets = await loadOperatorAssets(await assetDir(BASIC));
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const actual = (server.address() as { port: number }).port;
  const middleware = operatorMiddleware(port || actual, assets);
  server.on('request', (req, res) => middleware(req, res, () => { res.setHeader('Content-Type', 'application/json'); res.end('{"api":true}'); }));
  return { server, port: actual };
}
/** Raw HTTP/1.1 exchange, so Host and the request target are exactly what the test writes. Returns status, headers, body. */
function raw(port: number, request: string): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(request));
    let data = '';
    socket.on('data', chunk => { data += String(chunk); });
    socket.on('error', reject);
    socket.on('end', () => {
      const [head, ...rest] = data.split('\r\n\r\n');
      const lines = head!.split('\r\n');
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) { const i = line.indexOf(':'); headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim(); }
      resolve({ status: Number(lines[0]!.split(' ')[1]), headers, body: rest.join('\r\n\r\n') });
    });
  });
}
const get = (port: number, target: string, host: string | null = `127.0.0.1:${port}`, method = 'GET', extra = '') =>
  raw(port, `${method} ${target} HTTP/1.1\r\n${host === null ? '' : `Host: ${host}\r\n`}${extra}Connection: close\r\n\r\n`);

test('middleware: exact Host only, before static or API dispatch; headers on every response', async () => {
  const { server, port } = await serve(0);
  try {
    const ok = await get(port, '/operator/');
    assert.equal(ok.status, 200); assert.equal(ok.headers['content-type'], 'text/html; charset=utf-8');
    for (const [name, value] of Object.entries(OPERATOR_HEADERS)) assert.equal(ok.headers[name.toLowerCase()], value, name);
    assert.equal(ok.headers['content-security-policy'], OPERATOR_CSP);
    const api = await get(port, '/clients');
    assert.equal(api.body, '{"api":true}'); assert.equal(api.headers['cache-control'], 'no-store'); assert.equal(api.headers['x-frame-options'], 'DENY');
    for (const host of ['localhost:' + port, '127.0.0.1', `127.0.0.1:${port + 1}`, `[::1]:${port}`, `127.0.0.1.nip.io:${port}`, `evil.example`, `127.0.0.1:${port}.`, '']) {
      for (const target of ['/operator/', '/clients', '/operator/main.js']) {
        const refused = await get(port, target, host);
        assert.equal(refused.status, 421, `${host} ${target}`);
        assert.ok(!refused.body.includes('api') && !refused.body.includes('<!doctype'), 'no dispatch');
        assert.equal(refused.headers['content-security-policy'], OPERATOR_CSP);
      }
    }
    assert.equal((await get(port, '/clients', null)).status, 400, 'HTTP/1.1 without Host is rejected by Node itself');
    assert.equal((await raw(port, `GET /clients HTTP/1.0\r\n\r\n`)).status, 421, 'HTTP/1.0 without Host');
    assert.equal((await get(port, '/clients', `127.0.0.1:${port}`, 'GET', `Host: 127.0.0.1:${port}\r\n`)).status, 421, 'duplicate Host');
    assert.equal((await get(port, `http://127.0.0.1:${port}/clients`)).status, 421, 'absolute-form target');
    assert.equal((await get(port, `//evil.example/clients`)).status, 421, 'scheme-relative target');
    assert.equal((await get(port, '/clients', `127.0.0.1:${port}`, 'GET', 'X-Forwarded-Host: 127.0.0.1\r\nForwarded: host=127.0.0.1\r\n')).status, 200,
      'forwarded headers are ignored, not trusted');
    assert.equal((await get(port, '/clients', 'localhost:' + port, 'GET', `X-Forwarded-Host: 127.0.0.1:${port}\r\n`)).status, 421);
  } finally { server.close(); }
});

test('middleware: exact asset paths only; no redirect, listing, traversal, encoded variant or SPA fallback', async () => {
  const { server, port } = await serve(0);
  try {
    assert.equal((await get(port, '/operator/main.js')).headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal((await get(port, '/operator/?q=1')).status, 200);
    const head = await get(port, '/operator/styles.css', `127.0.0.1:${port}`, 'HEAD');
    assert.equal(head.status, 200); assert.equal(head.body, '');
    for (const path of ['/operator', '/operator/index.html', '/operator/manifest.json', '/operator/missing.js', '/operator/../package.json',
      '/operator/%2e%2e/package.json', '/operator/..%2fpackage.json', '/operator/%2E%2E%2F.env', '/operator//main.js', '/operator/main.js/',
      '/operator/MAIN.JS', '/operator/main.js%00', '/operator/sub/', '/operator/.env', '/operator?x=/operator/', '/operator/main.js;.css']) {
      const response = await get(port, path);
      assert.equal(response.status, 404, path);
      assert.equal(response.headers.location, undefined, `${path} never redirects`);
      assert.ok(!response.body.includes('export') && !response.body.includes('<!doctype'), `${path} exposes nothing`);
    }
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) assert.equal((await get(port, '/operator/', `127.0.0.1:${port}`, method)).status, 404, method);
    const passthrough = await get(port, '/operatorx');
    assert.equal(passthrough.body, '{"api":true}', 'paths outside /operator/ continue to the API unchanged');
  } finally { server.close(); }
});
