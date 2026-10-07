import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * Throwaway PostgreSQL databases for the integration tests in tests/pg (npm run test:pg). Each database goes through the
 * documented production path, not a test shortcut: `prisma migrate deploy` as the owner, then prisma/roles.sql as the
 * owner (rendered for a uniquely named role, because roles are cluster-wide), then the application connects as that
 * confined LOGIN role. Requires ATLAS_PG_ADMIN_URL with CREATEDB and CREATEROLE (the compose superuser works locally).
 */
export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
/** The pinned Prisma CLI, run with this Node binary: no npx/shell lookup, so it behaves the same on every OS. */
export const PRISMA_CLI = fileURLToPath(new URL('../../node_modules/prisma/build/index.js', import.meta.url));

export interface PgTestDatabase {
  readonly name: string;
  readonly serverVersion: string;
  /** Owner (migrations, seed, fixtures). Bypasses RLS by design; never handed to application code under test. */
  readonly ownerUrl: string;
  /** Confined runtime role created by prisma/roles.sql. */
  readonly runtimeUrl: string;
  readonly runtimeRole: string;
  readonly owner: pg.Client;
  drop(): Promise<void>;
}

export function adminUrl(): string {
  const url = process.env.ATLAS_PG_ADMIN_URL;
  if (!url) throw new Error('Set ATLAS_PG_ADMIN_URL to a PostgreSQL 17 admin connection string (see .env.example) to run tests/pg.');
  return url;
}

/** prisma/roles.sql with the role name and the psql password variable substituted. Fails if the file changes shape. */
export function renderRolesSql(sql: string, role: string, password: string): string {
  if (sql.split(":'atlas_app_password'").length !== 2 || (sql.match(/\batlas_app\b/g)?.length ?? 0) < 6) {
    throw new Error('prisma/roles.sql changed shape; update renderRolesSql');
  }
  return sql.replaceAll(":'atlas_app_password'", `'${password}'`).replace(/\batlas_app\b/g, `"${role}"`);
}

/** Runs a project command with DATABASE_URL pointed at `url`; throws with bounded output on failure. */
export function runWithDatabase(url: string, command: string, args: string[], extraEnv: Record<string, string> = {}): string {
  const result = spawnSync(command, args, { cwd: projectRoot, encoding: 'utf8', env: { ...process.env, DATABASE_URL: url, ...extraEnv } });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}: ${(result.stderr || result.stdout).slice(0, 2000)}`);
  return result.stdout;
}
export const runSeed = (ownerUrl: string, extraEnv: Record<string, string> = {}): string =>
  runWithDatabase(ownerUrl, process.execPath, ['--experimental-strip-types', 'prisma/seed.ts'], extraEnv);

export async function createTestDatabase(): Promise<PgTestDatabase> {
  const suffix = randomBytes(4).toString('hex');
  const name = `atlas_it_${suffix}`;
  const runtimeRole = `atlas_app_it_${suffix}`;
  const password = randomBytes(18).toString('hex');
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  const serverVersion = (await admin.query('SHOW server_version')).rows[0].server_version as string;
  await admin.query(`CREATE DATABASE "${name}"`);
  const ownerUrl = new URL(adminUrl()); ownerUrl.pathname = `/${name}`;
  const runtimeUrl = new URL(ownerUrl.toString()); runtimeUrl.username = runtimeRole; runtimeUrl.password = password;
  const owner = new pg.Client({ connectionString: ownerUrl.toString() });
  const drop = async () => {
    await owner.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS "${runtimeRole}"`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  };
  try {
    runWithDatabase(ownerUrl.toString(), process.execPath, [PRISMA_CLI, 'migrate', 'deploy']);
    await owner.connect();
    await owner.query(renderRolesSql(await readFile(new URL('../../prisma/roles.sql', import.meta.url), 'utf8'), runtimeRole, password));
  } catch (error) { await drop(); throw error; }
  return { name, serverVersion, ownerUrl: ownerUrl.toString(), runtimeUrl: runtimeUrl.toString(), runtimeRole, owner, drop };
}

/** Same URL with a pool of exactly one connection, so consecutive transactions provably reuse one physical connection. */
export function singleConnection(url: string): string {
  const u = new URL(url); u.searchParams.set('connection_limit', '1'); return u.toString();
}
