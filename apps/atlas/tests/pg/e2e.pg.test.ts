import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import type { AuditRecord, ClientContextV1, ObservationPage, ResourceView, SnapshotItem } from '../../packages/core/contracts.ts';
import { generateToken } from '../../packages/auth/token.ts';
import { authenticateToken } from '../../packages/auth/prisma-auth.ts';
import type { MappingReviewItem } from '../../packages/graph/mapping.ts';
import { loadDecisionConfig } from '../../packages/decisions/config.ts';
import { createDecisionRuntime } from '../../packages/decisions/runtime.ts';
import type { DecisionTelemetry } from '../../packages/decisions/telemetry.ts';
import { parseInvocation, runOperatorCommand } from '../../packages/ops/commands.ts';
import type { OperatorContext } from '../../packages/ops/commands.ts';
import type { HttpTransport } from '../../connectors/http.ts';
import { EnvSecretResolver } from '../../connectors/secrets.ts';
import { createTestDatabase, runSeed } from '../support/pg-harness.ts';
import { startApi } from '../support/api-process.ts';
import type { ApiProcess } from '../support/api-process.ts';
import { gastaVendor, testSecrets } from '../support/vendor-routes.ts';
import { routed, scriptedFetch } from '../support/decision-fixtures.ts';

// Task 1.10 / Checkpoint C end to end on PostgreSQL 17, one scenario in steps (the tests run in order and build on each
// other). The documented path: migrate deploy, roles.sql and the synthetic seed as the owner; everything else as the
// runtime role — the operator's ops commands in-process (the same code as `npm run ops`, scripts/ops.ts) and the compiled
// API in ATLAS_MODE=db for the technician. Vendors are the mock transport and Decisions a scripted endpoint: no network,
// and none of this is live verification. With ATLAS_E2E_EVIDENCE_DIR set, the run also writes what it showed as JSON
// (synthetic data; verification/e2e holds the run of the Checkpoint C report).
const pgdb = await createTestDatabase();
const db = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
let api: ApiProcess | undefined;
after(async () => { await api?.stop(); await db.$disconnect(); await pgdb.drop(); });
const techToken = generateToken(); const operatorToken = generateToken();
runSeed(pgdb.ownerUrl, { ATLAS_DEMO_TOKEN: techToken, ATLAS_OPERATOR_TOKEN: operatorToken });
await pgdb.owner.query(`INSERT INTO "Client" VALUES ('demo-vardahei','demo-other','Other client (synthetic)')`);
api = await startApi({ ATLAS_MODE: 'db', ATLAS_RUNTIME_DATABASE_URL: pgdb.runtimeUrl });

// Both actors come from the database through their tokens, not from code
const operator = (await authenticateToken(db, operatorToken))!;
const technician = (await authenticateToken(db, techToken))!;
const vendor = gastaVendor();
const methods = new Set<string>();
const transport: HttpTransport = (url, init) => { methods.add(init.method); return vendor.transport(url, init); };
const config = loadDecisionConfig({ env: {} }); // the file as reviewed: shadow mode
const decisions = scriptedFetch([routed('MONITOR', 0.95), routed('MONITOR', 0.95)]);
const runtime = createDecisionRuntime(config, { apiKey: 'test-key-not-a-credential', fetch: decisions.fetch });
const ctx: OperatorContext = { db, actor: operator, io: { transport, secrets: new EnvSecretResolver(testSecrets) }, workerId: 'worker-e2e',
  config: () => config, runtime: () => runtime };
const ops = (...argv: string[]) => runOperatorCommand(ctx, parseInvocation(argv));

const call = (path: string, init: RequestInit = {}, token = techToken) =>
  fetch(`${api!.base}${path}`, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } });
const get = async <T>(path: string): Promise<T> => {
  const response = await call(path);
  assert.equal(response.status, 200, path);
  return await response.json() as T;
};
const execute = (body: Record<string, unknown>) => call('/tools/execute', { method: 'POST', body: JSON.stringify(body) });
/** Owner view of the rows, one `a|b|c` string per row (array mode: unnamed columns never collapse). */
const rows = async (sql: string) => (await pgdb.owner.query<unknown[]>({ text: sql, rowMode: 'array' })).rows.map(r => r.join('|'));
const objects = async (sql: string) => (await pgdb.owner.query(sql)).rows as Record<string, unknown>[];
const evidence = (name: string, data: unknown) => {
  const dir = process.env.ATLAS_E2E_EVIDENCE_DIR;
  if (dir) { mkdirSync(dir, { recursive: true }); writeFileSync(`${dir}/${name}.json`, `${JSON.stringify(data, null, 2)}\n`); }
};
const pick = (result: { output: Record<string, unknown> }) => [result.output.previousStatus, result.output.status];

test('operator: explicit tenant bindings, then a live-read check through the mock vendor — GET only, inside the bound tenants', async () => {
  for (const [connection, system, tenant, ref] of [['gasta-huntress', 'huntress', '7001', 'env://HUNTRESS_GASTA'], ['gasta-atera', 'atera', '5001', 'env://ATERA_GASTA']]) {
    assert.deepEqual(await ops('bind', '--client', 'demo-gasta', '--connection', connection!, '--system', system!, '--tenant', tenant!, '--secret-ref', ref!),
      { ok: true, output: { connectionId: connection, status: 'DISABLED' } });
  }
  const huntress = await ops('live-read', '--client', 'demo-gasta', '--connection', 'gasta-huntress');
  const atera = await ops('live-read', '--client', 'demo-gasta', '--connection', 'gasta-atera');
  evidence('1-live-read', { huntress, atera, vendorRequests: vendor.requests.map(r => `GET ${r.url.host}${r.url.pathname}${r.url.search}`) });
  assert.deepEqual(huntress, { ok: true, output: { connectionId: 'gasta-huntress',
    system: 'huntress', activation: { status: 'ACTIVE' }, health: { status: 'OK', safeErrorCode: null },
    identities: { status: 'OK', registered: 2, candidates: 1, ambiguous: 0, safeErrorCode: null },
    resources: [{ resourceType: 'incident', status: 'OK', itemCount: 2, eventsStored: 2, safeErrorCode: null, retryAfterSeconds: null }] } });
  assert.deepEqual(atera, { ok: true, output: { connectionId: 'gasta-atera',
    system: 'atera', activation: { status: 'ACTIVE' }, health: { status: 'OK', safeErrorCode: null },
    identities: { status: 'OK', registered: 1, candidates: 1, ambiguous: 0, safeErrorCode: null },
    resources: [{ resourceType: 'ticket', status: 'OK', itemCount: 2, eventsStored: 0, safeErrorCode: null, retryAfterSeconds: null },
      { resourceType: 'alert', status: 'UNAVAILABLE', itemCount: null, eventsStored: 0, safeErrorCode: 'UPSTREAM_TENANT_FILTER_UNAVAILABLE', retryAfterSeconds: null }] } },
    'alerts unavailable upstream are named, and they do not fail the check');
  assert.deepEqual([...methods], ['GET']);
  assert.ok(vendor.requests.length > 0 && vendor.requests.every(r => ['api.huntress.io', 'app.atera.com'].includes(r.url.host)));
  assert.ok(!vendor.requests.some(r => /alert/i.test(r.url.pathname)), 'Atera alerts are never requested: no tenant filter upstream');
  const stored = (await rows(`SELECT row_to_json(c)::text FROM "Connection" c`)).join() + (await rows(`SELECT metadata::text FROM "AuditEvent"`)).join();
  for (const secret of Object.values(testSecrets)) assert.ok(!stored.includes(secret), 'references are stored, credentials never');
});

test('a failing health check of an active connection ends the live-read check before any sync: one request, nothing read', async () => {
  vendor.overrides.huntressOrganization = { status: 401 };
  const sent = vendor.requests.length;
  const result = await ops('live-read', '--client', 'demo-gasta', '--connection', 'gasta-huntress');
  delete vendor.overrides.huntressOrganization;
  assert.deepEqual(result, { ok: false, output: { connectionId: 'gasta-huntress', system: 'huntress', activation: { status: 'ACTIVE' },
    health: { status: 'ERROR', safeErrorCode: 'UPSTREAM_AUTH_FAILED' }, identities: null, resources: [] } });
  assert.deepEqual(vendor.requests.slice(sent).map(r => r.url.pathname), ['/v1/organizations/7001']);
});

test('mapping review: hostname matches wait in the queue as candidates and become links only when the operator confirms them', async () => {
  const queue = (await ops('mapping', '--client', 'demo-gasta')).output.items as MappingReviewItem[];
  evidence('2-mapping-queue', queue);
  assert.deepEqual(queue.map(i => `${i.status}:${i.method}:${i.connectionId}:${i.externalId}->${i.entityId}`).sort(),
    ['CANDIDATE:HOSTNAME_EXACT:gasta-atera:107001->demo-device-07', 'CANDIDATE:HOSTNAME_EXACT:gasta-huntress:207001->demo-device-07']);
  assert.ok(!(await get<ClientContextV1>('/clients/demo-gasta/overview')).links.some(l => l.connectionId.startsWith('gasta-')), 'a candidate is not a link');
  for (const item of queue) {
    assert.deepEqual((await ops('confirm-link', '--client', 'demo-gasta', '--link', item.linkId)).output, { linkId: item.linkId, status: 'CONFIRMED', conflictsWithLinkId: null });
  }
  assert.deepEqual((await ops('mapping', '--client', 'demo-gasta')).output.items, []);
});

test('shadow mode, two passes: the baseline pass applies and commits the rules decision; the shadow pass stores the model runs applied=false', async () => {
  const pass = await ops('worker-once');
  assert.deepEqual([pass.output.configVersion, pass.output.mode, pass.output.clients], [config.configVersion, 'shadow', [{ clientId: 'demo-gasta', events: { PROCESSED: 2 } }]]);
  assert.equal(decisions.calls.count, 0, 'the baseline pass never calls the provider');
  const shadow = await ops('shadow-once');
  assert.deepEqual([shadow.output.configVersion, shadow.output.mode, shadow.output.clients], [config.configVersion, 'shadow', [{ clientId: 'demo-gasta', shadow: { DONE: 2 } }]]);
  assert.equal(decisions.calls.count, 2);
  for (const body of decisions.calls.bodies as { model: string; input: string }[]) {
    assert.deepEqual([body.model, Object.keys(JSON.parse(body.input)).sort()], ['gpt-6-luna', ['kind', 'source', 'sourceSeverity']]);
    assert.ok(!/GASTA|Kari|credential|Analyst|@/i.test(JSON.stringify(body)), 'no names, hostnames, free text or emails reach Decisions');
  }
  const runs = await objects(`SELECT e."externalEventId" AS event, r.id, r.applied, r.provider, r.mode, r.status, r.result, r."requestedModel", r."responseModel",
      r."inputTokens", r."latencyMs", r."configVersion", o.id AS "observationId"
    FROM "DecisionRun" r JOIN "RawEvent" e ON e."workspaceId" = r."workspaceId" AND e."clientId" = r."clientId" AND e.id = r."eventId"
    LEFT JOIN "Observation" o ON o."workspaceId" = r."workspaceId" AND o."clientId" = r."clientId" AND o."decisionRunId" = r.id
    ORDER BY e."externalEventId", r.applied DESC`);
  evidence('3-worker-pass', { workerOnce: pass.output, shadowOnce: shadow.output, decisionRuns: runs, decisionRequests: decisions.calls.bodies });
  assert.deepEqual(runs.map(r => [r.event, r.applied, r.provider, r.mode, r.status, (r.result as { route: string }).route, r.responseModel ?? '-', r.inputTokens ?? '-',
    r.configVersion, r.observationId !== null].join('|')), [
    `9001|true|rules|shadow|OK|HUMAN_REVIEW|-|-|${config.configVersion}|true`, `9001|false|openai|shadow|OK|MONITOR|gpt-6-luna|42|${config.configVersion}|false`,
    `9002|true|rules|shadow|OK|INVESTIGATE|-|-|${config.configVersion}|true`, `9002|false|openai|shadow|OK|MONITOR|gpt-6-luna|42|${config.configVersion}|false`],
    'per event one applied rules run that the observation references, one non-applied model run that nothing references');
});

test('full context over HTTP: Gasta → Kari → GASTA-LT-07 with its confirmed source links, the CRITICAL incident first, every resource with its status', async () => {
  const ctx = await get<ClientContextV1>('/clients/demo-gasta/overview');
  evidence('4-context', ctx);
  assert.deepEqual([ctx.contractVersion, ctx.mode, ctx.clientId, ctx.completeness], ['ClientContextV1', 'db', 'demo-gasta', 'PARTIAL']);
  assert.deepEqual([ctx.people.map(p => p.id), ctx.devices.map(d => `${d.id}:${d.hostname}:${d.personId}`)], [['demo-kari'], ['demo-device-07:GASTA-LT-07:demo-kari']]);
  assert.deepEqual(ctx.links.map(l => `${l.connectionId}:${l.resourceType}:${l.externalId}:${l.entityId}:${l.status}`).sort(), [
    'demo-atera-connection:agent:demo-atera-agent-107:demo-device-07:CONFIRMED', 'demo-huntress-connection:agent:demo-huntress-agent-207:demo-device-07:CONFIRMED',
    'gasta-atera:agent:107001:demo-device-07:CONFIRMED', 'gasta-huntress:agent:207001:demo-device-07:CONFIRMED']);
  assert.deepEqual(ctx.observations.items.map(o => `${o.externalEventId}:${o.severity}:${o.priority}:${o.route}:${o.entityId}:${o.status}:${o.reasonCodes.join('+')}`),
    ['9001:CRITICAL:URGENT:HUMAN_REVIEW:demo-device-07:OPEN:RULES_BASELINE+SOURCE_URGENCY_FLOOR', '9002:LOW:NORMAL:HUMAN_REVIEW:null:OPEN:RULES_BASELINE+UNRESOLVED_DEVICE'],
    'the model said MONITOR for both: the source urgency floor and the unresolved device keep them in review');
  assert.deepEqual([ctx.observations.counts, ctx.observations.total], [{ INFO: 0, LOW: 1, MEDIUM: 0, HIGH: 0, CRITICAL: 1 }, 2]);
  assert.deepEqual(ctx.resources.map(r => `${r.connectionId}:${r.resourceType}:${r.status}:${r.safeErrorCode}`), [
    'demo-atera-connection:alert:MISSING:SYNC_NOT_CONFIGURED', 'demo-atera-connection:ticket:MISSING:SYNC_NOT_CONFIGURED',
    'demo-huntress-connection:incident:MISSING:SYNC_NOT_CONFIGURED', 'gasta-atera:alert:MISSING:UPSTREAM_TENANT_FILTER_UNAVAILABLE',
    'gasta-atera:ticket:OK:null', 'gasta-huntress:incident:OK:null'], 'in connection order; missing is explicit, never an empty list');
  const text = JSON.stringify(ctx);
  for (const forbidden of ['env://', 'secretRef', 'Analyst narrative', techToken, operatorToken, ...Object.values(testSecrets)]) assert.ok(!text.includes(forbidden), forbidden);
});

test('read tools over HTTP with audit: each execution is a ToolExecution row under its request ID; ambiguity, write tools and other clients are refused', async () => {
  const one = await execute({ version: '1', requestId: 'req-e2e-0001', clientId: 'demo-gasta', tool: 'huntress.incident.get',
    parameters: { incidentId: '9001', connectionId: 'gasta-huntress' } });
  assert.deepEqual([one.status, one.headers.get('x-atlas-correlation-id')], [201, 'req-e2e-0001']);
  const view = await one.json() as ResourceView<SnapshotItem>;
  assert.deepEqual([view.connectionId, view.status, view.items?.map(i => `${i.externalId}:${i.severity}`)], ['gasta-huntress', 'OK', ['9001:CRITICAL']]);
  assert.equal((await execute({ requestId: 'req-e2e-0002', clientId: 'demo-gasta', tool: 'huntress.incident.list' })).status, 409,
    'a fixture and a live Huntress connection: the caller names one instead of getting whichever comes first');
  const tickets = await (await execute({ requestId: 'req-e2e-0003', clientId: 'demo-gasta', tool: 'atera.ticket.list', parameters: { connectionId: 'gasta-atera' } }))
    .json() as ResourceView<SnapshotItem>;
  assert.deepEqual([tickets.status, tickets.items?.map(i => i.externalId)], ['OK', ['30001', '30002']]);
  const urgent = await (await execute({ requestId: 'req-e2e-0004', clientId: 'demo-gasta', tool: 'atlas.observation.list', parameters: { severity: ['CRITICAL', 'HIGH'] } }))
    .json() as ObservationPage;
  assert.deepEqual(urgent.items.map(o => o.externalEventId), ['9001']);
  assert.equal((await execute({ requestId: 'req-e2e-0005', clientId: 'demo-gasta', tool: 'atera.ticket.create' })).status, 403);
  assert.equal((await execute({ requestId: 'req-e2e-0006', clientId: 'demo-other', tool: 'atera.ticket.list' })).status, 403);
  const ledger = await objects(`SELECT id, "correlationId", "actorId", "toolName", "toolVersion", "riskLevel", "sideEffect", "inputHash", status, "safeErrorCode",
    "createdAt", "finishedAt" FROM "ToolExecution" ORDER BY "createdAt", id`);
  assert.deepEqual(ledger.map(r => [r.correlationId, r.toolName, r.status, r.safeErrorCode ?? '-', r.actorId].join('|')), ['req-e2e-0001|huntress.incident.get|SUCCEEDED|-|demo-technician',
    'req-e2e-0002|huntress.incident.list|FAILED|AMBIGUOUS_CONNECTION|demo-technician', 'req-e2e-0003|atera.ticket.list|SUCCEEDED|-|demo-technician',
    'req-e2e-0004|atlas.observation.list|SUCCEEDED|-|demo-technician']);
  assert.equal(ledger[0]!.id, one.headers.get('x-atlas-tool-execution-id'));
  const audit = (await get<AuditRecord[]>('/clients/demo-gasta/audit')).filter(a => a.correlationId.startsWith('req-e2e-'));
  const security = await objects(`SELECT "actorId", "eventType", outcome, "requestedClientId", "reasonCode", "correlationId", metadata, "recordedAt" FROM "SecurityAuditEvent"
    WHERE "correlationId" LIKE 'req-e2e-%'`);
  evidence('5-read-tools', { executions: ledger, clientAudit: audit, securityAudit: security });
  assert.deepEqual(audit.map(a => `${a.correlationId}:${a.eventType}:${a.metadata.safeErrorCode ?? '-'}`).sort(), [
    'req-e2e-0001:tool.started:-', 'req-e2e-0001:tool.succeeded:-', 'req-e2e-0002:tool.failed:AMBIGUOUS_CONNECTION', 'req-e2e-0002:tool.started:-',
    'req-e2e-0003:tool.started:-', 'req-e2e-0003:tool.succeeded:-', 'req-e2e-0004:tool.started:-', 'req-e2e-0004:tool.succeeded:-', 'req-e2e-0005:tool.denied:UNKNOWN_TOOL']);
  assert.deepEqual(security.map(r => [r.actorId, r.eventType, r.requestedClientId, r.reasonCode, r.correlationId].join('|')),
    ['demo-technician|tool.scope_denied|demo-other|SCOPE_DENIED|req-e2e-0006']);
  assert.deepEqual(await rows(`SELECT count(*) FROM "AuditEvent" WHERE "clientId" = 'demo-other'`), ['0'], 'the other client log is untouched');
});

test('triage by the operator: acknowledged stays in the active context, resolved leaves it, both audited; a stale expectation is a conflict', async () => {
  const critical = (await get<ObservationPage>('/clients/demo-gasta/observations?severity=CRITICAL')).items[0]!;
  const triage = (action: string, ...extra: string[]) => ops('triage', '--client', 'demo-gasta', '--observation', critical.id, '--action', action, ...extra);
  assert.deepEqual(pick(await triage('acknowledge')), ['OPEN', 'ACKNOWLEDGED']);
  assert.equal((await get<ClientContextV1>('/clients/demo-gasta/overview')).observations.items.find(o => o.id === critical.id)?.status, 'ACKNOWLEDGED');
  await assert.rejects(triage('toString'), /INVALID_TRIAGE_ACTION/, 'an inherited name is not an action');
  await assert.rejects(triage('resolve', '--expected', 'OPEN'), /OBSERVATION_STATUS_CHANGED/);
  assert.deepEqual(pick(await triage('resolve', '--expected', 'ACKNOWLEDGED')), ['ACKNOWLEDGED', 'RESOLVED']);
  assert.deepEqual((await get<ClientContextV1>('/clients/demo-gasta/overview')).observations.items.map(o => o.externalEventId), ['9002']);
  assert.deepEqual((await get<ObservationPage>('/clients/demo-gasta/observations?status=RESOLVED')).items.map(o => o.id), [critical.id]);
  assert.deepEqual(await rows(`SELECT "actorId", "eventType", coalesce(metadata->>'previousStatus', '-'), coalesce(metadata->>'observationStatus', '-') FROM "AuditEvent"
    WHERE "eventType" LIKE 'observation.%' AND metadata->>'observationId' = '${critical.id}' ORDER BY "recordedAt"`), ['demo-operator|observation.created|-|-',
    'demo-operator|observation.acknowledged|OPEN|ACKNOWLEDGED', 'demo-operator|observation.resolved|ACKNOWLEDGED|RESOLVED'], 'created by the operator\'s worker pass');
});

test('decision telemetry by the operator: calls, input tokens and shadow agreement from the durable records', async () => {
  const report = (await ops('telemetry', '--client', 'demo-gasta')).output as unknown as DecisionTelemetry;
  evidence('6-telemetry', report);
  assert.deepEqual(report.runs.map(r => `${r.provider}:${r.mode}:${r.status}:${r.code}:${r.count}`).sort(), ['openai:shadow:OK:null:2', 'rules:shadow:OK:null:2']);
  assert.deepEqual(report.inputTokens.filter(t => t.provider === 'openai'), [{ provider: 'openai', callsWithUsage: 2, total: 84, perCall: 42, perEvent: 42 }]);
  assert.deepEqual(report.shadowAgreement.map(a => `${a.baseline}->${a.shadow}:${a.count}`).sort(), ['HUMAN_REVIEW->MONITOR:1', 'INVESTIGATE->MONITOR:1']);
  assert.deepEqual([report.shadowJobs, report.guardRefusals], [[{ status: 'DONE', code: null, count: 2 }], []]);
  await assert.rejects(ops('telemetry', '--client', 'demo-gasta', '--minutes', '99999'), /INVALID_ARGUMENTS/);
});

test('the command boundary: another client, a malformed client ID or a missing permission is refused before any service call, in the workspace security audit', async () => {
  await assert.rejects(ops('mapping', '--client', 'demo-other'), /SCOPE_DENIED/);
  await assert.rejects(ops('mapping', '--client', 'bad id'), /INVALID_SCOPE_ID/);
  await assert.rejects(runOperatorCommand({ ...ctx, actor: technician }, parseInvocation(['bind', '--client', 'demo-gasta', '--connection', 'x-huntress',
    '--system', 'huntress', '--tenant', '7002', '--secret-ref', 'env://X'])), /PERMISSION_DENIED/, 'the technician reads; binding is not theirs');
  assert.deepEqual(await rows(`SELECT "actorId", "requestedClientId", "reasonCode", metadata->>'command' FROM "SecurityAuditEvent" WHERE "eventType" = 'ops.scope_denied'
    ORDER BY "recordedAt"`), ['demo-operator|demo-other|SCOPE_DENIED|mapping', 'demo-operator|bad id|INVALID_SCOPE_ID|mapping', 'demo-technician|demo-gasta|PERMISSION_DENIED|bind']);
  assert.deepEqual(await rows(`SELECT count(*) FROM "Connection" WHERE id = 'x-huntress'`), ['0']);
});
