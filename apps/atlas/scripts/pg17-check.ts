import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import pg from 'pg';
import { seedGraph, checkStructuralInvariants, checkRlsInvariants, checkRuntimeRoleGuard, seedIdentities, checkIdentityStructure, checkIdentityRlsInvariants, checkMappingStructure,
  checkSnapshotStructure, checkSnapshotRls, checkInboxStructure, checkDecisionLayerStructure, checkShadowJobRls, checkObservationLifecycle, checkToolLedger } from '../tests/sql-invariants.ts';
import type { SqlRunner } from '../tests/sql-invariants.ts';
import { SET_SCOPE_SQL } from '../packages/graph/scope-context.ts';
import { migrationNames, migrationSql } from '../tests/support/migrations.ts';
import { dropRolesSql, readRolesSql, renderRolesSql, uniqueRoleNames } from '../tests/support/roles-sql.ts';
import { checkM365Structure, checkM365Privileges, checkM365Rls } from '../tests/m365-sql-invariants.ts';
import { checkM365DirectoryBudget } from '../tests/m365-budget-invariants.ts';

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
const roles = uniqueRoleNames('check', suffix);
const roleName = roles.runtime;
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
  const ownerUrl = new URL(adminUrl); ownerUrl.pathname = `/${dbName}`;
  owner = new pg.Client({ connectionString: ownerUrl.toString() });
  await owner.connect();
  for (const m of migrations) await owner.query(await migrationSql(m));
  results.push(['Migrations applied in order (no role created or referenced)', migrations.join(' → ')]);
  // The production provisioning itself, after the migrations: prisma/roles.sql rendered for this check's role names.
  await owner.query(renderRolesSql(await readRolesSql(), roles, { runtimePassword: rolePassword, runnerPassword: randomBytes(18).toString('hex') }));
  results.push(['prisma/roles.sql (runtime, cleanup definer, cleanup runner)', 'applied']);
  const ownerRunner = asRunner(owner);
  await seedGraph(ownerRunner);
  await checkStructuralInvariants(ownerRunner);
  results.push(['Structural invariants (owner)', 'passed']);
  await checkMappingStructure(ownerRunner);
  results.push(['Mapping workflow schema (typed links, quarantine, immutable binding)', 'passed']);
  await checkSnapshotStructure(ownerRunner);
  results.push(['Snapshot schema (bounded items, attempt/success order, read-attempt order, PENDING, failure codes)', 'passed']);
  await checkInboxStructure(ownerRunner);
  results.push(['Inbox schema (leases with claim tokens, finished events, failure codes, decision vocabularies)', 'passed']);
  await checkDecisionLayerStructure(ownerRunner);
  results.push(['Decision layer schema (run config version and measurements, shadow jobs: scope link, leases, finished jobs, codes)', 'passed']);
  await checkObservationLifecycle(ownerRunner);
  results.push(['Observation lifecycle (immutable evidence, allowed status changes, acknowledgement author, superseding in client)', 'passed']);
  await checkToolLedger(ownerRunner);
  results.push(['Tool execution ledger (read tools only, outcome consistency, identity formats, final outcomes)', 'passed']);

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
  const shadowClient = await appPool.connect();
  try { await checkShadowJobRls(asRunner(shadowClient)); } finally { shadowClient.release(); }
  results.push(['Shadow job RLS (no context, one client, no cross-client write)', 'passed']);

  // Stage 2 M365 (migrations 202610081000-1200 + roles.sql): structure as the owner, grants from the catalog, RLS as the login role
  await checkM365Structure(ownerRunner);
  results.push(['M365 schema (scope FKs, typed mirrors, publication fence, immutability, retention)', 'passed']);
  await checkM365DirectoryBudget(ownerRunner);
  results.push(['M365 directory retry budget (domain, claim/publication/reset transitions, sign-in rows at zero)', 'passed']);
  await checkM365Privileges(ownerRunner, roles);
  results.push(['M365 privileges (column-limited runtime UPDATE, EXECUTE-only runner, confined definer, no PUBLIC EXECUTE)', 'passed']);
  const m365Client = await appPool.connect();
  try { await checkM365Rls(asRunner(m365Client)); } finally { m365Client.release(); }
  results.push(['M365 RLS (every new table: no context, other client, no foreign write, no DELETE)', 'passed']);

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
  for (const statement of dropRolesSql(roles)) await admin.query(statement).catch(() => undefined);
  await admin.end();
  for (const [k, v] of results) console.log(`${k}: ${v}`);
}
