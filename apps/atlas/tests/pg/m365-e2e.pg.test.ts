import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { authenticateToken } from '../../packages/auth/prisma-auth.ts';
import { proposeLink } from '../../packages/graph/mapping.ts';
import { guid } from '../m365-sql-invariants.ts';
import { setupM365Database } from '../support/m365-pg.ts';
import { startApi } from '../support/api-process.ts';
import { WS, gasta } from '../support/graph-fixtures.ts';
import { deviceRow, userRow } from '../support/m365-graph-mock.ts';
import { hourStart, iso } from '../support/m365-signin-mock.ts';
import { addOperator, cli } from '../support/m365-cli.ts';
import { CURSOR_SECRET, addHuntressObservation } from '../support/correlation-fixtures.ts';

// C6 (tests/pg/m365-e2e.pg.test.ts): the synthetic Gasta journey through the ACTUAL ops CLI (test-only fetch preload for the
// fixed token/Graph routes), the compiled DB-mode API and the tool gateway, all as the confined runtime role: probe-activate a
// bound DISABLED connection, sync users/devices, review and confirm the M365 mappings, sync a sign-in window, read the
// correlation via API, tool and CLI, revoke the device mapping and reread, status and a maintenance pass. No vendor write
// (only the token POST and Graph GETs exist), tool ledger and allowlisted audit persisted, no M365 data in RawEvent or
// Decisions. With ATLAS_S2C_EVIDENCE_DIR set, a synthetic receipt (codes, counts, local IDs) is written there.
const { pgdb, db } = await setupM365Database();
const TENANT = guid('6'); const USER = guid('a'); const DEVICE = guid('b'); const REG = guid('c');
await pgdb.owner.query(`INSERT INTO "Connection" ("workspaceId","clientId","id","system","externalTenantId","secretRef","status","boundBy","boundAt","lifecycleVersion")
  VALUES ($1,'demo-gasta','journey-m365','microsoft365',$2,'env://M365_GASTA','DISABLED','demo-admin',now(),1)`, [WS, TENANT]);
const token = await addOperator(pgdb.owner, 'demo-journey-operator', ['context:read', 'm365:read', 'events:ingest', 'connections:manage', 'mapping:review']);
const operator = (await authenticateToken(db, token))!;
const runner = { ATLAS_M365_CLEANUP_RUNNER_SECRET_REF: 'env://ATLAS_TEST_RUNNER_URL', ATLAS_TEST_RUNNER_URL: pgdb.runnerUrl };
const ops = cli(pgdb, token, runner);
const api = await startApi({ ATLAS_MODE: 'db', ATLAS_RUNTIME_DATABASE_URL: pgdb.runtimeUrl, ATLAS_CORRELATION_CURSOR_SECRET_REF: 'env://ATLAS_TEST_CURSOR_SECRET',
  ATLAS_TEST_CURSOR_SECRET: CURSOR_SECRET });
after(async () => { await api.stop(); ops.close(); await db.$disconnect(); await pgdb.drop(); });
const q = async (sql: string, params: unknown[] = []) => (await pgdb.owner.query(sql, params)).rows;
const count = async (table: string) => (await q(`SELECT count(*)::int AS n FROM "${table}"`))[0].n as number;
const R = hourStart(2); const end = new Date(R.getTime() + 3_600_000);
const signInRows = [{ id: 'j-device', createdDateTime: iso(R, 60_000), userId: guid('d'), deviceDetail: { deviceId: REG, displayName: 'DROP-ME' }, appId: guid('f'),
  status: { errorCode: 0 }, isInteractive: true, ipAddress: '192.0.2.44' },
{ id: 'j-person', createdDateTime: iso(R, 120_000), userId: USER, deviceDetail: { deviceId: guid('e') }, appId: guid('f'), status: { errorCode: 0 }, isInteractive: false },
{ id: 'j-other', createdDateTime: iso(R, 180_000), userId: guid('d'), deviceDetail: { deviceId: guid('e') }, appId: guid('f'), status: { errorCode: 0 }, isInteractive: true }];
const http = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${api.base}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};
const correlationPath = `/clients/demo-gasta/observations/obs-journey/correlation?connectionId=journey-m365&from=${encodeURIComponent(R.toISOString())}&to=${encodeURIComponent(end.toISOString())}`;
const sources = (body: Record<string, unknown>) => (body.items as { evidenceRef: { sourceId: string }; relationCodes: string[] }[]).map(i => `${i.evidenceRef.sourceId}:${i.relationCodes.join('+')}`);

test('C6: synthetic Gasta journey — activate, sync, review, correlate via API/tool/CLI, revoke mapping and reread, status, maintenance', async () => {
  const receipt: Record<string, unknown> = { date: new Date().toISOString().slice(0, 10), synthetic: true, steps: [] as unknown[] };
  const step = (name: string, outcome: unknown) => (receipt.steps as unknown[]).push({ name, outcome });
  const rawEvents = await count('RawEvent'); const decisions = await count('DecisionRun');
  ops.scenario({ tenant: TENANT, users: [userRow(USER)], devices: [deviceRow(DEVICE, REG)], signIns: signInRows });
  const probe = await ops.run(['m365-probe', '--client', 'demo-gasta', '--connection', 'journey-m365']);
  assert.deepEqual([probe.code, probe.output.status, probe.output.signIns], [0, 'ACTIVE', 'AVAILABLE']); step('m365-probe', probe.output.status);
  for (const resource of ['users', 'devices']) {
    const sync = await ops.run(['m365-sync', '--client', 'demo-gasta', '--connection', 'journey-m365', '--resource', resource]);
    assert.deepEqual([sync.code, sync.output.status, sync.output.rowCount], [0, 'PUBLISHED', 1]); step(`m365-sync ${resource}`, sync.output.status);
  }
  const mirrors = Object.fromEntries((await q(`SELECT "resourceType", id FROM "ExternalEntity" WHERE "connectionId" = 'journey-m365'`)).map(r => [r.resourceType, r.id]));
  const userLink = await proposeLink(db, operator, gasta, { externalEntityId: mirrors.m365_user, entityId: 'demo-kari' });
  const deviceLink = await proposeLink(db, operator, gasta, { externalEntityId: mirrors.m365_device, entityId: 'demo-device-07' });
  for (const link of [userLink.linkId, deviceLink.linkId]) {
    const confirm = await ops.run(['confirm-link', '--client', 'demo-gasta', '--link', link]);
    assert.deepEqual([confirm.code, confirm.output.status], [0, 'CONFIRMED']); step('confirm-link', confirm.output.status);
  }
  const signIns = await ops.run(['m365-sync', '--client', 'demo-gasta', '--connection', 'journey-m365', '--resource', 'signins', '--from', R.toISOString(),
    '--to', end.toISOString()]);
  assert.deepEqual([signIns.code, (signIns.output.roots as { outcome: string; evidenceCount: number }[]).map(r => [r.outcome, r.evidenceCount])], [0, [['PUBLISHED', 3]]]);
  step('m365-sync signins', 'PUBLISHED');
  await addHuntressObservation(pgdb.owner, 'obs-journey');
  const viaApi = await http(correlationPath);
  assert.deepEqual([viaApi.status, viaApi.body.contractVersion, sources(viaApi.body)], [200, 'atlas.correlation.v1',
    ['j-person:ASSIGNED_PERSON_ACTIVITY+SIGNIN_USER_REFERENCE', 'j-device:DEVICE_REFERENCE']]);
  const viaTool = await http('/tools/execute', { method: 'POST', body: JSON.stringify({ clientId: 'demo-gasta', tool: 'atlas.observation.get_correlation',
    parameters: { connectionId: 'journey-m365', observationId: 'obs-journey', from: R.toISOString(), to: end.toISOString() } }) });
  assert.deepEqual([viaTool.status, sources(viaTool.body)], [201, sources(viaApi.body)]);
  const viaCli = await ops.run(['correlation', '--client', 'demo-gasta', '--connection', 'journey-m365', '--observation', 'obs-journey', '--from', R.toISOString(),
    '--to', end.toISOString()]);
  assert.deepEqual([viaCli.code, sources(viaCli.output)], [0, sources(viaApi.body)]); step('correlation via API, tool and CLI', sources(viaApi.body).length);
  const printed = JSON.stringify([viaApi.body, viaTool.body, viaCli.output, probe.output, signIns.output]);
  for (const canary of ['192.0.2.44', 'DROP-ME', 'synthetic-preload-token', 'oauth2', 'skiptoken']) assert.ok(!printed.includes(canary), `no ${canary} in any output`);
  const reject = await ops.run(['reject-link', '--client', 'demo-gasta', '--link', deviceLink.linkId]);
  assert.deepEqual([reject.code, reject.output.status], [0, 'REJECTED']);
  const reread = await http(correlationPath);
  assert.deepEqual([(reread.body.resolution as { device: string; reasonCodes: string[] }).device, (reread.body.resolution as { reasonCodes: string[] }).reasonCodes,
    sources(reread.body)], ['UNRESOLVED', ['M365_DEVICE_MAPPING_MISSING'], ['j-person:ASSIGNED_PERSON_ACTIVITY+SIGNIN_USER_REFERENCE']]);
  step('revoke device mapping and reread', 'UNRESOLVED');
  const status = await ops.run(['m365-status', '--client', 'demo-gasta', '--connection', 'journey-m365']);
  assert.deepEqual([status.code, status.output.connectionStatus, (status.output.directory as { status: string }[]).map(d => d.status)], [0, 'ACTIVE', ['OK', 'OK']]);
  const cleanup = await ops.run(['m365-cleanup', '--client', 'demo-gasta']);
  assert.deepEqual([cleanup.code, cleanup.output.status], [0, 'COMPLETED']); step('m365-cleanup', cleanup.output.status);
  // No vendor write: the preload refuses anything but the token POST and the fixed Graph GETs, and only those occurred.
  const calls = ops.calls();
  assert.ok(calls.every(c => (c.method === 'POST' && c.path === `/${TENANT}/oauth2/v2.0/token`) || (c.method === 'GET' && c.path.startsWith('/v1.0/'))));
  assert.deepEqual([await count('RawEvent'), await count('DecisionRun')], [rawEvents + 1, decisions], 'only the synthetic observation event; no Decisions input');
  assert.deepEqual((await q(`SELECT status, "toolName" FROM "ToolExecution"`)), [{ status: 'SUCCEEDED', toolName: 'atlas.observation.get_correlation' }]);
  const events = (await q(`SELECT "eventType", count(*)::int AS n FROM "AuditEvent" GROUP BY 1 ORDER BY 1`)).map(r => `${r.eventType}:${r.n}`);
  for (const expected of ['connection.activated:1', 'correlation.read:4', 'm365.directory_published:2', 'm365.signin_requested:1', 'm365.signin_window_published:1',
    'mapping.link_confirmed:2', 'retention.completed:3', 'tool.started:1', 'tool.succeeded:1']) assert.ok(events.includes(expected), expected);
  const audit = JSON.stringify(await q(`SELECT metadata FROM "AuditEvent"`)) + JSON.stringify(await q(`SELECT metadata FROM "SecurityAuditEvent"`));
  for (const canary of [USER, DEVICE, REG, TENANT, '192.0.2.44', 'DROP-ME', 'j-device']) assert.ok(!audit.includes(canary), canary);
  receipt.graphCalls = calls.map(c => `${c.method} ${c.path.replace(TENANT, "<synthetic-tenant>")}`); receipt.auditEventCounts = events;
  if (process.env.ATLAS_S2C_EVIDENCE_DIR) {
    mkdirSync(process.env.ATLAS_S2C_EVIDENCE_DIR, { recursive: true });
    writeFileSync(join(process.env.ATLAS_S2C_EVIDENCE_DIR, 's2c-journey.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  }
});
