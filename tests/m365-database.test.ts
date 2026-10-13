import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { seedGraph } from './sql-invariants.ts';
import { checkM365Structure, checkM365Privileges, checkM365Rls } from './m365-sql-invariants.ts';
import { seedRetentionFixtures, checkCleanupRoutine } from './m365-cleanup-invariants.ts';
import { checkM365Prerequisites } from './m365-prerequisite-invariants.ts';
import { checkM365DtoStorage } from './m365-dto-storage-invariants.ts';
import { checkM365DirectoryBudget } from './m365-budget-invariants.ts';
import { RUNTIME_ROLE_CHECK_SQL, assertConfinedRuntimeRole } from '../packages/graph/runtime-role.ts';
import type { RuntimeRoleFacts } from '../packages/graph/runtime-role.ts';
import { migrateAll, provisionRoles, runner, asRole, PGLITE_ROLES } from './support/pglite.ts';
import { readRolesSql, renderRolesSql } from './support/roles-sql.ts';

// Stage 2 task 2.2 on PGlite (PostgreSQL 17 engine in-process): the M365 migrations apply without any pre-created role,
// prisma/roles.sql provisions the production grants afterwards, and the runtime self-check fails closed until it did.
// The real-server counterparts are scripts/pg17-check.ts and tests/pg/m365-*.pg.test.ts.
const withDb = async (fn: (db: PGlite) => Promise<void>) => { const db = new PGlite(); try { await fn(db); } finally { await db.close(); } };
const facts = async (db: PGlite) => (await asRole(db).query<RuntimeRoleFacts>(RUNTIME_ROLE_CHECK_SQL))[0];

test('M365 migrations need no pre-created role; schema invariants: scope FKs, typed mirrors and links, publication fence, immutable publication, bounded retention', () =>
  withDb(async db => {
    await migrateAll(db);
    const roles = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname LIKE 'atlas%'`);
    assert.equal(roles.rows[0]?.n, 0, 'the migrations created no role');
    const owner = runner(db);
    await seedGraph(owner);
    await checkM365Structure(owner);
  }));

test('lifecycle entry: initial states and visible prerequisites are required; same-statement parents are refused; ordered creation works', () =>
  withDb(async db => {
    await migrateAll(db);
    await seedGraph(runner(db));
    await checkM365Prerequisites(runner(db));
  }));

test('parser → storage: maximum Unicode/escaped/precision DTOs persist under the derived byte caps; out-of-contract values stay rejected', () =>
  withDb(async db => {
    await migrateAll(db);
    await seedGraph(runner(db));
    await checkM365DtoStorage(runner(db));
  }));

test('prisma/roles.sql: column-limited runtime UPDATE, confined definer, EXECUTE-only runner; every M365 table is client-scoped for the runtime role', () =>
  withDb(async db => {
    await migrateAll(db);
    const owner = runner(db);
    await seedGraph(owner);
    await checkM365Structure(owner);
    await provisionRoles(db);
    await checkM365Privileges(owner, PGLITE_ROLES);
    assertConfinedRuntimeRole(await facts(db));
    await checkM365Rls(asRole(db));
  }));

test('roles.sql fails closed and is idempotent: an existing Stage 1 runtime role is refused until provisioning ran; an unconfined existing role stops it', async () => {
  await withDb(async db => {
    await migrateAll(db);
    // The runtime role as Stage 1 provisioned it (table-level grants, default privileges): new M365 tables are wide open to it
    await db.exec(`CREATE ROLE ${PGLITE_ROLES.runtime} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD 'stage1LocalOnly';
      GRANT USAGE ON SCHEMA public TO ${PGLITE_ROLES.runtime}; GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ${PGLITE_ROLES.runtime};`);
    const before = await facts(db);
    assert.ok(before!.unguardedUpdateColumns > 0 && before!.cleanupOwnerViolations > 0);
    assert.throws(() => assertConfinedRuntimeRole(before), /RUNTIME_ROLE_NOT_CONFINED/, 'the upgraded runtime stays stopped');
    const password = async () => (await db.query<{ p: string | null }>(`SELECT rolpassword AS p FROM pg_authid WHERE rolname = $1`, [PGLITE_ROLES.runtime])).rows[0]?.p;
    const credential = await password();
    await provisionRoles(db);
    assertConfinedRuntimeRole(await facts(db));
    assert.equal(await password(), credential, 'the existing login credential is preserved');
    await provisionRoles(db);
    assertConfinedRuntimeRole(await facts(db));
  });
  for (const unconfined of [`CREATE ROLE ${PGLITE_ROLES.runtime} LOGIN NOINHERIT BYPASSRLS`, `CREATE ROLE ${PGLITE_ROLES.definer} LOGIN NOINHERIT`,
    `CREATE ROLE ${PGLITE_ROLES.runner} LOGIN INHERIT`, `CREATE ROLE ${PGLITE_ROLES.runner} LOGIN NOINHERIT; GRANT pg_read_all_data TO ${PGLITE_ROLES.runner}`]) {
    await withDb(async db => {
      await migrateAll(db);
      await db.exec(unconfined);
      await assert.rejects(provisionRoles(db), /not confined|must not be a member/, unconfined);
      await db.exec('ROLLBACK'); // psql -v ON_ERROR_STOP=1 ends the session; this single PGlite session continues
      const owner = (await db.query<{ owner: string }>(`SELECT proowner::regrole::text AS owner FROM pg_proc WHERE proname = 'atlas_m365_cleanup'`)).rows[0]?.owner;
      assert.notEqual(owner, PGLITE_ROLES.definer, 'nothing was changed');
    });
  }
});

test('roles.sql never returns a password: its result rows are status booleans only (what psql would print)', () =>
  withDb(async db => {
    await migrateAll(db);
    const secrets = { runtimePassword: 'CanaryRuntimeLocal0001', runnerPassword: 'CanaryRunnerLocal0002', poRunnerPassword: 'CanaryPoRunnerLocal0003',
      revalReaderPassword: 'CanaryRevalReaderLocal0004' };
    const results = await db.exec(renderRolesSql(await readRolesSql(), PGLITE_ROLES, secrets));
    const printed = JSON.stringify(results.map(r => ({ fields: r.fields.map(f => f.name), rows: r.rows })));
    assert.ok(!printed.includes(secrets.runtimePassword) && !printed.includes(secrets.runnerPassword) && !printed.includes(secrets.poRunnerPassword)
      && !printed.includes(secrets.revalReaderPassword));
    // R-EVAL RS-A (prisma/roles/reval.sql) prints one more status row, booleans only.
    assert.deepEqual(results.flatMap(r => r.rows), [{ runtime_role_set: true, definer_role_set: true, runner_role_set: true, fence_role_set: true,
      po_definer_role_set: true, po_runner_role_set: true, runtime_password_given: true, runner_password_given: true, po_runner_password_given: true },
    { reval_definer_role_set: true, reval_reader_role_set: true, reval_reader_password_given: true }]);
  }));

test('cleanup routine: only the EXECUTE-only runner may call it; it deletes only expired payload of the one client in context, withdraws expired pointers and audits', () =>
  withDb(async db => {
    await migrateAll(db);
    const owner = runner(db);
    await seedGraph(owner);
    await seedRetentionFixtures(owner);
    await provisionRoles(db);
    await checkCleanupRoutine(owner, asRole(db, PGLITE_ROLES.runner), asRole(db, PGLITE_ROLES.runtime));
  }));

test('directory retry budget (migration 202610081400): domain, claim/publication/reset transition classes, sign-in rows at zero', () =>
  withDb(async db => {
    await migrateAll(db);
    const owner = runner(db);
    await seedGraph(owner);
    await checkM365DirectoryBudget(owner);
  }));
