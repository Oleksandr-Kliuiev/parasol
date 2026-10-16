import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { RUNTIME_ROLE_CHECK_SQL, assertConfinedRuntimeRole } from '../../packages/graph/runtime-role.ts';
import type { RuntimeRoleFacts } from '../../packages/graph/runtime-role.ts';
import { PRISMA_CLI, createTestDatabase, provisionRoles, runWithDatabase } from '../support/pg-harness.ts';
import { readRolesSql, readS3cRolesSql, renderRolesSql, renderStage3RolesSql } from '../support/roles-sql.ts';
import { CA, KEY_A, WS, addPowerOfficeFixtures, connect, inTx, scopeOf, stateOf } from '../support/poweroffice-fixtures.ts';
import type { PoKey } from '../support/poweroffice-fixtures.ts';
import { SUMMARY, ageConnection, claimAttempt, publishAttempt } from '../support/poweroffice-history.ts';

// S4-A RC1 F3 repair on PostgreSQL 17. The cleanup definer never reads secretRef (exact no-secretRef Connection grant); the
// full synthetic pair is instead a DB invariant: Connection_poweroffice_binding_check (validated) requires every PowerOffice
// row with a synthetic tenant to carry exactly fixture://poweroffice/<same UUID>. Mutation is refused atomically for every
// role; rows without the synthetic tenant shape stay unusable and are refused by cleanup; a missing/unvalidated invariant
// refuses cleanup, readiness and provisioning; an upgrade over an invalid pre-existing pair fails closed without rewriting it.
const pgdb = await createTestDatabase();
const clients: pg.Client[] = [];
after(async () => { for (const c of clients) await c.end().catch(() => undefined); await pgdb.drop(); });
await addPowerOfficeFixtures(pgdb.owner);
const owner = pgdb.owner;
const runtime = await connect(pgdb.runtimeUrl); clients.push(runtime);
const runner = await connect(pgdb.poRunnerUrl); clients.push(runner);
const facts = async () => (await runtime.query(RUNTIME_ROLE_CHECK_SQL)).rows[0] as RuntimeRoleFacts;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const code = (p: Promise<unknown>) => p.then(() => undefined, e => stateOf(e));
const insertConnection = (id: string, tenant: string, secret: unknown, system = 'poweroffice') => code(owner.query(`INSERT INTO "Connection"
  ("workspaceId", "clientId", id, system, "externalTenantId", "secretRef", status, "boundBy", "boundAt", "lifecycleVersion")
  VALUES ($1, $2, $3, $4, $5, $6, 'FIXTURE', 'operator', now(), 1)`, [WS, CA, id, system, tenant, secret]));
async function cleanup(key: PoKey) {
  await runner.query('BEGIN');
  try {
    await runner.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true), set_config('app.poweroffice_connection_id', $3, true),
      set_config('app.actor_id', 'maintainer', true)`, [key.workspaceId, key.clientId, key.connectionId]);
    const r = (await runner.query(`SELECT public.atlas_poweroffice_cleanup($1, $2, $3, $4::uuid) AS r`, [key.workspaceId, key.clientId, key.connectionId, randomUUID()])).rows[0].r;
    await runner.query('COMMIT'); return r as { outcome: string; deletedSnapshots: number };
  } catch (error) { await runner.query('ROLLBACK'); throw error; }
}
const effects = (key: PoKey) => inTx(runtime, scopeOf(key), async c => (await c.query(`SELECT "snapshotId"::text AS pointer,
  (SELECT count(*)::int FROM public."PowerOfficeSnapshot" WHERE "connectionId" = $1) AS snapshots,
  (SELECT count(*)::int FROM public."AuditEvent" WHERE "eventType" = 'poweroffice.cleanup' AND metadata->>'connectionId' = $1) AS audits
  FROM public."PowerOfficeState" WHERE "connectionId" = $1`, [key.connectionId])).rows[0]);
const connectionRow = async (id: string) => (await owner.query(`SELECT "externalTenantId", "secretRef", "lifecycleVersion" FROM "Connection" WHERE id = $1`, [id])).rows[0];
const restore = `ALTER TABLE "Connection" ADD CONSTRAINT "Connection_poweroffice_binding_check" CHECK (coalesce(system <> 'poweroffice'
  OR "externalTenantId" !~ '^synthetic-po-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  OR "secretRef" = ('fixture://poweroffice/' || substr("externalTenantId", 14)), false))`;

test('the paired binding CHECK: malformed, non-fixture, mismatched, upper-case or NULL secret references refused; other systems unchanged', async () => {
  const tenant = `synthetic-po-${uuid(41)}`;
  for (const [label, secret, expected] of [['other UUID', `fixture://poweroffice/${uuid(42)}`, '23514'], ['vault reference', `vault://poweroffice/${uuid(41)}`, '23514'],
    ['malformed', 'fixture://poweroffice/not-a-uuid', '23514'], ['upper-case UUID', `fixture://poweroffice/${uuid(41).toUpperCase().replace('4000', 'ABCD')}`, '23514'],
    ['suffix', `fixture://poweroffice/${uuid(41)}/x`, '23514'], ['NULL', null, '23502']] as const) {
    assert.equal(await insertConnection(`po-bad-${label.replace(/\W/g, '')}`, tenant, secret), expected, label);
  }
  assert.equal(await insertConnection('po-good-41', tenant, `fixture://poweroffice/${uuid(41)}`), undefined, 'the exact pair');
  assert.equal(await insertConnection('po-legacy', 'legacy-company-1', 'vault://legacy/key'), undefined, 'a non-synthetic PowerOffice tenant is not constrained (and stays unusable)');
  assert.equal(await insertConnection('atera-pairless', `synthetic-po-${uuid(43)}`, 'vault://atera', 'atera'), undefined, 'other systems are not constrained');
});

test('mutation between admission and cleanup is refused atomically for owner and runtime; cleanup then purges only the intact pair', async () => {
  const claim = await inTx(runtime, scopeOf(KEY_A), c => claimAttempt(c, KEY_A, 'syncer'));
  await inTx(runtime, scopeOf(KEY_A), c => publishAttempt(c, KEY_A, claim, SUMMARY));
  await ageConnection(owner, KEY_A, '2 days');
  const before = await connectionRow('po-a');
  const fence = async () => (await owner.query(`SELECT version FROM "ActionAuthorityFence" WHERE "workspaceId" = $1`, [WS])).rows[0].version;
  const epoch = await fence();
  assert.equal(await code(owner.query(`UPDATE "Connection" SET "secretRef" = $1 WHERE id = 'po-a'`, [`fixture://poweroffice/${uuid(2)}`])), '23514', 'owner');
  assert.equal(await code(inTx(runtime, scopeOf(KEY_A), c => c.query(`UPDATE public."Connection" SET "secretRef" = 'vault://x' WHERE id = 'po-a'`))), '23514', 'runtime');
  assert.deepEqual(await connectionRow('po-a'), before); assert.equal(await fence(), epoch, 'no partial fence move');
  assert.deepEqual(await cleanup(KEY_A).then(r => [r.outcome, r.deletedSnapshots]), ['COMPLETED', 1], 'valid pair: purged');
});

test('a PowerOffice row without the synthetic tenant shape is refused by cleanup with zero pointer/delete/audit effects', async () => {
  const key: PoKey = { workspaceId: WS, clientId: CA, connectionId: 'po-legacy' };
  const claim = await inTx(runtime, scopeOf(key), c => claimAttempt(c, key, 'syncer'));
  await inTx(runtime, scopeOf(key), c => publishAttempt(c, key, claim, SUMMARY));
  await ageConnection(owner, key, '2 days');
  const before = await effects(key);
  assert.equal(before.snapshots, 1);
  assert.equal(await code(cleanup(key)), 'PO010');
  assert.deepEqual(await effects(key), before);
});

test('cleanup, readiness and provisioning rely on the INSTALLED, VALIDATED and EXACT invariant (missing, NOT VALID, same-name CHECK (true))', async () => {
  const key: PoKey = { workspaceId: WS, clientId: CA, connectionId: 'po-a2' };
  const claim = await inTx(runtime, scopeOf(key), c => claimAttempt(c, key, 'syncer'));
  await inTx(runtime, scopeOf(key), c => publishAttempt(c, key, claim, SUMMARY));
  await ageConnection(owner, key, '2 days');
  const before = await effects(key);
  const reprovision = () => provisionRoles(owner, pgdb.roles, { runtimePassword: randomBytes(18).toString('hex'), runnerPassword: randomBytes(18).toString('hex') });
  await owner.query(`ALTER TABLE "Connection" DROP CONSTRAINT "Connection_poweroffice_binding_check"`);
  assert.equal(await code(cleanup(key)), 'PO010', 'dropped: cleanup refuses before any lock');
  assert.ok((await facts()).poTableViolations > 0);
  await assert.rejects(reprovision(), /paired-binding CHECK/); await owner.query('ROLLBACK');
  await owner.query(`${restore} NOT VALID`);
  assert.equal(await code(cleanup(key)), 'PO010', 'not validated: refused');
  assert.ok((await facts()).poTableViolations > 0);
  await owner.query(`ALTER TABLE "Connection" VALIDATE CONSTRAINT "Connection_poweroffice_binding_check"`);
  assertConfinedRuntimeRole(await facts());
  // Same name, validated, altered definition CHECK (true): an invalid reference can now be written — the actual runner must
  // still refuse (exact definition required before any lock), with zero pointer/delete/audit effects and no detail leaked.
  const valid = await connectionRow('po-a2');
  try {
    await owner.query(`ALTER TABLE "Connection" DROP CONSTRAINT "Connection_poweroffice_binding_check";
      ALTER TABLE "Connection" ADD CONSTRAINT "Connection_poweroffice_binding_check" CHECK (true)`);
    assert.equal((await owner.query(`SELECT convalidated FROM pg_constraint WHERE conname = 'Connection_poweroffice_binding_check'`)).rows[0].convalidated, true);
    assert.ok((await facts()).poTableViolations > 0, 'an altered definition under the same name fails readiness');
    await assert.rejects(reprovision(), /paired-binding CHECK is missing, not validated or altered/); await owner.query('ROLLBACK');
    await owner.query(`UPDATE "Connection" SET "secretRef" = $1 WHERE id = 'po-a2'`, [`fixture://poweroffice/${uuid(77)}`]);
    const failure = await cleanup(key).then(() => null, (e: { code?: string; message?: string; detail?: string; where?: string }) => e);
    assert.equal(failure?.code, 'PO010', 'altered CHECK + invalid reference: cleanup refuses');
    assert.equal(failure?.message, 'POWEROFFICE_CLEANUP_FAILED', 'fixed message only');
    assert.ok(!JSON.stringify({ detail: failure?.detail, hint: (failure as { hint?: string } | null)?.hint }).includes('fixture://'), 'no reference or definition leaked');
    assert.deepEqual(await effects(key), before, 'no pointer, delete or audit effect');
  } finally {
    await owner.query(`UPDATE "Connection" SET "secretRef" = $1 WHERE id = 'po-a2'`, [valid.secretRef]);
    await owner.query(`ALTER TABLE "Connection" DROP CONSTRAINT IF EXISTS "Connection_poweroffice_binding_check"; ${restore}`);
  }
  assert.equal((await connectionRow('po-a2')).secretRef, valid.secretRef);
  assertConfinedRuntimeRole(await facts());
  await reprovision();
  assert.deepEqual(await effects(key), before, 'nothing purged while the invariant was absent');
  assert.equal((await cleanup(key)).outcome, 'COMPLETED');
});

test('upgrade over an invalid pre-existing PowerOffice pair fails closed with nothing rewritten; after operator repair it deploys', async () => {
  const old = await createTestDatabase({ migrateThrough: '202610091100_stage3_action_requests' });
  try {
    await old.owner.query(renderStage3RolesSql(await readS3cRolesSql(), old.roles, { runtimePassword: randomBytes(18).toString('hex'), runnerPassword: randomBytes(18).toString('hex') }));
    await old.owner.query(`INSERT INTO "Workspace" (id, name) VALUES ('up-ws', 'W'); INSERT INTO "Client" ("workspaceId", id, name) VALUES ('up-ws', 'up-c', 'C')`);
    await old.owner.query(`INSERT INTO "Connection" ("workspaceId","clientId",id,system,"externalTenantId","secretRef",status) VALUES
      ('up-ws','up-c','po-bad','poweroffice',$1,$2,'FIXTURE'), ('up-ws','up-c','po-ok','poweroffice',$3,$4,'FIXTURE')`,
      [`synthetic-po-${uuid(51)}`, `fixture://poweroffice/${uuid(52)}`, `synthetic-po-${uuid(53)}`, `fixture://poweroffice/${uuid(53)}`]);
    const rows = async () => (await old.owner.query(`SELECT id, "externalTenantId", "secretRef", status, "lifecycleVersion" FROM "Connection" ORDER BY id`)).rows;
    const fences = async () => (await old.owner.query(`SELECT "workspaceId", version FROM "ActionAuthorityFence" ORDER BY 1`)).rows;
    const [beforeRows, beforeFences] = [await rows(), await fences()];
    assert.throws(() => runWithDatabase(old.ownerUrl, process.execPath, [PRISMA_CLI, 'migrate', 'deploy']), /migrate deploy/);
    assert.deepEqual(await rows(), beforeRows, 'no accepted row rewritten or deleted');
    assert.deepEqual(await fences(), beforeFences);
    assert.equal((await old.owner.query(`SELECT to_regclass('public."PowerOfficeState"') AS t`)).rows[0].t, null, 'nothing of the failed migration applied');
    assert.equal((await old.owner.query(`SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'Connection_poweroffice_binding_check'`)).rows[0].n, 0);
    // Operator repair (the binding itself is immutable; its reference is corrected), then the failed migration is resolved.
    await old.owner.query(`UPDATE "Connection" SET "secretRef" = $1 WHERE id = 'po-bad'`, [`fixture://poweroffice/${uuid(51)}`]);
    runWithDatabase(old.ownerUrl, process.execPath, [PRISMA_CLI, 'migrate', 'resolve', '--rolled-back', '202610091200_stage4_poweroffice_state']);
    runWithDatabase(old.ownerUrl, process.execPath, [PRISMA_CLI, 'migrate', 'deploy']);
    await old.owner.query(renderRolesSql(await readRolesSql(), old.roles, { runtimePassword: randomBytes(18).toString('hex'), runnerPassword: randomBytes(18).toString('hex') }));
    assert.equal((await old.owner.query(`SELECT convalidated FROM pg_constraint WHERE conname = 'Connection_poweroffice_binding_check'`)).rows[0].convalidated, true);
  } finally { await old.drop(); }
});
