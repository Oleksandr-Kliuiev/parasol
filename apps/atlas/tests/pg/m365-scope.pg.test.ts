import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import type { Actor } from '../../packages/core/contracts.ts';
import { assertRuntimeRole, withScope } from '../../packages/graph/scoped-db.ts';
import { M365_TABLES } from '../../packages/graph/runtime-role.ts';
import { seedGraph } from '../sql-invariants.ts';
import type { SqlRunner } from '../sql-invariants.ts';
import { seedRetentionFixtures } from '../m365-cleanup-invariants.ts';
import { createTestDatabase, singleConnection } from '../support/pg-harness.ts';

// Stage 2 A1 on PostgreSQL 17 through Prisma and the confined login role: every M365 table denies a missing scope and
// another client of the same workspace; a pooled connection never inherits a scope; the runtime role is no owner/BYPASSRLS.
const pgdb = await createTestDatabase();
const runtime = new PrismaClient({ datasourceUrl: singleConnection(pgdb.runtimeUrl) });
const ownerPrisma = new PrismaClient({ datasourceUrl: pgdb.ownerUrl });
after(async () => { await runtime.$disconnect(); await ownerPrisma.$disconnect(); await pgdb.drop(); });
const asRunner = (c: pg.Client): SqlRunner => ({ exec: sql => c.query(sql).then(() => undefined), query: async (sql, params) => (await c.query(sql, params)).rows as never });
await seedGraph(asRunner(pgdb.owner));
await seedRetentionFixtures(asRunner(pgdb.owner)); // M365 rows in clients c1 (two tenants) and c2
const actor = (clientIds: string[]): Actor => ({ id: 'scope-probe', workspaceId: 'w', workspacePermissions: [], memberships: clientIds.map(clientId => ({ clientId, permissions: ['context:read'] })) });
const countAll = (tx: { $queryRawUnsafe<T>(sql: string): Promise<T> }) =>
  tx.$queryRawUnsafe<Record<string, number>[]>(`SELECT ${M365_TABLES.map(t => `(SELECT count(*)::int FROM "${t}") AS "${t}"`).join(', ')}`).then(r => r[0]!);

test('the runtime role is confined (no owner, no BYPASSRLS, Stage 2 grants and routine owner in place); the owner is refused', async () => {
  await assertRuntimeRole(runtime);
  await assert.rejects(assertRuntimeRole(ownerPrisma), /RUNTIME_ROLE_BYPASSES_RLS/);
});

test('every M365 table: no scope → nothing; one client → only its rows, even without a clientId filter; two clients → both', async () => {
  const unscoped = await countAll(runtime);
  assert.ok(Object.values(unscoped).every(n => n === 0), `no context denies every M365 table: ${JSON.stringify(unscoped)}`);
  const owner = await countAll(ownerPrisma);
  const perClient = async (clientId: string) => Object.fromEntries(await Promise.all(M365_TABLES.map(async t =>
    [t, Number((await pgdb.owner.query(`SELECT count(*)::int AS n FROM "${t}" WHERE "clientId" = $1`, [clientId])).rows[0].n)])));
  const [c1, c2] = [await perClient('c1'), await perClient('c2')];
  assert.ok(M365_TABLES.every(t => owner[t]! > 0 && c2[t]! > 0 && c1[t]! > c2[t]!), 'fixtures populate every table in both clients');
  assert.deepEqual(await withScope(runtime, actor(['c1']), [ 'c1' ], tx => countAll(tx)), c1);
  assert.deepEqual(await withScope(runtime, actor(['c2']), ['c2'], tx => countAll(tx)), c2);
  assert.deepEqual(await withScope(runtime, actor(['c1', 'c2']), ['c1', 'c2'], tx => countAll(tx)), owner);
  // Generated Prisma models follow the same policies; an explicit filter on another client yields nothing
  const seen = await withScope(runtime, actor(['c2']), ['c2'], async tx => ({
    evidence: await tx.m365SignInEvidence.findMany({ select: { clientId: true } }),
    foreign: await tx.m365DirectoryObject.count({ where: { clientId: 'c1' } }),
    states: await tx.m365ResourceState.findMany({ select: { clientId: true, connectionId: true } }) }));
  assert.ok(seen.evidence.length > 0 && seen.evidence.every(e => e.clientId === 'c2'));
  assert.equal(seen.foreign, 0);
  assert.deepEqual(seen.states, [{ clientId: 'c2', connectionId: 'm2' }]);
  // The single pooled connection carries no scope into the next unscoped use
  assert.ok(Object.values(await countAll(runtime)).every(n => n === 0), 'scope ends with the transaction on the reused connection');
});

test('writes into another client are rejected by RLS, and the runtime role can neither delete nor rewrite M365 payload', async () => {
  await assert.rejects(withScope(runtime, actor(['c2']), ['c2'], tx => tx.m365SignInWindow.create({ data: { workspaceId: 'w', clientId: 'c1', connectionId: 'm1',
    id: 'win-foreign', rootFrom: new Date('2026-10-01T10:00:00Z'), rootTo: new Date('2026-10-01T11:00:00Z') }, select: { id: true } })), /row-level security|42501/);
  await assert.rejects(withScope(runtime, actor(['c1']), ['c1'], tx => tx.m365SignInEvidence.deleteMany({})), /permission denied|42501/);
  await assert.rejects(withScope(runtime, actor(['c1']), ['c1'], tx => tx.m365DirectoryObject.updateMany({ data: { dto: {} } })), /permission denied|42501/);
  await assert.rejects(withScope(runtime, actor(['c1']), ['c1'], tx => tx.m365WindowEvidence.updateMany({ data: { leafId: 'L9' } })), /permission denied|42501/);
  // Plain SQL on the login role: c2's scope sees no c1 row in any M365 table, whatever the filter
  const client = new pg.Client({ connectionString: pgdb.runtimeUrl }); await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.workspace_id', 'w', true), set_config('app.client_ids', 'c2', true)`);
    for (const t of M365_TABLES) assert.equal(Number((await client.query(`SELECT count(*)::int AS n FROM "${t}" WHERE "clientId" = 'c1'`)).rows[0].n), 0, t);
    await client.query('ROLLBACK');
  } finally { await client.end(); }
});
