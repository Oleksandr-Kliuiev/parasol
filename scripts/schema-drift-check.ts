import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

/**
 * Drift check: the migrations, applied to a throwaway shadow database on a real PostgreSQL server, must produce exactly
 * the schema that prisma/schema.prisma describes. A non-empty diff means a new migration and the Prisma models disagree
 * (or `prisma migrate dev` would later generate unreviewed changes). CHECKs, partial indexes, triggers and RLS are not
 * part of the Prisma datamodel and are verified by tests/sql-invariants.ts instead.
 *
 *   ATLAS_PG_ADMIN_URL=postgresql://atlas:atlas_local_only@127.0.0.1:5432/atlas npm run db:check:drift
 */
const adminUrl = process.env.ATLAS_PG_ADMIN_URL;
if (!adminUrl) { console.error('Set ATLAS_PG_ADMIN_URL to a PostgreSQL 17 admin connection string (needs CREATEDB).'); process.exit(2); }
const dbName = `atlas_drift_${randomBytes(4).toString('hex')}`;
const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
let exitCode = 1;
try {
  await admin.query(`CREATE DATABASE "${dbName}"`);
  const shadowUrl = new URL(adminUrl); shadowUrl.pathname = `/${dbName}`;
  const result = spawnSync('npx', ['prisma', 'migrate', 'diff', '--from-migrations', 'prisma/migrations', '--to-schema-datamodel',
    'prisma/schema.prisma', '--shadow-database-url', shadowUrl.toString(), '--script', '--exit-code'], { encoding: 'utf8' });
  // --exit-code: 0 = no difference, 2 = difference, 1 = error. Prisma's informational lines go to stderr.
  const diff = result.stdout.split('\n').filter(l => l.trim() !== '' && !/^-- This is an empty migration\.?$/.test(l.trim())).join('\n');
  if (result.status === 0) { console.log('PASS schema drift: migrations and prisma/schema.prisma describe the same schema'); exitCode = 0; }
  else if (result.status === 2) console.error(`FAIL schema drift: migrations and prisma/schema.prisma differ:\n${diff}`);
  else console.error(`ERROR prisma migrate diff exited with ${result.status}:\n${result.stderr.slice(0, 2000)}`);
} finally {
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => undefined);
  await admin.end();
}
process.exit(exitCode);
