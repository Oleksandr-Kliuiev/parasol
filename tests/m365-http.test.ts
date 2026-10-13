import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AtlasError } from '../packages/core/contracts.ts';
import { ClientCredentialsTokenProvider, m365TokenCache } from '../connectors/microsoft365/auth.ts';
import { M365GraphSession } from '../connectors/microsoft365/connector.ts';
import type { M365Authority } from '../connectors/microsoft365/connector.ts';
import { directoryUrl, signInsUrl } from '../connectors/microsoft365/contract.ts';
import { graphGet, parseRetryAfter, validateNextLink } from '../connectors/microsoft365/http.ts';
import type { GraphTransport } from '../connectors/microsoft365/http.ts';
import { guid } from './m365-sql-invariants.ts';
import { M365_SECRET_VALUE, mockM365, page, userRow } from './support/m365-graph-mock.ts';

// Stage 2 task 2.4, B2 (unit, captured mock requests): the fixed Graph URL boundary before any bearer transmission,
// nextLink validation (origin, scheme, userinfo, port, fragment, version, collection path), redirect refusal, bounded
// paging, the restricted authority POST and safe error classification. No network.
const TENANT = guid('7');
const fails = (code: string) => (e: unknown) => e instanceof AtlasError && e.code === code;
beforeEach(() => m365TokenCache.clear());
const authority: M365Authority = { workspaceId: 'w', clientId: 'c1', connectionId: 'conn', tenantId: TENANT, lifecycleVersion: 2,
  recheck: async () => ({ secretRef: 'env://M365_GASTA' }), resolveSecret: async () => M365_SECRET_VALUE };

const BAD_LINKS: Record<string, string> = {
  attacker: 'https://evil.example/v1.0/users?$skiptoken=x', http: 'http://graph.microsoft.com/v1.0/users?$skiptoken=x',
  userinfo: 'https://user:pw@graph.microsoft.com/v1.0/users?$skiptoken=x', atSign: 'https://graph.microsoft.com@evil.example/v1.0/users?$skiptoken=x',
  port: 'https://graph.microsoft.com:8443/v1.0/users?$skiptoken=x', defaultPort: 'https://graph.microsoft.com:443/v1.0/users?$skiptoken=x',
  fragment: 'https://graph.microsoft.com/v1.0/users?$skiptoken=x#f', beta: 'https://graph.microsoft.com/beta/users?$skiptoken=x',
  sibling: 'https://graph.microsoft.com/v1.0/groups?$skiptoken=x', subPath: 'https://graph.microsoft.com/v1.0/users/delta?$skiptoken=x',
  dotSegments: 'https://graph.microsoft.com/v1.0/x/../users?$skiptoken=x', backslash: 'https://graph.microsoft.com\\@evil.example/v1.0/users?$skiptoken=x',
  upperHost: 'https://GRAPH.microsoft.com/v1.0/users?$skiptoken=x', noQuery: 'https://graph.microsoft.com/v1.0/users', space: 'https://graph.microsoft.com/v1.0/users? x',
  trailingSlash: 'https://graph.microsoft.com/v1.0/users/?$skiptoken=x', otherCloud: 'https://graph.microsoft.us/v1.0/users?$skiptoken=x',
  relative: '/v1.0/users?$skiptoken=x', nonString: 42 as unknown as string,
};

test('nextLink validation: only https Graph v1.0 on the same collection path, as returned', () => {
  const good = 'https://graph.microsoft.com/v1.0/users?$select=id&$top=500&$skiptoken=RFNwdAIAAQAAAB';
  assert.equal(validateNextLink(good, 'users'), good, 'used as returned, never rebuilt');
  assert.equal(validateNextLink('https://graph.microsoft.com/v1.0/auditLogs/signIns?$skiptoken=a', 'signIns'), 'https://graph.microsoft.com/v1.0/auditLogs/signIns?$skiptoken=a');
  for (const [name, link] of Object.entries(BAD_LINKS)) assert.throws(() => validateNextLink(link, 'users'), fails('M365_INVALID_NEXT_LINK'), name);
  assert.throws(() => validateNextLink(good, 'devices'), fails('M365_INVALID_NEXT_LINK'), 'a users link cannot continue a devices traversal');
});

test('a malicious nextLink stops the traversal before any request to it: the bearer token never leaves for a wrong URL', async () => {
  for (const [name, link] of Object.entries(BAD_LINKS)) {
    m365TokenCache.clear();
    const mock = mockM365(TENANT, { route: url => url.pathname === '/v1.0/users' ? page([userRow(guid('a'))], link) : undefined });
    const traversal = new M365GraphSession(authority, mock).traverse('users', directoryUrl('users'));
    await assert.rejects(traversal.next(), fails('M365_INVALID_NEXT_LINK'), name);
    assert.deepEqual(mock.gets().map(r => new URL(r.url).pathname), ['/v1.0/organization', '/v1.0/users'], name);
  }
});

test('fixed URL boundary at the transport: wrong origin/version/path never transmits a bearer, even through exported get', async () => {
  const sent: string[] = [];
  const transport: GraphTransport = async url => { sent.push(url); return new Response('{"value":[]}', { status: 200 }); };
  for (const url of [...Object.values(BAD_LINKS), 'https://graph.microsoft.com/v1.0/organization?$select=id']) {
    await assert.rejects(graphGet(transport, 'users', url, 'synthetic-token', Date.now), fails('M365_URL_REFUSED'), String(url));
  }
  assert.deepEqual(sent, [], 'graphGet refuses before calling the transport');
  const mock = mockM365(TENANT);
  const session = new M365GraphSession(authority, mock);
  for (const url of Object.values(BAD_LINKS)) await assert.rejects(session.get('users', url), fails('M365_URL_REFUSED'));
  await assert.rejects(session.get('users', directoryUrl('devices')), fails('M365_URL_REFUSED'), 'a fixed URL of another endpoint');
  assert.deepEqual(mock.requests, [], 'no secret use, token POST or GET for a refused URL');
});

test('first URLs come from the contract only: exact select/top and the documented inclusive ge/le sign-in filter', () => {
  assert.equal(directoryUrl('users'), 'https://graph.microsoft.com/v1.0/users?$select=id,displayName,userPrincipalName,userType,accountEnabled&$top=500');
  assert.equal(directoryUrl('devices'), 'https://graph.microsoft.com/v1.0/devices?$select=id,deviceId,displayName,accountEnabled,operatingSystem&$top=500');
  const url = new URL(signInsUrl(new Date('2026-10-08T10:00:00Z'), new Date('2026-10-08T11:00:00Z')));
  assert.equal(url.pathname, '/v1.0/auditLogs/signIns');
  assert.equal(url.searchParams.get('$filter'), 'createdDateTime ge 2026-10-08T10:00:00.000Z and createdDateTime le 2026-10-08T11:00:00.000Z');
  assert.equal(url.searchParams.get('$top'), '500');
  assert.equal(url.searchParams.get('$select'), null, 'no undocumented $select/$orderby on signIns');
});

test('redirects are refused; repeated links and page loops are bounded', async () => {
  const redirect = mockM365(TENANT, { route: () => ({ status: 302, headers: { location: 'https://evil.example/steal' } }) });
  await assert.rejects(new M365GraphSession(authority, redirect).get('users', directoryUrl('users')), fails('M365_REDIRECT_REFUSED'));
  assert.ok(!redirect.requests.some(r => r.url.includes('evil.example')));
  assert.ok(redirect.requests.every(r => r.redirect === 'error'));
  m365TokenCache.clear();
  const loop = 'https://graph.microsoft.com/v1.0/users?$skiptoken=same';
  const looping = mockM365(TENANT, { route: url => url.pathname === '/v1.0/users' ? page([], loop) : undefined });
  const traversal = new M365GraphSession(authority, looping).traverse('users', directoryUrl('users'));
  assert.ok(await traversal.next()); assert.ok(await traversal.next());
  await assert.rejects(traversal.next(), fails('M365_PAGINATION_LOOP'));
  assert.equal(looping.gets('/v1.0/users').length, 2);
});

test('authority POST is restricted: tenant must be a bound GUID, nothing is sent otherwise; redirect refused there too', async () => {
  const mock = mockM365(TENANT);
  const provider = new ClientCredentialsTokenProvider(mock.auth);
  for (const tenant of ['common', 'organizations', 'evil.example/x', guid('a').toUpperCase(), '00000000-0000-0000-0000-000000000000']) {
    await assert.rejects(provider.acquire(tenant, { applicationId: guid('9'), clientSecret: 's' }), fails('M365_TENANT_INVALID'), tenant);
  }
  assert.deepEqual(mock.requests, []);
  const redirecting = mockM365(TENANT, { token: () => ({ status: 302, headers: { location: 'https://evil.example' } }) });
  await assert.rejects(new ClientCredentialsTokenProvider(redirecting.auth).acquire(TENANT, { applicationId: guid('9'), clientSecret: 's' }), fails('M365_REDIRECT_REFUSED'));
});

test('status classification: 403 is access denied (not empty), 429 keeps the exact Retry-After, 5xx/timeouts transient; nothing leaks', async () => {
  const at = Date.UTC(2026, 9, 8, 12);
  assert.equal(parseRetryAfter('3600', at), 3600);
  assert.equal(parseRetryAfter('7200', at), 7200, 'above Stage 1’s one-hour clamp: honoured exactly');
  assert.equal(parseRetryAfter('Thu, 08 Oct 2026 13:30:00 GMT', at), 5400);
  assert.equal(parseRetryAfter(null, at), null); assert.equal(parseRetryAfter('soon', at), null);
  assert.equal(parseRetryAfter('86401', at), 'REJECTED', 'pathological: never honoured by retrying earlier');
  const replies: Record<string, { status: number; headers?: Record<string, string>; raw?: string }> = {
    M365_ACCESS_DENIED: { status: 403, raw: '{"error":{"message":"SENSITIVE tenant text"}}' },
    M365_RATE_LIMITED: { status: 429, headers: { 'retry-after': '1200' } }, M365_RETRY_AFTER_REJECTED: { status: 429, headers: { 'retry-after': '999999' } },
    M365_UPSTREAM_UNAVAILABLE: { status: 503 }, M365_NOT_FOUND: { status: 404 }, M365_UNEXPECTED_STATUS: { status: 418 },
    M365_INVALID_JSON: { status: 200, raw: '{"value": [' }, SYNC_LIMIT_EXCEEDED: { status: 200, raw: `{"value":[],"pad":"${'x'.repeat(5_000_100)}"}` },
  };
  for (const [code, reply] of Object.entries(replies)) {
    const transport: GraphTransport = async () => new Response(reply.raw ?? null, { status: reply.status, headers: reply.headers });
    const error = await graphGet(transport, 'users', `${directoryUrl('users')}&$skiptoken=SECRETLINK`, 'synthetic-bearer', () => at).catch(e => e) as AtlasError;
    assert.ok(fails(code)(error), code);
    assert.ok(!JSON.stringify({ m: error.message, d: error.details }).match(/SENSITIVE|SECRETLINK|synthetic-bearer|graph\.microsoft/), code);
    if (code === 'M365_RATE_LIMITED') { assert.equal(error.kind, 'TRANSIENT'); assert.equal(error.details.retryAfterSeconds, '1200'); }
    if (code === 'M365_ACCESS_DENIED') assert.equal(error.kind, 'PERMANENT');
  }
  const timeout: GraphTransport = async () => { throw Object.assign(new Error('timed out https://graph.microsoft.com/v1.0/users?$skiptoken=SECRETLINK'), { name: 'TimeoutError' }); };
  const error = await graphGet(timeout, 'users', directoryUrl('users'), 't', Date.now).catch(e => e) as AtlasError;
  assert.ok(fails('M365_UPSTREAM_TIMEOUT')(error)); assert.equal(error.kind, 'TRANSIENT'); assert.ok(!error.message.includes('SECRETLINK'));
});
