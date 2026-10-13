import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AtlasError } from '../packages/core/contracts.ts';
import { ClientCredentialsTokenProvider, m365TokenCache, parseM365Credential } from '../connectors/microsoft365/auth.ts';
import { M365GraphSession } from '../connectors/microsoft365/connector.ts';
import type { M365Authority } from '../connectors/microsoft365/connector.ts';
import { directoryUrl } from '../connectors/microsoft365/contract.ts';
import { guid } from './m365-sql-invariants.ts';
import { M365_APP, M365_SECRET_VALUE, mockM365, page, userRow } from './support/m365-graph-mock.ts';

// Stage 2 task 2.4, B1 (unit, captured mock requests): token acquisition, same-token tenant verification before any
// collection request, scoped token cache, authority recheck before secret resolution / token POST / every GET, one 401
// reacquisition per session across tenant verification and pages. No network; synthetic IDs only.
const TENANT = guid('7'); const OTHER_TENANT = guid('6');
const fails = (code: string) => (e: unknown) => e instanceof AtlasError && e.code === code;
beforeEach(() => m365TokenCache.clear());

interface FakeOptions { connectionId?: string; clientId?: string; version?: number; secretRef?: string; secret?: () => Promise<string> }
function fakeAuthority(options: FakeOptions = {}) {
  const log: string[] = []; let allowed = true;
  const authority: M365Authority = {
    workspaceId: 'w', clientId: options.clientId ?? 'c1', connectionId: options.connectionId ?? 'conn', tenantId: TENANT, lifecycleVersion: options.version ?? 2,
    recheck: async () => { log.push('recheck'); if (!allowed) throw new AtlasError('M365_CONNECTION_CHANGED', 'PERMANENT'); return { secretRef: options.secretRef ?? 'env://M365_GASTA' }; },
    resolveSecret: async () => { log.push('secret'); return options.secret ? options.secret() : M365_SECRET_VALUE; },
  };
  return { authority, log, revoke: () => { allowed = false; } };
}
const usersOnePage = (url: URL) => url.pathname === '/v1.0/users' ? page([userRow(guid('a'))]) : undefined;

test('token POST is the fixed client_credentials request; the SAME token verifies the organization before any collection request', async () => {
  const mock = mockM365(TENANT, { route: usersOnePage });
  const session = new M365GraphSession(fakeAuthority().authority, mock);
  await session.get('users', directoryUrl('users'));
  assert.deepEqual(mock.requests.map(r => [r.method, new URL(r.url).pathname]), [
    ['POST', `/${TENANT}/oauth2/v2.0/token`], ['GET', '/v1.0/organization'], ['GET', '/v1.0/users']]);
  const [post, org, users] = mock.requests;
  assert.equal(post!.url, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
  assert.equal(post!.redirect, 'error');
  const form = new URLSearchParams(post!.body!);
  assert.deepEqual([...form.keys()].sort(), ['client_id', 'client_secret', 'grant_type', 'scope']);
  assert.equal(form.get('grant_type'), 'client_credentials');
  assert.equal(form.get('scope'), 'https://graph.microsoft.com/.default');
  assert.equal(form.get('client_id'), M365_APP);
  assert.equal(org!.url, 'https://graph.microsoft.com/v1.0/organization?$select=id');
  assert.equal(org!.headers.Authorization, 'Bearer synthetic-token-0');
  assert.equal(users!.headers.Authorization, 'Bearer synthetic-token-0', 'the verified token, not another one');
  assert.ok(mock.requests.every(r => r.redirect === 'error'));
});

test('wrong tenant (credential of tenant B on binding A): no users/devices/signIns request, token never cached', async () => {
  for (const organization of [() => ({ status: 200, body: { value: [{ id: OTHER_TENANT }] } }), () => ({ status: 200, body: { value: [] } }),
    () => ({ status: 200, body: { value: [{ id: TENANT }, { id: OTHER_TENANT }] } }), () => ({ status: 200, body: { value: [{ id: 'not-a-guid' }] } }),
    () => ({ status: 200, body: { value: [{ id: TENANT }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/organization?$skiptoken=x' } })]) {
    const mock = mockM365(TENANT, { route: usersOnePage, organization });
    await assert.rejects(new M365GraphSession(fakeAuthority().authority, mock).get('users', directoryUrl('users')), fails('M365_TENANT_MISMATCH'));
    assert.deepEqual(mock.collectionGets(), [], 'no collection request with an unverified token');
    assert.equal(m365TokenCache.size(), 0);
  }
});

test('token cache is scoped by workspace/client/connection/tenant/application/secretRef/lifecycleVersion; eviction is per connection', async () => {
  const mock = mockM365(TENANT, { route: usersOnePage });
  const run = (o: FakeOptions) => new M365GraphSession(fakeAuthority(o).authority, mock).get('users', directoryUrl('users'));
  await run({}); await run({});
  assert.equal(mock.posts().length, 1, 'same scope and version: cached, already verified token');
  await run({ connectionId: 'conn-2' }); await run({ clientId: 'c2' }); await run({ version: 3 }); await run({ secretRef: 'env://M365_OTHER' });
  await run({ secret: async () => `${guid('5')}:other-app-secret` });
  assert.equal(mock.posts().length, 6, 'every other scope or credential version acquires and verifies its own token');
  assert.equal(mock.gets('/v1.0/organization').length, 6);
  assert.equal(m365TokenCache.evictConnection('w', 'c1', 'conn'), 4, 'versions 2 and 3, the second secretRef and the other application of conn');
  await run({});
  assert.equal(mock.posts().length, 7, 'evicted: a new token');
});

test('authority withdrawn while the secret resolves: no token POST, no organization or collection request', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let resolving!: () => void; const started = new Promise<void>(resolve => { resolving = resolve; });
  const fake = fakeAuthority({ secret: async () => { resolving(); await gate; return M365_SECRET_VALUE; } });
  const mock = mockM365(TENANT, { route: usersOnePage });
  const pending = new M365GraphSession(fake.authority, mock).get('users', directoryUrl('users'));
  pending.catch(() => undefined);
  await started;
  fake.revoke(); // disable / membership withdrawal commits during secret resolution
  release();
  await assert.rejects(pending, fails('M365_CONNECTION_CHANGED'));
  assert.deepEqual(mock.requests, [], 'nothing was sent anywhere');
  assert.deepEqual(fake.log, ['recheck', 'secret', 'recheck']);
});

test('authority is rechecked before every vendor call: revocation between pages stops the traversal', async () => {
  const fake = fakeAuthority();
  const mock = mockM365(TENANT, { route: (url, n) => url.pathname === '/v1.0/users'
    ? page([userRow(guid(String(n + 1)))], n === 0 ? 'https://graph.microsoft.com/v1.0/users?$skiptoken=p2' : undefined) : undefined });
  const traversal = new M365GraphSession(fake.authority, mock).traverse('users', directoryUrl('users'));
  assert.ok(await traversal.next());
  fake.revoke();
  await assert.rejects(traversal.next(), fails('M365_CONNECTION_CHANGED'));
  assert.equal(mock.gets('/v1.0/users').length, 1);
});

test('401 at the initial organization check: one reacquisition with its own verification; a further 401 is a bounded failure', async () => {
  const orgReplies = [401, 200];
  const mock = mockM365(TENANT, { route: usersOnePage, organization: () => orgReplies.shift() === 401 ? { status: 401 } : { status: 200, body: { value: [{ id: TENANT }] } } });
  await new M365GraphSession(fakeAuthority().authority, mock).get('users', directoryUrl('users'));
  assert.deepEqual(mock.requests.map(r => [r.method, new URL(r.url).pathname, r.headers.Authorization ?? '']), [
    ['POST', `/${TENANT}/oauth2/v2.0/token`, ''], ['GET', '/v1.0/organization', 'Bearer synthetic-token-0'],
    ['POST', `/${TENANT}/oauth2/v2.0/token`, ''], ['GET', '/v1.0/organization', 'Bearer synthetic-token-1'], ['GET', '/v1.0/users', 'Bearer synthetic-token-1']]);

  m365TokenCache.clear();
  const always401 = mockM365(TENANT, { route: usersOnePage, organization: () => ({ status: 401 }) });
  await assert.rejects(new M365GraphSession(fakeAuthority().authority, always401).get('users', directoryUrl('users')), fails('M365_AUTH_FAILED'));
  assert.equal(always401.posts().length, 2, 'exactly one reacquisition');
  assert.deepEqual(always401.collectionGets(), []);
  assert.equal(m365TokenCache.size(), 0, 'an unverified token is never cached');
});

test('401 on a page: the cached token is dropped and ONE new verified token retries; the budget is shared by the whole session', async () => {
  const mock = mockM365(TENANT, { route: (url, n) => url.pathname === '/v1.0/users' ? (n === 0 ? { status: 401 } : page([userRow(guid('a'))])) : undefined });
  const session = new M365GraphSession(fakeAuthority().authority, mock);
  await session.get('users', directoryUrl('users'));
  assert.equal(mock.posts().length, 2); assert.equal(mock.gets('/v1.0/organization').length, 2);
  assert.equal(mock.gets('/v1.0/users')[1]!.headers.Authorization, 'Bearer synthetic-token-1');
  // The same session (attempt) has used its one recovery: the next 401 fails without another token request
  const later = mockM365(TENANT);
  const shared = mockM365(TENANT, { route: (url, n) => url.pathname === '/v1.0/users' ? (n === 1 ? page([]) : { status: 401 }) : undefined,
    organization: (() => { let n = 0; return () => (n++ === 0 ? { status: 401 } : { status: 200, body: { value: [{ id: TENANT }] } }); })() });
  m365TokenCache.clear();
  await assert.rejects(new M365GraphSession(fakeAuthority().authority, shared).get('users', directoryUrl('users')), fails('M365_AUTH_FAILED'),
    'one 401 at verification plus one at the page exhausts the single recovery');
  assert.equal(shared.posts().length, 2);
  assert.deepEqual(later.requests, []);
});

test('token lifetime: inside the 120s margin a token is reacquired without spending the 401 recovery; too short a lifetime fails', async () => {
  let now = Date.UTC(2026, 9, 8, 12);
  const mock = mockM365(TENANT, { route: usersOnePage });
  const session = new M365GraphSession(fakeAuthority().authority, { graph: mock.graph, tokens: new ClientCredentialsTokenProvider(mock.auth, () => now) }, () => now);
  await session.get('users', directoryUrl('users'));
  now += 3600_000 - 119_000;
  await session.get('users', directoryUrl('users'));
  assert.equal(mock.posts().length, 2, 'expiry minus margin reached: a new token, verified again');
  const short = mockM365(TENANT, { route: usersOnePage, token: () => ({ status: 200, body: { token_type: 'Bearer', access_token: 'short', expires_in: 100 } }) });
  m365TokenCache.clear();
  await assert.rejects(new M365GraphSession(fakeAuthority().authority, short).get('users', directoryUrl('users')), fails('M365_TOKEN_LIFETIME_TOO_SHORT'));
  assert.equal(short.posts().length, 1); assert.deepEqual(short.gets(), []);
});

test('authority failures and malformed credentials leak nothing and send nothing further', async () => {
  const denied = mockM365(TENANT, { token: () => ({ status: 401, body: { error: 'invalid_client', error_description: `secret for ${TENANT} SENSITIVE` } }) });
  const error = await new M365GraphSession(fakeAuthority().authority, denied).get('users', directoryUrl('users')).catch(e => e) as AtlasError;
  assert.ok(fails('M365_AUTH_FAILED')(error));
  assert.ok(!JSON.stringify({ m: error.message, d: error.details }).match(/SENSITIVE|invalid_client|synthetic-client-secret|login\.microsoftonline/));
  assert.deepEqual(denied.gets(), []);
  for (const raw of ['no-separator', `${M365_APP}:`, `not-a-guid-not-a-guid-not-a-guid-xxxx:secret`, `${M365_APP}:bad\u0000secret`]) {
    const e = (() => { try { parseM365Credential(raw); return null; } catch (x) { return x as AtlasError; } })();
    assert.ok(e && fails('M365_CREDENTIAL_INVALID')(e) && !e.message.includes('secret'));
  }
  const malformed = mockM365(TENANT);
  await assert.rejects(new M365GraphSession(fakeAuthority({ secret: async () => 'oops' }).authority, malformed).get('users', directoryUrl('users')), fails('M365_CREDENTIAL_INVALID'));
  assert.deepEqual(malformed.requests, []);
  for (const body of [{ token_type: 'mac', access_token: 't', expires_in: 3600 }, { token_type: 'Bearer', access_token: 'has space', expires_in: 3600 },
    { token_type: 'Bearer', access_token: 't', expires_in: -1 }, { token_type: 'Bearer', expires_in: 3600 }]) {
    const bad = mockM365(TENANT, { token: () => ({ status: 200, body }) });
    await assert.rejects(new M365GraphSession(fakeAuthority().authority, bad).get('users', directoryUrl('users')), fails('M365_TOKEN_RESPONSE_INVALID'));
    assert.deepEqual(bad.gets(), []);
  }
});
