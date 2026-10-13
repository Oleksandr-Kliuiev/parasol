import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { RUNTIME_ROLE_CHECK_SQL, assertConfinedRuntimeRole } from '../../packages/graph/runtime-role.ts';
import type { RuntimeRoleFacts } from '../../packages/graph/runtime-role.ts';
import { powerOfficeProblems } from '../../packages/graph/poweroffice-role.ts';
import { createTestDatabase, provisionRoles } from '../support/pg-harness.ts';
import { addPowerOfficeFixtures, connect, stateOf } from '../support/poweroffice-fixtures.ts';
import { factsInEnvelope, inRollbackEnvelope } from '../support/poweroffice-envelope.ts';

// S4-A RC3 closure on PostgreSQL 17: database-local ACL objects outside pg_class/pg_proc/pg_namespace — large objects,
// foreign-data wrappers/servers, user mappings and default privileges — carry no authority for the two PowerOffice
// maintenance roles. Synthetic, database-local fixtures only: one synthetic large-object byte; a metadata-only wrapper with
// NO HANDLER and a server with a synthetic non-secret option (never connected). Provisioning (the full production wrapper)
// revokes explicit grants as their grantor and refuses PUBLIC, ownership and mapping paths atomically.
const pgdb = await createTestDatabase();
const clients: pg.Client[] = [];
after(async () => { for (const c of clients) await c.end().catch(() => undefined); await pgdb.drop(); });
await addPowerOfficeFixtures(pgdb.owner);
const { owner, roles } = pgdb;
const runtime = await connect(pgdb.runtimeUrl); clients.push(runtime);
const runner = await connect(pgdb.poRunnerUrl); clients.push(runner);
const facts = async () => (await runtime.query(RUNTIME_ROLE_CHECK_SQL)).rows[0] as RuntimeRoleFacts;
const healthy = async () => assertConfinedRuntimeRole(await facts());
const reprovision = () => provisionRoles(owner, roles, { runtimePassword: randomBytes(18).toString('hex'), runnerPassword: randomBytes(18).toString('hex') });
const flagged = async (who: 'runner' | 'definer' | 'both', label: string) => {
  const f = await facts();
  assert.equal(f.poExecuteViolations > 0, who !== 'definer', `${label}: runner`);
  assert.equal(f.poOwnerViolations > 0, who !== 'runner', `${label}: definer`);
};
const refused = async (label: string) => { await assert.rejects(reprovision(), /roles\.sql: PowerOffice role/, label); await owner.query('ROLLBACK'); };

test('large objects: an explicit grant is a real separate-session read path for each role, flagged and revoked; PUBLIC, ownership and compat mode refused', async () => {
  const lo = (await owner.query(`SELECT lo_from_bytea(0, decode('aa', 'hex'))::text AS oid`)).rows[0].oid as string;
  try {
    await healthy();
    const read = `SELECT octet_length(lo_get(${lo})) = 1 AS x`;
    for (const [who, role] of [['runner', roles.poRunner], ['definer', roles.poDefiner]] as const) {
      await owner.query(`GRANT SELECT ON LARGE OBJECT ${lo} TO "${role}"`);
      if (who === 'runner') assert.equal((await runner.query(read)).rows[0].x, true, 'the runner reads the synthetic byte in its own session');
      await flagged(who, `LO SELECT (${who})`);
      await reprovision(); await healthy();
      assert.equal(await runner.query(read).then(() => 'read', e => stateOf(e)), '42501', `${who}: revoked`);
    }
    for (const [label, tamper, repair, who] of [
      ['PUBLIC SELECT', `GRANT SELECT ON LARGE OBJECT ${lo} TO PUBLIC`, `REVOKE SELECT ON LARGE OBJECT ${lo} FROM PUBLIC`, 'both'],
      ['definer owns it', `ALTER LARGE OBJECT ${lo} OWNER TO "${roles.poDefiner}"`, `ALTER LARGE OBJECT ${lo} OWNER TO CURRENT_USER`, 'definer'],
    ] as const) {
      await owner.query(tamper);
      try { await flagged(who, label); await refused(label); } finally { await owner.query(repair); }
      await reprovision(); await healthy();
    }
    // lo_compat_privileges disables large-object permission checks for every role: session-local, inside the envelope only.
    assert.deepEqual(await inRollbackEnvelope(owner, async () => {
      await owner.query(`SET LOCAL lo_compat_privileges = on`);
      const f = await factsInEnvelope(owner, roles.runtime);
      return [f.poExecuteViolations > 0, f.poOwnerViolations > 0];
    }), [true, true]);
    await healthy();
  } finally { await owner.query(`SELECT lo_unlink(${lo})`); }
});

test('foreign-data wrapper/server USAGE, ownership, user mappings and default privileges: flagged per role; revoked or refused', async () => {
  await owner.query(`CREATE FOREIGN DATA WRAPPER s4a_fdw; CREATE SERVER s4a_srv FOREIGN DATA WRAPPER s4a_fdw OPTIONS (note 'synthetic')`);
  try {
    await healthy();
    for (const [who, role] of [['runner', roles.poRunner], ['definer', roles.poDefiner]] as const) {
      for (const grant of [`GRANT USAGE ON FOREIGN DATA WRAPPER s4a_fdw TO "${role}"`, `GRANT USAGE ON FOREIGN SERVER s4a_srv TO "${role}"`]) {
        await owner.query(grant);
        await flagged(who, `${grant}`);
        await reprovision(); await healthy();
      }
    }
    for (const [label, tamper, repair, who] of [
      ['PUBLIC server USAGE', `GRANT USAGE ON FOREIGN SERVER s4a_srv TO PUBLIC`, `REVOKE USAGE ON FOREIGN SERVER s4a_srv FROM PUBLIC`, 'both'],
      ['user mapping for the runner', `CREATE USER MAPPING FOR "${roles.poRunner}" SERVER s4a_srv OPTIONS (note 'synthetic')`,
        `DROP USER MAPPING FOR "${roles.poRunner}" SERVER s4a_srv`, 'runner'],
      ['definer owns the server', `ALTER SERVER s4a_srv OWNER TO "${roles.poDefiner}"`, `ALTER SERVER s4a_srv OWNER TO CURRENT_USER`, 'definer'],
      ['default privileges for the runner', `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO "${roles.poRunner}"`,
        `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM "${roles.poRunner}"`, 'runner'],
    ] as const) {
      await owner.query(tamper);
      try { await flagged(who, label); await refused(label); } finally { await owner.query(repair); }
      await reprovision(); await healthy();
    }
    assert.deepEqual(await inRollbackEnvelope(owner, async () => powerOfficeProblems(await factsInEnvelope(owner, roles.runtime))), []);
  } finally { await owner.query(`DROP SERVER s4a_srv; DROP FOREIGN DATA WRAPPER s4a_fdw`); }
});
