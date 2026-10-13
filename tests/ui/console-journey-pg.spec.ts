import { test, expect } from '@playwright/test';
import type { Page, Request } from '@playwright/test';
import { generateToken, hashToken } from '../../packages/auth/token.ts';
import { createTestDatabase, runSeed } from '../support/pg-harness.ts';
import type { PgTestDatabase } from '../support/pg-harness.ts';
import type { ApiProcess } from '../support/api-process.ts';
import { apiRequests, NOTHING_RETAINED, recordRequests, startConsoleApi, submitToken, tokenRetained } from '../support/operator-ui.ts';

// S5-B DB read journey (B1, B2, B3, B7, B8) against the compiled API in ATLAS_MODE=db on a disposable PostgreSQL 17
// database, synthetic rows only: server order/counts/filters/limit/opaque paging compared with the API's own pages; get
// and list evidence through the actual Gateway with its ToolExecution and audit rows; GET reads write nothing; no other
// table changes; a membership removed before the evidence click is a server 403 with a security audit row and a full
// console scope reset. Requires ATLAS_PG_ADMIN_URL (npm run test:ui under the PG wrapper).
const tech = generateToken(); const shifting = generateToken();
let pgdb: PgTestDatabase;
let api: ApiProcess & { console: string };
const AT = "now() - interval '1 minute'";

test.beforeAll(async () => {
  pgdb = await createTestDatabase();
  runSeed(pgdb.ownerUrl, { ATLAS_DEMO_TOKEN: tech });
  const item = (type: string, id: string, title: string, severity: string | null) =>
    `{"source":"${type === 'incident' ? 'huntress' : 'atera'}","resourceType":"${type}","externalId":"${id}","title":"${title}","status":"Open","severity":${severity ? `"${severity}"` : 'null'},` +
    `"priority":null,"device":{"resourceType":"agent","externalId":"agent-7"},"occurredAt":"2026-10-10T07:00:00.000Z","updatedAt":null}`;
  await pgdb.owner.query(`
    INSERT INTO "Client" VALUES ('demo-vardahei','demo-other','Other client (synthetic)');
    INSERT INTO "Connection" VALUES ('demo-vardahei','demo-other','other-atera','atera','atera-synthetic-other','fixture://no-credentials','FIXTURE');
    INSERT INTO "Actor" ("workspaceId","id","displayName","workspacePermissions") VALUES ('demo-vardahei','demo-shifting','Actor losing a membership (synthetic)',ARRAY[]::text[]);
    INSERT INTO "ClientMembership" ("workspaceId","clientId","actorId","permissions") VALUES ('demo-vardahei','demo-gasta','demo-shifting',ARRAY['context:read']);
    INSERT INTO "ApiToken" ("workspaceId","id","actorId","tokenHash","revokedAt") VALUES ('demo-vardahei','t-shifting','demo-shifting','${hashToken(shifting)}',NULL);
    INSERT INTO "RawEvent" ("workspaceId","clientId","id","connectionId","resourceType","externalEventId","revision","eventKey","normalized","payloadHash","occurredAt","status")
      SELECT 'demo-vardahei','demo-gasta','ev-m-'||g,'demo-atera-connection','alert','alert-m-'||g,'1','key-m-'||g,
        jsonb_build_object('kind','DISK_CAPACITY','summary','Disk usage high (synthetic) #'||g),'hash-m-'||g, now() - g * interval '1 minute','PROCESSED' FROM generate_series(1,30) g;
    INSERT INTO "RawEvent" ("workspaceId","clientId","id","connectionId","resourceType","externalEventId","revision","eventKey","normalized","payloadHash","occurredAt","status") VALUES
      ('demo-vardahei','demo-gasta','ev-c-1','demo-huntress-connection','incident','9001','1','key-c-1','{"kind":"SECURITY_INCIDENT","summary":"Possible credential theft (synthetic)"}','hash-c-1',now() - interval '2 days','PROCESSED'),
      ('demo-vardahei','demo-gasta','ev-t-1','demo-atera-connection','ticket','T-77','1','key-t-1','{"kind":"DISK_CAPACITY","summary":"Resolved ticket (synthetic)"}','hash-t-1',now() - interval '3 days','PROCESSED'),
      ('demo-vardahei','demo-other','ev-o-1','other-atera','alert','other-alert-1','1','key-o-1','{"kind":"DISK_CAPACITY","summary":"Other client (synthetic)"}','hash-o-1',now(),'PROCESSED');
    INSERT INTO "Observation" ("workspaceId","clientId","id","eventId","entityId","domain","severity","severityRank","priority","route","confidence","provider","promptVersion","reasonCodes","createdAt")
      SELECT 'demo-vardahei','demo-gasta','obs-m-'||g,'ev-m-'||g,'demo-device-07','OPERATIONS','MEDIUM',2,'NORMAL','MONITOR',0.9,'rules','rules-v1',ARRAY['RULES_BASELINE'], now() - g * interval '1 minute'
      FROM generate_series(1,30) g;
    INSERT INTO "Observation" ("workspaceId","clientId","id","eventId","entityId","domain","severity","severityRank","priority","route","confidence","provider","promptVersion","reasonCodes","createdAt",
      "status","resolvedAt","resolvedBy") VALUES
      ('demo-vardahei','demo-gasta','obs-c-1','ev-c-1','demo-device-07','SECURITY','CRITICAL',4,'URGENT','MONITOR',0.1,'rules','rules-v1',ARRAY['SOURCE_URGENCY_FLOOR'],now() - interval '2 days','OPEN',NULL,NULL),
      ('demo-vardahei','demo-gasta','obs-t-1','ev-t-1',NULL,'OPERATIONS','HIGH',3,'URGENT','INVESTIGATE',1,'rules','rules-v1',ARRAY['RULES_BASELINE'],now() - interval '3 days','RESOLVED',now() - interval '1 day','demo-technician'),
      ('demo-vardahei','demo-other','obs-o-1','ev-o-1',NULL,'OPERATIONS','HIGH',3,'URGENT','INVESTIGATE',1,'rules','rules-v1',ARRAY['RULES_BASELINE'],now(),'OPEN',NULL,NULL);
    INSERT INTO "SyncState" ("workspaceId","clientId","connectionId","resourceType","status","lastSyncAt","lastSuccessAt") VALUES
      ('demo-vardahei','demo-gasta','demo-atera-connection','alert','OK',${AT},${AT}), ('demo-vardahei','demo-gasta','demo-atera-connection','ticket','OK',${AT},${AT}),
      ('demo-vardahei','demo-gasta','demo-huntress-connection','incident','OK',${AT},${AT});
    INSERT INTO "ResourceSnapshot" VALUES
      ('demo-vardahei','demo-gasta','demo-atera-connection','alert',${AT},'[${item('alert', 'alert-m-1', 'Disk C: 97% (synthetic)', 'MEDIUM')},${item('alert', 'alert-m-12', 'Disk D: 91% (synthetic)', 'MEDIUM')}]',2,false,'test'),
      ('demo-vardahei','demo-gasta','demo-atera-connection','ticket',${AT},'[${item('ticket', 'T-77', 'Disk follow-up ticket (synthetic)', null)}]',1,false,'test'),
      ('demo-vardahei','demo-gasta','demo-huntress-connection','incident',${AT},'[${item('incident', '9001', 'Credential theft report (synthetic)', 'CRITICAL')}]',1,false,'test');`);
  api = await startConsoleApi({ ATLAS_MODE: 'db', ATLAS_RUNTIME_DATABASE_URL: pgdb.runtimeUrl });
});
test.afterAll(async () => { await api?.stop(); await pgdb?.drop(); });

const count = async (table: string) => Number((await pgdb.owner.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n);
const digest = async (table: string) => (await pgdb.owner.query(`SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS d FROM "${table}" t`)).rows[0].d as string;
const UNCHANGED = ['Observation', 'RawEvent', 'ResourceSnapshot', 'SyncState', 'ClientMembership', 'Connection', 'EntityLink', 'DecisionRun'];
const apiPage = async (query: string, token = tech) =>
  (await (await fetch(`${api.base}/clients/demo-gasta/observations?${query}`, { headers: { Authorization: `Bearer ${token}` } })).json()) as
  { items: { summary: string }[]; counts: Record<string, number>; total: number; nextCursor: string | null };
const rowSummaries = (page: Page) => page.locator('#queue-body .obs-summary').evaluateAll(nodes => nodes.map(n => (n.textContent ?? '').replace(/^Selected: /, '')));
const rowBySummary = (page: Page, summary: RegExp) => page.locator('#queue-body .obs').filter({ has: page.locator('.obs-summary', { hasText: summary }) });
function posts(page: Page): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  page.on('request', (request: Request) => { if (request.method() === 'POST') bodies.push(JSON.parse(request.postData() ?? 'null')); });
  return bodies;
}
async function setFilters(page: Page, statuses: string[], severities: string[], size: string) {
  for (const box of await page.locator('#queue-controls input[type=checkbox]').all()) {
    const value = await box.getAttribute('value');
    await box.setChecked(statuses.includes(value!) || severities.includes(value!));
  }
  await page.locator('#queue-controls select').selectOption(size);
  await page.getByRole('button', { name: 'Apply filters' }).click();
}

test('server order, counts, filters, limit and opaque pages; get/list evidence through the Gateway with ledger and audit only', async ({ page, context }) => {
  const before = Object.fromEntries(await Promise.all(UNCHANGED.map(async t => [t, await digest(t)])));
  const [executions, audits, security] = [await count('ToolExecution'), await count('AuditEvent'), await count('SecurityAuditEvent')];
  const seen = recordRequests(page, api.base);
  const bodies = posts(page);
  await page.goto(api.console);
  await submitToken(page, tech);
  await page.getByRole('button', { name: /Gasta/ }).click();
  const DEFAULT = 'status=OPEN%2CACKNOWLEDGED&severity=INFO%2CLOW%2CMEDIUM%2CHIGH%2CCRITICAL&limit=25';
  const first = await apiPage(DEFAULT);
  await expect(page.locator('#queue-status')).toContainText('Page 1: 25 observations');
  expect(await rowSummaries(page)).toEqual(first.items.map(i => i.summary));
  expect(first.items[0]!.summary).toBe('Possible credential theft (synthetic)');
  await expect(page.locator('#queue-body .counts')).toHaveText(`CRITICAL ${first.counts.CRITICAL} · HIGH 0 · MEDIUM 30 · LOW 0 · INFO 0 · total ${first.total}`);
  expect(first.total).toBe(31);

  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.locator('#queue-status')).toContainText('Page 2: 6 observations');
  const second = await apiPage(`${DEFAULT}&cursor=${first.nextCursor}`);
  expect(await rowSummaries(page)).toEqual(second.items.map(i => i.summary));
  await expect(page.getByRole('button', { name: 'Next page' })).toHaveCount(0);
  await page.getByRole('button', { name: 'First page' }).click();
  await expect(page.locator('#queue-status')).toContainText('Page 1: 25 observations');

  await setFilters(page, ['OPEN', 'RESOLVED'], ['HIGH', 'CRITICAL'], '50');
  await expect(page.locator('#queue-status')).toContainText('Page 1: 2 observations · statuses OPEN, RESOLVED · HIGH, CRITICAL · 50 per page.');
  expect(await rowSummaries(page)).toEqual((await apiPage('status=OPEN%2CRESOLVED&severity=HIGH%2CCRITICAL&limit=50')).items.map(i => i.summary));

  await page.locator('#queue-body .obs').filter({ hasText: 'credential theft' }).click();
  await expect(page.locator('#detail-body')).toContainText('Urgent: source severity CRITICAL');
  await expect(page.locator('#detail-body')).toContainText('MONITOR');
  await expect(page.locator('#detail-body')).toContainText('10% (explanatory only');
  await page.getByRole('button', { name: 'Read this stored Huntress incident' }).click();
  const evidence = page.locator('#evidence-body');
  await expect(evidence).toContainText('Credential theft report (synthetic)');
  await expect(evidence).toContainText('OK — Stored read within its freshness limit');
  const [incidentRun] = (await pgdb.owner.query(`SELECT id, "toolName", status, "correlationId", "actorId" FROM "ToolExecution" ORDER BY "createdAt" DESC LIMIT 1`)).rows;
  expect(incidentRun).toMatchObject({ toolName: 'huntress.incident.get', status: 'SUCCEEDED', correlationId: bodies[0]!.requestId, actorId: 'demo-technician' });
  await expect(evidence).toContainText(`Tool execution ID${incidentRun.id}`);
  expect(bodies[0]).toEqual({ version: '1', clientId: 'demo-gasta', tool: 'huntress.incident.get', parameters: { connectionId: 'demo-huntress-connection', incidentId: '9001' },
    requestId: bodies[0]!.requestId });

  await page.locator('#queue-body .obs').filter({ hasText: 'Resolved ticket' }).click();
  await expect(page.locator('#detail-body')).toContainText('Resolved');
  await expect(page.locator('#detail-body')).toContainText('Unresolved: this observation is not linked');
  await page.getByRole('button', { name: 'Read this stored Atera ticket' }).click();
  await expect(evidence).toContainText('Disk follow-up ticket (synthetic)');

  await setFilters(page, ['OPEN', 'ACKNOWLEDGED'], ['MEDIUM'], '25');
  for (const [summary, expected] of [['#1', 'Disk C: 97% (synthetic)'], ['#25', 'Not in this stored read.']] as const) {
    await rowBySummary(page, new RegExp(`${summary}$`)).click();
    await page.getByRole('button', { name: 'Read the stored Atera alert list and find this alert' }).click();
    await expect(evidence).toContainText(expected);
  }
  await expect(evidence).not.toContainText('may exist beyond it');
  expect(bodies.map(b => b.tool)).toEqual(['huntress.incident.get', 'atera.ticket.get', 'atera.alert.list', 'atera.alert.list']);
  expect(new Set(bodies.map(b => b.requestId)).size).toBe(4);

  const ledger = (await pgdb.owner.query(`SELECT "correlationId", status FROM "ToolExecution" ORDER BY "createdAt"`)).rows.slice(executions);
  expect(ledger).toEqual(bodies.map(b => ({ correlationId: b.requestId, status: 'SUCCEEDED' })));
  const audit = (await pgdb.owner.query(`SELECT "eventType", "correlationId" FROM "AuditEvent" ORDER BY "recordedAt", "eventType" DESC`)).rows.slice(audits);
  expect(audit).toEqual(bodies.flatMap(b => [{ eventType: 'tool.started', correlationId: b.requestId }, { eventType: 'tool.succeeded', correlationId: b.requestId }]));
  expect(await count('SecurityAuditEvent')).toBe(security);
  expect(Object.fromEntries(await Promise.all(UNCHANGED.map(async t => [t, await digest(t)])))).toEqual(before);
  expect(apiRequests(seen).every(r => r.sameOrigin && r.bearerIs(tech) && (r.method === 'GET' ? /^\/clients(\/demo-gasta\/(overview|observations\?.+))?$/.test(r.path) : r.path === '/tools/execute'))).toBe(true);
  expect(await page.locator('body').innerText()).not.toMatch(/Other client|example\.invalid/);
  expect(await tokenRetained(page, context, tech)).toEqual(NOTHING_RETAINED);
});

test('membership removed before the evidence click: server 403 + security audit, no execution row; full scope reset and one picker refresh', async ({ page }) => {
  const seen = recordRequests(page, api.base);
  const bodies = posts(page);
  await page.goto(api.console);
  await submitToken(page, shifting);
  await page.getByRole('button', { name: /Gasta/ }).click();
  await rowBySummary(page, /#1$/).click();
  await pgdb.owner.query(`DELETE FROM "ClientMembership" WHERE "actorId" = 'demo-shifting'`);
  const executions = await count('ToolExecution');
  await page.getByRole('button', { name: 'Read the stored Atera alert list and find this alert' }).click();
  await expect(page.locator('#scope-panel')).toContainText('refused access to the previously selected client');
  await expect(page.locator('#workspace')).toBeHidden();
  await expect(page.locator('#clients-status')).toHaveText('No clients are available to this token.');
  await page.waitForTimeout(300);
  expect(apiRequests(seen).map(r => `${r.method} ${r.path.split('?')[0]}`)).toEqual(['GET /clients', 'GET /clients/demo-gasta/overview', 'GET /clients/demo-gasta/observations',
    'POST /tools/execute', 'GET /clients']);
  expect(await count('ToolExecution')).toBe(executions);
  const denied = await pgdb.owner.query(`SELECT "actorId","eventType","requestedClientId","correlationId" FROM "SecurityAuditEvent" ORDER BY "recordedAt" DESC LIMIT 1`);
  expect(denied.rows[0]).toEqual({ actorId: 'demo-shifting', eventType: 'tool.scope_denied', requestedClientId: 'demo-gasta', correlationId: bodies[0]!.requestId });
});
