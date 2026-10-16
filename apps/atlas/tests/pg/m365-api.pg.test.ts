import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupM365Database } from '../support/m365-pg.ts';
import { startApi } from '../support/api-process.ts';
import { M365_CONNECTION } from '../support/m365-fixtures.ts';
import { hourStart, iso } from '../support/m365-signin-mock.ts';
import { addOperator } from '../support/m365-cli.ts';
import { CURSOR_SECRET, KARI, OTHER_DEVICE, REGISTRATION, addHuntressObservation, confirmM365Links, publishScenarioDirectory, publishSignIns,
  signIn } from '../support/correlation-fixtures.ts';

// The compiled API (tests/pg/m365-api.pg.test.ts; npm run api:build first, as test:pg does): GET
// /clients/:clientId/observations/:observationId/correlation and the composed registry in GET /tools and POST /tools/execute,
// DB mode as the confined runtime role; strict query (unknown/repeated/nested/override keys → 400), cursor codes in the body,
// all-of authority with exactly one workspace denial, the shared 512-character cursor bound below the 2048 body cap, Stage 1
// endpoints usable without the cursor configuration, and the fixture counterpart's unchanged public discovery.
const { pgdb, db } = await setupM365Database();
await confirmM365Links(pgdb.owner);
await publishScenarioDirectory(pgdb.owner);
await addHuntressObservation(pgdb.owner, 'obs-api');
const R = hourStart(3); const end = new Date(R.getTime() + 3_600_000);
await publishSignIns(db, () => [signIn('a-1', iso(R, 60_000), KARI, OTHER_DEVICE), signIn('a-2', iso(R, 120_000), KARI, REGISTRATION),
  signIn('a-3', iso(R, 180_000), KARI, REGISTRATION)], R, end);
const both = await addOperator(pgdb.owner, 'demo-api-both', ['context:read', 'm365:read']);
const single = await addOperator(pgdb.owner, 'demo-api-single', ['context:read']);
const cursorEnv = { ATLAS_CORRELATION_CURSOR_SECRET_REF: 'env://ATLAS_TEST_CURSOR_SECRET', ATLAS_TEST_CURSOR_SECRET: CURSOR_SECRET };
const api = await startApi({ ATLAS_MODE: 'db', ATLAS_RUNTIME_DATABASE_URL: pgdb.runtimeUrl, ...cursorEnv });
const bare = await startApi({ ATLAS_MODE: 'db', ATLAS_RUNTIME_DATABASE_URL: pgdb.runtimeUrl, ATLAS_CORRELATION_CURSOR_SECRET_REF: '' });
const fixture = await startApi({ ATLAS_MODE: 'fixture', ATLAS_DEMO_TOKEN: 'synthetic-demo-token-for-api-tests', ...cursorEnv });
after(async () => { await api.stop(); await bare.stop(); await fixture.stop(); await db.$disconnect(); await pgdb.drop(); });
const path = (client = 'demo-gasta', observation = 'obs-api') => `/clients/${client}/observations/${observation}/correlation`;
const query = (extra = '') => `?connectionId=${M365_CONNECTION}&from=${encodeURIComponent(R.toISOString())}&to=${encodeURIComponent(end.toISOString())}${extra}`;
const get = async (base: string, url: string, token = both) => {
  const res = await fetch(`${base}${url}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json() as Record<string, unknown>, correlation: res.headers.get('x-atlas-correlation-id') };
};
const denials = async (actor: string) => (await pgdb.owner.query(`SELECT "eventType", "reasonCode", "requestedClientId" FROM "SecurityAuditEvent" WHERE "actorId" = $1`, [actor])).rows;

test('HTTP correlation: CorrelationContextV1 pages with the authenticated cursor; the read is audited under the response correlation ID', async () => {
  const first = await get(api.base, `${path()}${query('&limit=2')}`);
  assert.deepEqual([first.status, first.body.contractVersion, first.body.total, first.body.truncated, (first.body.items as unknown[]).length], [200, 'atlas.correlation.v1', 3, true, 2]);
  const second = await get(api.base, `${path()}${query(`&limit=2&cursor=${first.body.nextCursor}`)}`);
  assert.deepEqual([second.status, (second.body.items as { evidenceRef: { sourceId: string } }[]).map(i => i.evidenceRef.sourceId), second.body.nextCursor], [200, ['a-1'], null]);
  const audit = (await pgdb.owner.query(`SELECT "eventType" FROM "AuditEvent" WHERE "correlationId" = $1`, [second.correlation])).rows;
  assert.deepEqual(audit, [{ eventType: 'correlation.read' }]);
  const changed = await get(api.base, `${path()}${query(`&limit=3&cursor=${first.body.nextCursor}`)}`);
  assert.deepEqual([changed.status, changed.body.code], [409, 'CORRELATION_CHANGED']);
  const original = String(first.body.nextCursor); // flip the last MAC character deterministically (never a no-op)
  const tampered = await get(api.base, `${path()}${query(`&limit=2&cursor=${original.slice(0, -1)}${original.endsWith('A') ? 'B' : 'A'}`)}`);
  assert.deepEqual([tampered.status, tampered.body.code], [400, 'CORRELATION_CURSOR_INVALID']);
});

test('HTTP correlation: unknown, repeated, nested, tenant-override and path-override keys, bad limits and malformed times are 400 before any data', async () => {
  for (const extra of ['&tenantId=x', '&clientId=demo-other', '&from=2026-10-01T00:00:00Z', '&limit=0', '&limit=101', '&limit=abc', '&observationId=obs-api',
    '&connectionId[x]=1', '&unexpected=1', '&cursor=']) {
    assert.equal((await get(api.base, `${path()}${query(extra)}`)).status, 400, extra);
  }
  assert.equal((await get(api.base, `${path()}?connectionId=${M365_CONNECTION}&from=2026-02-30T00:00:00Z&to=${encodeURIComponent(end.toISOString())}`)).status, 400);
  assert.equal((await get(api.base, `${path('demo-gasta', 'no-such-observation')}${query()}`)).status, 400, 'safe not-found');
});

test('HTTP correlation authority: single permission → 403 with one workspace denial; malformed client → 403 INVALID_SCOPE_ID; another client → 403', async () => {
  assert.equal((await get(api.base, `${path()}${query()}`, single)).status, 403);
  assert.deepEqual(await denials('demo-api-single'), [{ eventType: 'correlation.read_denied', reasonCode: 'PERMISSION_DENIED', requestedClientId: 'demo-gasta' }]);
  assert.equal((await get(api.base, `${path('bad%20client')}${query()}`)).status, 403);
  assert.equal((await get(api.base, `${path('demo-other')}${query()}`)).status, 403);
  assert.deepEqual((await denials('demo-api-both')).map(d => [d.eventType, d.reasonCode]).sort(),
    [['correlation.read_denied', 'INVALID_SCOPE_ID'], ['correlation.read_denied', 'SCOPE_DENIED']]);
});

test('the same maximal input (128-character IDs, 512-character cursor) reaches the MAC check over HTTP and tools; 513 characters is refused', async () => {
  const long = (c: string) => `${c}${'x'.repeat(127)}`; const cursor = `${'A'.repeat(468)}.${'B'.repeat(43)}`;
  const max = await get(api.base, `${path('demo-gasta', long('o'))}?connectionId=${long('c')}&from=2026-10-01T00:00:00.0000001Z&to=2026-10-01T23:59:59.9999999Z&limit=100&cursor=${cursor}`);
  assert.deepEqual([max.status, max.body.code], [400, 'CORRELATION_CURSOR_INVALID']);
  const over = await get(api.base, `${path()}${query(`&cursor=A${cursor}`)}`);
  assert.deepEqual([over.status, over.body.code], [400, 'CORRELATION_CURSOR_INVALID']);
  const parameters = { connectionId: long('c'), observationId: long('o'), from: '2026-10-01T00:00:00.0000001Z', to: '2026-10-01T23:59:59.9999999Z', limit: 100, cursor };
  const tool = await fetch(`${api.base}/tools/execute`, { method: 'POST', headers: { authorization: `Bearer ${both}`, 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: 'demo-gasta', tool: 'atlas.observation.get_correlation', parameters }) });
  assert.equal(tool.status, 400);
  const ledger = (await pgdb.owner.query(`SELECT status, "safeErrorCode" FROM "ToolExecution" WHERE "actorId" = 'demo-api-both'`)).rows;
  assert.deepEqual(ledger, [{ status: 'FAILED', safeErrorCode: 'CORRELATION_CURSOR_INVALID' }]);
});

test('GET /tools: the composed registry filtered all-of; Stage 1 entries keep the singular permission; execution uses the same registry', async () => {
  const listed = async (token: string) => (await (await fetch(`${api.base}/tools`, { headers: { authorization: `Bearer ${token}` } })).json()) as Record<string, unknown>[];
  const full = await listed(both);
  assert.deepEqual(full.filter(t => String(t.name).includes('signin') || String(t.name).includes('correlation')).map(t => [t.name, t.permissions, 'permission' in t]),
    [['atlas.observation.get_correlation', ['context:read', 'm365:read'], false], ['microsoft365.signin.list', ['context:read', 'm365:read'], false]]);
  assert.ok(full.filter(t => !String(t.name).includes('signin') && !String(t.name).includes('correlation')).every(t => t.permission === 'context:read' && !('permissions' in t)));
  assert.ok(!(await listed(single)).some(t => String(t.name).includes('correlation')), 'not advertised without both permissions on one client');
  const run = await fetch(`${api.base}/tools/execute`, { method: 'POST', headers: { authorization: `Bearer ${both}`, 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: 'demo-gasta', tool: 'microsoft365.signin.list', parameters: { connectionId: M365_CONNECTION, from: R.toISOString(), to: end.toISOString() } }) });
  assert.deepEqual([run.status, ((await run.json()) as { total: number }).total], [201, 3], 'POST answers 201 as for every Stage 1 tool');
});

test('without the cursor configuration the API starts and Stage 1 reads work; M365 paged reads fail closed (500), also for a first page', async () => {
  assert.equal((await get(bare.base, '/clients/demo-gasta/overview')).status, 200);
  assert.equal((await get(bare.base, `${path()}${query()}`)).status, 500);
});

test('fixture API: public discovery unchanged for the demo actor (no m365:read); the correlation counterpart is denied all-of', async () => {
  const token = 'synthetic-demo-token-for-api-tests';
  const tools = await (await fetch(`${fixture.base}/tools`, { headers: { authorization: `Bearer ${token}` } })).json() as Record<string, unknown>[];
  assert.deepEqual(tools.map(t => t.name), ['atlas.client.get_context', 'atlas.observation.list', 'atera.alert.list', 'atera.ticket.list', 'atera.ticket.get',
    'huntress.incident.list', 'huntress.incident.get']);
  assert.ok(tools.every(t => t.permission === 'context:read' && !('permissions' in t)));
  assert.equal((await fetch(`${fixture.base}${path()}${query()}`, { headers: { authorization: `Bearer ${token}` } })).status, 403);
  const denied = await fetch(`${fixture.base}/tools/execute`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: 'demo-gasta', tool: 'microsoft365.signin.list', parameters: { connectionId: 'demo-m365-fixture', from: R.toISOString(), to: end.toISOString() } }) });
  assert.equal(denied.status, 403);
});
