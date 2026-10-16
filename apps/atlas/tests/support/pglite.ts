import type { PGlite } from '@electric-sql/pglite';
import type { SqlRunner } from '../sql-invariants.ts';
import { migrationNames, migrationSql } from './migrations.ts';
import { readRolesSql, renderRolesSql } from './roles-sql.ts';
import type { RoleNames } from './roles-sql.ts';

/**
 * PGlite helpers for the in-process SQL tests (tests/database.test.ts, tests/m365-database.test.ts). Migrations run as
 * the superuser session without any pre-created role, exactly as `prisma migrate deploy` would; the production
 * prisma/roles.sql provisions the roles afterwards. PGlite is one session, so a confined role is entered with SET ROLE.
 */
export const PGLITE_ROLES: RoleNames = { runtime: 'atlas_app_test', definer: 'atlas_def_test', runner: 'atlas_run_test', fence: 'atlas_fen_test',
  poDefiner: 'atlas_pod_test', poRunner: 'atlas_por_test' };
const PGLITE_SECRETS = { runtimePassword: 'pgliteRuntimeLocalOnly', runnerPassword: 'pgliteRunnerLocalOnly', poRunnerPassword: 'pglitePoRunnerLocalOnly' };

/** Fresh install: every migration in apply order. */
export async function migrateAll(db: PGlite): Promise<void> { for (const m of await migrationNames()) await db.exec(await migrationSql(m)); }
/** prisma/roles.sql (production grants) for the PGlite role names. */
export async function provisionRoles(db: PGlite): Promise<void> { await db.exec(renderRolesSql(await readRolesSql(), PGLITE_ROLES, PGLITE_SECRETS)); }

export function runner(db: PGlite): SqlRunner {
  return {
    exec: s => db.exec(s).then(() => undefined),
    query: async (s, params) => (await db.query(s, params as never)).rows as never
  };
}
/**
 * Statements run as `role` (default: the runtime role), everything else as the owner: each call switches the session
 * identity. SET SESSION AUTHORIZATION, not SET ROLE: like a real login, session_user is then the role itself (the runtime
 * self-check refuses a SET ROLE from another session user). PGlite ignores RESET/DEFAULT here, so the owner is restored by
 * name. A statement that aborts an explicit transaction leaves the session as the owner with the transaction rolled back.
 */
export function asRole(db: PGlite, role: string = PGLITE_ROLES.runtime): SqlRunner {
  const as = async <T>(fn: () => Promise<T>): Promise<T> => {
    const owner = (await db.query<{ u: string }>('SELECT session_user AS u')).rows[0]!.u;
    await db.exec(`SET SESSION AUTHORIZATION ${role}`);
    try { return await fn(); }
    finally {
      try { await db.exec(`SET SESSION AUTHORIZATION "${owner}"`); }
      catch { await db.exec('ROLLBACK'); await db.exec(`SET SESSION AUTHORIZATION "${owner}"`); }
    }
  };
  return { exec: s => as(() => db.exec(s).then(() => undefined)), query: (s, params) => as(async () => (await db.query(s, params as never)).rows as never) };
}
