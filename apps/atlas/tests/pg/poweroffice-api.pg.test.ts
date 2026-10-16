import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { createTestDatabase } from '../support/pg-harness.ts';
import { CA, WS, addPowerOfficeFixtures, tokens } from '../support/poweroffice-fixtures.ts';
import { addSyncConnection, addToken, sleep } from '../support/poweroffice-sync.ts';
import { ageConnection } from '../support/poweroffice-history.ts';
import { counts, failingSync, goodSync, readAudits } from '../support/poweroffice-read.ts';
import { startTrappedApi, trapControl, trapDir } from '../support/poweroffice-process.ts';

// S4-C C1/C2 through ACTUAL HTTP (compiled DB-mode API, real PostgreSQL 17, outbound network trap): route-specific private
// bearer dispatch for GET /clients/:clientId/poweroffice/:connectionId/status|summary — 401/403/404/400/500/503 fixed
// synthetic envelopes, every 04 precedence row with its HTTP status (UNAVAILABLE 503 with its DTO, others 200),
// Cache-Control: no-store everywhere, DISABLED by default; the legacy Gateway neither lists nor executes a PowerOffice tool
// and its accepted behavior is unchanged; no token/company key/amount in API output; zero outbound network attempts.
const pgdb = await createTestDatabase();
const prisma = new PrismaClient({ datasources: { db: { url: pgdb.runtimeUrl } } });
const owner = pgdb.owner;
await addPowerOfficeFixtures(owner);
const trap = trapDir();
const api = await startTrappedApi(trap, { ATLAS_RUNTIME_DATABASE_URL: pgdb.runtimeUrl, ATLAS_POWEROFFICE_MODE: 'MOCK' });
const disabled = await startTrappedApi(trap, { ATLAS_RUNTIME_DATABASE_URL: pgdb.runtimeUrl });
after(async () => { await api.stop(); await disabled.stop(); await prisma.$disconnect(); await pgdb.drop(); trap.close(); });
const key = (connectionId: string) => ({ workspaceId: WS, clientId: CA, connectionId });
const conns = {
  missing: await addSyncConnection(owner, key('ap-missing'), 3), fresh: await addSyncConnection(owner, key('ap-fresh'), 120),
  stale: await addSyncConnection(owner, key('ap-stale'), 3), failed: await addSyncConnection(owner, key('ap-failed'), 3),
  error: await addSyncConnection(owner, key('ap-error'), 3), expired: await addSyncConnection(owner, key('ap-expired'), 3),
  disabled: await addSyncConnection(owner, key('ap-disabled'), 3, { status: 'DISABLED', version: 2 }), changed: await addSyncConnection(owner, key('ap-changed'), 3),
};
for (const id of ['ap-fresh', 'ap-stale', 'ap-failed', 'ap-expired', 'ap-changed']) await goodSync(prisma, CA, id);
await failingSync(prisma, CA, 'ap-failed'); await failingSync(prisma, CA, 'ap-error');
await ageConnection(owner, conns.stale, '20 minutes'); await ageConnection(owner, conns.expired, '25 hours');
await owner.query(`UPDATE "Connection" SET "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = 'ap-changed'`);

interface Reply { status: number; cache: string | null; body: Record<string, unknown> }
async function get(path: string, bearer: string | null = tokens.reader!, base = api.base, headers: Record<string, string> = {}): Promise<Reply> {
  const res = await fetch(`${base}${path}`, { headers: { ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }), ...headers } });
  return { status: res.status, cache: res.headers.get('cache-control'), body: await res.json() as Record<string, unknown> };
}
const po = (id: string, what: 'status' | 'summary' = 'summary', client = CA) => `/clients/${encodeURIComponent(client)}/poweroffice/${encodeURIComponent(id)}/${what}`;
const envelope = (r: Reply, status: number, code: string) => {
  assert.deepEqual([r.status, r.cache, r.body], [status, 'no-store', { statusCode: status, code, synthetic: true }], code);
};

test('every 04 precedence row through HTTP: 200 with the strict DTO, UNAVAILABLE 503 with its DTO; Cache-Control no-store', async () => {
  const rows: [string, number, string, string | null, boolean][] = [
    ['ap-missing', 200, 'MISSING', null, false], ['ap-fresh', 200, 'FRESH', null, true], ['ap-stale', 200, 'STALE', 'POWEROFFICE_SNAPSHOT_STALE', true],
    ['ap-failed', 200, 'STALE', 'POWEROFFICE_SOURCE_FAILED', true], ['ap-error', 200, 'ERROR', 'POWEROFFICE_SOURCE_FAILED', false],
    ['ap-expired', 200, 'EXPIRED', 'POWEROFFICE_SNAPSHOT_EXPIRED', false], ['ap-disabled', 503, 'UNAVAILABLE', 'POWEROFFICE_CONNECTION_UNAVAILABLE', false],
    ['ap-changed', 503, 'UNAVAILABLE', 'POWEROFFICE_BINDING_CHANGED', false]];
  for (const [id, http, status, code, visible] of rows) {
    const s = await get(po(id)); const t = await get(po(id, 'status'));
    assert.deepEqual([s.status, s.cache, s.body.status, s.body.safeErrorCode, s.body.summary !== null, s.body.synthetic], [http, 'no-store', status, code, visible, true], id);
    assert.deepEqual([t.status, t.cache, t.body.status, t.body.safeErrorCode, 'summary' in t.body, t.body.synthetic], [http, 'no-store', status, code, false, true], id);
    assert.equal(Object.keys(s.body).length, 11);
  }
  const fresh = (await get(po('ap-fresh'))).body;
  assert.deepEqual(Object.keys(fresh.summary as object), ['totalCount', 'currencies']);
  assert.ok(!JSON.stringify(fresh).includes(conns.fresh.companyKey), 'no company key');
});

test('fixed synthetic envelopes: 401 missing/malformed/unknown/expired bearer, 403 scope/permission, 404, 400 query, 503 disabled', async () => {
  const before = await counts(owner);
  envelope(await get(po('ap-fresh'), null), 401, 'POWEROFFICE_AUTHENTICATION_FAILED');
  envelope(await get(po('ap-fresh'), null, api.base, { authorization: 'Basic abc' }), 401, 'POWEROFFICE_AUTHENTICATION_FAILED');
  envelope(await get(po('ap-fresh'), 'short'), 401, 'POWEROFFICE_AUTHENTICATION_FAILED');
  envelope(await get(po('ap-fresh'), 'atl_' + 'z'.repeat(40)), 401, 'POWEROFFICE_AUTHENTICATION_FAILED');
  const expiring = await addToken(owner, WS, 'reader', 300); await sleep(500);
  envelope(await get(po('ap-fresh'), expiring), 401, 'POWEROFFICE_AUTHENTICATION_FAILED');
  envelope(await get(po('ap-fresh'), tokens.disabled!), 401, 'POWEROFFICE_AUTHENTICATION_FAILED');
  assert.deepEqual(await counts(owner), before, 'authentication failures write nothing');
  envelope(await get(po('ap-fresh'), tokens.contextOnly!), 403, 'PERMISSION_DENIED');
  envelope(await get(po('ap-fresh', 'status', 'po-client-unknown')), 403, 'SCOPE_DENIED');
  envelope(await get(po('ap-fresh', 'summary', 'bad%20client')), 403, 'SCOPE_DENIED');
  envelope(await get(po('ap-fresh'), tokens.admin!), 403, 'SCOPE_DENIED');
  const afterDenials = await counts(owner);
  assert.deepEqual([afterDenials.denials - before.denials, afterDenials.audits, afterDenials.executions], [4, before.audits, before.executions]);
  for (const id of ['atera-a', 'po-b', 'ap-nope', 'po-x']) envelope(await get(po(id)), 404, 'POWEROFFICE_NOT_FOUND');
  envelope(await get(`${po('ap-fresh')}?raw=1`), 400, 'INVALID_ARGUMENTS');
  envelope(await get(`${po('ap-fresh')}?clientId=po-client-b`), 400, 'INVALID_ARGUMENTS');
  envelope(await get(po('ap-fresh'), tokens.reader!, disabled.base), 503, 'POWEROFFICE_DISABLED');
  envelope(await get(po('ap-fresh'), null, disabled.base), 401, 'POWEROFFICE_AUTHENTICATION_FAILED');
  assert.deepEqual((await counts(owner)).audits, before.audits, 'refusals never write a client audit');
});

test('an actual read-audit failure is HTTP 500 POWEROFFICE_AUDIT_FAILED with no financial payload', async () => {
  await owner.query(`CREATE FUNCTION public.s4c_test_api_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW."eventType" LIKE 'poweroffice.%.read' THEN RAISE EXCEPTION 'audit sink down' USING ERRCODE = '58000'; END IF; RETURN NEW; END $$;
    REVOKE ALL ON FUNCTION public.s4c_test_api_audit_fault() FROM PUBLIC;
    CREATE TRIGGER s4c_test_api_audit_fault BEFORE INSERT ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION public.s4c_test_api_audit_fault();`);
  try { envelope(await get(po('ap-fresh')), 500, 'POWEROFFICE_AUDIT_FAILED'); }
  finally { await owner.query(`DROP TRIGGER s4c_test_api_audit_fault ON "AuditEvent"; DROP FUNCTION public.s4c_test_api_audit_fault();`); }
});

test('readiness failure through HTTP: a lost workspace fence is 503 POWEROFFICE_RUNTIME_NOT_READY; the reviewed repair restores 200', async () => {
  const lost = Number((await owner.query(`SELECT version FROM "ActionAuthorityFence" WHERE "workspaceId" = $1`, [WS])).rows[0].version);
  await owner.query(`BEGIN; ALTER TABLE "ActionAuthorityFence" DISABLE TRIGGER "ActionAuthorityFence_guard";
    DELETE FROM "ActionAuthorityFence" WHERE "workspaceId" = '${WS}'; ALTER TABLE "ActionAuthorityFence" ENABLE ALWAYS TRIGGER "ActionAuthorityFence_guard"; COMMIT;`);
  try { envelope(await get(po('ap-fresh')), 503, 'POWEROFFICE_RUNTIME_NOT_READY'); envelope(await get(po('ap-fresh', 'status')), 503, 'POWEROFFICE_RUNTIME_NOT_READY'); }
  finally {
    await owner.query(`BEGIN; ALTER TABLE "ActionAuthorityFence" DISABLE TRIGGER "ActionAuthorityFence_guard";
      INSERT INTO "ActionAuthorityFence" ("workspaceId", version) VALUES ('${WS}', ${lost}); ALTER TABLE "ActionAuthorityFence" ENABLE ALWAYS TRIGGER "ActionAuthorityFence_guard"; COMMIT;`);
  }
  assert.equal((await get(po('ap-fresh'))).status, 200);
});

test('legacy Gateway exclusion: no PowerOffice tool listed or executable; the refusal equals any unknown tool; context unchanged', async () => {
  const all = await addToken(owner, WS, 'reader');
  const list = await fetch(`${api.base}/tools`, { headers: { authorization: `Bearer ${all}` } });
  assert.equal(list.status, 200);
  assert.ok(!JSON.stringify(await list.json()).toLowerCase().includes('poweroffice'), 'not advertised');
  const execute = async (tool: string) => {
    const res = await fetch(`${api.base}/tools/execute`, { method: 'POST', headers: { authorization: `Bearer ${all}`, 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: CA, tool, parameters: { connectionId: 'ap-fresh' } }) });
    return { status: res.status, body: await res.json() };
  };
  const reads = (await readAudits(owner)).length;
  const unknown = await execute('nonexistent.read');
  for (const tool of ['poweroffice.summary', 'poweroffice_summary', 'poweroffice.status', 'poweroffice']) {
    assert.deepEqual(await execute(tool), unknown, tool);
  }
  assert.equal((await readAudits(owner)).length, reads, 'the PowerOffice read service was never reached');
  const executions = Number((await owner.query(`SELECT count(*) FROM "ToolExecution" WHERE "toolName" ILIKE '%poweroffice%'`)).rows[0].count);
  assert.equal(executions, 0, 'no PowerOffice ledger row');
  const overview = await fetch(`${api.base}/clients/${CA}/overview`, { headers: { authorization: `Bearer ${tokens.reader}` } });
  assert.equal(overview.status, 200);
  const text = JSON.stringify(await overview.json());
  assert.ok(!/poweroffice|outstanding|currencies/i.test(text), 'ClientContextV1 carries no PowerOffice data');
});

test('privacy and network: API output holds no token/company key/amount; zero outbound attempts; the trap control records one', async () => {
  const output = api.captured.stdout + api.captured.stderr + disabled.captured.stdout + disabled.captured.stderr;
  for (const secret of [...Object.values(tokens), ...Object.values(conns).map(c => c.companyKey), pgdb.runtimeUrl, 'fixture://']) {
    assert.ok(!output.includes(secret), 'no credential, URL or binding in API logs');
  }
  assert.ok(!/\d+\.\d{2}/.test(output), 'no amount in API logs');
  assert.equal(trap.trapped(), '', 'no outbound network attempt by either API process');
  const ctl = trapDir();
  try {
    const control = await trapControl(ctl);
    assert.ok(control.includes('fetch') && control.includes('net.connect'), 'the preload records real attempts');
  } finally { ctl.close(); }
});
