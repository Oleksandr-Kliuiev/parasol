import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { RUNTIME_ROLE_CHECK_SQL, assertConfinedRuntimeRole } from '../../packages/graph/runtime-role.ts';
import type { RuntimeRoleFacts } from '../../packages/graph/runtime-role.ts';
import { createTestDatabase, provisionRoles } from '../support/pg-harness.ts';
import { addPowerOfficeFixtures, connect, stateOf } from '../support/poweroffice-fixtures.ts';
import { factsInEnvelope, inRollbackEnvelope, provisionInEnvelope, provisioningBody, runtimeFactsInEnvelope } from '../support/poweroffice-envelope.ts';

// S4-A RC3 R1 on PostgreSQL 17: the MAINTAIN table privilege (VACUUM/ANALYZE/REINDEX/REFRESH/CLUSTER and LOCK TABLE) is
// part of every effective table-privilege check — both PowerOffice maintenance roles over user and built-in relations, the
// provisioning postcondition, and the runtime's exact grants on all three PowerOffice tables. Explicit grants are revoked
// by provisioning; PUBLIC grants are refused atomically (uncommitted, inside the rollback envelope). Positive controls show
// MAINTAIN alone really allows an ACCESS EXCLUSIVE lock on a harmless synthetic table.
const pgdb = await createTestDatabase();
const clients: pg.Client[] = [];
after(async () => { for (const c of clients) await c.end().catch(() => undefined); await pgdb.drop(); });
await addPowerOfficeFixtures(pgdb.owner);
const { owner, roles } = pgdb;
const runtime = await connect(pgdb.runtimeUrl); clients.push(runtime);
const runner = await connect(pgdb.poRunnerUrl); clients.push(runner);
const observer = await connect(pgdb.ownerUrl); clients.push(observer);
const facts = async () => (await runtime.query(RUNTIME_ROLE_CHECK_SQL)).rows[0] as RuntimeRoleFacts;
const healthy = async () => assertConfinedRuntimeRole(await facts());
const reprovision = () => provisionRoles(owner, roles, { runtimePassword: randomBytes(18).toString('hex'), runnerPassword: randomBytes(18).toString('hex') });
const body = await provisioningBody(roles);
const PO = ['PowerOfficeState', 'PowerOfficeAttempt', 'PowerOfficeSnapshot'];
await owner.query(`CREATE TABLE public.s4a_maint_target (x integer)`);
/** ACCESS EXCLUSIVE lock attempt in the client's own rolled-back transaction: 'locked' or the SQLSTATE. */
const lock = async (c: pg.Client, table: string, role?: string) => {
  await c.query('BEGIN');
  try {
    if (role) await c.query(`SET LOCAL ROLE "${role}"`);
    await c.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE NOWAIT`);
    return 'locked';
  } catch (e) { return stateOf(e) ?? 'ERR'; } finally { await c.query('ROLLBACK'); }
};
const relacl = async (c: pg.Client) => (await c.query(`SELECT relname, relacl::text FROM pg_class WHERE relname = ANY($1) ORDER BY 1`,
  [[...PO, 's4a_maint_target']])).rows;

test('explicit MAINTAIN on an unrelated synthetic table: a real ACCESS EXCLUSIVE capability for each maintenance role, flagged, revoked', async () => {
  await healthy();
  for (const [who, role] of [['runner', roles.poRunner], ['definer', roles.poDefiner]] as const) {
    const control = () => who === 'runner' ? lock(runner, 'public.s4a_maint_target') : lock(owner, 'public.s4a_maint_target', role);
    assert.equal(await control(), '42501', `${who}: no lock before`);
    await owner.query(`GRANT MAINTAIN ON public.s4a_maint_target TO "${role}"`);
    assert.equal(await control(), 'locked', `${who}: MAINTAIN alone allows ACCESS EXCLUSIVE (positive control)`);
    const f = await facts();
    assert.equal(f.poExecuteViolations > 0, who === 'runner', `${who}: runner counter`);
    assert.equal(f.poOwnerViolations > 0, who === 'definer', `${who}: definer counter`);
    assert.throws(() => assertConfinedRuntimeRole(f), /RUNTIME_ROLE_NOT_CONFINED/);
    await reprovision(); await healthy();
    assert.equal(await control(), '42501', `${who}: revoked by provisioning`);
  }
});

test('explicit MAINTAIN to the runtime on each of State/Attempt/Snapshot fails the full runtime assertion and is revoked', async () => {
  for (const table of PO) {
    await owner.query(`GRANT MAINTAIN ON public."${table}" TO "${roles.runtime}"`);
    if (table === 'PowerOfficeSnapshot') assert.equal(await lock(runtime, `public."${table}"`), 'locked', 'positive control: the runtime could lock the immutable snapshots');
    const f = await facts();
    assert.ok(f.poRuntimeGrantViolations > 0, `${table}: runtime grant violation`);
    assert.throws(() => assertConfinedRuntimeRole(f), /RUNTIME_ROLE_NOT_CONFINED/, table);
    await reprovision(); await healthy();
    assert.equal((await owner.query(`SELECT has_table_privilege($1, $2, 'MAINTAIN') AS x`, [roles.runtime, `public."${table}"`])).rows[0].x, false);
  }
  assert.equal(await lock(runtime, `public."PowerOfficeSnapshot"`), '42501');
});

test('PUBLIC MAINTAIN on the synthetic table and on each PowerOffice table is refused atomically; never committed or visible', async () => {
  const baseline = await relacl(owner);
  for (const table of ['s4a_maint_target', ...PO]) {
    await inRollbackEnvelope(owner, async () => {
      await owner.query(`GRANT MAINTAIN ON public."${table}" TO PUBLIC`);
      assert.deepEqual(await relacl(observer), baseline, `${table}: invisible to another session`);
      const po = await factsInEnvelope(owner, roles.runtime);
      assert.ok(po.poExecuteViolations > 0 && po.poOwnerViolations > 0, `${table}: both maintenance roles flagged`);
      const full = await runtimeFactsInEnvelope(owner, roles.runtime);
      assert.equal(full.sessionRoleMismatch, false);
      if (PO.includes(table)) assert.ok(full.poRuntimeGrantViolations > 0, `${table}: runtime flagged`);
      assert.throws(() => assertConfinedRuntimeRole(full), /RUNTIME_ROLE_NOT_CONFINED/, `${table}: full startup assertion refuses`);
      assert.match(await provisionInEnvelope(owner, body) ?? '', /roles\.sql: PowerOffice role .* holds a capability outside its exact allowlist/, `${table}: refused`);
    });
    assert.deepEqual(await relacl(owner), baseline, `${table}: rolled back`);
  }
  await healthy();
});
