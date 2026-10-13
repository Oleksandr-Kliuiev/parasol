import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { powerOfficeProblems } from '../../packages/graph/poweroffice-role.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { addPowerOfficeFixtures, connect } from '../support/poweroffice-fixtures.ts';
import { factsInEnvelope, inRollbackEnvelope, provisionInEnvelope, provisioningBody, sharedAclSnapshot } from '../support/poweroffice-envelope.ts';

// S4-A RC3 closure on PostgreSQL 17: BUILT-IN and SHARED-catalog privilege drift for the two PowerOffice maintenance roles.
// Every grant here is UNCOMMITTED: one owner transaction applies it, evaluates readiness on that same connection, runs the
// production roles.sql body (outer BEGIN/COMMIT removed, savepoint) and ALWAYS rolls back. A separate observer session
// proves the drift is never visible, and the shared/built-in ACL snapshot is identical before, during and after. Metadata
// only: no built-in is invoked, no file/credential/password row is read.
const pgdb = await createTestDatabase();
const clients: pg.Client[] = [];
after(async () => { for (const c of clients) await c.end().catch(() => undefined); await pgdb.drop(); });
await addPowerOfficeFixtures(pgdb.owner);
const { owner, roles } = pgdb;
const observer = await connect(pgdb.ownerUrl); clients.push(observer);
const runner = await connect(pgdb.poRunnerUrl); clients.push(runner);
const body = await provisioningBody(roles);
const baseline = await sharedAclSnapshot(owner);
type Probe = readonly [kind: 'function' | 'table' | 'column', target: string, priv: string];
const can = async (role: string, [kind, target, priv]: Probe) => (await owner.query(kind === 'function' ? `SELECT has_function_privilege($1, $2, $3) AS x`
  : kind === 'table' ? `SELECT has_table_privilege($1, $2, $3) AS x` : `SELECT has_column_privilege($1, $2, 'rolname', $3) AS x`, [role, target, priv])).rows[0].x as boolean;

/** One uncommitted drift: readiness flags `flagged`; provisioning revokes it (`revocable`) or refuses atomically. */
async function drift(label: string, grant: string, flagged: ('runner' | 'definer')[], revocable: boolean, probe?: { role: string; check: Probe }): Promise<void> {
  const initial = probe ? await can(probe.role, probe.check) : undefined;
  await inRollbackEnvelope(owner, async () => {
    await owner.query(grant);
    assert.deepEqual(await sharedAclSnapshot(observer), baseline, `${label}: never visible to another session`);
    if (probe) assert.equal(await can(probe.role, probe.check), true, `${label}: effective inside the envelope`);
    const f = await factsInEnvelope(owner, roles.runtime);
    assert.equal(f.poExecuteViolations > 0, flagged.includes('runner'), `${label}: runner`);
    assert.equal(f.poOwnerViolations > 0, flagged.includes('definer'), `${label}: definer`);
    const outcome = await provisionInEnvelope(owner, body);
    if (revocable) {
      assert.equal(outcome, undefined, `${label}: the production provisioning body revokes it`);
      assert.deepEqual(powerOfficeProblems(await factsInEnvelope(owner, roles.runtime)), [], `${label}: healthy afterwards`);
      if (probe) assert.equal(await can(probe.role, probe.check), initial, `${label}: back to the initial privilege`);
    } else {
      assert.match(outcome ?? '', /roles\.sql: PowerOffice role .* holds a capability outside its exact allowlist/, `${label}: refused`);
    }
  });
  assert.deepEqual(await sharedAclSnapshot(owner), baseline, `${label}: rolled back completely`);
}

test('initial privilege metadata of the probed built-ins (pg_init_privs) and a healthy baseline', async () => {
  const initial = (await owner.query(`SELECT p.oid::regprocedure::text AS f, i.privtype, EXISTS (SELECT 1 FROM aclexplode(i.initprivs) a WHERE a.grantee = 0) AS public
    FROM pg_proc p LEFT JOIN pg_init_privs i ON i.objoid = p.oid AND i.classoid = 'pg_proc'::regclass AND i.objsubid = 0
    WHERE p.oid IN ('pg_catalog.pg_read_file(text)'::regprocedure, 'pg_catalog.lower(text)'::regprocedure) ORDER BY 1`)).rows;
  assert.deepEqual(initial, [{ f: 'lower(text)', privtype: null, public: false }, { f: 'pg_read_file(text)', privtype: 'i', public: false }]);
  const unrecorded = (await owner.query(`SELECT c.relname, c.relacl IS NULL AS owner_only FROM pg_class c LEFT JOIN pg_init_privs i ON i.objoid = c.oid
    AND i.classoid = 'pg_class'::regclass AND i.objsubid = 0 WHERE c.oid IN ('information_schema.sql_parts'::regclass, 'information_schema.transforms'::regclass,
    'information_schema.tables'::regclass) AND i.objoid IS NULL ORDER BY 1`)).rows;
  assert.deepEqual(unrecorded, [{ relname: 'sql_parts', owner_only: true }, { relname: 'tables', owner_only: false }, { relname: 'transforms', owner_only: true }]);
  assert.deepEqual(await inRollbackEnvelope(owner, async () => powerOfficeProblems(await factsInEnvelope(owner, roles.runtime))), [],
    'standard PUBLIC catalog/information_schema access stays healthy');
  assert.equal((await runner.query(`SELECT lower('A') = 'a' AND public.atlas_app_workspace() IS NULL AS x`)).rows[0].x, true, 'ordinary built-in SQL and shared helpers');
});

test('explicit built-in/shared grants to either role (incl. grant options) are revoked by provisioning; nothing is ever committed', async () => {
  for (const [name, role] of [['runner', roles.poRunner], ['definer', roles.poDefiner]] as const) {
    const cases: [string, string, Probe | undefined][] = [
      ['EXECUTE on pg_read_file', `GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) TO "${role}"`, ['function', 'pg_catalog.pg_read_file(text)', 'EXECUTE']],
      ['explicit EXECUTE with grant option on PUBLIC lower', `GRANT EXECUTE ON FUNCTION pg_catalog.lower(text) TO "${role}" WITH GRANT OPTION`,
        ['function', 'pg_catalog.lower(text)', 'EXECUTE']],
      ['SELECT on pg_authid', `GRANT SELECT ON pg_catalog.pg_authid TO "${role}"`, ['table', 'pg_catalog.pg_authid', 'SELECT']],
      ['column SELECT on pg_authid', `GRANT SELECT (rolname) ON pg_catalog.pg_authid TO "${role}"`, ['column', 'pg_catalog.pg_authid', 'SELECT']],
      ['SELECT on information_schema.sql_parts', `GRANT SELECT ON information_schema.sql_parts TO "${role}"`, ['table', 'information_schema.sql_parts', 'SELECT']],
      ['SET on parameter session_replication_role', `GRANT SET ON PARAMETER session_replication_role TO "${role}"`, undefined],
      ['CREATE on the database', `GRANT CREATE ON DATABASE "${pgdb.name}" TO "${role}"`, undefined],
      ['CONNECT/TEMP granted explicitly on the database', `GRANT CONNECT, TEMP ON DATABASE "${pgdb.name}" TO "${role}"`, undefined],
      ['CREATE on tablespace pg_default', `GRANT CREATE ON TABLESPACE pg_default TO "${role}"`, undefined],
    ];
    for (const [label, grant, check] of cases) await drift(`${label} (${name})`, grant, [name], true, check ? { role, check } : undefined);
  }
});

test('PUBLIC drift on initially restricted built-ins and shared objects is refused atomically, never committed or visible', async () => {
  for (const [label, grant] of [
    ['PUBLIC EXECUTE on pg_read_file', `GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) TO PUBLIC`],
    ['PUBLIC SELECT on pg_authid', `GRANT SELECT ON pg_catalog.pg_authid TO PUBLIC`],
    ['PUBLIC column SELECT on pg_authid', `GRANT SELECT (rolname) ON pg_catalog.pg_authid TO PUBLIC`],
    ['PUBLIC SELECT on information_schema._pg_user_mappings', `GRANT SELECT ON information_schema._pg_user_mappings TO PUBLIC`],
    ['PUBLIC SELECT on information_schema.sql_parts', `GRANT SELECT ON information_schema.sql_parts TO PUBLIC`],
    ['PUBLIC SELECT on information_schema.transforms', `GRANT SELECT ON information_schema.transforms TO PUBLIC`],
    ['PUBLIC SET on parameter session_replication_role', `GRANT SET ON PARAMETER session_replication_role TO PUBLIC`],
    ['PUBLIC CREATE on the database', `GRANT CREATE ON DATABASE "${pgdb.name}" TO PUBLIC`],
    ['PUBLIC CREATE on tablespace pg_default', `GRANT CREATE ON TABLESPACE pg_default TO PUBLIC`],
  ] as const) {
    await drift(label, grant, ['runner', 'definer'], false);
  }
  assert.equal((await observer.query(`SELECT count(*)::int AS n FROM pg_parameter_acl`)).rows[0].n, 0, 'no parameter ACL row exists afterwards');
});

test('RC3 R2: CREATE on a NON-DEFAULT tablespace (explicit or PUBLIC) is examined — metadata-only ACL drift on pg_global, never committed', async () => {
  // No tablespace is created, altered for storage, used or dropped: only the shared ACL of the built-in non-default
  // tablespace pg_global changes inside the rollback envelope. The former pg_default-only predicate cannot see it.
  const tablespaces = (await owner.query(`SELECT spcname FROM pg_tablespace ORDER BY 1`)).rows.map(r => r.spcname);
  assert.deepEqual(tablespaces, ['pg_default', 'pg_global']);
  const defaultOnly = async (role: string) => (await owner.query(`SELECT has_tablespace_privilege($1, 'pg_default', 'CREATE') AS x`, [role])).rows[0].x as boolean;
  for (const [name, role] of [['runner', roles.poRunner], ['definer', roles.poDefiner]] as const) {
    await inRollbackEnvelope(owner, async () => {
      await owner.query(`GRANT CREATE ON TABLESPACE pg_global TO "${role}"`);
      assert.equal(await defaultOnly(role), false, 'invisible to a pg_default-only check');
    });
    await drift(`explicit CREATE on pg_global (${name})`, `GRANT CREATE ON TABLESPACE pg_global TO "${role}"`, [name], true);
  }
  await drift('PUBLIC CREATE on pg_global', `GRANT CREATE ON TABLESPACE pg_global TO PUBLIC`, ['runner', 'definer'], false);
});
