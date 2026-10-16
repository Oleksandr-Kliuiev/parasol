import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { adminUrl, createTestDatabase, urlFor } from './pg-harness.ts';
import type { PgTestDatabase, TestDatabaseOptions } from './pg-harness.ts';
import { REVAL_READY_SQL } from '../../packages/graph/reval-role.ts';
import type { RevalFacts } from '../../packages/graph/reval-role.ts';

/**
 * R-EVAL RS-A PG17 tests run under a dedicated NOSUPERUSER NOBYPASSRLS LOGIN migration owner (CREATEDB + CREATEROLE, the
 * documented non-superuser path): it runs `prisma migrate deploy` and prisma/roles.sql (its non-superuser branch) and so
 * owns the tables. The compose superuser only bootstraps that owner and cleans up; it never reaches an owner config.
 */
export interface NonsuperDb {
  readonly db: PgTestDatabase; readonly ownerRole: string; readonly ownerPassword: string; readonly ownerUrl: string;
  /** Superuser client on the test database (bootstrap/cleanup/catalog drift injection only). */
  readonly admin: pg.Client;
  cleanup(): Promise<void>;
}
export async function nonsuperDatabase(options: Omit<TestDatabaseOptions, 'adminUrl'> = {}): Promise<NonsuperDb> {
  const root = new pg.Client({ connectionString: adminUrl() }); await root.connect();
  const ownerRole = `atlas_rv_owner_${randomBytes(4).toString('hex')}`; const ownerPassword = randomBytes(18).toString('hex');
  await root.query(`CREATE ROLE "${ownerRole}" LOGIN NOSUPERUSER NOBYPASSRLS CREATEDB CREATEROLE PASSWORD '${ownerPassword}'`);
  const cleanup = async () => {
    const owner = (await root.query(`SELECT oid FROM pg_roles WHERE rolname = $1`, [ownerRole])).rows[0]?.oid;
    if (owner) {
      for (const r of (await root.query(`SELECT datname FROM pg_database WHERE datdba = $1`, [owner])).rows) await root.query(`DROP DATABASE IF EXISTS "${r.datname}" WITH (FORCE)`);
      for (const r of (await root.query(`SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid WHERE m.member = $1`, [owner])).rows) {
        await root.query(`DROP ROLE IF EXISTS "${r.rolname}"`).catch(() => undefined);
      }
      await root.query(`DROP ROLE IF EXISTS "${ownerRole}"`).catch(() => undefined);
    }
    await root.end().catch(() => undefined);
  };
  try {
    const db = await createTestDatabase({ ...options, adminUrl: urlFor(adminUrl(), ownerRole, ownerPassword) });
    const u = new URL(adminUrl()); u.pathname = `/${db.name}`;
    const admin = new pg.Client({ connectionString: u.toString() }); await admin.connect();
    return { db, ownerRole, ownerPassword, ownerUrl: db.ownerUrl, admin,
      cleanup: async () => { await admin.end().catch(() => undefined); await db.drop().catch(() => undefined); await cleanup(); } };
  } catch (error) { await cleanup(); throw error; }
}
/** rolsuper/rolbypassrls of the roles actually used (recorded as evidence). */
export async function roleFlags(client: pg.Client, roles: readonly string[]): Promise<Record<string, { super: boolean; bypassRls: boolean; login: boolean }>> {
  const rows = (await client.query(`SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = ANY($1)`, [roles])).rows;
  return Object.fromEntries(rows.map(r => [r.rolname, { super: r.rolsuper, bypassRls: r.rolbypassrls, login: r.rolcanlogin }]));
}
/** The R-EVAL readiness facts evaluated as `url`'s role (the runtime in production). */
export async function revalFacts(url: string): Promise<RevalFacts> {
  const c = new pg.Client({ connectionString: url }); await c.connect();
  try { return (await c.query(REVAL_READY_SQL)).rows[0] as RevalFacts; } finally { await c.end(); }
}
export const violations = (f: RevalFacts): number => Object.values(f).reduce((n: number, v) => n + Number(v), 0);
