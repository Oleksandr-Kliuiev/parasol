import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { assertRuntimeRole } from '../../packages/graph/scoped-db.ts';
import { adminUrl, createTestDatabase, provisionRoles, urlFor } from '../support/pg-harness.ts';
import type { PgTestDatabase } from '../support/pg-harness.ts';
import { RA, RW, activate, addRemoteFixtures, connectAs, ledger, ownerScoped, policyRow, reserveOnce, revise, settleOnce, sqlstate } from '../support/ask-remote-pg.ts';

// ASK-REMOTE R-A under the documented NON-superuser migration owner (CREATEDB/CREATEROLE) on PostgreSQL 17: provisioning
// transfers all eight routines to the NOLOGIN remote definer through the owner's ADMIN+SET link (never INHERIT) with the
// temporary schema CREATE revoked again; it is rerunnable; the owner is itself FORCE-RLS confined on the remote tables,
// provisions only through the trusted routines (direct DML refused) and the real confined runtime reserves and settles.
const root = new pg.Client({ connectionString: adminUrl() });
await root.connect();
const ownerRole = `atlas_ar_nonsuper_${randomBytes(4).toString('hex')}`;
const ownerPassword = randomBytes(18).toString('hex');
await root.query(`CREATE ROLE "${ownerRole}" LOGIN NOSUPERUSER NOBYPASSRLS CREATEDB CREATEROLE PASSWORD '${ownerPassword}'`);
let pgdb: PgTestDatabase | undefined; let setupError: unknown = null;
try { pgdb = await createTestDatabase({ adminUrl: urlFor(adminUrl(), ownerRole, ownerPassword) }); } catch (error) { setupError = error; }
after(async () => {
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
const db = (): PgTestDatabase => { if (setupError) throw setupError; return pgdb!; };

test('non-superuser owner: remote definer owns the routines, owner holds ADMIN+SET without INHERIT, no leftover CREATE, rerunnable', async () => {
  const { owner, remoteRole } = db();
  assert.equal((await owner.query(`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`)).rows[0].rolsuper, false);
  const owners = (await owner.query(`SELECT DISTINCT proowner::regrole::text AS o FROM pg_proc WHERE proname LIKE 'atlas\\_ask\\_remote\\_%'`)).rows.map(r => r.o);
  assert.deepEqual(owners, [remoteRole]);
  const links = (await owner.query(`SELECT m.admin_option AS admin, m.set_option AS set, m.inherit_option AS inherit FROM pg_auth_members m
    WHERE m.roleid = $1::regrole AND m.member = $2::regrole`, [remoteRole, ownerRole])).rows;
  assert.ok(links.length > 0 && links.every(l => !l.inherit), 'never INHERIT');
  assert.ok(links.some(l => l.set), 'SET for the ownership transfer and ACL resets');
  assert.equal((await owner.query(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS c`, [remoteRole])).rows[0].c, false);
  await provisionRoles(owner, db().roles, { runtimePassword: randomBytes(18).toString('hex'), runnerPassword: randomBytes(18).toString('hex') });
  assert.equal((await owner.query(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS c`, [remoteRole])).rows[0].c, false);
  const runtime = new PrismaClient({ datasourceUrl: db().runtimeUrl });
  try { await assertRuntimeRole(runtime); } finally { await runtime.$disconnect(); }
});

test('non-superuser owner is FORCE-RLS confined and provisions only through the trusted routines; the confined runtime reserves and settles', async () => {
  const { owner } = db();
  await addRemoteFixtures(owner);
  const policy = await activate(owner, RW, [RA]);
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM "RemoteAskPolicy"`)).rows[0].n, 0, 'blank settings see nothing (FORCE RLS on the owner)');
  assert.equal((await policyRow(owner, RW))!.state, 'ACTIVE');
  assert.equal(await sqlstate(owner.query(`SELECT public.atlas_ask_remote_client_set($1, $2::uuid, $3, $4::bigint, false)`,
    [RW, policy.admissionId, RA, policy.policyVersion])), 'AR004', 'routine refuses without the captured workspace setting');
  assert.equal(await sqlstate(ownerScoped(owner, RW, () => owner.query(`UPDATE "RemoteAskPolicy" SET state = 'PAUSED', "stateReason" = 'OWNER'`))), 'AR007',
    'direct owner DML is not provisioning');
  const runtime = await connectAs(db().runtimeUrl);
  try {
    const a = await reserveOnce(runtime, RW, RA, policy);
    assert.equal(await settleOnce(runtime, RW, RA, a, 'USAGE_VERIFIED', { promptTokens: 4000, completionTokens: 512 }), '1523');
    assert.deepEqual((await ledger(owner, RW)).counters.map(c => c.charged), ['1523', '1523']);
    const revoked = await revise(owner, RW, { state: 'REVOKED' });
    assert.equal(await sqlstate(reserveOnce(runtime, RW, RA, { admissionId: policy.admissionId, policyVersion: revoked })), 'AR001');
  } finally { await runtime.end(); }
});
