import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { seedGraph } from '../sql-invariants.ts';
import type { SqlRunner } from '../sql-invariants.ts';
import { seedM365 } from '../m365-sql-invariants.ts';
import { checkM365Prerequisites } from '../m365-prerequisite-invariants.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { beginScoped, openSession } from '../support/pg-race.ts';

// Review S2-A-rc3 on PostgreSQL 17: lifecycle entry checks never defer to a later foreign key. The shared cases run as the
// owner on one database; on a second one the production runtime role (exact grants, client scope) sees the same refusals
// for a terminal or parentless entry and still performs ordered parent-first creation in one transaction.
const asRunner = (c: pg.Client): SqlRunner => ({ exec: sql => c.query(sql).then(() => undefined), query: async (sql, params) => (await c.query(sql, params)).rows as never });
const shared = await createTestDatabase();
const scoped = await createTestDatabase();
const runtime = await openSession(scoped.runtimeUrl);
after(async () => { await runtime.client.end().catch(() => undefined); await shared.drop(); await scoped.drop(); });

test('shared lifecycle-entry invariants on a real server (owner session; triggers apply to every role)', async () => {
  await seedGraph(asRunner(shared.owner));
  await checkM365Prerequisites(asRunner(shared.owner));
});

test('as the runtime role: a parentless or terminal entry is refused and rolled back; ordered creation in one transaction succeeds', async () => {
  await seedGraph(asRunner(scoped.owner));
  await seedM365(asRunner(scoped.owner));
  const state = `INSERT INTO "M365ResourceState" ("workspaceId","clientId","connectionId","resourceType","latestStartedSeq") VALUES ('w','c1','m1','m365_device',1) RETURNING 1`;
  const generation = (status: string) => `INSERT INTO "M365DirectoryGeneration" ("workspaceId","clientId","connectionId","resourceType","id","attemptSeq",
    "lifecycleVersion","state","claimToken","leaseExpiresAt","completedAt","expiresAt") VALUES ('w','c1','m1','m365_device','rt-gen',1,1,'${status}',
    ${status === 'STAGING' ? `gen_random_uuid(),now() + interval '10 minutes',NULL` : 'NULL,NULL,now()'},now() + interval '23 hours')`;
  const refused = async (sql: string, error: RegExp) => {
    await beginScoped(runtime);
    await assert.rejects(runtime.client.query(sql), error);
    await runtime.client.query('ROLLBACK');
  };
  await refused(`WITH s AS (${state}) ${generation('PUBLISHED')}`, /starts STAGING/);
  await refused(`WITH s AS (${state}) ${generation('STAGING')}`, /needs its resource state to exist first/);
  await refused(generation('STAGING'), /needs its resource state to exist first/);
  assert.equal(Number((await scoped.owner.query(`SELECT count(*)::int AS n FROM "M365ResourceState"`)).rows[0].n), 0, 'nothing survived a refusal');
  await beginScoped(runtime);
  await runtime.client.query(state);
  await runtime.client.query(generation('STAGING'));
  await runtime.client.query('COMMIT');
  assert.deepEqual((await scoped.owner.query(`SELECT state FROM "M365DirectoryGeneration" WHERE id = 'rt-gen'`)).rows, [{ state: 'STAGING' }]);
});
