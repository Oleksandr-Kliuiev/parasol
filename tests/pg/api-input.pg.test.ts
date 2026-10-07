import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateToken } from '../../packages/auth/token.ts';
import { auditText } from '../../packages/audit/sanitize.ts';
import { createTestDatabase, runSeed } from '../support/pg-harness.ts';
import { startApi } from '../support/api-process.ts';
import type { ApiProcess } from '../support/api-process.ts';

// Review R1 on the compiled API (ATLAS_MODE=db) against PostgreSQL 17: input that PostgreSQL cannot store as text (NUL,
// lone UTF-16 surrogates) or that is not an identifier ends in a controlled denial with exactly one audit row — never a
// 500 that erases the denial — and reads no client data. URL path and JSON body are both covered.
const pgdb = await createTestDatabase();
const token = generateToken();
let api: ApiProcess;
before(async () => {
  runSeed(pgdb.ownerUrl, { ATLAS_DEMO_TOKEN: token });
  await pgdb.owner.query(`INSERT INTO "Client" VALUES ('demo-vardahei','demo-other','Other client (synthetic)')`);
  api = await startApi({ ATLAS_MODE: 'db', ATLAS_RUNTIME_DATABASE_URL: pgdb.runtimeUrl });
});
after(async () => { await api?.stop(); await pgdb.drop(); });

const SECURITY_ROW = `"eventType"||'|'||coalesce("requestedClientId",'-')||'|'||"reasonCode"||'|'||coalesce(metadata->>'tool','')`;
const CLIENT_ROW = `"clientId"||'|'||"eventType"||'|'||coalesce(metadata->>'tool','')||'|'||coalesce(metadata->>'safeErrorCode','')`;
const rows = async (table: string, expr: string) => (await pgdb.owner.query(`SELECT id, ${expr} AS s FROM "${table}"`)).rows as { id: string; s: string }[];

/** One authenticated request and the audit rows it added (identified by id, so equal timestamps cannot reorder them). */
async function probe(path: string, body?: unknown): Promise<{ status: number; security: string[]; client: string[] }> {
  const known = new Set([...await rows('SecurityAuditEvent', SECURITY_ROW), ...await rows('AuditEvent', CLIENT_ROW)].map(r => r.id));
  const response = await fetch(`${api.base}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  await response.arrayBuffer();
  const added = (all: { id: string; s: string }[]) => all.filter(r => !known.has(r.id)).map(r => r.s);
  return { status: response.status, security: added(await rows('SecurityAuditEvent', SECURITY_ROW)), client: added(await rows('AuditEvent', CLIENT_ROW)) };
}

test('URL path: a malformed client ID gets the same 403 as any out-of-scope client and exactly one escaped security-audit row', async () => {
  const cases: [string, string, string][] = [
    ['/clients/ghost%00client/overview', 'client.overview_denied', 'ghost\\u0000client'],
    ['/clients/ghost%00client/observations', 'client.observations_denied', 'ghost\\u0000client'],
    ['/clients/ghost%00client/audit', 'client.audit_denied', 'ghost\\u0000client'],
    ['/clients/ghost%5Cu0000client/overview', 'client.overview_denied', 'ghost\\\\u0000client'],
    ['/clients/ghost%0Aclient/overview', 'client.overview_denied', 'ghost\\u000aclient'],
    ['/clients/a%2Fb/overview', 'client.overview_denied', 'a/b'],
    [`/clients/${'x%00'.repeat(60)}/overview`, 'client.overview_denied', auditText('x\u0000'.repeat(60))]
  ];
  for (const [path, eventType, stored] of cases) {
    assert.deepEqual(await probe(path), { status: 403, security: [`${eventType}|${stored}|INVALID_SCOPE_ID|`], client: [] }, path);
  }
  assert.ok(auditText('x\u0000'.repeat(60)).length <= 200);
  assert.deepEqual(await probe('/clients/no-such-client/overview'),
    { status: 403, security: ['client.overview_denied|no-such-client|SCOPE_DENIED|'], client: [] }, 'control: well-formed, out of scope');
});

test('JSON body: a malformed client ID is a recorded scope denial, a malformed tool name a recorded tool denial; nothing is read', async () => {
  const execute = (clientId: string, tool: string) => probe('/tools/execute', { clientId, tool });
  assert.deepEqual(await execute('ghost\u0000client', 'atera.alert.list'),
    { status: 403, security: ['tool.scope_denied|ghost\\u0000client|INVALID_SCOPE_ID|atera.alert.list'], client: [] });
  assert.deepEqual(await execute('ghost\ud800', 'atera.alert.list'),
    { status: 403, security: ['tool.scope_denied|ghost\\ud800|INVALID_SCOPE_ID|atera.alert.list'], client: [] });
  assert.deepEqual(await execute('demo-gasta', 'unknown\u0000tool'),
    { status: 403, security: [], client: ['demo-gasta|tool.denied|unknown\\u0000tool|INVALID_TOOL_NAME'] });
  assert.deepEqual(await execute('demo-gasta', 'unknown\ud800tool'),
    { status: 403, security: [], client: ['demo-gasta|tool.denied|unknown\\ud800tool|INVALID_TOOL_NAME'] });
  assert.deepEqual(await execute('demo-other', 'unknown\u0000tool'),
    { status: 403, security: ['tool.scope_denied|demo-other|SCOPE_DENIED|unknown\\u0000tool'], client: [] }, 'scope is decided before the tool name');
  // Controls: the existing denials are unchanged
  assert.deepEqual(await execute('demo-gasta', 'unknown.tool'), { status: 403, security: [], client: ['demo-gasta|tool.denied|unknown.tool|UNKNOWN_TOOL'] });
  assert.deepEqual(await execute('no-such-client', 'atera.alert.list'),
    { status: 403, security: ['tool.scope_denied|no-such-client|SCOPE_DENIED|atera.alert.list'], client: [] });
  const reads = (await pgdb.owner.query(`SELECT count(*)::int AS n FROM "AuditEvent" WHERE "eventType" IN ('tool.started','tool.succeeded')`)).rows[0].n;
  assert.equal(reads, 0, 'no tool ran, so no client data was read');
});

test('structurally invalid bodies stay a 400 before any scope decision and write nothing', async () => {
  for (const body of [{ clientId: 'demo-gasta', tool: 'atera.alert.list', risk: 0 }, { clientId: 5, tool: 'atera.alert.list' }, ['demo-gasta'], { clientId: 'x'.repeat(129), tool: 'atera.alert.list' }]) {
    assert.deepEqual(await probe('/tools/execute', body), { status: 400, security: [], client: [] }, JSON.stringify(body).slice(0, 60));
  }
});

test('versioned tool DTO (task 1.9): version, parameters and requestId are checked at the boundary, the schema in the gateway; the correlation comes back', async () => {
  for (const body of [{ version: '2', clientId: 'demo-gasta', tool: 'atera.alert.list' }, { version: 1, clientId: 'demo-gasta', tool: 'atera.alert.list' },
    { clientId: 'demo-gasta', tool: 'atera.ticket.get', parameters: [] }, { clientId: 'demo-gasta', tool: 'atera.ticket.get', parameters: 'ticketId=1' },
    { clientId: 'demo-gasta', tool: 'atera.ticket.get', parameters: { ticketId: 'x'.repeat(3000) } },
    { clientId: 'demo-gasta', tool: 'atera.alert.list', requestId: 'short' }, { clientId: 'demo-gasta', tool: 'atera.alert.list', requestId: 'with spaces 1' }]) {
    assert.deepEqual(await probe('/tools/execute', body), { status: 400, security: [], client: [] }, JSON.stringify(body).slice(0, 70));
  }
  assert.deepEqual(await probe('/tools/execute', { version: '1', clientId: 'demo-gasta', tool: 'atera.ticket.get', parameters: { ticketId: 'a b' } }),
    { status: 400, security: [], client: ['demo-gasta|tool.rejected|atera.ticket.get|INVALID_TOOL_PARAMETERS'] }, 'the tool schema rejects, audited');
  const post = (body: unknown) => fetch(`${api.base}/tools/execute`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body) });
  const ok = await post({ version: '1', clientId: 'demo-gasta', tool: 'atera.ticket.get', parameters: { ticketId: '1' }, requestId: 'req-http-0001' });
  const view = await ok.json() as { status: string; items: unknown };
  assert.deepEqual([ok.status, ok.headers.get('x-atlas-correlation-id'), /^[0-9a-f-]{36}$/.test(ok.headers.get('x-atlas-tool-execution-id') ?? ''), view.status, view.items],
    [201, 'req-http-0001', true, 'MISSING', null], 'a resource never read stays MISSING, also for one source ID');
  const ledger = (await pgdb.owner.query(`SELECT status, "correlationId" FROM "ToolExecution" WHERE id = $1`, [ok.headers.get('x-atlas-tool-execution-id')])).rows;
  assert.deepEqual(ledger, [{ status: 'SUCCEEDED', correlationId: 'req-http-0001' }]);
  for (const [clientId, reason] of [['demo-other', 'SCOPE_DENIED'], ['ghost\u0000client', 'INVALID_SCOPE_ID']]) {
    const denied = await post({ clientId, tool: 'atera.alert.list', requestId: 'req-http-0002' });
    await denied.arrayBuffer();
    assert.deepEqual([denied.status, denied.headers.get('x-atlas-correlation-id')], [403, 'req-http-0002'], reason);
  }
  assert.deepEqual((await pgdb.owner.query(`SELECT "reasonCode" FROM "SecurityAuditEvent" WHERE "correlationId" = 'req-http-0002' ORDER BY "recordedAt"`)).rows.map(r => r.reasonCode),
    ['SCOPE_DENIED', 'INVALID_SCOPE_ID'], 'the denials carry the request correlation');
  const tools = await (await fetch(`${api.base}/tools`, { headers: { Authorization: `Bearer ${token}` } })).json() as { name: string; risk: number; parameters: Record<string, { required: boolean }> }[];
  const get = tools.find(t => t.name === 'atera.ticket.get')!;
  assert.deepEqual([get.risk, get.parameters.ticketId?.required, tools.every(t => t.risk === 0)], [0, true, true]);
});
