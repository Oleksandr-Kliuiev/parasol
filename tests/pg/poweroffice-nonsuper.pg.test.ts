import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { assertRuntimeRole } from '../../packages/graph/scoped-db.ts';
import { adminUrl, createTestDatabase, provisionRoles, urlFor } from '../support/pg-harness.ts';
import type { PgTestDatabase } from '../support/pg-harness.ts';
import { CA, KEY_A, WS, addPowerOfficeFixtures, connect, inTx, scopeOf } from '../support/poweroffice-fixtures.ts';
import { SUMMARY, ageConnection, claimAttempt, publishAttempt } from '../support/poweroffice-history.ts';

// S4-A A2/A3 under the documented NON-superuser migration owner (CREATEDB/CREATEROLE): provisioning transfers the PowerOffice
// routine to its NOLOGIN definer with the owner's ADMIN+SET (never INHERIT) link and an ADMIN-only link to the runner; the
// owner itself is FORCE-RLS confined on the new tables (blank/foreign settings see nothing); the real confined runner purges
// with no 42501. A superuser connection is used ONLY for the aging fixture.
const root = new pg.Client({ connectionString: adminUrl() });
await root.connect();
const ownerRole = `atlas_po_nonsuper_${randomBytes(4).toString('hex')}`;
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
const db = (): PgTestDatabase => { if (setupError) throw setupError; return pgdb!; };

test('non-superuser owner: routine owned by the PowerOffice definer, exact owner links, temporary CREATE revoked, rerunnable provisioning', async () => {
  const { owner, roles } = db();
  const links = (await owner.query(`SELECT r.rolname AS role, m.admin_option AS admin, m.set_option AS set, m.inherit_option AS inherit FROM pg_auth_members m
    JOIN pg_roles r ON r.oid = m.roleid WHERE m.member = $1::regrole AND r.rolname IN ($2, $3) ORDER BY r.rolname = $3`, [ownerRole, roles.poDefiner, roles.poRunner])).rows;
  // PostgreSQL 16+: the creator's ADMIN-only link plus, for the definer, the owner's SET grant (separate grantor rows); never INHERIT.
  const of = (role: string) => links.filter(l => l.role === role);
  assert.ok(links.every(l => !l.inherit));
  assert.deepEqual([of(roles.poDefiner).some(l => l.admin), of(roles.poDefiner).some(l => l.set)], [true, true], 'definer: ADMIN + SET');
  assert.deepEqual(of(roles.poRunner), [{ role: roles.poRunner, admin: true, set: false, inherit: false }], 'runner: ADMIN only');
  assert.equal((await owner.query(`SELECT proowner::regrole::text AS o FROM pg_proc WHERE proname = 'atlas_poweroffice_cleanup'`)).rows[0].o, roles.poDefiner);
  assert.equal((await owner.query(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS c`, [roles.poDefiner])).rows[0].c, false);
  await provisionRoles(owner, roles, { runtimePassword: randomBytes(18).toString('hex'), runnerPassword: randomBytes(18).toString('hex') });
  const runtime = new PrismaClient({ datasourceUrl: db().runtimeUrl }); closers.push(() => runtime.$disconnect());
  await assertRuntimeRole(runtime);
});

test('the non-superuser owner is FORCE-RLS confined on PowerOffice rows; the real confined runner purges without 42501', async () => {
  const { owner } = db();
  await addPowerOfficeFixtures(owner);
  const runtime = await connect(db().runtimeUrl); closers.push(() => runtime.end());
  const claim = await inTx(runtime, scopeOf(KEY_A), c => claimAttempt(c, KEY_A, 'syncer'));
  await inTx(runtime, scopeOf(KEY_A), c => publishAttempt(c, KEY_A, claim, SUMMARY));
  const seen = (workspace: string, clients: string) => inTx(owner, { workspaceId: workspace, clientIds: clients }, async c =>
    (await c.query(`SELECT (SELECT count(*)::int FROM public."PowerOfficeState") + (SELECT count(*)::int FROM public."PowerOfficeAttempt")
      + (SELECT count(*)::int FROM public."PowerOfficeSnapshot") AS n`)).rows[0].n);
  assert.equal(await seen('', ''), 0, 'blank settings: nothing');
  assert.equal(await seen(WS, 'po-client-b'), 0, 'another client: nothing');
  assert.equal(await seen('po-ws-other', CA), 0, 'another workspace: nothing');
  assert.equal(await seen(WS, CA), 3, 'its own explicit scope only');
  // Aging needs replica mode (superuser-only fixture), on this database.
  const su = new pg.Client({ connectionString: Object.assign(new URL(adminUrl()), { pathname: `/${db().name}` }).toString() });
  await su.connect(); closers.push(() => su.end());
  await ageConnection(su, KEY_A, '25 hours');
  const runner = await connect(db().poRunnerUrl); closers.push(() => runner.end());
  await runner.query('BEGIN');
  await runner.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true), set_config('app.poweroffice_connection_id', 'po-a', true),
    set_config('app.actor_id', 'maintainer', true)`, [WS, CA]);
  const result = (await runner.query(`SELECT public.atlas_poweroffice_cleanup($1, $2, 'po-a', $3::uuid) AS r`, [WS, CA, randomUUID()])).rows[0].r;
  await runner.query('COMMIT');
  assert.deepEqual(result, { outcome: 'COMPLETED', clearedPointer: true, deletedSnapshots: 1, deletedAttempts: 0, morePending: false });
});

test('RC2 F1–F3 under the non-superuser owner: its own foreign schema/view/CREATE grants to either role fail readiness and are revoked by its provisioning', async () => {
  const { owner, roles } = db();
  const runtime = new PrismaClient({ datasourceUrl: db().runtimeUrl }); closers.push(() => runtime.$disconnect());
  await owner.query(`CREATE SCHEMA s4a_ns_extra; CREATE VIEW s4a_ns_extra.tokens AS SELECT count(*) AS n FROM public."ApiToken";
    GRANT USAGE, CREATE ON SCHEMA s4a_ns_extra TO "${roles.poRunner}", "${roles.poDefiner}";
    GRANT SELECT ON s4a_ns_extra.tokens TO "${roles.poRunner}", "${roles.poDefiner}"; GRANT CREATE ON SCHEMA public TO "${roles.poRunner}"`);
  try {
    await assert.rejects(assertRuntimeRole(runtime), /RUNTIME_ROLE_NOT_CONFINED/);
    await provisionRoles(owner, roles, { runtimePassword: randomBytes(18).toString('hex'), runnerPassword: randomBytes(18).toString('hex') });
    await assertRuntimeRole(runtime);
    for (const role of [roles.poRunner, roles.poDefiner]) {
      const r = (await owner.query(`SELECT has_table_privilege($1, 's4a_ns_extra.tokens', 'SELECT') AS v, has_schema_privilege($1, 's4a_ns_extra', 'USAGE') AS u,
        has_schema_privilege($1, 's4a_ns_extra', 'CREATE') AS c, has_schema_privilege($1, 'public', 'CREATE') AS p`, [role])).rows[0];
      assert.deepEqual(r, { v: false, u: false, c: false, p: false }, role);
    }
  } finally { await owner.query(`DROP SCHEMA s4a_ns_extra CASCADE`); }
  await assertRuntimeRole(runtime);
});
