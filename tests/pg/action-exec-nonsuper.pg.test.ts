import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { assertRuntimeRole } from '../../packages/graph/scoped-db.ts';
import { adminUrl, createTestDatabase, urlFor } from '../support/pg-harness.ts';
import type { PgTestDatabase } from '../support/pg-harness.ts';
import { CA, CB, WA, addActionFixtures, privateDir, runtimeClient, scoped } from '../support/action-fixtures.ts';
import { actionFlow, addApprovalActors } from '../support/action-approval.ts';
import { addExecutionActors, exec, scriptedPorts } from '../support/action-exec.ts';

// Stage 3 S3-C, R2 under the documented NON-superuser migration owner (CREATEDB/CREATEROLE): provisioning grants the S3-C
// write surface, a complete execution reaches VERIFIED, and its attempt, verification and synthetic ticket are observed
// only through the explicitly scoped confined runtime — the FORCE-RLS owner sees none of them unscoped, and a blank or
// other-client runtime scope sees zero.
const root = new pg.Client({ connectionString: adminUrl() });
await root.connect();
const ownerRole = `atlas_nonsuper_${randomBytes(4).toString('hex')}`;
const ownerPassword = randomBytes(18).toString('hex');
await root.query(`CREATE ROLE "${ownerRole}" LOGIN NOSUPERUSER NOBYPASSRLS CREATEDB CREATEROLE PASSWORD '${ownerPassword}'`);
let pgdb: PgTestDatabase | undefined; let setupError: unknown = null;
try { pgdb = await createTestDatabase({ adminUrl: urlFor(adminUrl(), ownerRole, ownerPassword) }); } catch (error) { setupError = error; }
const closers: (() => Promise<unknown>)[] = [];
after(async () => {
  for (const close of closers) await close().catch(() => undefined);
  await pgdb?.drop().catch(() => undefined);
  const owner = (await root.query(`SELECT oid FROM pg_roles WHERE rolname = $1`, [ownerRole])).rows[0]?.oid;
  if (owner) {
    for (const r of (await root.query(`SELECT datname FROM pg_database WHERE datdba = $1`, [owner])).rows) await root.query(`DROP DATABASE IF EXISTS "${r.datname}" WITH (FORCE)`);
    for (const r of (await root.query(`SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid WHERE m.member = $1`, [owner])).rows) {
      await root.query(`DROP ROLE IF EXISTS "${r.rolname}"`).catch(() => undefined);
    }
    await root.query(`DROP ROLE IF EXISTS "${ownerRole}"`);
  }
  await root.end();
});

test('non-superuser owner: execution to VERIFIED; attempt/verification/ticket observed only through the scoped runtime', async () => {
  if (setupError) throw setupError;
  const { owner } = pgdb!;
  assert.deepEqual((await owner.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`)).rows[0], { rolsuper: false, rolbypassrls: false });
  const db = new PrismaClient({ datasourceUrl: pgdb!.runtimeUrl }); closers.push(() => db.$disconnect());
  const runtime = await runtimeClient(pgdb!.runtimeUrl); closers.push(() => runtime.end());
  const files = await privateDir(); closers.push(files.remove);
  await assertRuntimeRole(db);
  await addActionFixtures(owner);
  await addApprovalActors(owner);
  await addExecutionActors(owner);
  const r = await actionFlow(db, files).approved();
  const { ports, calls } = scriptedPorts(db);
  assert.deepEqual([(await exec(db, ports, r)).state, calls.create, calls.read], ['VERIFIED', 1, 1]);
  const count = async (client: pg.Client, sql: string, ws = WA, clients = CA) =>
    client === owner ? (await owner.query(sql)).rows[0].n as number : (await scoped<{ n: number }>(runtime, ws, clients, sql))[0]!.n;
  for (const table of ['ActionAttempt', 'ActionVerification', 'ActionMockTicket']) {
    const sql = `SELECT count(*)::int AS n FROM "${table}"`;
    assert.deepEqual([await count(owner, sql), await count(runtime, sql), await count(runtime, sql, WA, CB), await count(runtime, sql, '', '')], [0, 1, 0, 0], table);
  }
});
