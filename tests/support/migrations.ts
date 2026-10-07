import { readdir, readFile } from 'node:fs/promises';

/**
 * The migration set as `prisma migrate deploy` applies it: every directory under prisma/migrations, in lexicographic
 * (timestamp) order. Shared by the PGlite tests, scripts/pg17-check.ts and the PostgreSQL integration tests, so a new
 * migration is exercised everywhere without editing hard-coded lists.
 */
const migrationsDir = new URL('../../prisma/migrations/', import.meta.url);

export const FROZEN_V1_1_2 = '202610071500_v1_1_2_conflict_scope_and_legacy_guard';

export async function migrationNames(): Promise<string[]> {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  return entries.filter(e => e.isDirectory()).map(e => e.name).sort();
}
/** Migrations that come after `name` (exclusive), in apply order. */
export async function migrationsAfter(name: string): Promise<string[]> {
  const all = await migrationNames();
  if (!all.includes(name)) throw new Error(`unknown migration ${name}`);
  return all.filter(m => m > name);
}
export function migrationSql(name: string): Promise<string> {
  return readFile(new URL(`${name}/migration.sql`, migrationsDir), 'utf8');
}
