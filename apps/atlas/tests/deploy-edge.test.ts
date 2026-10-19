import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proxyIdentityFromEnv, proxyIdentityMiddleware } from '../apps/api/src/deploy/proxy-identity.ts';
import { OPENAPI_DOCUMENT } from '../apps/api/src/deploy/openapi.ts';
import { allowedHostsFromEnv, operatorMiddleware } from '../apps/api/src/operator/http.ts';
import { loadOperatorAssets } from '../apps/api/src/operator/assets.ts';
import { MANIFEST_FORMAT } from '../apps/api/src/operator/manifest.ts';
import { createCredentialHolder } from '../apps/operator/src/credential.ts';
import { isConsoleLocation, isSessionLocation } from '../apps/operator/src/origin.ts';

// Deployment edge (docs/deploy/DEPLOY.md): the Microsoft sign-in proxy identity, /session and /openapi.json, the console Host
// allowlist and the console's edge-session credential — over a real node:http server with raw requests.
const SECRET = 'p'.repeat(40);
const TOKENS = { ATLAS_USER_TOKEN_OLEKSANDR: `atl_${'a'.repeat(43)}`, ATLAS_USER_TOKEN_BJARTE: `atl_${'b'.repeat(43)}` };
const ENV = { ATLAS_PROXY_SECRET: SECRET, ATLAS_PROXY_USERS: 'Oleksandr@Vardahei.no=ATLAS_USER_TOKEN_OLEKSANDR; bjarte@vardahei.no=ATLAS_USER_TOKEN_BJARTE', ...TOKENS };
const servers: Server[] = []; const dirs: string[] = [];
after(async () => { for (const s of servers) s.close(); for (const d of dirs) await rm(d, { recursive: true, force: true }); });

/** A server whose final handler echoes what the API routes would see: authorization and any x-atlas header. */
async function serve(handler: (req: IncomingMessage, res: import('node:http').ServerResponse, next: () => void) => void): Promise<number> {
  const server = createServer((req, res) => handler(req, res, () => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ authorization: req.headers.authorization ?? null, proxy: Object.keys(req.headers).filter(h => h.startsWith('x-atlas-')),
      raw: req.rawHeaders.filter((_, i) => i % 2 === 0).map(h => h.toLowerCase()).filter(h => h.startsWith('x-atlas-') || h === 'authorization') }));
  }));
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return (server.address() as { port: number }).port;
}
function raw(port: number, lines: string[]): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.end([...lines, 'Connection: close', '', ''].join('\r\n')));
    let data = ''; socket.on('data', c => { data += c; }); socket.on('error', reject);
    socket.on('end', () => resolve({ status: Number(data.split(' ')[1]), body: data.slice(data.indexOf('\r\n\r\n') + 4) }));
  });
}

const basic = (user: string, secret: string) => `Authorization: Basic ${Buffer.from(`${user}:${secret}`, 'utf8').toString('base64')}`;

test('proxyIdentityFromEnv: both unset is off; a short/space/colon secret, empty or malformed list, duplicate or non-token entry refuses', () => {
  assert.equal(proxyIdentityFromEnv({}), null);
  const config = proxyIdentityFromEnv(ENV)!;
  assert.deepEqual([...config.users.keys()], ['oleksandr@vardahei.no', 'bjarte@vardahei.no'], 'emails are lower-cased');
  for (const bad of [{ ...ENV, ATLAS_PROXY_SECRET: 'short' }, { ...ENV, ATLAS_PROXY_SECRET: `${SECRET} x` }, { ...ENV, ATLAS_PROXY_SECRET: `${SECRET}:x` },
    { ATLAS_PROXY_SECRET: SECRET }, { ATLAS_PROXY_USERS: ENV.ATLAS_PROXY_USERS, ...TOKENS }, { ...ENV, ATLAS_PROXY_USERS: ' ' },
    { ...ENV, ATLAS_PROXY_USERS: 'not-an-email=ATLAS_USER_TOKEN_BJARTE' }, { ...ENV, ATLAS_PROXY_USERS: 'a@b.no=ATLAS_USER_TOKEN_BJARTE;A@b.no=ATLAS_USER_TOKEN_OLEKSANDR' },
    { ...ENV, ATLAS_PROXY_USERS: 'a@b.no=MISSING_TOKEN' }, { ...ENV, ATLAS_PROXY_USERS: 'a@b.no=lower_name' }, { ...ENV, ATLAS_USER_TOKEN_BJARTE: 'too short' }]) {
    assert.throws(() => proxyIdentityFromEnv(bad as never), /ATLAS_PROXY_/);
  }
});

test('proxy identity: Basic <email>:<secret> from the edge becomes that user\'s own bearer token; /session answers', async () => {
  const port = await serve(proxyIdentityMiddleware(proxyIdentityFromEnv(ENV)));
  const ok = await raw(port, ['GET /clients HTTP/1.1', 'Host: x', basic('OLEKSANDR@vardahei.no', SECRET)]);
  assert.deepEqual([ok.status, JSON.parse(ok.body)], [200, { authorization: `Bearer ${TOKENS.ATLAS_USER_TOKEN_OLEKSANDR}`, proxy: [], raw: ['authorization'] }],
    'the routes see only the user\'s bearer token');
  const session = await raw(port, ['GET /session HTTP/1.1', 'Host: x', basic('bjarte@vardahei.no', SECRET)]);
  assert.deepEqual([session.status, JSON.parse(session.body)], [200, { user: 'bjarte@vardahei.no' }]);
  assert.equal((await raw(port, ['GET /session HTTP/1.1', 'Host: x', `Authorization: Bearer ${TOKENS.ATLAS_USER_TOKEN_BJARTE}`])).status, 401, 'a bearer request is not a sign-in session');
});

test('proxy identity refuses: wrong/missing secret 401, unknown email 403, duplicated Authorization 401; Bearer and none pass unchanged', async () => {
  const port = await serve(proxyIdentityMiddleware(proxyIdentityFromEnv(ENV)));
  const cases: [string[], number][] = [
    [[basic('bjarte@vardahei.no', 'q'.repeat(40))], 401],
    [['Authorization: Basic Ymphcn RlQHZhcmRhaGVpLm5v'], 401],
    [[basic('bjarte@vardahei.no', '')], 401],
    [[basic('', SECRET)], 401],
    [[basic('asbjorn@vardahei.no', SECRET)], 403],
    [[basic('bjarte@vardahei.no', SECRET), basic('bjarte@vardahei.no', SECRET)], 401],
    [[basic('bjarte@vardahei.no', SECRET), `Authorization: Bearer ${TOKENS.ATLAS_USER_TOKEN_OLEKSANDR}`], 401],
  ];
  for (const [headers, status] of cases) assert.equal((await raw(port, ['GET /clients HTTP/1.1', 'Host: x', ...headers])).status, status, headers.join(' | '));
  const machine = await raw(port, ['GET /clients HTTP/1.1', 'Host: x', 'Authorization: Bearer atl_machine_client_token_xxxxxx']);
  assert.deepEqual(JSON.parse(machine.body), { authorization: 'Bearer atl_machine_client_token_xxxxxx', proxy: [], raw: ['authorization'] });
  assert.deepEqual(JSON.parse((await raw(port, ['GET /clients HTTP/1.1', 'Host: x'])).body), { authorization: null, proxy: [], raw: [] });
  const off = await serve(proxyIdentityMiddleware(null));
  assert.equal((await raw(off, ['GET /clients HTTP/1.1', 'Host: x', basic('bjarte@vardahei.no', SECRET)])).status, 401,
    'with the boundary off any Basic credential is refused, never trusted');
});

test('/openapi.json: the OpenAPI 3.1 document without authentication; it names every DB-mode route', async () => {
  const port = await serve(proxyIdentityMiddleware(null));
  const r = await raw(port, ['GET /openapi.json HTTP/1.1', 'Host: x']);
  const doc = JSON.parse(r.body);
  assert.deepEqual([r.status, doc.openapi, doc.components.securitySchemes.bearer.scheme], [200, '3.1.0', 'bearer']);
  for (const path of ['/clients', '/clients/{id}/overview', '/clients/{id}/observations', '/clients/{id}/observations/{observationId}', '/clients/{id}/audit', '/clients/{clientId}/observations/{observationId}/correlation',
    '/tools', '/tools/execute', '/audit/security', '/session']) assert.ok(doc.paths[path], path);
  assert.deepEqual(doc, JSON.parse(JSON.stringify(OPENAPI_DOCUMENT)));
});

test('console Host gate: the loopback authority plus exactly the configured deployment authorities; everything else 421', async () => {
  assert.deepEqual(allowedHostsFromEnv(undefined), []); assert.deepEqual(allowedHostsFromEnv(' '), []);
  assert.deepEqual(allowedHostsFromEnv('admin.vardahei.tech, atlas-admin-api:3100'), ['admin.vardahei.tech', 'atlas-admin-api:3100']);
  for (const bad of ['Admin.vardahei.tech', 'http://a.b', 'a.b/x', 'a b', 'a.b:0', '*.b', 'a.b,']) assert.throws(() => allowedHostsFromEnv(bad), /ATLAS_ALLOWED_HOSTS/, bad);
  const dir = await mkdtemp(join(tmpdir(), 'atlas-deploy-assets-')); dirs.push(dir);
  const body = '<!doctype html><title>t</title>';
  await writeFile(join(dir, 'index.html'), body);
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ format: MANIFEST_FORMAT, files: [{ path: 'index.html', bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') }] }));
  const port = await serve(operatorMiddleware(3100, await loadOperatorAssets(dir), ['admin.vardahei.tech', 'atlas-admin-api:3100']));
  for (const [host, status] of [['127.0.0.1:3100', 200], ['admin.vardahei.tech', 200], ['atlas-admin-api:3100', 200], ['admin.vardahei.tech:443', 421],
    ['evil.example', 421], ['atlas-admin-api', 421]] as const) {
    assert.equal((await raw(port, ['GET /operator/ HTTP/1.1', `Host: ${host}`])).status, status, host);
  }
  assert.equal((await raw(port, ['GET /operator/ HTTP/1.1', 'Host: admin.vardahei.tech', 'Host: admin.vardahei.tech'])).status, 421, 'duplicated Host');
});

test('console edge session: no Authorization, same-origin credentials; token mode unchanged (omit); only https names at /operator/', async () => {
  const seen: RequestInit[] = [];
  const holder = createCredentialHolder(async (_input, init) => { seen.push(init); return new Response('{}'); });
  const signal = new AbortController().signal;
  await assert.rejects(holder.get({ kind: 'clients' } as never, signal), /REQUEST_REFUSED/, 'nothing is sent without a credential');
  const before = holder.epoch(); holder.useSession!();
  assert.ok(holder.connected() && holder.epoch() > before);
  await holder.get({ kind: 'clients' } as never, signal);
  assert.deepEqual([new Headers(seen[0]!.headers).has('authorization'), seen[0]!.credentials], [false, 'same-origin']);
  assert.ok(holder.replace(`atl_${'c'.repeat(43)}`));
  await holder.get({ kind: 'clients' } as never, signal);
  assert.deepEqual([new Headers(seen[1]!.headers).get('authorization'), seen[1]!.credentials], [`Bearer atl_${'c'.repeat(43)}`, 'omit']);
  holder.clear(); assert.equal(holder.connected(), false);
  assert.deepEqual([isSessionLocation('https://admin.vardahei.tech', '/operator/'), isSessionLocation('https://admin.vardahei.tech:8443', '/operator/'),
    isSessionLocation('http://admin.vardahei.tech', '/operator/'), isSessionLocation('https://localhost', '/operator/'), isSessionLocation('https://admin.vardahei.tech', '/x')],
    [true, false, false, false, false]);
  assert.equal(isConsoleLocation('http://127.0.0.1:3100', '/operator/'), true, 'the local console is unchanged');
});

test('proxy refusals preserve the PowerOffice JSON contract with the boundary enabled or disabled', async () => {
  for (const config of [null, proxyIdentityFromEnv(ENV)]) {
    const port = await serve(proxyIdentityMiddleware(config));
    for (const endpoint of ['status', 'summary']) {
      for (const headers of [['Authorization: Basic abc'], ['Authorization: Bearer malformed', 'Authorization: Bearer duplicate']]) {
        const r = await raw(port, [`GET /clients/synthetic/poweroffice/synthetic/${endpoint} HTTP/1.1`, 'Host: x', ...headers]);
        assert.equal(r.status, 401);
        assert.deepEqual(JSON.parse(r.body), { statusCode: 401, code: 'POWEROFFICE_AUTHENTICATION_FAILED', synthetic: true });
      }
    }
  }
});
