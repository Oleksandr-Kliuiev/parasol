import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { RUNTIME_ROLE_CHECK_SQL, assertConfinedRuntimeRole } from '../../packages/graph/runtime-role.ts';
import type { RuntimeRoleFacts } from '../../packages/graph/runtime-role.ts';
import { seedGraph } from '../sql-invariants.ts';
import type { SqlRunner } from '../sql-invariants.ts';
import { seedM365 } from '../m365-sql-invariants.ts';
import { createTestDatabase, provisionRoles, urlFor } from '../support/pg-harness.ts';

// Review S2-A-rc1 F1 on PostgreSQL 17: the runtime self-check enforces what prisma/roles.sql requires of the runtime role —
// LOGIN NOINHERIT, no CREATEROLE/CREATEDB/REPLICATION, no outgoing role membership at all, and the check runs as the
// session's own login. NOINHERIT SET-only grants hide privileges from has_table_privilege, but SET ROLE reaches them;
// every such path must stop the runtime before it serves data. Synthetic roles only, dropped in finally.
const pgdb = await createTestDatabase();
const owner = pgdb.owner;
const asRunner = (c: pg.Client): SqlRunner => ({ exec: sql => c.query(sql).then(() => undefined), query: async (sql, params) => (await c.query(sql, params)).rows as never });
await seedGraph(asRunner(owner));
await seedM365(asRunner(owner));
const runtime = new pg.Client({ connectionString: pgdb.runtimeUrl }); await runtime.connect();
const probes: string[] = [];
after(async () => {
  await runtime.end().catch(() => undefined);
  for (const p of probes.reverse()) {
    await owner.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "${p}"`).catch(() => undefined);
    await owner.query(`DROP ROLE IF EXISTS "${p}"`).catch(() => undefined);
  }
  await pgdb.drop();
});
const rt = `"${pgdb.runtimeRole}"`;
const facts = async (c: pg.Client = runtime) => (await c.query(RUNTIME_ROLE_CHECK_SQL)).rows[0] as RuntimeRoleFacts;
const accepted = async () => assertConfinedRuntimeRole(await facts());
const assertRefused = async (label: string) => {
  const f = await facts();
  assert.throws(() => assertConfinedRuntimeRole(f), /RUNTIME_ROLE_NOT_CONFINED|RUNTIME_ROLE_BYPASSES_RLS/, label);
};
const probe = async (attributes: string) => {
  const name = `atlas_rx_${randomBytes(4).toString('hex')}`; probes.push(name);
  await owner.query(`CREATE ROLE "${name}" ${attributes}`); return `"${name}"`;
};

test('baseline: the provisioned runtime role passes; it is the session login, NOINHERIT, member of nothing', async () => {
  await accepted();
  const f = await facts();
  assert.deepEqual([f.sessionRoleMismatch, f.runtimeAttributeViolations, f.runtimeMemberships], [false, 0, 0]);
});

test('direct and transitive SET-only paths to BYPASSRLS are refused before data is served (and are real paths)', async () => {
  const bypass = await probe('NOLOGIN NOINHERIT BYPASSRLS');
  await owner.query(`GRANT SELECT ON "Connection" TO ${bypass}`);
  await owner.query(`GRANT ${bypass} TO ${rt} WITH INHERIT FALSE, SET TRUE`);
  assert.equal(Number((await runtime.query(`SELECT count(*)::int AS n FROM "Connection"`)).rows[0].n), 0, 'without scope RLS hides every row...');
  await runtime.query(`SET ROLE ${bypass}`);
  assert.ok(Number((await runtime.query(`SELECT count(*)::int AS n FROM "Connection"`)).rows[0].n) > 0, '...but SET ROLE would bypass it');
  await runtime.query('RESET ROLE');
  await assertRefused('direct SET-only BYPASSRLS');
  await owner.query(`REVOKE ${bypass} FROM ${rt}`);
  await accepted();
  const hop = await probe('NOLOGIN NOINHERIT');
  await owner.query(`GRANT ${bypass} TO ${hop} WITH INHERIT FALSE, SET TRUE`);
  await owner.query(`GRANT ${hop} TO ${rt} WITH INHERIT FALSE, SET TRUE`);
  await runtime.query(`SET ROLE ${hop}`); await runtime.query(`SET ROLE ${bypass}`); // the transitive path exists
  await runtime.query('RESET ROLE');
  await assertRefused('transitive SET-only BYPASSRLS');
  await owner.query(`REVOKE ${hop} FROM ${rt}`);
  await accepted();
});

test('SET-only paths to DELETE on the audit or UPDATE of immutable M365 columns, and an inherited grant, are refused', async () => {
  const deleter = await probe('NOLOGIN NOINHERIT');
  await owner.query(`GRANT DELETE ON "AuditEvent" TO ${deleter}`);
  const updater = await probe('NOLOGIN NOINHERIT');
  await owner.query(`GRANT UPDATE (dto) ON "M365SignInEvidence" TO ${updater}`);
  for (const [label, role, inherit] of [['DELETE on AuditEvent', deleter, 'FALSE'], ['immutable UPDATE', updater, 'FALSE'], ['inherited DELETE', deleter, 'TRUE']] as const) {
    await owner.query(`GRANT ${role} TO ${rt} WITH INHERIT ${inherit}, SET TRUE`);
    await assertRefused(label);
    await owner.query(`REVOKE ${role} FROM ${rt}`);
    await accepted();
  }
});

test('runtime attributes are enforced as in roles.sql, and a SET ROLE from another session login is refused', async () => {
  for (const [attribute, restore] of [['CREATEDB', 'NOCREATEDB'], ['CREATEROLE', 'NOCREATEROLE'], ['INHERIT', 'NOINHERIT']]) {
    await owner.query(`ALTER ROLE ${rt} ${attribute}`);
    await assertRefused(attribute);
    await owner.query(`ALTER ROLE ${rt} ${restore}`);
  }
  await accepted();
  const password = randomBytes(18).toString('hex');
  const other = await probe(`LOGIN NOINHERIT PASSWORD '${password}'`);
  await owner.query(`GRANT ${rt} TO ${other} WITH INHERIT FALSE, SET TRUE`);
  const login = new pg.Client({ connectionString: urlFor(pgdb.ownerUrl, other.slice(1, -1), password) }); await login.connect();
  try {
    await login.query(`SET ROLE ${rt}`);
    const f = await facts(login);
    assert.equal(f.sessionRoleMismatch, true);
    assert.throws(() => assertConfinedRuntimeRole(f), /RUNTIME_ROLE_NOT_CONFINED/, 'current_user is the runtime, but the session could RESET ROLE');
  } finally { await login.end(); await owner.query(`REVOKE ${rt} FROM ${other}`); }
});

test('roles.sql refuses the same memberships, and normal re-provisioning keeps the runtime accepted', async () => {
  const hop = await probe('NOLOGIN NOINHERIT');
  await owner.query(`GRANT ${hop} TO ${rt} WITH INHERIT FALSE, SET TRUE`);
  const names = { runtime: pgdb.runtimeRole, definer: pgdb.definerRole, runner: pgdb.runnerRole, fence: pgdb.fenceRole, poDefiner: pgdb.poDefinerRole, poRunner: pgdb.poRunnerRole };
  const secrets = { runtimePassword: randomBytes(18).toString('hex'), runnerPassword: randomBytes(18).toString('hex') };
  await assert.rejects(provisionRoles(owner, names, secrets), /must not be a member of any role/);
  await owner.query('ROLLBACK').catch(() => undefined);
  await owner.query(`REVOKE ${hop} FROM ${rt}`);
  await provisionRoles(owner, names, secrets);
  await accepted();
});
