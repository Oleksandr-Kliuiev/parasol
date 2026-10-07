import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import pg from 'pg';
import { seedGraph, checkStructuralInvariants, checkRlsInvariants, checkRuntimeRoleGuard, seedIdentities, checkIdentityStructure, checkIdentityRlsInvariants, checkMappingStructure,
  checkSnapshotStructure, checkSnapshotRls, checkInboxStructure } from '../tests/sql-invariants.ts';
import type { SqlRunner } from '../tests/sql-invariants.ts';
import { SET_SCOPE_SQL } from '../packages/graph/scope-context.ts';
import { migrationNames, migrationSql } from '../tests/support/migrations.ts';

/**
 * Integration check against a REAL PostgreSQL 17 server (not PGlite). Creates a throwaway database, applies every
 * migration (prisma/migrations, in order) as the owner, creates a confined LOGIN role like prisma/roles.sql, then verifies the SQL invariants and the
 * RLS acceptance list through a connection pool, including connection reuse. Drops everything afterwards.
 *
 *   ATLAS_PG_ADMIN_URL=postgresql://owner@127.0.0.1:5432/postgres npm run db:check:pg17
 *
 * The admin role needs CREATEDB and CREATEROLE. With the compose file: postgresql://atlas:atlas_local_only@localhost:5432/atlas.
 * This does not exercise Prisma Client; Prisma generate/seed/query integration remains a separate step (docs/06).
 */
const adminUrl = process.env.ATLAS_PG_ADMIN_URL;
if (!adminUrl) { console.error('Set ATLAS_PG_ADMIN_URL to a PostgreSQL 17 admin connection string.'); process.exit(2); }
const suffix = randomBytes(4).toString('hex');
const dbName = `atlas_v11_check_${suffix}`;
const roleName = `atlas_app_check_${suffix}`;
const rolePassword = randomBytes(18).toString('hex');
const migrations = await migrationNames();

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
const serverVersion = (await admin.query('SHOW server_version')).rows[0].server_version as string;
const results: [string, string][] = [['PostgreSQL server', serverVersion]];
const asRunner = (c: { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> }): SqlRunner => ({
  exec: sql => c.query(sql).then(() => undefined),
  query: async (sql, params) => (await c.query(sql, params)).rows as never
});
let owner: pg.Client | null = null; let appPool: pg.Pool | null = null;
try {
  assert.ok(serverVersion.startsWith('17.'), `expected PostgreSQL 17, got ${serverVersion}`);
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.query(`CREATE ROLE "${roleName}" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${rolePassword}'`);
  const ownerUrl = new URL(adminUrl); ownerUrl.pathname = `/${dbName}`;
  owner = new pg.Client({ connectionString: ownerUrl.toString() });
  await owner.connect();
  for (const m of migrations) await owner.query(await migrationSql(m));
  results.push(['Migrations applied in order', migrations.join(' → ')]);
  // Same grants as prisma/roles.sql (the file itself uses a psql variable for the password).
  await owner.query(`GRANT USAGE ON SCHEMA public TO "${roleName}";
    GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO "${roleName}";
    REVOKE UPDATE ON "AuditEvent", "SecurityAuditEvent" FROM "${roleName}";
    REVOKE INSERT, UPDATE ON "Actor", "ClientMembership", "ApiToken" FROM "${roleName}";`);
  const ownerRunner = asRunner(owner);
  await seedGraph(ownerRunner);
  await checkStructuralInvariants(ownerRunner);
  results.push(['Structural invariants (owner)', 'passed']);
  await checkMappingStructure(ownerRunner);
  results.push(['Mapping workflow schema (typed links, quarantine, immutable binding)', 'passed']);
  await checkSnapshotStructure(ownerRunner);
  results.push(['Snapshot schema (bounded items, attempt/success order, failure codes)', 'passed']);
  await checkInboxStructure(ownerRunner);
  results.push(['Inbox schema (leases, finished events, failure codes, decision vocabularies)', 'passed']);

  // Confined role through a pool of ONE connection: every checkout reuses the same physical connection.
  const appUrl = new URL(ownerUrl.toString()); appUrl.username = roleName; appUrl.password = rolePassword;
  appPool = new pg.Pool({ connectionString: appUrl.toString(), max: 1 });
  const first = await appPool.connect();
  const firstPid = (await first.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  try { await checkRlsInvariants(asRunner(first), { label: 'PostgreSQL 17' }); } finally { first.release(); }
  results.push(['RLS acceptance (confined login role)', 'passed']);

  // Identities (migration 202610071600): lookup by own digest, actor/memberships only when named, no runtime writes.
  await seedIdentities(ownerRunner);
  await checkIdentityStructure(ownerRunner);
  const identityClient = await appPool.connect();
  try { await checkIdentityRlsInvariants(ownerRunner, asRunner(identityClient), { label: 'PostgreSQL 17' }); } finally { identityClient.release(); }
  results.push(['Identity lookup policies (token digest, named actor, no runtime writes)', 'passed']);
  const snapshotClient = await appPool.connect();
  try { await checkSnapshotRls(asRunner(snapshotClient)); } finally { snapshotClient.release(); }
  results.push(['Snapshot RLS (no context, one client)', 'passed']);

  // Runtime-role guard: ownership of any protected table (not only Observation) and a table with RLS disabled are detected.
  const guardClient = await appPool.connect();
  try { await checkRuntimeRoleGuard(ownerRunner, asRunner(guardClient), roleName, {}); } finally { guardClient.release(); }
  results.push(['Runtime-role guard (ownership of RawEvent, RLS disabled on Approval)', 'passed']);

  // Connection reuse across pool checkouts: scope set in a transaction on checkout 1 is gone on checkout 2.
  const c1 = await appPool.connect();
  await c1.query('BEGIN'); await c1.query(SET_SCOPE_SQL, ['w', 'c1']);
  assert.equal(Number((await c1.query(`SELECT count(*)::int AS n FROM "Observation"`)).rows[0].n), 2);
  await c1.query('COMMIT'); c1.release();
  const c2 = await appPool.connect();
  assert.equal((await c2.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, firstPid, 'pool handed back the same connection');
  assert.equal(Number((await c2.query(`SELECT count(*)::int AS n FROM "Observation"`)).rows[0].n), 0, 'no scope carried over between checkouts');
  // Negative control: a SESSION-level set_config (is_local = false) WOULD leak into the next checkout. This is why
  // scoped-db.ts uses is_local = true inside a transaction and nothing else.
  await c2.query(`SELECT set_config('app.workspace_id', 'w', false), set_config('app.client_ids', 'c1', false)`);
  c2.release();
  const c3 = await appPool.connect();
  assert.equal(Number((await c3.query(`SELECT count(*)::int AS n FROM "Observation"`)).rows[0].n), 2, 'negative control: session-level context leaks');
  await c3.query('DISCARD ALL'); c3.release();
  const c4 = await appPool.connect();
  assert.equal(Number((await c4.query(`SELECT count(*)::int AS n FROM "Observation"`)).rows[0].n), 0);
  c4.release();
  results.push(['Pool connection reuse (SET LOCAL ends with transaction; session SET would leak)', 'passed']);
  console.log('PASS pg17-check');
} finally {
  await appPool?.end().catch(() => undefined);
  await owner?.end().catch(() => undefined);
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => undefined);
  await admin.query(`DROP ROLE IF EXISTS "${roleName}"`).catch(() => undefined);
  await admin.end();
  for (const [k, v] of results) console.log(`${k}: ${v}`);
}
