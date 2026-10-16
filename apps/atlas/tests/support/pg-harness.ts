import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { dropRolesSql, readRolesSql, remoteRoleName, renderRolesSql, revalRoleNames, uniqueRoleNames } from './roles-sql.ts';
import type { RoleNames, RoleSecrets } from './roles-sql.ts';
import { migrationsThrough } from './migrations.ts';

/**
 * Throwaway PostgreSQL databases for the integration tests in tests/pg (npm run test:pg). Each database goes through the
 * documented production path, not a test shortcut: `prisma migrate deploy` as the owner, then prisma/roles.sql as the
 * owner (rendered for uniquely named runtime/definer/runner/fence/PowerOffice definer/PowerOffice runner/remote definer/R-EVAL
 * evidence definer/evidence reader roles, because roles are cluster-wide; all nine are dropped with the database), then the application connects as that confined LOGIN role. Requires ATLAS_PG_ADMIN_URL with
 * CREATEDB and CREATEROLE (the compose superuser works locally).
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
  /** NOLOGIN owner of the cleanup routine and the EXECUTE-only cleanup runner (its own credential), both from roles.sql. */
  readonly definerRole: string;
  /** NOLOGIN owner of the Stage 3 action fence trigger function (roles.sql). */
  readonly fenceRole: string;
  readonly runnerRole: string;
  readonly runnerUrl: string;
  /** Stage 4: NOLOGIN owner of the PowerOffice cleanup routine and its EXECUTE-only runner (own credential), from roles.sql. */
  readonly poDefinerRole: string;
  readonly poRunnerRole: string;
  readonly poRunnerUrl: string;
  /** Stage 5 ASK-REMOTE: NOLOGIN owner of the atlas_ask_remote_* routines, from roles.sql. */
  readonly remoteRole: string;
  /** R-EVAL RS-A: NOLOGIN owner of atlas_reval_snapshot() and the EXECUTE-only evidence-reader LOGIN (roles/reval.sql). */
  readonly revalDefinerRole: string;
  readonly revalReaderRole: string;
  readonly revalReaderUrl: string;
  /** The evidence reader's password (test-only; written to a 0600 secret file by tests that need it, never printed). */
  readonly revalReaderPassword: string;
  /** Every role name of this database, as prisma/roles.sql renders them. */
  readonly roles: RoleNames;
  readonly owner: pg.Client;
  drop(): Promise<void>;
}

export function adminUrl(): string {
  const url = process.env.ATLAS_PG_ADMIN_URL;
  if (!url) throw new Error('Set ATLAS_PG_ADMIN_URL to a PostgreSQL 17 admin connection string (see .env.example) to run tests/pg.');
  return url;
}
export { renderRolesSql } from './roles-sql.ts';
/** Runs prisma/roles.sql (production grants) as the owner for these role names; used again by the upgrade tests. */
export async function provisionRoles(owner: pg.Client, names: RoleNames, secrets: RoleSecrets): Promise<void> {
  await owner.query(renderRolesSql(await readRolesSql(), names, secrets));
}
/** A URL of the same database for another login role. */
export function urlFor(url: string, role: string, password: string): string {
  const u = new URL(url); u.username = role; u.password = password; return u.toString();
}
/** Deploys only the migrations up to and including `last` (an older release), through the pinned Prisma CLI. */
export async function deployMigrationsThrough(url: string, last: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-migrations-'));
  try {
    await mkdir(join(dir, 'migrations'));
    // The schema folder (prisma/*.prisma), with the migrations next to the file holding the datasource, as in prisma/
    const prismaDir = fileURLToPath(new URL('../../prisma/', import.meta.url));
    for (const file of (await readdir(prismaDir)).filter(f => f.endsWith('.prisma'))) await copyFile(join(prismaDir, file), join(dir, file));
    await copyFile(join(prismaDir, 'migrations', 'migration_lock.toml'), join(dir, 'migrations', 'migration_lock.toml'));
    for (const name of await migrationsThrough(last)) {
      await cp(join(prismaDir, 'migrations', name), join(dir, 'migrations', name), { recursive: true });
    }
    runWithDatabase(url, process.execPath, [PRISMA_CLI, 'migrate', 'deploy', '--schema', dir]);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** Runs a project command with DATABASE_URL pointed at `url`; throws with bounded output on failure. */
export function runWithDatabase(url: string, command: string, args: string[], extraEnv: Record<string, string> = {}): string {
  const result = spawnSync(command, args, { cwd: projectRoot, encoding: 'utf8', env: { ...process.env, DATABASE_URL: url, ...extraEnv } });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}: ${(result.stderr || result.stdout).slice(0, 2000)}`);
  return result.stdout;
}
/** The synthetic seed; tokens only when a test passes them, never inherited from the developer's shell. */
export const runSeed = (ownerUrl: string, extraEnv: Record<string, string> = {}): string =>
  runWithDatabase(ownerUrl, process.execPath, ['--experimental-strip-types', 'prisma/seed.ts'], { ATLAS_DEMO_TOKEN: '', ATLAS_OPERATOR_TOKEN: '', ...extraEnv });

export interface TestDatabaseOptions {
  /** Deploy only up to this migration and skip roles.sql: the state of an older release, for upgrade tests. */
  migrateThrough?: string;
  /** false: migrate but leave prisma/roles.sql to the test (its role names are still the ones dropped by drop()). */
  provision?: boolean;
  /** Another administrator (for example a non-superuser with CREATEDB and CREATEROLE): it creates, owns and drops everything. */
  adminUrl?: string;
}
export async function createTestDatabase(options: TestDatabaseOptions = {}): Promise<PgTestDatabase> {
  const suffix = randomBytes(4).toString('hex');
  const name = `atlas_it_${suffix}`;
  const roles = uniqueRoleNames('it', suffix);
  const secrets = { runtimePassword: randomBytes(18).toString('hex'), runnerPassword: randomBytes(18).toString('hex'), poRunnerPassword: randomBytes(18).toString('hex'),
    revalReaderPassword: randomBytes(18).toString('hex') };
  const admin = new pg.Client({ connectionString: options.adminUrl ?? adminUrl() });
  await admin.connect();
  const serverVersion = (await admin.query('SHOW server_version')).rows[0].server_version as string;
  await admin.query(`CREATE DATABASE "${name}"`);
  const ownerUrl = new URL(options.adminUrl ?? adminUrl()); ownerUrl.pathname = `/${name}`;
  const owner = new pg.Client({ connectionString: ownerUrl.toString() });
  const drop = async () => {
    await owner.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
    for (const statement of dropRolesSql(roles)) await admin.query(statement).catch(() => undefined);
    await admin.end().catch(() => undefined);
  };
  try {
    if (options.migrateThrough) await deployMigrationsThrough(ownerUrl.toString(), options.migrateThrough);
    else runWithDatabase(ownerUrl.toString(), process.execPath, [PRISMA_CLI, 'migrate', 'deploy']);
    await owner.connect();
    if (!options.migrateThrough && options.provision !== false) await provisionRoles(owner, roles, secrets);
  } catch (error) { await drop(); throw error; }
  return { name, serverVersion, ownerUrl: ownerUrl.toString(), runtimeUrl: urlFor(ownerUrl.toString(), roles.runtime, secrets.runtimePassword),
    runtimeRole: roles.runtime, definerRole: roles.definer, fenceRole: roles.fence, runnerRole: roles.runner, runnerUrl: urlFor(ownerUrl.toString(), roles.runner, secrets.runnerPassword),
    poDefinerRole: roles.poDefiner, poRunnerRole: roles.poRunner, poRunnerUrl: urlFor(ownerUrl.toString(), roles.poRunner, secrets.poRunnerPassword),
    remoteRole: remoteRoleName(roles), revalDefinerRole: revalRoleNames(roles).definer, revalReaderRole: revalRoleNames(roles).reader,
    revalReaderUrl: urlFor(ownerUrl.toString(), revalRoleNames(roles).reader, secrets.revalReaderPassword), revalReaderPassword: secrets.revalReaderPassword,
    roles, owner, drop };
}

/** Same URL with a pool of exactly one connection, so consecutive transactions provably reuse one physical connection. */
export function singleConnection(url: string): string {
  const u = new URL(url); u.searchParams.set('connection_limit', '1'); return u.toString();
}
