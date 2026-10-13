import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { authenticateToken } from '../../packages/auth/prisma-auth.ts';
import { generateToken, hashToken } from '../../packages/auth/token.ts';
import { bindConnection } from '../../packages/connections/connections.ts';
import { directoryUrl } from '../../connectors/microsoft365/contract.ts';
import { runPilot } from '../../packages/ops/pilot/driver.ts';
import type { PilotSeams } from '../../packages/ops/pilot/driver.ts';
import type { Receipt } from '../../packages/ops/pilot/receipts.ts';
import { guid } from '../m365-sql-invariants.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { hourStart } from '../support/m365-signin-mock.ts';
import { vendorFixture } from '../support/mock-http.ts';
import { gastaVendor } from '../support/vendor-routes.ts';
import { CANARY, failingSink, jsonResponse, pilotConfig, scriptedDispatch, tempDir } from '../support/pilot-support.ts';

// The S2-LIVE pilot driver in-process against a DISPOSABLE PostgreSQL database (migrate + roles.sql, no seed) with a
// synthetic pilot namespace bound through the accepted bind service. The ONLY test seam is the injected in-memory dispatch
// that answers the production token/Graph/Huntress URLs (synthetic; no network); everything else is the production path:
// confinement, token authentication, accepted command boundary and services, recorded transports, file receipts.
// The pilot env is an explicit synthetic object — never this process's environment.
const pgdb = await createTestDatabase();
const db = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
const tmp = tempDir();
after(async () => { tmp.close(); await db.$disconnect(); await pgdb.drop(); });
const q = async (sql: string, params: unknown[] = []) => (await pgdb.owner.query(sql, params)).rows;
const GRANTS = ['connections:manage', 'events:ingest', 'context:read', 'm365:read', 'mapping:review'];
async function actor(workspace: string, client: string, id: string, permissions: string[]): Promise<string> {
  const token = generateToken();
  await q(`INSERT INTO "Actor" ("workspaceId","id","displayName") VALUES ($1,$2,'Synthetic pilot actor')`, [workspace, id]);
  await q(`INSERT INTO "ClientMembership" ("workspaceId","clientId","actorId","permissions") VALUES ($1,$2,$3,$4)`, [workspace, client, id, permissions]);
  await q(`INSERT INTO "ApiToken" ("workspaceId","id","actorId","tokenHash","label") VALUES ($1,$2,$3,$4,'synthetic')`, [workspace, `token-${id}`, id, hashToken(token)]);
  return token;
}
await q(`INSERT INTO "Workspace" VALUES ('pilot-ws','Synthetic pilot workspace'),('demo-vardahei','Stock demo namespace')`);
await q(`INSERT INTO "Client" VALUES ('pilot-ws','pilot-client','Synthetic pilot client'),('pilot-ws','pilot-other','Other'),('demo-vardahei','pilot-demo-client','Demo')`);
const operator = await actor('pilot-ws', 'pilot-client', 'pilot-operator', GRANTS);
const mapper = await actor('pilot-ws', 'pilot-client', 'pilot-mapper', ['mapping:review', 'context:read']);
const outsider = await actor('pilot-ws', 'pilot-other', 'pilot-outsider', GRANTS);
const reader = await actor('pilot-ws', 'pilot-client', 'pilot-reader', ['context:read']);
const demo = await actor('demo-vardahei', 'pilot-demo-client', 'pilot-demo-operator', GRANTS);
const scope = { workspaceId: 'pilot-ws', clientId: 'pilot-client' };
const binder = (await authenticateToken(db, operator))!;
await bindConnection(db, binder, scope, { connectionId: 'pilot-m365', system: 'microsoft365', externalTenantId: CANARY.tenant, secretRef: 'env://PILOT_M365_CREDENTIAL' });
await bindConnection(db, binder, scope, { connectionId: 'pilot-huntress', system: 'huntress', externalTenantId: '7001', secretRef: 'env://PILOT_HUNTRESS_CREDENTIAL' });

const ENV = { ATLAS_RUNTIME_DATABASE_URL: pgdb.runtimeUrl, ATLAS_OPERATOR_TOKEN: operator, PILOT_M365_CREDENTIAL: `${CANARY.app}:${CANARY.secret}`,
  PILOT_HUNTRESS_CREDENTIAL: `pilotkey:${CANARY.secret}`, ATLAS_CORRELATION_CURSOR_SECRET_REF: 'env://PILOT_CURSOR_SECRET', PILOT_CURSOR_SECRET: 'p'.repeat(40) };
const users = [guid('a'), guid('b'), guid('c')].map(id => ({ id, displayName: CANARY.name, userPrincipalName: CANARY.upn, userType: 'Member', accountEnabled: true }));
const devices = [{ id: guid('d'), deviceId: guid('e'), displayName: `${CANARY.name}-LAPTOP`, accountEnabled: true, operatingSystem: 'Windows' }];
const upstream = { signIns: () => jsonResponse(200, { value: [] }) };
const huntress = gastaVendor();
const emulator = scriptedDispatch((url, init) => {
  if (url.origin === 'https://login.microsoftonline.com') return jsonResponse(200, { token_type: 'Bearer', access_token: CANARY.token, expires_in: 3600 });
  if (url.origin === 'https://api.huntress.io') return huntress.transport(url.toString(), init as never);
  const top = url.searchParams.get('$top');
  if (url.pathname === '/v1.0/organization') return jsonResponse(200, { value: [{ id: CANARY.tenant }] });
  if (url.pathname === '/v1.0/users') {
    if (top === '1') return jsonResponse(200, { value: users.slice(0, 1) });
    return url.searchParams.has('$skiptoken') ? jsonResponse(200, { value: users.slice(2) })
      : jsonResponse(200, { value: users.slice(0, 2), '@odata.nextLink': `${directoryUrl('users')}&$skiptoken=${CANARY.nextLinkMarker}` });
  }
  if (url.pathname === '/v1.0/devices') return jsonResponse(200, { value: devices });
  if (url.pathname === '/v1.0/auditLogs/signIns') return upstream.signIns();
  return jsonResponse(404, { error: CANARY.errorBody });
});
const CANARIES = [...Object.values(CANARY), operator, 'pilot-client', 'pilot-m365', 'pilot-huntress', pgdb.runtimeRole, tmp.dir, 'GASTA-LT-07', 'credential theft', 'pilotkey'];

async function run(command: string, flags: Record<string, string>, options: { token?: string; url?: string; seams?: PilotSeams; private?: boolean } = {}) {
  const receipts = tmp.path(`r-${Math.random()}.jsonl`); const priv = tmp.path(`p-${Math.random()}.json`);
  const config = pilotConfig(command, { client: 'pilot-client', ...flags }, ['pilot-m365', 'pilot-huntress'], receipts, options.private ? { private: priv } : {});
  const before = emulator.calls.length;
  const outcome = await runPilot({ argv: ['--config', tmp.write(`c-${Math.random()}.json`, config)], execArgv: [],
    env: { ...ENV, ATLAS_OPERATOR_TOKEN: options.token ?? operator, ...(options.url ? { ATLAS_RUNTIME_DATABASE_URL: options.url } : {}) } },
  { dispatch: emulator.dispatch, ...options.seams });
  const text = existsSync(receipts) ? readFileSync(receipts, 'utf8') : '';
  for (const canary of CANARIES) assert.ok(!JSON.stringify(outcome.summary).includes(canary) && !text.includes(canary), `${command}: ${canary}`);
  assert.doesNotMatch(JSON.stringify(outcome.summary) + text, /(^|[^A-Z])(PASS|PASSED|ACCEPTED|LIVE)([^A-Z]|$)/, 'factual outcomes only, never a gate verdict');
  const lines = text.trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as Receipt);
  return { ...outcome, receipts: lines, calls: emulator.calls.slice(before), private: options.private ? JSON.parse(readFileSync(priv, 'utf8')) : null,
    result: outcome.summary.result as Record<string, any> };
}
const classes = (r: { summary: { recording: { perClass: Record<string, { dispatches: number; httpStatuses: Record<string, number> }> } | null } }) =>
  Object.fromEntries(Object.entries(r.summary.recording!.perClass).map(([c, x]) => [c, [x.dispatches, x.httpStatuses]]));

const securityRows = async (actorId: string) => q(`SELECT "eventType", "requestedClientId", "reasonCode", metadata FROM "SecurityAuditEvent"
  WHERE "actorId" = $1 ORDER BY "recordedAt", id`, [actorId]);
const effects = async () => (await q(`SELECT (SELECT count(*)::int FROM "SecurityAuditEvent") AS security, (SELECT count(*)::int FROM "AuditEvent") AS audit,
  (SELECT count(*)::int FROM "EntityLink") AS links, (SELECT count(*)::int FROM "ExternalEntity") AS external, (SELECT count(*)::int FROM "RawEvent") AS raw,
  (SELECT count(*)::int FROM "M365ResourceState") AS m365, (SELECT string_agg(id || ':' || status || ':' || "lifecycleVersion", ',' ORDER BY id) FROM "Connection") AS connections`))[0];
const denial = (command: string, reasonCode: string, requestedClientId = 'pilot-client') => ({ eventType: 'ops.scope_denied', requestedClientId, reasonCode, metadata: { command } });

test('confinement, authentication and fixture refusals come before any application read or dispatch and append no audit', async () => {
  const initial = await effects();
  const owner = await run('m365-status', { connection: 'pilot-m365' }, { url: pgdb.ownerUrl });
  assert.deepEqual([owner.exitCode, owner.summary.status, owner.summary.safeErrorCode], [2, 'REFUSED', 'RUNTIME_ROLE_BYPASSES_RLS']);
  assert.deepEqual([owner.summary.recording!.complete, owner.summary.recording!.dispatches, owner.receipts.map(r => r.kind)], [true, 0, ['run-start', 'run-end']]);
  assert.equal((await run('m365-status', { connection: 'pilot-m365' }, { token: generateToken() })).summary.safeErrorCode, 'OPERATOR_TOKEN_INVALID');
  const fixture = await run('m365-status', { connection: 'pilot-m365', client: 'pilot-demo-client' }, { token: demo });
  assert.deepEqual([fixture.exitCode, fixture.summary.safeErrorCode], [2, 'PILOT_FIXTURE_SCOPE_REFUSED'], 'the stock demo workspace is never a live source');
  assert.deepEqual(await effects(), initial, 'no audit row (workspace or client) and no other write before authentication/fixture admission');
  const denied = await run('m365-status', { connection: 'pilot-m365' }, { token: outsider });
  assert.deepEqual([denied.exitCode, denied.summary.status, denied.summary.safeErrorCode], [2, 'COMMAND_ERROR', 'SCOPE_DENIED']);
  assert.deepEqual(await securityRows('pilot-outsider'), [denial('m365-status', 'SCOPE_DENIED')], 'the accepted boundary audit, exactly once');
  assert.equal(emulator.calls.length, 0, 'zero dispatches');
});

test('mapping/confirm-link without m365:read: one safe workspace security audit per invocation, zero dispatches, no client audit or other effect', async () => {
  const initial = await effects();
  for (const [i, [command, flags]] of ([['mapping', {}], ['confirm-link', { link: 'pilot-link-unknown' }], ['mapping', {}]] as const).entries()) {
    const r = await run(command, flags, { token: mapper });
    assert.deepEqual([r.exitCode, r.summary.status, r.summary.safeErrorCode, r.summary.recording!.dispatches, r.summary.recording!.complete, r.calls.length],
      [2, 'REFUSED', 'PILOT_AUTHORITY_REFUSED', 0, true, 0], command);
    const rows = await securityRows('pilot-mapper');
    assert.equal(rows.length, i + 1, 'exactly one audit row per refused invocation');
    assert.deepEqual(rows[i], denial(command, 'PERMISSION_DENIED'));
  }
  const text = JSON.stringify(await securityRows('pilot-mapper'));
  for (const id of ['pilot-m365', 'pilot-huntress', 'pilot-link-unknown', CANARY.tenant, mapper]) assert.ok(!text.includes(id), `no ${id} in denial metadata`);
  assert.deepEqual(await effects(), { ...initial, security: initial.security + 3 }, 'nothing else written: no client audit, link, mirror, event, M365 state or connection change');
  assert.deepEqual(await q(`SELECT count(*)::int AS n FROM "AuditEvent" WHERE "clientId" = 'pilot-other'`), [{ n: 0 }]);
});

test('accepted command-boundary permission refusals are still audited exactly once (no second pilot audit)', async () => {
  const initial = await effects();
  const r1 = await run('mapping', {}, { token: reader });
  assert.deepEqual([r1.exitCode, r1.summary.status, r1.summary.safeErrorCode, r1.calls.length], [2, 'COMMAND_ERROR', 'PERMISSION_DENIED', 0], 'no mapping:review: the accepted boundary decides');
  assert.deepEqual(await securityRows('pilot-reader'), [denial('mapping', 'PERMISSION_DENIED')]);
  const r2 = await run('m365-status', { connection: 'pilot-m365' }, { token: mapper });
  assert.deepEqual([r2.summary.status, r2.summary.safeErrorCode], ['COMMAND_ERROR', 'PERMISSION_DENIED']);
  assert.deepEqual((await securityRows('pilot-mapper')).slice(3), [denial('m365-status', 'PERMISSION_DENIED')]);
  assert.deepEqual(await effects(), { ...initial, security: initial.security + 2 });
});

test('a failing security audit keeps the pilot denial fail closed: SECURITY_AUDIT_FAILED, no row, zero dispatches', async () => {
  await q(`CREATE FUNCTION pilot_test_audit_down() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit outage'; END $$`);
  // Stage 3 readiness: a new PUBLIC routine is drift for the fence definer; a trigger fires without EXECUTE
  await q(`REVOKE ALL ON FUNCTION pilot_test_audit_down() FROM PUBLIC`);
  await q(`CREATE TRIGGER pilot_test_audit_down BEFORE INSERT ON "SecurityAuditEvent" FOR EACH ROW EXECUTE FUNCTION pilot_test_audit_down()`);
  try {
    const initial = await effects();
    const r = await run('confirm-link', { link: 'pilot-link-unknown' }, { token: mapper });
    assert.deepEqual([r.exitCode, r.summary.status, r.summary.safeErrorCode, r.summary.result, r.calls.length], [2, 'REFUSED', 'SECURITY_AUDIT_FAILED', null, 0]);
    assert.deepEqual(await effects(), initial);
  } finally {
    await q(`DROP TRIGGER pilot_test_audit_down ON "SecurityAuditEvent"`); await q(`DROP FUNCTION pilot_test_audit_down()`);
  }
});

test('m365-probe: token POST and Graph GETs recorded through the accepted activation; ACTIVE is refused with zero dispatches', async () => {
  const r = await run('m365-probe', { connection: 'pilot-m365' });
  assert.deepEqual([r.exitCode, r.summary.status, r.result], [0, 'COMMAND_OK', { status: 'ACTIVE', connection: 'connection-1', lifecycleVersion: 2, signIns: 'AVAILABLE', safeErrorCode: null }]);
  assert.deepEqual(classes(r), { 'm365.token': [1, { 200: 1 }], 'graph.organization': [1, { 200: 1 }], 'graph.users': [1, { 200: 1 }],
    'graph.devices': [1, { 200: 1 }], 'graph.signIns': [1, { 200: 1 }] });
  assert.deepEqual(r.receipts.map(x => x.kind === 'dispatch' || x.kind === 'completion' ? `${x.kind}:${x.seq}:${x.endpointClass}` : x.kind), ['run-start',
    'dispatch:1:m365.token', 'completion:1:m365.token', 'dispatch:2:graph.organization', 'completion:2:graph.organization', 'dispatch:3:graph.users',
    'completion:3:graph.users', 'dispatch:4:graph.devices', 'completion:4:graph.devices', 'dispatch:5:graph.signIns', 'completion:5:graph.signIns', 'run-end']);
  assert.ok(r.calls.every(c => c.init.redirect === 'error'), 'every dispatch refuses redirects');
  assert.ok(r.calls.slice(1).every(c => (c.init.headers as Record<string, string>).Authorization === `Bearer ${CANARY.token}`), 'same-token tenant check composition');
  assert.deepEqual(await q(`SELECT status, "lifecycleVersion" AS v FROM "Connection" WHERE id = 'pilot-m365'`), [{ status: 'ACTIVE', v: 2 }]);
  const again = await run('m365-probe', { connection: 'pilot-m365' });
  assert.deepEqual([again.exitCode, again.summary.status, again.summary.safeErrorCode, again.summary.recording!.dispatches], [2, 'COMMAND_ERROR', 'CONNECTION_ALREADY_ACTIVE', 0]);
});

test('directory: a two-page traversal is one dispatch per page; row/item counts come from the service; the read projects counts only', async () => {
  const sync = await run('m365-sync', { connection: 'pilot-m365', resource: 'users' });
  assert.deepEqual([sync.exitCode, sync.result.status, sync.result.rowCount, sync.result.generation], [0, 'PUBLISHED', 3, 'generation-1']);
  assert.deepEqual(classes(sync), { 'm365.token': [1, { 200: 1 }], 'graph.organization': [1, { 200: 1 }], 'graph.users': [2, { 200: 2 }] },
    'the accepted same-token tenant check precedes the collection pages');
  const read = await run('m365-directory', { connection: 'pilot-m365', resource: 'users', limit: '2' }, { private: true });
  assert.deepEqual([read.exitCode, read.result.itemCount, read.result.total, read.result.truncated, read.result.nextCursorPresent, read.summary.recording!.dispatches],
    [0, 2, 3, true, true, 0]);
  assert.equal(read.private.aliases['connection-1'], 'pilot-m365');
  assert.ok(typeof read.private.nextCursor === 'string' && !JSON.stringify(read.summary).includes(read.private.nextCursor), 'the cursor stays private');
});

test('sign-ins: create → 429 RETRY with requested and effective bounds; a resume before retryAt is NOT_DUE with zero dispatches', async () => {
  upstream.signIns = () => jsonResponse(429, { error: CANARY.errorBody }, { 'retry-after': '120' });
  const from = hourStart(3).toISOString(); const to = new Date(hourStart(3).getTime() + 1_800_000).toISOString();
  const created = await run('m365-sync', { connection: 'pilot-m365', resource: 'signins', from, to }, { private: true });
  assert.deepEqual([created.exitCode, created.result.mode, created.result.request, created.result.requestedFrom, created.result.requestedTo],
    [0, 'create', 'request-1', from, to]);
  assert.deepEqual([created.result.retrievalFrom, created.result.roots.map((x: any) => [x.outcome, x.safeErrorCode, x.attemptsUsed])],
    [from, [['RETRY', 'M365_RATE_LIMITED', 1]]], 'the narrow request widens to its canonical hour root');
  assert.deepEqual(classes(created)['graph.signIns'], [1, { 429: 1 }]);
  const requestId = created.private.aliases['request-1'] as string;
  const resumed = await run('m365-sync', { connection: 'pilot-m365', resource: 'signins', request: requestId });
  assert.deepEqual([resumed.result.roots.map((x: any) => x.outcome), resumed.summary.recording!.dispatches], [['NOT_DUE'], 0]);
  const status = await run('m365-status', { connection: 'pilot-m365', request: requestId });
  assert.deepEqual([status.result.request.request, status.result.request.outcome, status.result.request.roots[0].safeErrorCode], ['request-1', 'IN_PROGRESS', 'M365_RATE_LIMITED']);
});

test('completion receipt failure after an actual call: the command result looks successful, the run is incomplete (exit 1) and halted', async () => {
  const r = await run('m365-sync', { connection: 'pilot-m365', resource: 'devices' },
    { seams: { wrapSink: failingSink(x => x.kind === 'completion' && x.endpointClass === 'graph.devices') } });
  assert.deepEqual([r.summary.status, r.result.status, r.result.rowCount], ['COMMAND_OK', 'PUBLISHED', 1], 'the accepted service received the untouched Response');
  assert.deepEqual([r.exitCode, r.summary.recording!.complete, r.summary.recording!.incompleteReasons, r.summary.recording!.pending], [1, false, ['COMPLETION_RECORD_FAILED'], 1]);
  const pre = await run('m365-sync', { connection: 'pilot-m365', resource: 'users' }, { seams: { wrapSink: failingSink(x => x.kind === 'dispatch') } });
  assert.deepEqual([pre.exitCode, pre.calls.length, pre.result.status, pre.summary.recording!.incompleteReasons], [1, 0, 'FAILED', ['PRE_DISPATCH_RECORD_FAILED']],
    'no receipt, no dispatch: a visible failed attempt');
});

test('live-read (Stage 1 Huntress): GET with redirect:error only, classified per resource; summary and receipts carry no vendor content', async () => {
  const r = await run('live-read', { connection: 'pilot-huntress' });
  assert.deepEqual([r.exitCode, r.result.activation.status, r.result.health.status, r.result.identities.registered], [0, 'ACTIVE', 'OK', 2]);
  assert.deepEqual(r.result.resources.map((x: any) => [x.resourceType, x.status, x.itemCount]),
    [['incident', 'OK', (vendorFixture('huntress/incident-reports-sent.json') as { incident_reports: unknown[] }).incident_reports.length]]);
  assert.deepEqual(classes(r), { 'huntress.organization': [2, { 200: 2 }], 'huntress.incidents': [1, { 200: 1 }], 'huntress.agents': [2, { 200: 2 }] });
  assert.ok(r.calls.every(c => c.init.method === 'GET' && c.init.redirect === 'error' && Object.keys(c.init).sort().join() === 'headers,method,redirect,signal'));
  const mapping = await run('mapping', {});
  assert.deepEqual([mapping.exitCode, mapping.result, mapping.summary.recording!.dispatches], [0, { itemCount: 0, items: [] }, 0], 'no seed rows, no candidates manufactured');
  const confirm = await run('confirm-link', { link: 'pilot-link-unknown' });
  assert.deepEqual([confirm.summary.status, confirm.summary.recording!.dispatches], ['COMMAND_ERROR', 0]);
  const correlation = await run('correlation', { connection: 'pilot-m365', observation: 'pilot-observation-unknown', from: hourStart(3).toISOString(), to: hourStart(2).toISOString() });
  assert.deepEqual([correlation.summary.status, correlation.summary.recording!.dispatches], ['COMMAND_ERROR', 0], 'reads never dispatch');
});
