import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AtlasError } from '../../packages/core/contracts.ts';
import { m365TokenCache } from '../../connectors/microsoft365/auth.ts';
import type { GraphTransport } from '../../connectors/microsoft365/http.ts';
import { bindConnection, resolveConnection, resolveCredential } from '../../packages/connections/connections.ts';
import { disableM365Connection } from '../../packages/connections/m365-disable.ts';
import { activateConnection } from '../../packages/sync/activation.ts';
import { issueM365ActivationCapability, runM365Activation } from '../../packages/m365/activation.ts';
import { gasta, WS } from '../support/graph-fixtures.ts';
import { M365_CONNECTION, M365_FIXTURE_CONNECTION, m365Actors } from '../support/m365-fixtures.ts';
import { mockM365, page, syntheticSecrets, userRow } from '../support/m365-graph-mock.ts';
import { connectionRow, ioOf, setupM365Database } from '../support/m365-pg.ts';
import { guid } from '../m365-sql-invariants.ts';

// Stage 2 task 2.4, B1/B1a/B1b on PostgreSQL 17 with the confined runtime role and a captured mock Graph/authority:
// versioned one-use activation capability on a bound DISABLED connection, same-token tenant verification before any
// collection call, disable during the probe invalidating the capability and the cached token version, no generic bypass.
const { pgdb, db } = await setupM365Database();
after(async () => { await db.$disconnect(); await pgdb.drop(); });
beforeEach(() => m365TokenCache.clear());
const { admin } = m365Actors;
const TENANT_A = guid('1'); const TENANT_B = guid('2');
const fails = (code: string) => (e: unknown) => e instanceof AtlasError && e.code === code;
const audits = async (eventType: string, connectionId: string) => (await pgdb.owner.query(`SELECT "actorId", metadata FROM "AuditEvent"
  WHERE "eventType" = $1 AND metadata->>'connectionId' = $2 ORDER BY "recordedAt", id`, [eventType, connectionId])).rows;
const directoryRows = async (connectionId: string) => Number((await pgdb.owner.query(`SELECT (SELECT count(*) FROM "M365DirectoryGeneration" WHERE "connectionId" = $1)
  + (SELECT count(*) FROM "ExternalEntity" WHERE "connectionId" = $1) + (SELECT count(*) FROM "M365SignInEvidence" WHERE "connectionId" = $1) AS n`, [connectionId])).rows[0].n);
const fullDirectory = (url: URL) => url.pathname === '/v1.0/users' ? page([userRow(guid('a'))])
  : url.pathname === '/v1.0/devices' ? page([]) : url.pathname === '/v1.0/auditLogs/signIns' ? page([]) : undefined;
let n = 0;
const bindNew = async (tenant: string) => {
  const id = `m365-act-${++n}`;
  assert.deepEqual(await bindConnection(db, admin, gasta, { connectionId: id, system: 'microsoft365', externalTenantId: tenant, secretRef: 'env://M365_GASTA' }),
    { connectionId: id, status: 'DISABLED' });
  return id;
};

test('B1a: a newly bound DISABLED connection activates only through the capability; probes publish nothing; replay is refused', async () => {
  const id = await bindNew(TENANT_A);
  const mock = mockM365(TENANT_A, { route: fullDirectory });
  await assert.rejects(activateConnection(db, admin, gasta, id, { transport: async () => new Response(null), secrets: syntheticSecrets() }),
    fails('M365_ACTIVATION_CAPABILITY_REQUIRED'), 'the generic Stage 1 activation cannot reach an M365 connection');
  const capability = await issueM365ActivationCapability(db, admin, gasta, id);
  assert.equal(capability.lifecycleVersion, 1);
  const result = await runM365Activation(db, admin, capability, ioOf(mock));
  assert.deepEqual(result, { status: 'ACTIVE', connectionId: id, lifecycleVersion: 2, signIns: 'AVAILABLE', safeErrorCode: null });
  assert.deepEqual(await connectionRow(pgdb, id), { status: 'ACTIVE', v: 2 });
  assert.deepEqual(mock.requests.map(r => `${r.method} ${new URL(r.url).pathname} ${new URL(r.url).searchParams.get('$top') ?? ''}`.trim()), [
    `POST /${TENANT_A}/oauth2/v2.0/token`, 'GET /v1.0/organization', 'GET /v1.0/users 1', 'GET /v1.0/devices 1', 'GET /v1.0/auditLogs/signIns 1']);
  assert.equal(await directoryRows(id), 0, 'capability probes stage, mirror and publish nothing');
  const [audit] = await audits('connection.activated', id);
  assert.deepEqual(audit.metadata, { connectionId: id, system: 'microsoft365', connectionStatus: 'ACTIVE', lifecycleVersion: '2' });
  const signin = (await pgdb.owner.query(`SELECT status, "safeErrorCode" FROM "M365ResourceState" WHERE "connectionId" = $1 AND "resourceType" = 'm365_signin'`, [id])).rows;
  assert.deepEqual(signin, [{ status: 'OK', safeErrorCode: null }]);
  const sent = mock.requests.length;
  await assert.rejects(runM365Activation(db, admin, capability, ioOf(mock)), fails('ACTIVATION_CAPABILITY_USED'));
  await assert.rejects(issueM365ActivationCapability(db, admin, gasta, id), fails('CONNECTION_ALREADY_ACTIVE'));
  assert.equal(mock.requests.length, sent, 'replay: zero I/O');
  // The generic credential path refuses M365 even for an ACTIVE connection: the secret resolver is never asked
  const secrets = syntheticSecrets();
  const resolved = await resolveConnection(db, { ...m365Actors.syncer }, gasta, id, 'sync');
  await assert.rejects(resolveCredential(db, m365Actors.syncer, resolved, secrets), fails('M365_DEDICATED_AUTHORITY_REQUIRED'));
  assert.deepEqual(secrets.calls, []);
});

test('B1: credential of tenant B on a binding to tenant A never reaches users/devices/signIns and stays DISABLED', async () => {
  const id = await bindNew(guid('3'));
  const mock = mockM365(guid('3'), { route: fullDirectory, organization: () => ({ status: 200, body: { value: [{ id: TENANT_B }] } }) });
  const result = await runM365Activation(db, admin, await issueM365ActivationCapability(db, admin, gasta, id), ioOf(mock));
  assert.deepEqual(result, { status: 'DISABLED', connectionId: id, safeErrorCode: 'M365_TENANT_MISMATCH' });
  assert.deepEqual(mock.collectionGets(), []);
  assert.deepEqual(await connectionRow(pgdb, id), { status: 'DISABLED', v: 1 });
  assert.equal(m365TokenCache.size(), 0);
  assert.deepEqual((await audits('connection.activation_failed', id)).map(r => r.metadata),
    [{ connectionId: id, system: 'microsoft365', safeErrorCode: 'M365_TENANT_MISMATCH' }]);
});

test('B1a: FIXTURE, ACTIVE, non-M365, foreign client and a capability of another actor are refused before any I/O', async () => {
  await assert.rejects(issueM365ActivationCapability(db, admin, gasta, M365_FIXTURE_CONNECTION), fails('FIXTURE_CONNECTION_NOT_SUPPORTED'));
  await assert.rejects(issueM365ActivationCapability(db, admin, gasta, M365_CONNECTION), fails('CONNECTION_ALREADY_ACTIVE'));
  await assert.rejects(issueM365ActivationCapability(db, admin, gasta, 'demo-atera-connection'), fails('CONNECTION_NOT_M365'));
  await assert.rejects(issueM365ActivationCapability(db, admin, { workspaceId: WS, clientId: 'demo-other' }, M365_CONNECTION), fails('SCOPE_DENIED'));
  await assert.rejects(issueM365ActivationCapability(db, m365Actors.m365Reviewer, gasta, M365_CONNECTION), fails('PERMISSION_DENIED'));
  const id = await bindNew(guid('4'));
  const capability = await issueM365ActivationCapability(db, admin, gasta, id);
  const mock = mockM365(guid('4'), { route: fullDirectory });
  await assert.rejects(runM365Activation(db, m365Actors.syncer, capability, ioOf(mock)), fails('ACTIVATION_CAPABILITY_INVALID'));
  await assert.rejects(runM365Activation(db, admin, { ...capability }, ioOf(mock)), fails('ACTIVATION_CAPABILITY_INVALID'), 'a copy is not the issued capability');
  assert.deepEqual(mock.requests, []);
});

test('B1b: m365-disable during the probe invalidates the capability and the cached token version; reactivation needs a new capability', async () => {
  const id = await bindNew(guid('5'));
  const mock = mockM365(guid('5'), { route: fullDirectory });
  let disabled = false;
  const graph: GraphTransport = async (url, init) => {
    if (!disabled && url.includes('/v1.0/users')) { disabled = true; assert.equal((await disableM365Connection(db, admin, gasta, id)).lifecycleVersion, 2); }
    return mock.graph(url, init);
  };
  const result = await runM365Activation(db, admin, await issueM365ActivationCapability(db, admin, gasta, id), { ...ioOf(mock), graph });
  assert.deepEqual(result, { status: 'DISABLED', connectionId: id, safeErrorCode: 'M365_CONNECTION_CHANGED' });
  assert.deepEqual(mock.gets('/v1.0/devices'), [], 'the in-flight users probe finished; nothing after it was sent');
  assert.deepEqual(await connectionRow(pgdb, id), { status: 'DISABLED', v: 2 });
  assert.equal(m365TokenCache.size(), 0, 'm365-disable evicted the local entries of the old version');
  // A new capability pins version 2: the token of version 1 can never be reused (new POST + verification)
  const posts = mock.posts().length;
  const again = await runM365Activation(db, admin, await issueM365ActivationCapability(db, admin, gasta, id), ioOf(mock));
  assert.equal(again.status, 'ACTIVE');
  assert.equal(mock.posts().length, posts + 1);
  assert.deepEqual(await connectionRow(pgdb, id), { status: 'ACTIVE', v: 3 });
});

test('B1b: a disable committing between the probe and the activation transaction consumes nothing (conditional on the version)', async () => {
  const id = await bindNew(guid('6'));
  const mock = mockM365(guid('6'), { route: fullDirectory });
  let disabled = false;
  const graph: GraphTransport = async (url, init) => {
    const response = await mock.graph(url, init);
    if (!disabled && url.includes('/auditLogs/signIns')) { disabled = true; await disableM365Connection(db, admin, gasta, id); }
    return response; // the last probe answer arrives after the disable committed
  };
  const result = await runM365Activation(db, admin, await issueM365ActivationCapability(db, admin, gasta, id), { ...ioOf(mock), graph });
  assert.deepEqual(result, { status: 'DISABLED', connectionId: id, safeErrorCode: 'M365_CONNECTION_CHANGED' });
  assert.deepEqual(await connectionRow(pgdb, id), { status: 'DISABLED', v: 2 });
  assert.deepEqual(await audits('connection.activated', id), []);
});

test('capability expiry is server-held: mutating the returned Date cannot extend it, and an expired capability sends nothing', async () => {
  const id = await bindNew(guid('c'));
  const t0 = Date.now();
  let now = t0;
  const capability = await issueM365ActivationCapability(db, admin, gasta, id, () => new Date(now));
  assert.equal(capability.expiresAt.getTime(), t0 + 10 * 60_000);
  capability.expiresAt.setTime(t0 + 365 * 24 * 3600_000); // the caller tampers with its copy
  now = t0 + 10 * 60_000 + 1;
  const mock = mockM365(guid('c'), { route: fullDirectory });
  const result = await runM365Activation(db, admin, capability, ioOf(mock), () => new Date(now));
  assert.deepEqual(result, { status: 'DISABLED', connectionId: id, safeErrorCode: 'ACTIVATION_CAPABILITY_EXPIRED' });
  assert.deepEqual(mock.requests, [], 'zero I/O after the original expiry');
  // Expiry reached while probing: the next recheck stops further calls
  now = Date.now();
  const second = await issueM365ActivationCapability(db, admin, gasta, id, () => new Date(now));
  const mid = mockM365(guid('c'), { route: url => { if (url.pathname === '/v1.0/users') now += 11 * 60_000; return fullDirectory(url); } });
  assert.deepEqual(await runM365Activation(db, admin, second, ioOf(mid), () => new Date(now)),
    { status: 'DISABLED', connectionId: id, safeErrorCode: 'ACTIVATION_CAPABILITY_EXPIRED' });
  assert.deepEqual(mid.gets('/v1.0/devices'), []);
  assert.deepEqual(await connectionRow(pgdb, id), { status: 'DISABLED', v: 1 });
});

test('sign-ins 403 gives directory-only activation with a separately recorded capability; directory 403 fails activation', async () => {
  const id = await bindNew(guid('9'));
  const mock = mockM365(guid('9'), { route: url => url.pathname === '/v1.0/auditLogs/signIns' ? { status: 403 } : fullDirectory(url) });
  assert.deepEqual(await runM365Activation(db, admin, await issueM365ActivationCapability(db, admin, gasta, id), ioOf(mock)),
    { status: 'ACTIVE', connectionId: id, lifecycleVersion: 2, signIns: 'UNAVAILABLE', safeErrorCode: 'M365_SIGNINS_NOT_AVAILABLE' });
  const signin = (await pgdb.owner.query(`SELECT status, "safeErrorCode" FROM "M365ResourceState" WHERE "connectionId" = $1 AND "resourceType" = 'm365_signin'`, [id])).rows;
  assert.deepEqual(signin, [{ status: 'UNAVAILABLE', safeErrorCode: 'M365_SIGNINS_NOT_AVAILABLE' }]);
  const id2 = await bindNew(guid('a'));
  const denied = mockM365(guid('a'), { route: url => url.pathname === '/v1.0/devices' ? { status: 403 } : fullDirectory(url) });
  assert.deepEqual(await runM365Activation(db, admin, await issueM365ActivationCapability(db, admin, gasta, id2), ioOf(denied)),
    { status: 'DISABLED', connectionId: id2, safeErrorCode: 'M365_ACCESS_DENIED' });
  assert.deepEqual(denied.gets('/v1.0/auditLogs/signIns'), []);
});

test('authority withdrawn during the probe: no further I/O, still DISABLED, the denial goes to the workspace security audit', async () => {
  const id = await bindNew(guid('b'));
  const mock = mockM365(guid('b'), { route: fullDirectory });
  const graph: GraphTransport = async (url, init) => {
    if (url.includes('/v1.0/users')) await pgdb.owner.query(`UPDATE "ClientMembership" SET permissions = ARRAY['context:read'] WHERE "actorId" = 'demo-admin' AND "clientId" = 'demo-gasta'`);
    return mock.graph(url, init);
  };
  try {
    const result = await runM365Activation(db, admin, await issueM365ActivationCapability(db, admin, gasta, id), { ...ioOf(mock), graph });
    assert.deepEqual(result, { status: 'DISABLED', connectionId: id, safeErrorCode: 'PERMISSION_DENIED' });
    assert.deepEqual(mock.gets('/v1.0/devices'), []);
    const denial = (await pgdb.owner.query(`SELECT "eventType", "requestedClientId", "reasonCode" FROM "SecurityAuditEvent" WHERE "eventType" = 'connection.m365_denied'`)).rows;
    assert.deepEqual(denial, [{ eventType: 'connection.m365_denied', requestedClientId: 'demo-gasta', reasonCode: 'PERMISSION_DENIED' }]);
  } finally {
    await pgdb.owner.query(`UPDATE "ClientMembership" SET permissions = ARRAY['connections:manage'] WHERE "actorId" = 'demo-admin' AND "clientId" = 'demo-gasta'`);
  }
  assert.deepEqual(await connectionRow(pgdb, id), { status: 'DISABLED', v: 1 });
});
