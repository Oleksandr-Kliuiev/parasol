import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { disableM365Connection } from '../../packages/connections/m365-disable.ts';
import { guid } from '../m365-sql-invariants.ts';
import { setupM365Database } from '../support/m365-pg.ts';
import { WS, gasta } from '../support/graph-fixtures.ts';
import { M365_CONNECTION, M365_TENANT, m365Actors } from '../support/m365-fixtures.ts';
import { deviceRow, userRow } from '../support/m365-graph-mock.ts';
import { hourStart, iso } from '../support/m365-signin-mock.ts';
import { addOperator, cli, waitFor } from '../support/m365-cli.ts';

// Actual ops CLI processes (scripts/ops.ts) with the test-only fetch preload: probe/activation of a DISABLED connection,
// ACTIVE refusal without I/O, revoke (m365-disable) while a probe response is held, and the sign-in/directory recovery
// chain across processes — create, later resume, NOT_DUE without any upstream call, FAILED root requeue then resume,
// directory Retry-After / explicit audited reset. Request ID and charged counters persist across processes.
const { pgdb, db } = await setupM365Database();
const PROBE_TENANT = guid('6');
await pgdb.owner.query(`INSERT INTO "Connection" ("workspaceId","clientId","id","system","externalTenantId","secretRef","status","boundBy","boundAt","lifecycleVersion")
  VALUES ($1,'demo-gasta','probe-m365','microsoft365',$2,'env://M365_GASTA','DISABLED','demo-admin',now(),1)`, [WS, PROBE_TENANT]);
const token = await addOperator(pgdb.owner, 'demo-m365-operator', ['context:read', 'm365:read', 'events:ingest', 'connections:manage']);
const ops = cli(pgdb, token);
after(async () => { ops.close(); await db.$disconnect(); await pgdb.drop(); });
const q = async (sql: string, params: unknown[] = []) => (await pgdb.owner.query(sql, params)).rows;
const version = async (id: string) => (await q(`SELECT status, "lifecycleVersion" AS v FROM "Connection" WHERE id = $1`, [id]))[0];
const directory = { users: [userRow(guid('a'))], devices: [deviceRow(guid('b'), guid('c'))] };

test('m365-probe activates a bound DISABLED connection through the versioned capability; ACTIVE is refused without any I/O', async () => {
  ops.scenario({ tenant: PROBE_TENANT, ...directory, signIns: [] });
  const r = await ops.run(['m365-probe', '--client', 'demo-gasta', '--connection', 'probe-m365']);
  assert.deepEqual(r, { code: 0, output: { command: 'm365-probe', status: 'ACTIVE', connectionId: 'probe-m365', lifecycleVersion: 2, signIns: 'AVAILABLE', safeErrorCode: null } });
  assert.deepEqual(ops.calls().map(c => `${c.method} ${c.path}`), [`POST /${PROBE_TENANT}/oauth2/v2.0/token`, 'GET /v1.0/organization', 'GET /v1.0/users',
    'GET /v1.0/devices', 'GET /v1.0/auditLogs/signIns']);
  const calls = ops.calls().length;
  assert.deepEqual(await ops.run(['m365-probe', '--client', 'demo-gasta', '--connection', 'probe-m365']),
    { code: 2, output: { command: 'm365-probe', safeErrorCode: 'CONNECTION_ALREADY_ACTIVE' } });
  assert.equal(ops.calls().length, calls, 'no token request, no Graph call');
  assert.deepEqual(await version('probe-m365'), { status: 'ACTIVE', v: 2 });
});

test('m365-disable committed while a probe response is held: the probe cannot activate and the connection stays DISABLED', async () => {
  await disableM365Connection(db, m365Actors.admin, gasta, 'probe-m365');
  ops.scenario({ tenant: PROBE_TENANT, ...directory, signIns: [], hold: '/v1.0/users' });
  const running = ops.start(['m365-probe', '--client', 'demo-gasta', '--connection', 'probe-m365']);
  await waitFor(() => ops.held());
  const disabled = await disableM365Connection(db, m365Actors.admin, gasta, 'probe-m365');
  ops.release();
  const r = await running;
  assert.deepEqual(r, { code: 1, output: { command: 'm365-probe', status: 'DISABLED', connectionId: 'probe-m365', safeErrorCode: 'M365_CONNECTION_CHANGED' } });
  assert.deepEqual(await version('probe-m365'), { status: 'DISABLED', v: disabled.lifecycleVersion });
  assert.ok(!ops.calls().slice(-3).some(c => c.path === '/v1.0/auditLogs/signIns'), 'no further vendor call after the version changed');
  // Reactivation needs a new capability: a sign-in 403 gives directory-only degraded activation, never an empty success
  ops.scenario({ tenant: PROBE_TENANT, ...directory, replies: { '/v1.0/auditLogs/signIns': { status: 403 } } });
  const degraded = await ops.run(['m365-probe', '--client', 'demo-gasta', '--connection', 'probe-m365']);
  assert.deepEqual([degraded.code, degraded.output.status, degraded.output.signIns, degraded.output.safeErrorCode], [0, 'ACTIVE', 'UNAVAILABLE', 'M365_SIGNINS_NOT_AVAILABLE']);
  const status = await ops.run(['m365-status', '--client', 'demo-gasta', '--connection', 'probe-m365']);
  assert.deepEqual([status.output.connectionStatus, (status.output.signIns as Record<string, unknown>).capability, (status.output.signIns as Record<string, unknown>).safeErrorCode],
    ['ACTIVE', 'UNAVAILABLE', 'M365_SIGNINS_NOT_AVAILABLE']);
});

test('sign-ins: create → 429 RETRY; a later process resume is NOT_DUE with zero upstream calls; FAILED root requeue, then resume publishes', async () => {
  const R = hourStart(3);
  ops.scenario({ tenant: M365_TENANT, replies: { '/v1.0/auditLogs/signIns': { status: 429, headers: { 'retry-after': '120' } } } });
  const created = await ops.run(['m365-sync', '--client', 'demo-gasta', '--connection', M365_CONNECTION, '--resource', 'signins', '--from', R.toISOString(),
    '--to', new Date(R.getTime() + 3_600_000).toISOString()]);
  const requestId = created.output.requestId as string;
  const root = (created.output.roots as Record<string, unknown>[])[0]!;
  assert.deepEqual([created.code, created.output.mode, root.outcome, root.safeErrorCode, root.attemptsUsed, root.maxAttempts], [0, 'create', 'RETRY', 'M365_RATE_LIMITED', 1, 5]);
  assert.ok(Math.abs(Date.parse(root.retryAt as string) - Date.now() - 120_000) < 10_000, 'exactly the source delay, persisted');
  const before = ops.calls().length;
  const resumed = await ops.run(['m365-sync', '--client', 'demo-gasta', '--connection', M365_CONNECTION, '--resource', 'signins', '--request', requestId]);
  assert.deepEqual([resumed.code, resumed.output.mode, (resumed.output.roots as Record<string, unknown>[]).map(x => [x.outcome, x.attemptsUsed, x.retryAt])],
    [0, 'resume', [['NOT_DUE', 1, root.retryAt]]]);
  assert.equal(ops.calls().length, before, 'NOT_DUE performs no token request and no Graph call');
  assert.deepEqual((await q(`SELECT count(*)::int AS n FROM "M365SyncRequest"`))[0].n, 1, 'no new request');
  // Time passes beyond the persisted retryAt (owner shift of the due time only); a permanent 403 then FAILS the root job,
  // and an explicit audited requeue resets only its budget.
  await q(`UPDATE "M365SyncRootJob" SET "retryAt" = now() - interval '1 second' WHERE "requestId" = $1`, [requestId]);
  ops.scenario({ tenant: M365_TENANT, replies: { '/v1.0/auditLogs/signIns': { status: 403 } } });
  const failed = await ops.run(['m365-sync', '--client', 'demo-gasta', '--connection', M365_CONNECTION, '--resource', 'signins', '--request', requestId]);
  const failedRoot = (failed.output.roots as Record<string, unknown>[])[0]!;
  assert.deepEqual([failed.code, failedRoot.outcome, failedRoot.safeErrorCode, failedRoot.attemptsUsed], [1, 'FAILED', 'M365_ACCESS_DENIED', 2]);
  const windowId = failedRoot.windowId as string;
  const status = await ops.run(['m365-status', '--client', 'demo-gasta', '--connection', M365_CONNECTION, '--request', requestId]);
  assert.deepEqual([(status.output.request as Record<string, unknown>).outcome, ((status.output.request as Record<string, unknown>).roots as Record<string, unknown>[])[0]!.state],
    ['FAILED', 'FAILED'], 'derived from the current root jobs, not the immutable OPEN request');
  const calls = ops.calls().length;
  assert.deepEqual(await ops.run(['m365-requeue', '--client', 'demo-gasta', '--connection', M365_CONNECTION, '--request', requestId, '--window', windowId]),
    { code: 0, output: { command: 'm365-requeue', requestId, windowId, state: 'PENDING', attemptsUsed: 0 } });
  assert.equal(ops.calls().length, calls, 'requeue performs no Graph I/O');
  ops.scenario({ tenant: M365_TENANT, signIns: [{ id: 'cli-s1', createdDateTime: iso(R, 60_000), userId: guid('d'), deviceDetail: { deviceId: guid('e') },
    appId: guid('f'), status: { errorCode: 0 }, isInteractive: true }] });
  const done = await ops.run(['m365-sync', '--client', 'demo-gasta', '--connection', M365_CONNECTION, '--resource', 'signins', '--request', requestId]);
  assert.deepEqual([done.code, (done.output.roots as Record<string, unknown>[]).map(x => [x.outcome, x.evidenceCount, x.attemptsUsed])], [0, [['PUBLISHED', 1, 1]]]);
  const final = await ops.run(['m365-status', '--client', 'demo-gasta', '--connection', M365_CONNECTION, '--request', requestId]);
  assert.equal((final.output.request as Record<string, unknown>).outcome, 'COMPLETE');
  assert.ok(!JSON.stringify(final.output).includes(M365_TENANT) && !JSON.stringify(final.output).includes('cli-s1'), 'status: no tenant, vendor ID or DTO');
  assert.deepEqual((await q(`SELECT "eventType" FROM "AuditEvent" WHERE "eventType" = 'm365.signin_requeued'`)).length, 1);
});

test('directory: 429 persists Retry-After; a reset before it is due is refused; after it, the explicit audited reset and a new sync publish', async () => {
  ops.scenario({ tenant: M365_TENANT, replies: { '/v1.0/users': { status: 429, headers: { 'retry-after': '2' } } } });
  const failed = await ops.run(['m365-sync', '--client', 'demo-gasta', '--connection', M365_CONNECTION, '--resource', 'users']);
  assert.deepEqual([failed.code, failed.output.status, failed.output.safeErrorCode, failed.output.recorded, failed.output.attemptsUsed], [1, 'FAILED', 'M365_RATE_LIMITED', true, 1]);
  assert.deepEqual(await ops.run(['m365-directory-reset', '--client', 'demo-gasta', '--connection', M365_CONNECTION, '--resource', 'users']),
    { code: 2, output: { command: 'm365-directory-reset', safeErrorCode: 'M365_RETRY_NOT_DUE' } });
  const notDue = await ops.run(['m365-sync', '--client', 'demo-gasta', '--connection', M365_CONNECTION, '--resource', 'users']);
  assert.deepEqual([notDue.code, notDue.output.safeErrorCode], [2, 'M365_RETRY_NOT_DUE'], 'no claim before the persisted retryAt');
  await sleep(2_500);
  const reset = await ops.run(['m365-directory-reset', '--client', 'demo-gasta', '--connection', M365_CONNECTION, '--resource', 'users']);
  assert.deepEqual([reset.code, reset.output.previousAttemptsUsed, reset.output.attemptsUsed], [0, 1, 0]);
  assert.equal((await q(`SELECT count(*)::int AS n FROM "AuditEvent" WHERE "eventType" = 'm365.directory_retry_reset'`))[0].n, 1, 'visible and audited');
  ops.scenario({ tenant: M365_TENANT, users: [userRow(guid('a')), userRow(guid('5'))] });
  const published = await ops.run(['m365-sync', '--client', 'demo-gasta', '--connection', M365_CONNECTION, '--resource', 'users']);
  assert.deepEqual([published.code, published.output.status, published.output.rowCount], [0, 'PUBLISHED', 2]);
});
