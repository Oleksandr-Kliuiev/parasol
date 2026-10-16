import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PrismaClient } from '@prisma/client';
import { powerOfficeCredential } from '../../packages/poweroffice/authority.ts';
import { readPowerOfficeStatus, readPowerOfficeSummary } from '../../packages/poweroffice/read.ts';
import { runExportPass } from '../../packages/poweroffice/pass.ts';
import { publishFact } from '../../packages/poweroffice/publication.ts';
import { endClaim } from '../../packages/poweroffice/capabilities.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { CA, CB, WS, WX, addPowerOfficeFixtures, connect } from '../support/poweroffice-fixtures.ts';
import { addSyncConnection, addToken, codeOf, denials, observe, revokeToken, sleep, untilWaiting } from '../support/poweroffice-sync.ts';
import { MOCK, as, counts, goodSync, openClaim, readAudits, summaryOf } from '../support/poweroffice-read.ts';

// S4-C C1/C2 authority of the dedicated reads on PostgreSQL 17: all-of context:read + poweroffice:read on ONE current
// membership; a denial after authentication is exactly one workspace SecurityAuditEvent and nothing else; unauthenticated,
// inactive, revoked, expired and last-lock-expired callers get no audit and no data; a failed read audit returns no
// payload; a read concurrent with publication returns the coherent old or new snapshot and changes no domain row.
const pgdb = await createTestDatabase();
const prisma = new PrismaClient({ datasources: { db: { url: pgdb.runtimeUrl } } });
const runtimeSql = await connect(pgdb.runtimeUrl);
const sessions: pg.Client[] = [];
after(async () => { for (const c of [runtimeSql, ...sessions]) await c.end().catch(() => undefined); await prisma.$disconnect(); await pgdb.drop(); });
const owner = pgdb.owner;
await addPowerOfficeFixtures(owner);
const key = (connectionId: string, clientId = CA) => ({ workspaceId: WS, clientId, connectionId });
const c1 = await addSyncConnection(owner, key('ra-a'), 12);
const cb = await addSyncConnection(owner, key('ra-b', CB), 2);
await goodSync(prisma, CA, c1.connectionId);
async function session(url: string): Promise<pg.Client> { const c = await connect(url); sessions.push(c); return c; }

test('all-of on ONE membership: split, context-only, admin, foreign, unknown and malformed clients are one workspace denial each', async () => {
  assert.equal((await summaryOf(prisma, 'ra-a', CA, 'syncer')).status, 'FRESH', 'read rights are part of the sync set');
  assert.equal((await summaryOf(prisma, 'ra-b', CB)).status, 'MISSING');
  const cases: [string, string, string, string][] = [
    ['contextOnly', CA, 'ra-a', 'PERMISSION_DENIED'], ['poOnly', CA, 'ra-a', 'PERMISSION_DENIED'], ['split', CA, 'ra-a', 'PERMISSION_DENIED'],
    ['split', CB, 'ra-b', 'PERMISSION_DENIED'], ['admin', CA, 'ra-a', 'SCOPE_DENIED'], ['syncer', CB, 'ra-b', 'SCOPE_DENIED'],
    ['reader', 'po-client-unknown', 'ra-a', 'SCOPE_DENIED'], ['reader', 'bad client', 'ra-a', 'SCOPE_DENIED'], ['outsider', CA, 'ra-a', 'SCOPE_DENIED'],
  ];
  for (const [actor, client, connection, code] of cases) {
    for (const read of [readPowerOfficeSummary, readPowerOfficeStatus]) {
      const before = await counts(owner); const denied = (await denials(owner)).length;
      assert.equal(await codeOf(read(prisma, MOCK, as(actor), client, connection)), code, `${actor} → ${client}`);
      const after1 = await counts(owner); const rows = await denials(owner);
      assert.deepEqual([after1.audits, after1.states, after1.executions], [before.audits, before.states, before.executions], 'no client audit, State or ledger');
      assert.equal(rows.length, denied + 1, 'exactly one workspace denial');
      const last = rows.at(-1);
      assert.deepEqual([last.actorId, last.eventType, last.requestedClientId, last.reasonCode, last.metadata], [actor, 'poweroffice.read.denied', client, code, {}]);
    }
  }
  const outsider = (await owner.query(`SELECT "workspaceId" FROM "SecurityAuditEvent" WHERE "actorId" = 'outsider'`)).rows;
  assert.ok(outsider.length > 0 && outsider.every(r => r.workspaceId === WX), 'a foreign caller is denied in its own workspace');
});

test('unauthenticated, inactive, revoked or expired bearers: POWEROFFICE_AUTHENTICATION_FAILED with no audit of any kind', async () => {
  const revoked = await addToken(owner, WS, 'reader'); await revokeToken(owner, revoked);
  const expired = await addToken(owner, WS, 'reader', 200);
  await sleep(400); // a real DB-clock expiry (the expiry CHECK forbids an already-past expiresAt)
  const unknown = 'atl_' + 'x'.repeat(40);
  const before = await counts(owner);
  for (const bearer of [revoked, expired, unknown]) {
    assert.equal(await codeOf(readPowerOfficeSummary(prisma, MOCK, powerOfficeCredential(bearer), CA, 'ra-a')), 'POWEROFFICE_AUTHENTICATION_FAILED');
  }
  assert.equal(await codeOf(summaryOf(prisma, 'ra-a', CA, 'disabled')), 'POWEROFFICE_AUTHENTICATION_FAILED');
  for (const malformed of ['', 'short', 'x'.repeat(300), undefined, 42]) assert.throws(() => powerOfficeCredential(malformed), { code: 'POWEROFFICE_AUTHENTICATION_FAILED' });
  assert.equal(await codeOf(readPowerOfficeSummary(prisma, MOCK, { kind: 'PowerOfficeCredential' } as never, CA, 'ra-a')), 'POWEROFFICE_AUTHENTICATION_FAILED',
    'a forged credential object is unknown');
  assert.deepEqual(await counts(owner), before);
});

test('token expiring while the read waits for the State lock: refused after the last lock, no audit, no data', async () => {
  const bearer = await addToken(owner, WS, 'reader', 1500);
  const holder = await session(pgdb.runtimeUrl);
  await holder.query('BEGIN');
  await holder.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true)`, [WS, CA]);
  await holder.query(`SELECT 1 FROM public."PowerOfficeState" WHERE "connectionId" = 'ra-a' FOR UPDATE`);
  const before = await counts(owner);
  const read = codeOf(readPowerOfficeSummary(prisma, MOCK, powerOfficeCredential(bearer), CA, 'ra-a'));
  try {
    await untilWaiting(owner, 'PowerOfficeState');
    await sleep(2000);
  } finally { await holder.query('ROLLBACK'); }
  assert.equal(await read, 'POWEROFFICE_AUTHENTICATION_FAILED');
  assert.deepEqual(await counts(owner), before, 'neither a client audit nor a denial');
});

test('a failed read audit (actual DB failure) returns no payload and changes nothing; the denial audit failure likewise', async () => {
  const domain = await observe(runtimeSql, c1);
  const before = await counts(owner);
  await owner.query(`CREATE FUNCTION public.s4c_test_read_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW."eventType" LIKE 'poweroffice.%.read' THEN RAISE EXCEPTION 'audit sink down' USING ERRCODE = '58000'; END IF; RETURN NEW; END $$;
    REVOKE ALL ON FUNCTION public.s4c_test_read_audit_fault() FROM PUBLIC;
    CREATE TRIGGER s4c_test_read_audit_fault BEFORE INSERT ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION public.s4c_test_read_audit_fault();
    CREATE FUNCTION public.s4c_test_denial_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'denial sink down' USING ERRCODE = '58000'; END $$;
    REVOKE ALL ON FUNCTION public.s4c_test_denial_fault() FROM PUBLIC;
    CREATE TRIGGER s4c_test_denial_fault BEFORE INSERT ON "SecurityAuditEvent" FOR EACH ROW EXECUTE FUNCTION public.s4c_test_denial_fault();`);
  try {
    let leaked: unknown = null;
    await readPowerOfficeSummary(prisma, MOCK, as('reader'), CA, 'ra-a').then(dto => { leaked = dto; }, () => undefined);
    assert.equal(leaked, null, 'no DTO escapes a failed audit');
    assert.equal(await codeOf(readPowerOfficeSummary(prisma, MOCK, as('reader'), CA, 'ra-a')), 'POWEROFFICE_AUDIT_FAILED');
    assert.equal(await codeOf(readPowerOfficeStatus(prisma, MOCK, as('reader'), CA, 'ra-a')), 'POWEROFFICE_AUDIT_FAILED');
    assert.equal(await codeOf(summaryOf(prisma, 'ra-a', CA, 'contextOnly')), 'POWEROFFICE_AUDIT_FAILED');
  } finally {
    await owner.query(`DROP TRIGGER s4c_test_read_audit_fault ON "AuditEvent"; DROP FUNCTION public.s4c_test_read_audit_fault();
      DROP TRIGGER s4c_test_denial_fault ON "SecurityAuditEvent"; DROP FUNCTION public.s4c_test_denial_fault();`);
  }
  assert.deepEqual(await counts(owner), before);
  assert.deepEqual(await observe(runtimeSql, c1), domain);
});

test('reads concurrent with publication see the coherent old or new snapshot; an in-flight read holds publication back', async () => {
  const old = await summaryOf(prisma, 'ra-a', CA);
  const claim = await openClaim(prisma, CA, 'ra-a');
  const pass = await runExportPass(prisma, claim.claim);
  assert.equal(pass.complete, true);
  // An in-flight read (fence SHARE + State SHARE, as the service holds them) makes publication wait.
  const reader = await session(pgdb.runtimeUrl);
  await reader.query('BEGIN');
  await reader.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true)`, [WS, CA]);
  await reader.query(`SELECT version FROM public."ActionAuthorityFence" WHERE "workspaceId" = $1 FOR SHARE`, [WS]);
  await reader.query(`SELECT 1 FROM public."PowerOfficeState" WHERE "connectionId" = 'ra-a' FOR SHARE`);
  const publication = publishFact(prisma, claim.claim, pass.complete ? pass.summary : null);
  let published = false; void publication.then(() => { published = true; }, () => undefined);
  await untilWaiting(owner, 'ActionAuthorityFence');
  const during = Array.from({ length: 6 }, () => summaryOf(prisma, 'ra-a', CA));
  await sleep(300);
  assert.equal(published, false, 'publication waits behind the read locks');
  await reader.query('COMMIT');
  const receipt = await publication;
  endClaim(claim.claim);
  const fresh = await summaryOf(prisma, 'ra-a', CA);
  assert.notEqual(fresh.asOf, old.asOf);
  for (const r of await Promise.all(during)) {
    if (r.asOf === old.asOf) assert.deepEqual([r.summary, r.lastAttemptState, r.lastCompletedState], [old.summary, 'ACTIVE', 'SUCCEEDED'], 'old, coherent');
    else assert.deepEqual(r, fresh, 'new, coherent');
  }
  assert.equal((await observe(runtimeSql, c1)).state.pointer, receipt.snapshotId);
  assert.ok(cb.connectionId);
  assert.ok((await readAudits(owner, 'ra-a')).length >= 8);
});
