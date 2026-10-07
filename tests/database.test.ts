import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { seedGraph, checkStructuralInvariants, checkRlsInvariants, checkRuntimeRoleGuard, seedIdentities, checkIdentityStructure, checkIdentityRlsInvariants } from './sql-invariants.ts';
import type { SqlRunner } from './sql-invariants.ts';
import { migrationNames, migrationsAfter, migrationSql, FROZEN_V1_1_2 } from './support/migrations.ts';

// PGlite embeds the PostgreSQL 17 engine in-process. It verifies the SQL of both migrations and the policies, but it is
// not a standalone PostgreSQL 17 server with connection pooling: scripts/pg17-check.ts covers that against a real server.
const sql = (rel: string) => readFile(new URL(rel, import.meta.url), 'utf8');
const FOUNDATION = '../prisma/migrations/202610070001_foundation/migration.sql';
const V11 = '../prisma/migrations/202610071200_v1_1_contracts/migration.sql';
const V112 = '../prisma/migrations/202610071500_v1_1_2_conflict_scope_and_legacy_guard/migration.sql';
const V110_AS_SHIPPED = '../prisma/upgrades/202610071200_v1_1_contracts.as-shipped-in-1.1.0.sql';
const UPGRADE = '../prisma/upgrades/v1_1_0_to_v1_1_1.sql';

/** Fresh install: every migration in apply order, as `prisma migrate deploy` would run them. */
async function migrateAll(db: PGlite): Promise<void> { for (const m of await migrationNames()) await db.exec(await migrationSql(m)); }
/** Migrations added after the frozen v1.1.2 set, for upgrade-path tests that apply the frozen part by hand. */
async function migrateAfterFrozen(db: PGlite): Promise<void> { for (const m of await migrationsAfter(FROZEN_V1_1_2)) await db.exec(await migrationSql(m)); }

function runner(db: PGlite): SqlRunner {
  return {
    exec: s => db.exec(s).then(() => undefined),
    query: async (s, params) => (await db.query(s, params as never)).rows as never
  };
}
const confinedRole = `CREATE ROLE atlas_app_test NOLOGIN NOINHERIT NOBYPASSRLS;
  GRANT USAGE ON SCHEMA public TO atlas_app_test;
  GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO atlas_app_test;
  REVOKE UPDATE ON "AuditEvent", "SecurityAuditEvent" FROM atlas_app_test;
  REVOKE INSERT, UPDATE ON "Actor", "ClientMembership", "ApiToken" FROM atlas_app_test;`;
/**
 * Statements run as the confined role, everything else as the owner: PGlite is one session, so each call switches roles.
 * A statement that aborts an explicit transaction leaves the session in the owner role with the transaction rolled back.
 */
function asConfinedRole(db: PGlite): SqlRunner {
  const asRole = async <T>(fn: () => Promise<T>): Promise<T> => {
    await db.exec('SET ROLE atlas_app_test');
    try { return await fn(); }
    finally { try { await db.exec('RESET ROLE'); } catch { await db.exec('ROLLBACK'); await db.exec('RESET ROLE'); } }
  };
  return { exec: s => asRole(() => db.exec(s).then(() => undefined)), query: (s, params) => asRole(async () => (await db.query(s, params as never)).rows as never) };
}
/** Shape of the schema, independent of row data: columns, constraints and indexes. Used to prove upgrade-path equivalence. */
async function schemaShape(db: PGlite): Promise<string[]> {
  const cols = await db.query<{ s: string }>(`SELECT table_name||'.'||column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,'') AS s FROM information_schema.columns WHERE table_schema = current_schema() AND table_name <> '_prisma_migrations' ORDER BY 1`);
  const cons = await db.query<{ s: string }>(`SELECT conrelid::regclass||'.'||conname||':'||pg_get_constraintdef(oid) AS s FROM pg_constraint WHERE connamespace = current_schema()::regnamespace ORDER BY 1`);
  const idx = await db.query<{ s: string }>(`SELECT indexname||':'||regexp_replace(indexdef, '^CREATE (UNIQUE )?INDEX \\S+ ON ', '') AS s FROM pg_indexes WHERE schemaname = current_schema() ORDER BY 1`);
  const pol = await db.query<{ s: string }>(`SELECT tablename||'.'||policyname||':'||coalesce(qual,'')||':'||coalesce(with_check,'') AS s FROM pg_policies WHERE schemaname = current_schema() ORDER BY 1`);
  const trg = await db.query<{ s: string }>(`SELECT tgrelid::regclass||'.'||tgname||':'||pg_get_triggerdef(oid) AS s FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1`);
  return [...cols.rows, ...cons.rows, ...idx.rows, ...pol.rows, ...trg.rows].map(r => r.s);
}

test('all migrations apply in order and the v1.1.2 invariants hold: identity with resource type and conflict rows, applied decision per event pinned by FK, severity rank, priority floor, append-only logs', async () => {
  const db = new PGlite();
  try {
    await migrateAll(db);
    const owner = runner(db);
    await seedGraph(owner);
    await checkStructuralInvariants(owner);
  } finally { await db.close(); }
});

test('row-level security confines a non-owner role: no context denies, clients of one workspace are isolated, context ends with the transaction', async () => {
  const db = new PGlite();
  try {
    await migrateAll(db);
    const owner = runner(db);
    await seedGraph(owner);
    await checkStructuralInvariants(owner);
    // Same grants as prisma/roles.sql, minus LOGIN/password: PGlite is a single in-process session, so we SET ROLE instead.
    await db.exec(confinedRole);
    await db.exec('SET ROLE atlas_app_test');
    await checkRlsInvariants(runner(db), { label: 'PGlite' });
    await db.exec('RESET ROLE');
    const asOwner = await db.query(`SELECT count(*)::int AS n FROM "Observation"`);
    assert.equal((asOwner.rows[0] as { n: number }).n, 3, 'the owner still sees everything: RLS is not FORCEd, which is why the app must not run as owner');
  } finally { await db.close(); }
});

test('runtime-role guard rejects ownership of any protected table and detects a table with RLS disabled', async () => {
  const db = new PGlite();
  try {
    await migrateAll(db);
    const owner = runner(db);
    await seedGraph(owner);
    await checkStructuralInvariants(owner); // populates RawEvent, so an owner-bypass is observable
    await db.exec(confinedRole);
    // The guard query runs as the confined role; reconfiguration runs as the owner.
    await checkRuntimeRoleGuard(owner, asConfinedRole(db), 'atlas_app_test', {});
  } finally { await db.close(); }
});

test('identities: token visible only for its own digest, actor and memberships only when named, no identity writes by the runtime role', async () => {
  const db = new PGlite();
  try {
    await migrateAll(db);
    const owner = runner(db);
    await seedGraph(owner);
    await seedIdentities(owner);
    await checkIdentityStructure(owner);
    await db.exec(confinedRole);
    await checkIdentityRlsInvariants(owner, asConfinedRole(db), { label: 'PGlite' });
  } finally { await db.close(); }
});

test('upgrade of a populated v1.0 database: legacy closures are marked, not invented; legacy events get a versioned key; unknown statuses stop the migration', async () => {
  const db = new PGlite();
  try {
    await db.exec(await sql(FOUNDATION));
    await db.exec(`
      INSERT INTO "Workspace" VALUES ('w','Demo'); INSERT INTO "Client" VALUES ('w','c1','Client 1');
      INSERT INTO "Connection" VALUES ('w','c1','a','atera','atera-demo','fixture://none','FIXTURE');
      INSERT INTO "RawEvent" VALUES ('w','c1','r1','a','alert-1','1','k1','{}','p1',now(),now(),'RECEIVED');
      INSERT INTO "RawEvent" VALUES ('w','c1','r2','a','alert-2','1','k2','{}','p2',now(),now(),'PROCESSED');
      INSERT INTO "Observation" VALUES ('w','c1','o-open','r1','OPERATIONS','MEDIUM','MONITOR',1,'LEGACY_CODE','OPEN',now());
      INSERT INTO "Observation" VALUES ('w','c1','o-closed','r2','SECURITY','CRITICAL','HUMAN_REVIEW',1,'LEGACY_CODE','RESOLVED',now());
    `);
    await db.exec(await sql(V11)); await db.exec(await sql(V112)); await migrateAfterFrozen(db);
    const rows = (await db.query<{ id: string; status: string; legacyClosure: boolean; resolvedBy: string | null; priority: string; severityRank: number; reasonCodes: string[] }>(
      `SELECT id, status, "legacyClosure", "resolvedBy", priority, "severityRank", "reasonCodes" FROM "Observation" ORDER BY id`)).rows;
    assert.deepEqual(rows.map(r => [r.id, r.status, r.legacyClosure, r.resolvedBy, r.priority, r.severityRank, r.reasonCodes]),
      [['o-closed', 'RESOLVED', true, null, 'URGENT', 4, ['LEGACY_CODE']], ['o-open', 'OPEN', false, null, 'NORMAL', 2, ['LEGACY_CODE']]]);
    const events = (await db.query<{ id: string; resourceType: string; eventKeyVersion: string }>(`SELECT id, "resourceType", "eventKeyVersion" FROM "RawEvent" ORDER BY id`)).rows;
    assert.deepEqual(events, [{ id: 'r1', resourceType: 'legacy-unknown', eventKeyVersion: 'v1' }, { id: 'r2', resourceType: 'legacy-unknown', eventKeyVersion: 'v1' }]);
    // New closures still need author and time; the legacy flag is not a loophole for new rows
    await assert.rejects(db.exec(`UPDATE "Observation" SET status='RESOLVED' WHERE id='o-open'`));
    await assert.rejects(db.exec(`UPDATE "Observation" SET status='RESOLVED', "legacyClosure"=true WHERE id='o-open'`), /legacyClosure/);
    await db.exec(`UPDATE "Observation" SET status='RESOLVED', "resolvedAt"=now(), "resolvedBy"='tech' WHERE id='o-open'`);
    // A legacy closure can be reopened (flag cleared) but never re-flagged
    await db.exec(`UPDATE "Observation" SET status='OPEN', "legacyClosure"=false WHERE id='o-closed'`);
    await assert.rejects(db.exec(`UPDATE "Observation" SET status='RESOLVED', "legacyClosure"=true WHERE id='o-closed'`), /legacyClosure/);
  } finally { await db.close(); }
  const bad = new PGlite();
  try {
    await bad.exec(await sql(FOUNDATION));
    await bad.exec(`
      INSERT INTO "Workspace" VALUES ('w','Demo'); INSERT INTO "Client" VALUES ('w','c1','Client 1');
      INSERT INTO "Connection" VALUES ('w','c1','a','atera','atera-demo','fixture://none','FIXTURE');
      INSERT INTO "RawEvent" VALUES ('w','c1','r1','a','alert-1','1','k1','{}','p1',now(),now(),'RECEIVED');
      INSERT INTO "Observation" VALUES ('w','c1','o-weird','r1','OPERATIONS','MEDIUM','MONITOR',1,'X','CLOSED_BY_SCRIPT',now());
    `);
    await assert.rejects(bad.exec(await sql(V11)), /preflight: Observation\.status/);
  } finally { await bad.close(); }
});

test('upgrade path 1.1.0 → 1.1.1 → 1.1.2 yields the same schema shape (columns, constraints, indexes, policies, triggers) and passes the same invariants as a fresh install', async () => {
  const fresh = new PGlite(); const upgraded = new PGlite();
  try {
    await migrateAll(fresh);
    await upgraded.exec(await sql(FOUNDATION)); await upgraded.exec(await sql(V110_AS_SHIPPED)); await upgraded.exec(await sql(UPGRADE)); await upgraded.exec(await sql(V112));
    await migrateAfterFrozen(upgraded);
    assert.deepEqual(await schemaShape(upgraded), await schemaShape(fresh));
    const owner = runner(upgraded);
    await seedGraph(owner);
    await checkStructuralInvariants(owner);
  } finally { await fresh.close(); await upgraded.close(); }
});
