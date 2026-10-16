import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateToken } from '../../packages/auth/token.ts';
import { createTestDatabase, projectRoot, runSeed } from '../support/pg-harness.ts';
import type { PgTestDatabase } from '../support/pg-harness.ts';
import { runMain, stageDist } from '../support/operator-dist.ts';
import type { Outcome, Started, StagedDist } from '../support/operator-dist.ts';
import { OPERATOR_CSP } from '../../apps/api/src/operator/http.ts';

// S5-A on the compiled API process (A1, A2): ATLAS_OPERATOR_UI default/invalid/enabled, fail-closed assets, startup
// from another working directory, Host gate and headers over real HTTP in fixture and DB mode, and no file exposure.
// Startup cases run a private copy of dist (tests/support/operator-dist.ts); the shared dist/ is never modified.
const fixtureToken = randomBytes(24).toString('hex');
const dbToken = generateToken();
let pgdb: PgTestDatabase;
let withUi: StagedDist; let withoutUi: StagedDist;
const started: Started[] = [];

before(async () => {
  pgdb = await createTestDatabase();
  runSeed(pgdb.ownerUrl, { ATLAS_DEMO_TOKEN: dbToken });
  [withUi, withoutUi] = await Promise.all([stageDist(true), stageDist(false)]);
});
after(async () => {
  for (const s of started) await s.stop();
  await Promise.all([withUi?.remove(), withoutUi?.remove()]);
  await pgdb?.drop();
});

const fixture = (extra: Record<string, string> = {}) => ({ ATLAS_MODE: 'fixture', ATLAS_DEMO_TOKEN: fixtureToken, ...extra });
const up = (outcome: Outcome): Started => {
  assert.ok('started' in outcome, `expected start, got ${'exitCode' in outcome ? outcome.exitCode : ''} ${'stderr' in outcome ? outcome.stderr.slice(0, 300) : ''}`);
  started.push(outcome.started);
  return outcome.started;
};
const refused = (outcome: Outcome, pattern: RegExp) => {
  assert.ok('exitCode' in outcome, 'expected a refusal to start');
  assert.notEqual(outcome.exitCode, 0); assert.match(outcome.stderr, pattern);
};
function raw(port: number, request: string): Promise<{ status: number; head: string; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(request));
    let data = '';
    socket.on('data', chunk => { data += String(chunk); });
    socket.on('error', reject);
    socket.on('end', () => { const [head, ...body] = data.split('\r\n\r\n'); resolve({ status: Number(head!.split(' ')[1]), head: head!, body: body.join('') }); });
  });
}
const rawGet = (port: number, target: string, host = `127.0.0.1:${port}`, extra = '') =>
  raw(port, `GET ${target} HTTP/1.1\r\nHost: ${host}\r\n${extra}Connection: close\r\n\r\n`);

test('default: console disabled, API unchanged and independent of console files; invalid flags refuse to start', async () => {
  const api = up(await runMain(withoutUi.main, fixture(), withoutUi.root, ['ATLAS_OPERATOR_UI']));
  const page = await fetch(`${api.base}/operator/`);
  assert.equal(page.status, 404); assert.equal(page.headers.get('content-security-policy'), null);
  const clients = await fetch(`${api.base}/clients`, { headers: { Authorization: `Bearer ${fixtureToken}` } });
  assert.equal(clients.status, 200);
  assert.deepEqual(await clients.json(), [{ id: 'demo-gasta', name: 'Gasta (synthetic)' }]);
  for (const header of ['content-security-policy', 'x-frame-options', 'referrer-policy', 'cache-control']) assert.equal(clients.headers.get(header), null, header);
  assert.equal((await rawGet(api.port, '/clients', 'localhost:1')).status, 401, 'without the console no Host gate is added');
  up(await runMain(withoutUi.main, fixture({ ATLAS_OPERATOR_UI: '0' }), withoutUi.root));
  for (const value of ['', 'true', '2', ' 1']) refused(await runMain(withUi.main, fixture({ ATLAS_OPERATOR_UI: value }), withUi.root), /ATLAS_OPERATOR_UI must be unset, 0 or 1/);
});

test('enabled with missing or tampered assets fails closed with the fixed code; enabled from another cwd serves the built bytes', async () => {
  refused(await runMain(withoutUi.main, fixture({ ATLAS_OPERATOR_UI: '1' }), withoutUi.root), /OPERATOR_UI_ASSETS_UNAVAILABLE/);
  const api = up(await runMain(withUi.main, fixture({ ATLAS_OPERATOR_UI: '1' }), tmpdir()));
  const manifest = JSON.parse(await readFile(join(projectRoot, 'dist/operator/manifest.json'), 'utf8')) as { files: { path: string; sha256: string }[] };
  for (const file of manifest.files) {
    const response = await fetch(`${api.base}/operator/${file.path === 'index.html' ? '' : file.path}`);
    assert.equal(response.status, 200, file.path);
    assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'), file.sha256, file.path);
  }
  const tampered = await stageDist(true);
  try {
    await writeFile(join(tampered.operator, 'main.js'), 'export {}; // changed after the build\n');
    refused(await runMain(tampered.main, fixture({ ATLAS_OPERATOR_UI: '1' }), tampered.root), /OPERATOR_UI_ASSETS_UNAVAILABLE/);
  } finally { await tampered.remove(); }
});

test('enabled fixture API: exact Host only on assets and API, headers everywhere, no file exposure or redirect', async () => {
  const api = up(await runMain(withUi.main, fixture({ ATLAS_OPERATOR_UI: '1' }), withUi.root));
  const auth = `Authorization: Bearer ${fixtureToken}\r\n`;
  const ok = await rawGet(api.port, '/clients', `127.0.0.1:${api.port}`, auth);
  assert.equal(ok.status, 200);
  for (const line of [`Content-Security-Policy: ${OPERATOR_CSP}`, 'Cache-Control: no-store', 'X-Content-Type-Options: nosniff', 'Referrer-Policy: no-referrer', 'X-Frame-Options: DENY']) {
    assert.ok(ok.head.includes(line), line);
  }
  assert.ok((await rawGet(api.port, '/clients')).head.includes('Cache-Control: no-store'), '401 carries the headers too');
  for (const host of [`localhost:${api.port}`, `127.0.0.1`, `127.0.0.2:${api.port}`, `[::1]:${api.port}`, `rebind.example:${api.port}`]) {
    for (const target of ['/operator/', '/operator/main.js', '/clients', '/clients/demo-gasta/overview']) {
      const response = await rawGet(api.port, target, host, auth);
      assert.equal(response.status, 421, `${host}${target}`);
      assert.ok(!response.body.includes('demo-gasta') && !response.body.includes('import'), 'no dispatch');
    }
  }
  const post = await raw(api.port, `POST /tools/execute HTTP/1.1\r\nHost: rebind.example\r\n${auth}Content-Type: application/json\r\nContent-Length: 4\r\nConnection: close\r\n\r\n{bad`);
  assert.equal(post.status, 421, 'refused before body parsing or tool dispatch');
  for (const target of ['/operator', '/operator/index.html', '/operator/manifest.json', '/operator/../package.json', '/operator/%2e%2e/package.json',
    '/operator/..%2f..%2fpackage.json', '/operator/%2e%2e%2f%2e%2e%2f.env', '/package.json', '/.env', '/apps/operator/src/main.ts', '/dist/operator/main.js',
    '/operator/credential.ts', '/operator/../../apps/api/src/main.ts', '/operator/nested/main.js']) {
    const response = await rawGet(api.port, target);
    assert.equal(response.status, 404, target);
    assert.ok(!/^location:/im.test(response.head), `${target} does not redirect`);
    assert.ok(!response.body.includes('"dependencies"') && !response.body.includes('ATLAS_') && !response.body.includes('import '), `${target} exposes nothing`);
  }
});

test('enabled DB API: Host gate before authentication and audit; exact Host keeps existing auth semantics with headers', async () => {
  const api = up(await runMain(withUi.main, { ATLAS_MODE: 'db', ATLAS_RUNTIME_DATABASE_URL: pgdb.runtimeUrl, ATLAS_OPERATOR_UI: '1' }, withUi.root));
  const auth = `Authorization: Bearer ${dbToken}\r\n`;
  const securityRows = async () => Number((await pgdb.owner.query(`SELECT count(*)::int AS n FROM "SecurityAuditEvent"`)).rows[0].n);
  const before = await securityRows();
  assert.equal((await rawGet(api.port, '/clients/not-mine/overview', `localhost:${api.port}`, auth)).status, 421);
  assert.equal(await securityRows(), before, 'a refused Host never reaches authorization or its audit');
  const list = await rawGet(api.port, '/clients', `127.0.0.1:${api.port}`, auth);
  assert.equal(list.status, 200); assert.ok(list.head.includes(`Content-Security-Policy: ${OPERATOR_CSP}`));
  assert.ok(list.body.includes('demo-gasta'));
  assert.equal((await rawGet(api.port, '/clients')).status, 401);
  assert.equal((await rawGet(api.port, '/clients/not-mine/overview', `127.0.0.1:${api.port}`, auth)).status, 403);
  assert.equal(await securityRows(), before + 1, 'existing denial audit unchanged');
  assert.equal((await rawGet(api.port, '/operator/')).status, 200);
});
