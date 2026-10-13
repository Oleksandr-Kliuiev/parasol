import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { generateToken, hashToken } from '../../packages/auth/token.ts';
import { powerOfficeCredential, withPowerOfficeAuthority } from '../../packages/poweroffice/authority.ts';
import type { PowerOfficeAuthority, PowerOfficeCredential, PowerOfficeRequest } from '../../packages/poweroffice/authority.ts';
import { checkBinding } from '../../packages/poweroffice/binding.ts';
import { lockState } from '../../packages/poweroffice/locks.ts';
import { createTestDatabase, provisionRoles } from '../support/pg-harness.ts';
import { CA, CB, CX, KEY_A, WS, WX, addPowerOfficeFixtures, connect, inTx, scopeOf, tokens } from '../support/poweroffice-fixtures.ts';
import { claimAttempt } from '../support/poweroffice-history.ts';

// S4-A A4 on PostgreSQL 17: the private bearer authority. All-of permissions on ONE membership of the chosen client, no
// workspace-admin shortcut, no forged credential; exactly one workspace denial audit (never a client audit); the caller's
// token re-checked with the DB clock AFTER the last lock; readiness and audit failures fixed; zero callback calls/data on refusal.
const pgdb = await createTestDatabase();
const prisma = new PrismaClient({ datasources: { db: { url: pgdb.runtimeUrl } } });
const runtime = await connect(pgdb.runtimeUrl);
after(async () => { await runtime.end().catch(() => undefined); await prisma.$disconnect(); await pgdb.drop(); });
await addPowerOfficeFixtures(pgdb.owner);
const owner = pgdb.owner;
await inTx(runtime, scopeOf(KEY_A), c => claimAttempt(c, KEY_A, 'syncer'));

let calls = 0;
const steps = { lock: async (tx: Parameters<typeof lockState>[0], scope: { workspaceId: string; clientId: string; connectionId: string; operation: string }) => {
  calls++; return lockState(tx, scope, scope.operation === 'read' ? 'SHARE' : 'UPDATE'); },
  run: async (_tx: unknown, a: PowerOfficeAuthority, state: unknown) => {
    const b = checkBinding(a.connection, a.operation === 'read' ? 'read' : a.operation === 'sync' ? 'source' : 'closeout');
    return 'refused' in b ? b : { ok: { actor: a.actorId, client: a.clientId, now: a.now, state: state !== null, epoch: a.epoch } }; } };
const call = (who: string | PowerOfficeCredential, request: Partial<PowerOfficeRequest> = {}) =>
  withPowerOfficeAuthority(prisma, typeof who === 'string' ? powerOfficeCredential(tokens[who] ?? who) : who,
    { clientId: CA, connectionId: 'po-a', operation: 'read', ...request }, steps as never);
const denials = async () => (await owner.query(`SELECT "workspaceId" AS w, "actorId" AS a, "eventType" AS e, outcome, "requestedClientId" AS c, "reasonCode" AS r, metadata
  FROM "SecurityAuditEvent" WHERE "eventType" LIKE 'poweroffice.%' ORDER BY "recordedAt", id`)).rows;
const clientAudits = async () => Number((await owner.query(`SELECT count(*) AS n FROM "AuditEvent"`)).rows[0].n);
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code);

test('authorized: all-of permissions on one membership; DB clock after the locks; no audit written by the authority itself', async () => {
  const ok = await call('reader') as { actor: string; client: string; now: Date; state: boolean };
  assert.equal(ok.actor, 'reader'); assert.equal(ok.client, CA); assert.equal(ok.state, true);
  assert.ok(Math.abs(ok.now.getTime() - Date.now()) < 60_000);
  assert.equal(await code(call('syncer', { operation: 'sync' })), 'ok');
  assert.equal(await code(call('syncer', { operation: 'recover' })), 'ok');
  assert.equal(await code(call('maintainer', { operation: 'maintain' })), 'ok');
  assert.equal(await code(call('reader', { clientId: CB, connectionId: 'po-b' })), 'ok');
  assert.deepEqual(await denials(), []); assert.equal(await clientAudits(), 0);
});

test('refusals: context:read alone, missing context:read, split memberships, admin shortcut, wrong client/workspace, wrong operation — one workspace denial each', async () => {
  const cases: [string, Partial<PowerOfficeRequest>, string, string][] = [
    ['contextOnly', {}, 'PERMISSION_DENIED', CA], ['poOnly', {}, 'PERMISSION_DENIED', CA], ['split', {}, 'PERMISSION_DENIED', CA],
    ['split', { clientId: CB, connectionId: 'po-b' }, 'PERMISSION_DENIED', CB], ['admin', {}, 'SCOPE_DENIED', CA],
    ['reader', { clientId: CX, connectionId: 'po-x' }, 'SCOPE_DENIED', CX], ['reader', { clientId: 'a,b\u0000' }, 'SCOPE_DENIED', 'a,b\\u0000'],
    ['reader', { operation: 'sync' }, 'PERMISSION_DENIED', CA], ['syncer', { operation: 'maintain' }, 'PERMISSION_DENIED', CA],
    ['maintainer', { operation: 'recover' }, 'PERMISSION_DENIED', CA], ['outsider', {}, 'SCOPE_DENIED', CA],
  ];
  const before = calls;
  for (const [who, request, expected, requested] of cases) {
    const seen = (await denials()).length;
    assert.equal(await code(call(who, request)), expected, `${who} ${JSON.stringify(request)}`);
    const added = (await denials()).slice(seen);
    assert.equal(added.length, 1, `${who}: exactly one workspace denial`);
    assert.deepEqual(added[0], { w: who === 'outsider' ? WX : WS, a: who, e: `poweroffice.${request.operation ?? 'read'}.denied`, outcome: 'DENIED',
      c: requested, r: expected, metadata: {} });
  }
  assert.equal(calls, before, 'no lock callback (no data access) for any refusal'); assert.equal(await clientAudits(), 0, 'never a client audit');
});

test('authentication: unknown, revoked, malformed or inactive callers refuse without any audit', async () => {
  const seen = (await denials()).length;
  await owner.query(`INSERT INTO "ApiToken" ("workspaceId", id, "actorId", "tokenHash", "revokedAt") VALUES ($1, 'tok-revoked', 'reader', $2, now())`, [WS, hashToken('atl_revoked_' + 'r'.repeat(30))]);
  for (const who of [generateToken(), 'atl_revoked_' + 'r'.repeat(30), 'disabled']) assert.equal(await code(call(who)), 'POWEROFFICE_AUTHENTICATION_FAILED', who.slice(0, 12));
  assert.throws(() => powerOfficeCredential('Bearer x'), /POWEROFFICE_AUTHENTICATION_FAILED/);
  assert.equal((await denials()).length, seen);
});

test('a token that expires while the transaction waits for the State lock is refused after the last lock with zero effects', async () => {
  const bearer = generateToken();
  await owner.query(`INSERT INTO "ApiToken" ("workspaceId", id, "actorId", "tokenHash", "expiresAt") VALUES ($1, 'tok-expiring', 'syncer', $2,
    (clock_timestamp() AT TIME ZONE 'UTC') + interval '1500 milliseconds')`, [WS, hashToken(bearer)]);
  const credential = powerOfficeCredential(bearer);
  const holder = await connect(pgdb.runtimeUrl);
  try {
    await holder.query('BEGIN');
    await holder.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true)`, [WS, CA]);
    await holder.query(`SELECT 1 FROM public."PowerOfficeState" WHERE "connectionId" = 'po-a' FOR UPDATE`);
    const seen = (await denials()).length; let ran = false;
    const pending = withPowerOfficeAuthority(prisma, credential, { clientId: CA, connectionId: 'po-a', operation: 'sync' },
      { lock: tx => lockState(tx, KEY_A, 'UPDATE'), run: async () => { ran = true; return { ok: 'decided' }; } });
    await new Promise(resolve => setTimeout(resolve, 2500));
    await holder.query('COMMIT');
    assert.equal(await code(pending), 'POWEROFFICE_AUTHENTICATION_FAILED');
    assert.equal(ran, false); assert.equal((await denials()).length, seen, 'no audit for an expired caller');
  } finally { await holder.end(); }
});

test('readiness fails closed (POWEROFFICE_RUNTIME_NOT_READY): broad PowerOffice grant or missing fence lock privilege; provisioning restores', async () => {
  const reprovision = () => provisionRoles(owner, pgdb.roles, { runtimePassword: randomBytes(18).toString('hex'), runnerPassword: randomBytes(18).toString('hex') });
  for (const tamper of [`GRANT UPDATE ON "PowerOfficeSnapshot" TO "${pgdb.runtimeRole}"`, `REVOKE UPDATE ("workspaceId") ON "ActionAuthorityFence" FROM "${pgdb.runtimeRole}"`,
    `DROP POLICY "PowerOfficeState_maintenance" ON "PowerOfficeState"`,
    // RC1 F1/F3: an extra routine for a maintenance role, or a missing paired-binding invariant, refuses before any work.
    `CREATE OR REPLACE FUNCTION public.s4a_extra() RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS 'SELECT 42';
     REVOKE ALL ON FUNCTION public.s4a_extra() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.s4a_extra() TO "${pgdb.poRunnerRole}"`,
    `GRANT EXECUTE ON FUNCTION public.s4a_extra() TO "${pgdb.poDefinerRole}"`]) {
    await owner.query(tamper);
    const before = calls;
    assert.equal(await code(call('reader')), 'POWEROFFICE_RUNTIME_NOT_READY', tamper);
    assert.equal(calls, before);
    await reprovision();
  }
  assert.equal(await code(call('reader')), 'ok');
  await owner.query(`ALTER TABLE "Connection" DROP CONSTRAINT "Connection_poweroffice_binding_check"`);
  assert.equal(await code(call('reader')), 'POWEROFFICE_RUNTIME_NOT_READY', 'the binding invariant is required');
  await owner.query(`ALTER TABLE "Connection" ADD CONSTRAINT "Connection_poweroffice_binding_check" CHECK (coalesce(system <> 'poweroffice'
    OR "externalTenantId" !~ '^synthetic-po-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR "secretRef" = ('fixture://poweroffice/' || substr("externalTenantId", 14)), false))`);
  assert.equal(await code(call('reader')), 'ok');
});

test('fixed conflict codes with zero partial effects: denial-audit failure, a known rollback inside run, and a real deadlock behind the fence', async () => {
  await owner.query(`CREATE FUNCTION public.s4a_test_denial_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    RAISE EXCEPTION 'denial sink down' USING ERRCODE = '58000'; END $$; REVOKE ALL ON FUNCTION public.s4a_test_denial_fault() FROM PUBLIC;
    CREATE TRIGGER s4a_test_denial_fault BEFORE INSERT ON "SecurityAuditEvent" FOR EACH ROW EXECUTE FUNCTION public.s4a_test_denial_fault();`);
  const seen = (await denials()).length;
  try { assert.equal(await code(call('contextOnly')), 'POWEROFFICE_AUDIT_FAILED'); }
  finally { await owner.query(`DROP TRIGGER s4a_test_denial_fault ON "SecurityAuditEvent"; DROP FUNCTION public.s4a_test_denial_fault();`); }
  assert.equal((await denials()).length, seen);
  const stateBefore = (await owner.query(`SELECT "updatedAt" FROM "PowerOfficeState" WHERE "connectionId" = 'po-a'`)).rows[0].updatedAt;
  assert.equal(await code(withPowerOfficeAuthority(prisma, powerOfficeCredential(tokens.syncer!), { clientId: CA, connectionId: 'po-a', operation: 'sync' },
    { lock: tx => lockState(tx, KEY_A, 'UPDATE'), run: async tx => {
      await tx.$executeRaw`UPDATE public."PowerOfficeState" SET "updatedAt" = "updatedAt" + interval '1 second' WHERE "connectionId" = 'po-a'`;
      await tx.$executeRawUnsafe(`DO $$ BEGIN RAISE EXCEPTION 'serialization' USING ERRCODE = '40001'; END $$`);
      return { ok: 'never' }; } })), 'POWEROFFICE_DB_CONFLICT');
  assert.deepEqual((await owner.query(`SELECT "updatedAt" FROM "PowerOfficeState" WHERE "connectionId" = 'po-a'`)).rows[0].updatedAt, stateBefore, 'rolled back');
  // Real deadlock: the admission holds the fence and waits for State; the other session holds State and then asks for the fence.
  const other = await connect(pgdb.runtimeUrl);
  try {
    await other.query('BEGIN');
    await other.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true)`, [WS, CA]);
    await other.query(`SELECT 1 FROM public."PowerOfficeState" WHERE "connectionId" = 'po-a' FOR UPDATE`);
    let ran = false;
    const admission = withPowerOfficeAuthority(prisma, powerOfficeCredential(tokens.syncer!), { clientId: CA, connectionId: 'po-a', operation: 'sync' },
      { lock: tx => lockState(tx, KEY_A, 'UPDATE'), run: async () => { ran = true; return { ok: 'x' }; } });
    await new Promise(resolve => setTimeout(resolve, 400));
    const otherFence = other.query(`SELECT 1 FROM public."ActionAuthorityFence" WHERE "workspaceId" = $1 FOR UPDATE`, [WS]).then(() => 'locked', e => e.code);
    assert.equal(await code(admission), 'POWEROFFICE_DB_CONFLICT', 'the admission waited first and is the deadlock victim');
    assert.equal(await otherFence, 'locked'); assert.equal(ran, false);
    await other.query('ROLLBACK');
  } finally { await other.end(); }
  assert.equal(await code(call('syncer', { operation: 'sync' })), 'ok', 'no automatic retry; the next explicit call proceeds');
});

test('binding decided by the caller under authority: unknown/non-PowerOffice is NOT_FOUND, unbound or disabled-for-source is UNAVAILABLE', async () => {
  assert.equal(await code(call('reader', { connectionId: 'atera-a' })), 'POWEROFFICE_NOT_FOUND');
  assert.equal(await code(call('reader', { connectionId: 'missing' })), 'POWEROFFICE_NOT_FOUND');
  assert.equal(await code(call('reader', { connectionId: 'bad id!' })), 'POWEROFFICE_NOT_FOUND', 'malformed IDs never reach SQL');
  assert.equal(await code(call('reader', { connectionId: 'po-unbound' })), 'POWEROFFICE_CONNECTION_UNAVAILABLE');
  assert.equal(await code(call('syncer', { operation: 'sync', connectionId: 'po-disabled' })), 'POWEROFFICE_CONNECTION_UNAVAILABLE');
  assert.equal(await code(call('syncer', { operation: 'recover', connectionId: 'po-disabled' })), 'ok');
});
