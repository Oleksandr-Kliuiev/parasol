import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ClientContextV1, ObservationPage, ResourceView, AuditRecord, SecurityAuditRecord } from '../../packages/core/contracts.ts';
import { generateToken, hashToken } from '../../packages/auth/token.ts';
import { createTestDatabase, runSeed } from '../support/pg-harness.ts';
import { startApi, startApiExpectingRefusal } from '../support/api-process.ts';
import type { ApiProcess } from '../support/api-process.ts';

// Checkpoint A end to end: the compiled API in ATLAS_MODE=db on a real PostgreSQL 17 server, connected as the confined
// runtime role, actors from the database. Run `npm run api:build` first (npm run test:pg does).
const pgdb = await createTestDatabase();
const tech = generateToken(); const noAudit = generateToken(); const ingestOnly = generateToken(); const revoked = generateToken();
let api: ApiProcess;

before(async () => {
  runSeed(pgdb.ownerUrl, { ATLAS_DEMO_TOKEN: tech });
  // Owner-side fixtures: a second client, two more synthetic actors, a revoked token, 101 newer MEDIUM + 1 older CRITICAL.
  await pgdb.owner.query(`
    INSERT INTO "Client" VALUES ('demo-vardahei','demo-other','Other client (synthetic)');
    INSERT INTO "Connection" VALUES ('demo-vardahei','demo-other','other-atera','atera','atera-synthetic-other','fixture://no-credentials','FIXTURE');
    INSERT INTO "Actor" ("workspaceId","id","displayName","workspacePermissions") VALUES
      ('demo-vardahei','demo-tech-no-audit','Technician without audit access (synthetic)',ARRAY[]::text[]),
      ('demo-vardahei','demo-ingest-only','Ingestion service (synthetic)',ARRAY[]::text[]);
    INSERT INTO "ClientMembership" ("workspaceId","clientId","actorId","permissions") VALUES
      ('demo-vardahei','demo-gasta','demo-tech-no-audit',ARRAY['context:read']),
      ('demo-vardahei','demo-gasta','demo-ingest-only',ARRAY['events:ingest']);
    INSERT INTO "ApiToken" ("workspaceId","id","actorId","tokenHash","revokedAt") VALUES
      ('demo-vardahei','t-no-audit','demo-tech-no-audit','${hashToken(noAudit)}',NULL),
      ('demo-vardahei','t-ingest','demo-ingest-only','${hashToken(ingestOnly)}',NULL),
      ('demo-vardahei','t-revoked','demo-technician','${hashToken(revoked)}',now());
    INSERT INTO "RawEvent" ("workspaceId","clientId","id","connectionId","resourceType","externalEventId","revision","eventKey","normalized","payloadHash","occurredAt","status")
      SELECT 'demo-vardahei','demo-gasta','ev-m-'||g,'demo-atera-connection','alert','demo-alert-'||g,'1','key-m-'||g,
        jsonb_build_object('kind','DISK_CAPACITY','summary','Disk usage high (synthetic) #'||g),'hash-m-'||g, now() - g * interval '1 minute','PROCESSED'
      FROM generate_series(1,101) g;
    INSERT INTO "RawEvent" ("workspaceId","clientId","id","connectionId","resourceType","externalEventId","revision","eventKey","normalized","payloadHash","occurredAt","status") VALUES
      ('demo-vardahei','demo-gasta','ev-c-1','demo-huntress-connection','incident','demo-incident-1','1','key-c-1','{"kind":"SECURITY_INCIDENT","summary":"Possible credential theft (synthetic)"}','hash-c-1',now() - interval '10 days','PROCESSED'),
      ('demo-vardahei','demo-other','ev-o-1','other-atera','alert','other-alert-1','1','key-o-1','{"kind":"DISK_CAPACITY","summary":"Other client (synthetic)"}','hash-o-1',now(),'PROCESSED');
    INSERT INTO "Observation" ("workspaceId","clientId","id","eventId","entityId","domain","severity","severityRank","priority","route","confidence","provider","promptVersion","reasonCodes","createdAt")
      SELECT 'demo-vardahei','demo-gasta','obs-m-'||g,'ev-m-'||g,'demo-device-07','OPERATIONS','MEDIUM',2,'NORMAL','MONITOR',0.9,'rules','rules-v1',ARRAY['RULES_BASELINE'], now() - g * interval '1 minute'
      FROM generate_series(1,101) g;
    INSERT INTO "Observation" ("workspaceId","clientId","id","eventId","entityId","domain","severity","severityRank","priority","route","confidence","provider","promptVersion","reasonCodes","createdAt") VALUES
      ('demo-vardahei','demo-gasta','obs-c-1','ev-c-1','demo-device-07','SECURITY','CRITICAL',4,'URGENT','HUMAN_REVIEW',1,'rules','rules-v1',ARRAY['SOURCE_URGENCY_FLOOR'],now() - interval '10 days'),
      ('demo-vardahei','demo-other','obs-o-1','ev-o-1',NULL,'OPERATIONS','HIGH',3,'URGENT','INVESTIGATE',1,'rules','rules-v1',ARRAY['RULES_BASELINE'],now());`);
  api = await startApi({ ATLAS_MODE: 'db', ATLAS_RUNTIME_DATABASE_URL: pgdb.runtimeUrl });
});
after(async () => { await api?.stop(); await pgdb.drop(); });

const call = (path: string, token: string | null, init: RequestInit = {}) =>
  fetch(`${api.base}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
const json = async <T>(path: string, token: string): Promise<T> => {
  const response = await call(path, token);
  assert.equal(response.status, 200, path);
  return await response.json() as T;
};
const securityRows = async () => (await pgdb.owner.query(`SELECT "actorId","eventType","requestedClientId","reasonCode" FROM "SecurityAuditEvent" ORDER BY "recordedAt", id`)).rows
  .map(r => `${r.actorId}|${r.eventType}|${r.requestedClientId}|${r.reasonCode}`);

test('the API refuses to start through the owner connection or without a runtime connection', async () => {
  const owner = await startApiExpectingRefusal({ ATLAS_MODE: 'db', ATLAS_RUNTIME_DATABASE_URL: pgdb.ownerUrl });
  assert.notEqual(owner.code, 0); assert.match(owner.stderr, /RUNTIME_ROLE_BYPASSES_RLS/);
  const missing = await startApiExpectingRefusal({ ATLAS_MODE: 'db', ATLAS_RUNTIME_DATABASE_URL: '' });
  assert.notEqual(missing.code, 0); assert.match(missing.stderr, /ATLAS_RUNTIME_DATABASE_URL/);
});

test('authentication: no, malformed, unknown or revoked credentials are 401', async () => {
  for (const token of [null, 'short', generateToken(), revoked]) assert.equal((await call('/clients', token)).status, 401, String(token).slice(0, 8));
  assert.equal((await fetch(`${api.base}/clients`, { headers: { Authorization: `Basic ${tech}` } })).status, 401);
});

test('Parasol export matches the shared contract and only includes authorized clients', async () => {
  const expected = JSON.parse(readFileSync(new URL('../../../../contracts/customer-identity/atlas-export.v1.example.json', import.meta.url), 'utf8'));
  assert.deepEqual(await json('/clients/identity-export', tech), expected);
  assert.equal((await call('/clients/identity-export', tech)).headers.get('cache-control'), 'no-store');
  assert.deepEqual(await json('/clients/identity-export', ingestOnly), { ...expected, clients: [] });
  for (const token of [null, revoked]) assert.equal((await call('/clients/identity-export', token)).status, 401);
  const raw = await (await call('/clients/identity-export', tech)).text();
  for (const forbidden of ['secretRef', 'tokenHash', 'externalTenantId', 'demo-other', tech]) assert.ok(!raw.includes(forbidden));
});

test('Gasta → Kari → GASTA-LT-07 with both confirmed mappings, explicit MISSING resources and no secret fields', async () => {
  assert.deepEqual(await json('/clients', tech), [{ id: 'demo-gasta', name: 'Gasta (synthetic)' }]);
  const response = await call('/clients/demo-gasta/overview', tech);
  const raw = await response.text();
  const ctx = JSON.parse(raw) as ClientContextV1;
  assert.equal(response.status, 200);
  assert.equal(ctx.contractVersion, 'ClientContextV1'); assert.equal(ctx.mode, 'db'); assert.equal(ctx.completeness, 'PARTIAL');
  assert.deepEqual([ctx.workspaceId, ctx.clientId, ctx.clientName], ['demo-vardahei', 'demo-gasta', 'Gasta (synthetic)']);
  assert.deepEqual(ctx.people.map(p => [p.id, p.displayName]), [['demo-kari', 'Kari (synthetic)']]);
  assert.deepEqual(ctx.devices.map(d => [d.id, d.hostname, d.personId]), [['demo-device-07', 'GASTA-LT-07', 'demo-kari']]);
  assert.deepEqual(ctx.links.map(l => `${l.system}:${l.resourceType}:${l.externalId}->${l.entityKind}:${l.entityId}:${l.status}`).sort(), [
    'atera:agent:demo-atera-agent-107->DEVICE:demo-device-07:CONFIRMED', 'huntress:agent:demo-huntress-agent-207->DEVICE:demo-device-07:CONFIRMED']);
  assert.deepEqual(ctx.resources.map(r => `${r.source}/${r.resourceType}:${r.status}:${r.safeErrorCode}:${JSON.stringify(r.items)}`), [
    'atera/alert:MISSING:SYNC_NOT_CONFIGURED:null', 'atera/ticket:MISSING:SYNC_NOT_CONFIGURED:null', 'huntress/incident:MISSING:SYNC_NOT_CONFIGURED:null']);
  for (const secret of ['secretRef', 'fixture://', 'externalTenantId', 'synthetic-gasta', 'tokenHash', hashToken(tech), tech, 'password']) {
    assert.ok(!raw.includes(secret), `response must not contain ${secret}`);
  }
});

test('observations: an old CRITICAL stays first among 101 newer MEDIUMs; counts cover the whole OPEN set of this client only', async () => {
  const ctx = await json<ClientContextV1>('/clients/demo-gasta/overview', tech);
  assert.equal(ctx.observations.items[0]?.severity, 'CRITICAL'); assert.equal(ctx.observations.items[0]?.priority, 'URGENT');
  assert.equal(ctx.observations.items.length, 100); assert.equal(ctx.observations.total, 102); assert.equal(ctx.observations.truncated, true);
  assert.deepEqual(ctx.observations.counts, { INFO: 0, LOW: 0, MEDIUM: 101, HIGH: 0, CRITICAL: 1 }, 'the other client\'s HIGH is not counted');
  assert.ok(ctx.observations.items.every(o => o.clientId === 'demo-gasta'));
  const page = await json<ObservationPage>('/clients/demo-gasta/observations?limit=5', tech);
  assert.deepEqual(page.items.map(o => o.severity), ['CRITICAL', 'MEDIUM', 'MEDIUM', 'MEDIUM', 'MEDIUM']);
  assert.deepEqual([page.total, page.truncated], [102, true]);
  assert.ok(page.items[1]!.createdAt > page.items[2]!.createdAt, 'newest first within a severity');
  for (const bad of ['0', '101', 'abc', '5&limit=6']) assert.equal((await call(`/clients/demo-gasta/observations?limit=${bad}`, tech)).status, 400, bad);
});

test('another client, a non-existent client and a missing permission are 403 and land in the workspace security audit only', async () => {
  for (const id of ['demo-other', 'no-such-client']) assert.equal((await call(`/clients/${id}/overview`, tech)).status, 403, id);
  assert.equal((await call('/clients/demo-gasta/overview', ingestOnly)).status, 403);
  assert.deepEqual(await json('/clients', ingestOnly), [], 'events:ingest alone lists no client');
  const rows = await securityRows();
  assert.ok(rows.includes('demo-technician|client.overview_denied|demo-other|SCOPE_DENIED'));
  assert.ok(rows.includes('demo-technician|client.overview_denied|no-such-client|SCOPE_DENIED'));
  assert.ok(rows.includes('demo-ingest-only|client.overview_denied|demo-gasta|PERMISSION_DENIED'));
  assert.equal(Number((await pgdb.owner.query(`SELECT count(*)::int AS n FROM "AuditEvent" WHERE "clientId" = 'demo-other'`)).rows[0].n), 0);
});

test('read tools over the database: resource views with status, write tool denied, strict DTO, scope denial audited', async () => {
  const execute = (body: unknown, token = tech) => call('/tools/execute', token, { method: 'POST', body: JSON.stringify(body) });
  const ticket = await execute({ clientId: 'demo-gasta', tool: 'atera.ticket.list' });
  assert.equal(ticket.status, 201);
  const view = await ticket.json() as ResourceView;
  assert.deepEqual([view.status, view.items, view.safeErrorCode], ['MISSING', null, 'SYNC_NOT_CONFIGURED']);
  assert.equal((await execute({ clientId: 'demo-gasta', tool: 'atera.ticket.create' })).status, 403);
  assert.equal((await execute({ clientId: 'demo-gasta', tool: 'atera.ticket.list', risk: 0 })).status, 400);
  assert.equal((await execute({ clientId: 'demo-other', tool: 'atera.ticket.list' })).status, 403);
  assert.ok((await securityRows()).includes('demo-technician|tool.scope_denied|demo-other|SCOPE_DENIED'));
  assert.equal((await json<unknown[]>('/tools', tech)).length, 7);
  assert.deepEqual(await json('/tools', ingestOnly), []);
  const audit = await json<AuditRecord[]>('/clients/demo-gasta/audit', tech);
  const events = audit.map(a => a.eventType);
  for (const e of ['tool.started', 'tool.succeeded', 'tool.denied']) assert.ok(events.includes(e), e);
  assert.ok(audit.every(a => Object.keys(a.metadata).every(k => ['tool', 'toolVersion', 'safeErrorCode', 'toolExecutionId', 'parameter'].includes(k))),
    'allowlisted metadata only');
});

test('GET /audit/security needs security_audit:read; a refused read is itself recorded', async () => {
  const log = await json<SecurityAuditRecord[]>('/audit/security', tech);
  assert.ok(log.length >= 4 && log.every(r => r.workspaceId === 'demo-vardahei' && r.outcome === 'DENIED'));
  assert.ok(log.some(r => r.eventType === 'client.overview_denied' && r.requestedClientId === 'demo-other'));
  assert.equal((await call('/audit/security', noAudit)).status, 403);
  assert.ok((await securityRows()).includes('demo-tech-no-audit|audit.security_denied|null|PERMISSION_DENIED'));
  assert.equal((await call('/audit/security?limit=1', tech)).status, 200);
  assert.equal((await call('/audit/security?limit=1000', tech)).status, 400);
});

test('one actor, two memberships: context:read on Gasta, only events:ingest on another client — each client gets exactly its permission', async () => {
  const split = generateToken();
  await pgdb.owner.query(`
    INSERT INTO "Actor" ("workspaceId","id","displayName") VALUES ('demo-vardahei','demo-split','Split technician (synthetic)');
    INSERT INTO "ClientMembership" ("workspaceId","clientId","actorId","permissions") VALUES
      ('demo-vardahei','demo-gasta','demo-split',ARRAY['context:read']), ('demo-vardahei','demo-other','demo-split',ARRAY['events:ingest']);
    INSERT INTO "ApiToken" ("workspaceId","id","actorId","tokenHash") VALUES ('demo-vardahei','t-split','demo-split','${hashToken(split)}');`);
  assert.deepEqual(await json('/clients', split), [{ id: 'demo-gasta', name: 'Gasta (synthetic)' }]);
  assert.equal((await json<ClientContextV1>('/clients/demo-gasta/overview', split)).clientId, 'demo-gasta');
  assert.equal((await call('/clients/demo-other/overview', split)).status, 403);
  assert.ok((await securityRows()).includes('demo-split|client.overview_denied|demo-other|PERMISSION_DENIED'));
  const tool = await call('/tools/execute', split, { method: 'POST', body: JSON.stringify({ clientId: 'demo-other', tool: 'atera.alert.list' }) });
  assert.equal(tool.status, 403);
  const otherAudit = (await pgdb.owner.query(`SELECT "eventType"||'|'||(metadata->>'safeErrorCode') AS s FROM "AuditEvent" WHERE "clientId" = 'demo-other' AND "actorId" = 'demo-split'`)).rows.map(r => r.s);
  assert.deepEqual(otherAudit, ['tool.denied|PERMISSION_DENIED'], 'a member without the permission: denial in that client\'s audit, no read');
  assert.equal((await json<unknown[]>('/tools', split)).length, 7);
});

test('observations over HTTP (task 1.8): status and severity filters, keyset pages, and invalid parameters as 400 before any query', async () => {
  await pgdb.owner.query(`UPDATE "Observation" SET status = 'RESOLVED', "resolvedAt" = now(), "resolvedBy" = 'demo-technician' WHERE "clientId" = 'demo-gasta' AND severity = 'CRITICAL'`);
  const active = await json<ObservationPage>('/clients/demo-gasta/observations', tech);
  assert.deepEqual([active.total, active.counts.CRITICAL, active.items[0]?.severity, active.items[0]?.status], [101, 0, 'MEDIUM', 'OPEN'], 'closed ones leave the active set');
  const resolved = await json<ObservationPage>('/clients/demo-gasta/observations?status=RESOLVED,SUPPRESSED', tech);
  assert.deepEqual(resolved.items.map(o => `${o.severity}:${o.status}:${o.resolvedAt !== null}`), ['CRITICAL:RESOLVED:true']);
  // Seven more MEDIUMs created at the very same millisecond: the pages must also walk a tie on the time, by id
  await pgdb.owner.query(`
    INSERT INTO "RawEvent" ("workspaceId","clientId","id","connectionId","resourceType","externalEventId","revision","eventKey","normalized","payloadHash","occurredAt","status")
      SELECT 'demo-vardahei','demo-gasta','ev-tie-'||g,'demo-atera-connection','alert','demo-alert-tie-'||g,'1','key-tie-'||g,
        jsonb_build_object('kind','DISK_CAPACITY','summary','Tie (synthetic) #'||g),'hash-tie-'||g, '2026-10-07T08:00:00.000Z','PROCESSED' FROM generate_series(1,7) g;
    INSERT INTO "Observation" ("workspaceId","clientId","id","eventId","entityId","domain","severity","severityRank","priority","route","confidence","provider","promptVersion","reasonCodes","createdAt")
      SELECT 'demo-vardahei','demo-gasta','obs-tie-'||g,'ev-tie-'||g,'demo-device-07','OPERATIONS','MEDIUM',2,'NORMAL','MONITOR',0.9,'rules','rules-v1',ARRAY['RULES_BASELINE'],
        '2026-10-07T08:00:00.000Z' FROM generate_series(1,7) g;`);
  const ids: string[] = []; let cursor: string | null = null;
  do {
    const page: ObservationPage = await json<ObservationPage>(`/clients/demo-gasta/observations?severity=MEDIUM&limit=3${cursor ? `&cursor=${cursor}` : ''}`, tech);
    ids.push(...page.items.map(o => o.id)); cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual([ids.length, new Set(ids).size], [108, 108], 'every MEDIUM once across the pages, the tied ones included');
  const tied = ids.filter(id => id.startsWith('obs-tie-'));
  assert.deepEqual(tied, [...tied].sort(), 'a tie on time is ordered by id');
  for (const bad of ['status=CLOSED', 'status=OPEN,OPEN', 'status=', 'severity=URGENT', 'cursor=%25', `cursor=${'a'.repeat(401)}`, 'cursor=abc',
    'status=OPEN&status=RESOLVED', 'limit=0']) {
    assert.equal((await call(`/clients/demo-gasta/observations?${bad}`, tech)).status, 400, bad);
  }
});
