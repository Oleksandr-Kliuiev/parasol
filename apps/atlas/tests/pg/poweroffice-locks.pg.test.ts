import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { initializeState, lockAttempt, lockState } from '../../packages/poweroffice/locks.ts';
import { setLocal } from '../../packages/auth/transaction-token.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { CA, CB, CX, KEY_A, KEY_A2, KEY_B, KEY_X, WS, WX, addPowerOfficeFixtures, connect, inTx, scopeOf, sqlState } from '../support/poweroffice-fixtures.ts';
import type { PoKey, TxScope } from '../support/poweroffice-fixtures.ts';
import { SUMMARY, claimAttempt, publishAttempt } from '../support/poweroffice-history.ts';

// S4-A on PostgreSQL 17: row-level isolation of the three tables (blank/foreign workspace or client; the cleanup definer
// confined to ONE connection of a client by its RESTRICTIVE policy) and every explicit lock of the approved matrix under the
// real confined grants — runtime fence SHARE/UPDATE, State SHARE/UPDATE, Attempt UPDATE; no Snapshot lock; the definer
// locks fence and State only, never Attempt/Snapshot/Connection. Lock conflicts use a short lock_timeout (55P03) as the probe.
const pgdb = await createTestDatabase();
const prisma = new PrismaClient({ datasources: { db: { url: pgdb.runtimeUrl } } });
const extra: pg.Client[] = [];
after(async () => { await prisma.$disconnect(); for (const c of extra) await c.end().catch(() => undefined); await pgdb.drop(); });
await addPowerOfficeFixtures(pgdb.owner);
const client = async (url = pgdb.runtimeUrl) => { const c = await connect(url); extra.push(c); return c; };
const runtime = await client();
for (const key of [KEY_A, KEY_A2, KEY_B, KEY_X]) {
  const claim = await inTx(runtime, scopeOf(key, key === KEY_X ? 'outsider' : 'syncer'), c => claimAttempt(c, key, key === KEY_X ? 'outsider' : 'syncer'));
  await inTx(runtime, scopeOf(key), c => publishAttempt(c, key, claim, SUMMARY));
}
const active = await inTx(runtime, scopeOf(KEY_A), c => claimAttempt(c, KEY_A, 'syncer'));
const counts = (c: pg.Client, scope: TxScope) => inTx(c, scope, async x => (await x.query(`SELECT
  (SELECT count(*)::int FROM public."PowerOfficeState") AS s, (SELECT count(*)::int FROM public."PowerOfficeAttempt") AS a,
  (SELECT count(*)::int FROM public."PowerOfficeSnapshot") AS n`)).rows[0]);
/** Statements as the PowerOffice cleanup definer (SET LOCAL ROLE from the superuser owner) inside one rolled-back transaction. */
async function asDefiner<T>(scope: TxScope, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const owner = pgdb.owner;
  await owner.query('BEGIN');
  try {
    await owner.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true), set_config('app.poweroffice_connection_id', $3, true)`,
      [scope.workspaceId, scope.clientIds, scope.connectionId ?? '']);
    await owner.query(`SET LOCAL ROLE "${pgdb.poDefinerRole}"`);
    return await fn(owner);
  } finally { await owner.query('ROLLBACK'); }
}

test('runtime RLS: blank or foreign workspace/client sees no PowerOffice row; a client scope sees only its rows', async () => {
  assert.deepEqual(await counts(runtime, { workspaceId: '', clientIds: '' }), { s: 0, a: 0, n: 0 });
  assert.deepEqual(await counts(runtime, { workspaceId: WS, clientIds: '' }), { s: 0, a: 0, n: 0 });
  assert.deepEqual(await counts(runtime, { workspaceId: WX, clientIds: CA }), { s: 0, a: 0, n: 0 }, 'client of another workspace');
  assert.deepEqual(await counts(runtime, { workspaceId: WS, clientIds: CX }), { s: 0, a: 0, n: 0 });
  assert.deepEqual(await counts(runtime, { workspaceId: WS, clientIds: CB }), { s: 1, a: 1, n: 1 });
  assert.deepEqual(await counts(runtime, { workspaceId: WS, clientIds: CA }), { s: 2, a: 3, n: 2 });
  assert.equal(await sqlState(inTx(runtime, { workspaceId: WS, clientIds: CB }, c => c.query(`INSERT INTO public."PowerOfficeState" ("workspaceId", "clientId", "connectionId")
    VALUES ($1, $2, 'po-unbound')`, [WS, CA]))), '42501', 'WITH CHECK refuses a row of another client');
});

test('definer RLS: the RESTRICTIVE three-ID policy confines it to the one admitted connection, even within the same client', async () => {
  const seen = (scope: TxScope) => asDefiner(scope, async c => (await c.query(`SELECT
    (SELECT array_agg(DISTINCT "connectionId" ORDER BY "connectionId") FROM public."PowerOfficeState") AS s,
    (SELECT array_agg(DISTINCT "connectionId" ORDER BY "connectionId") FROM public."PowerOfficeAttempt") AS a,
    (SELECT array_agg(DISTINCT "connectionId" ORDER BY "connectionId") FROM public."PowerOfficeSnapshot") AS n`)).rows[0]);
  assert.deepEqual(await seen({ workspaceId: WS, clientIds: CA, connectionId: 'po-a' }), { s: ['po-a'], a: ['po-a'], n: ['po-a'] }, 'X only, never Y of the same client');
  assert.deepEqual(await seen({ workspaceId: WS, clientIds: CA, connectionId: 'po-a2' }), { s: ['po-a2'], a: ['po-a2'], n: ['po-a2'] });
  for (const scope of [{ workspaceId: WS, clientIds: CA, connectionId: '' }, { workspaceId: WS, clientIds: CB, connectionId: 'po-a' },
    { workspaceId: WX, clientIds: CA, connectionId: 'po-a' }, { workspaceId: '', clientIds: '', connectionId: 'po-a' }]) {
    assert.deepEqual(await seen(scope), { s: null, a: null, n: null }, JSON.stringify(scope));
  }
  // Writes are confined the same way: nothing of po-a2 is reachable while admitted for po-a.
  assert.equal(await asDefiner({ workspaceId: WS, clientIds: CA, connectionId: 'po-a' }, async c =>
    (await c.query(`UPDATE public."PowerOfficeState" SET "updatedAt" = "updatedAt" WHERE "connectionId" = 'po-a2'`)).rowCount), 0);
});

test('runtime locks under its exact grants: fence SHARE/UPDATE, State SHARE/UPDATE, Attempt UPDATE; Snapshot cannot be locked', async () => {
  const s = scopeOf(KEY_A);
  for (const lock of [`SELECT 1 FROM public."ActionAuthorityFence" WHERE "workspaceId" = '${WS}' FOR SHARE`,
    `SELECT 1 FROM public."ActionAuthorityFence" WHERE "workspaceId" = '${WS}' FOR UPDATE`,
    `SELECT 1 FROM public."PowerOfficeState" WHERE "connectionId" = 'po-a' FOR SHARE`, `SELECT 1 FROM public."PowerOfficeState" WHERE "connectionId" = 'po-a' FOR UPDATE`,
    `SELECT 1 FROM public."PowerOfficeAttempt" WHERE id = '${active.id}' FOR UPDATE`]) {
    assert.equal(await sqlState(inTx(runtime, s, c => c.query(lock))), undefined, lock);
  }
  for (const mode of ['FOR UPDATE', 'FOR NO KEY UPDATE', 'FOR SHARE', 'FOR KEY SHARE']) {
    assert.equal(await sqlState(inTx(runtime, s, c => c.query(`SELECT 1 FROM public."PowerOfficeSnapshot" ${mode}`))), '42501', `Snapshot ${mode}`);
  }
  // The shared helpers (packages/poweroffice/locks.ts) through Prisma as the runtime role.
  const result = await prisma.$transaction(async tx => {
    await setLocal(tx, { 'app.workspace_id': WS, 'app.client_ids': CA });
    await tx.$queryRaw`SELECT 1 FROM public."ActionAuthorityFence" WHERE "workspaceId" = ${WS} FOR UPDATE`;
    await initializeState(tx, { workspaceId: WS, clientId: CA, connectionId: 'po-a' });
    const st = await lockState(tx, { workspaceId: WS, clientId: CA, connectionId: 'po-a' }, 'UPDATE');
    const missing = await lockState(tx, { workspaceId: WS, clientId: CA, connectionId: 'po-unbound' }, 'SHARE');
    return { st, missing, owned: await lockAttempt(tx, KEY_A, active.id), foreign: await lockAttempt(tx, KEY_A, 'not-a-uuid') };
  });
  assert.equal(result.st?.activeAttemptId, active.id); assert.equal(result.st?.nextSequence, 3);
  assert.equal(result.missing, null, 'a read lock never creates State'); assert.equal(result.owned, true); assert.equal(result.foreign, false);
});

test('definer locks: fence and State FOR UPDATE only; no Attempt/Snapshot/Connection row lock; no secret reference read', async () => {
  const scope = { workspaceId: WS, clientIds: CA, connectionId: 'po-a' };
  const probe = (sql: string) => sqlState(asDefiner(scope, c => c.query(sql)));
  assert.equal(await probe(`SELECT 1 FROM public."ActionAuthorityFence" WHERE "workspaceId" = '${WS}' FOR UPDATE`), undefined);
  assert.equal(await probe(`SELECT 1 FROM public."PowerOfficeState" FOR UPDATE`), undefined);
  assert.equal(await probe(`SELECT system, status, "lifecycleVersion" FROM public."Connection" WHERE id = 'po-a'`), undefined, 'plain scoped Connection read');
  for (const sql of [`SELECT 1 FROM public."PowerOfficeAttempt" FOR UPDATE`, `SELECT 1 FROM public."PowerOfficeSnapshot" FOR SHARE`,
    `SELECT id FROM public."Connection" FOR UPDATE`, `SELECT id FROM public."Connection" FOR KEY SHARE`, `SELECT "secretRef" FROM public."Connection"`,
    `SELECT 1 FROM public."ApiToken"`, `SELECT 1 FROM public."ClientMembership"`, `SELECT 1 FROM public."Actor"`,
    `UPDATE public."PowerOfficeState" SET "lastSuccessAt" = NULL`, `UPDATE public."PowerOfficeAttempt" SET state = 'FAILED'`,
    `UPDATE public."ActionAuthorityFence" SET version = version + 1`, `TRUNCATE public."PowerOfficeSnapshot"`]) {
    assert.equal(await probe(sql), '42501', sql);
  }
});

test('lock conflicts: read SHARE fences coexist but exclude auth/Connection mutation and PowerOffice writes; State SHARE excludes State UPDATE', async () => {
  const reader = await client(); const other = await client(); const owner2 = await client(pgdb.ownerUrl);
  const begin = async (c: pg.Client, key: PoKey) => { await c.query('BEGIN'); await c.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true)`,
    [key.workspaceId, key.clientId]); await c.query(`SET LOCAL lock_timeout = '300ms'`); };
  await begin(reader, KEY_A);
  await reader.query(`SELECT 1 FROM public."ActionAuthorityFence" WHERE "workspaceId" = $1 FOR SHARE`, [WS]);
  await reader.query(`SELECT 1 FROM public."PowerOfficeState" WHERE "connectionId" = 'po-a' FOR SHARE`);
  const attempt = async (c: pg.Client, sql: string, key = KEY_A) => { await begin(c, key); try { await c.query(sql); return undefined; }
    catch (e) { return (e as { code?: string }).code; } finally { await c.query('ROLLBACK'); } };
  assert.equal(await attempt(other, `SELECT 1 FROM public."ActionAuthorityFence" WHERE "workspaceId" = '${WS}' FOR SHARE`), undefined, 'readers coexist');
  assert.equal(await attempt(other, `SELECT 1 FROM public."PowerOfficeState" WHERE "connectionId" = 'po-a' FOR SHARE`), undefined);
  assert.equal(await attempt(other, `SELECT 1 FROM public."ActionAuthorityFence" WHERE "workspaceId" = '${WS}' FOR UPDATE`), '55P03', 'a PowerOffice write waits');
  assert.equal(await attempt(other, `SELECT 1 FROM public."PowerOfficeState" WHERE "connectionId" = 'po-a' FOR UPDATE`), '55P03');
  assert.equal(await attempt(owner2, `UPDATE public."Connection" SET "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = 'po-a2'`), '55P03',
    'a binding mutation waits for the read fence (fence trigger)');
  assert.equal(await attempt(owner2, `UPDATE public."ApiToken" SET "revokedAt" = now() WHERE id = 'tok-reader'`), '55P03', 'so does revocation');
  assert.equal(await attempt(other, `SELECT 1 FROM public."ActionAuthorityFence" WHERE "workspaceId" = '${WX}' FOR UPDATE`, KEY_X), undefined, 'another workspace is independent');
  await reader.query('COMMIT');
  assert.equal(await attempt(owner2, `UPDATE public."Connection" SET "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = 'po-a2'`), undefined, 'and proceeds afterwards');
});
