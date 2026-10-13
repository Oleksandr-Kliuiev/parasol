import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { assertRuntimeRole } from '../../packages/graph/scoped-db.ts';
import { actionCredential } from '../../packages/actions/authority.ts';
import { previewAction, requestAction } from '../../packages/actions/requests.ts';
import { adminUrl, createTestDatabase, provisionRoles, urlFor } from '../support/pg-harness.ts';
import type { PgTestDatabase } from '../support/pg-harness.ts';
import { CA, MOCK, WA, WB, addActionFixtures, fenceVersion, privateDir, runtimeClient, scoped, tokens } from '../support/action-fixtures.ts';

// Stage 3 S3-A, A5/A6 under the documented NON-superuser migration owner (CREATEDB/CREATEROLE). The fence table is FORCE
// RLS, so this owner has no unscoped access to it — yet its auth/Connection writes, with a blank or a wrong app.* setting,
// still increment exactly their own workspace fence through the dedicated definer. A missing fence row rolls the owner's
// write back (ACTION_FENCE_NOT_READY); trusted provisioning counts global completeness as owner + fence definer.
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
const db = (): PgTestDatabase => { if (setupError) throw setupError; return pgdb!; };
const names = () => ({ runtime: db().runtimeRole, definer: db().definerRole, runner: db().runnerRole, fence: db().fenceRole, poDefiner: db().poDefinerRole, poRunner: db().poRunnerRole });
const reprovision = () => provisionRoles(db().owner, names(), { runtimePassword: randomBytes(18).toString('hex'), runnerPassword: randomBytes(18).toString('hex') });
let runtime: pg.Client; let prisma: PrismaClient;
const files = await privateDir(); closers.push(files.remove);

test('non-superuser owner: fresh provisioning, the definer link is ADMIN+SET without INHERIT; owner writes with blank/wrong GUC increment their own fence', async () => {
  const { owner } = db();
  assert.deepEqual((await owner.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`)).rows[0], { rolsuper: false, rolbypassrls: false });
  runtime = await runtimeClient(db().runtimeUrl); closers.push(() => runtime.end());
  prisma = new PrismaClient({ datasourceUrl: db().runtimeUrl }); closers.push(() => prisma.$disconnect());
  await assertRuntimeRole(prisma);
  // PostgreSQL 16+: the creator's ADMIN link (granted by the bootstrap superuser) plus roles.sql's own SET grant; never INHERIT
  assert.deepEqual((await owner.query(`SELECT bool_or(m.admin_option) AS admin, bool_or(m.set_option) AS set, bool_or(m.inherit_option) AS inherit,
      bool_and(m.member = $2::regrole) AS only_owner FROM pg_auth_members m WHERE m.roleid = $1::regrole`, [names().fence, ownerRole])).rows,
    [{ admin: true, set: true, inherit: false, only_owner: true }]);
  await addActionFixtures(owner); // blank GUC: Workspace inserts create fences, auth/Connection inserts increment them
  const a0 = await fenceVersion(runtime, WA) as number; const b0 = await fenceVersion(runtime, WB) as number;
  assert.ok(a0 > 0 && b0 > 0);
  await owner.query('BEGIN');
  await owner.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', 'act-client-x', true)`, [WB]);
  await owner.query(`UPDATE "Actor" SET "displayName" = 'renamed' WHERE "workspaceId" = $1 AND id = 'reader'`, [WA]);
  await owner.query(`UPDATE "Connection" SET "secretRef" = "secretRef" WHERE "workspaceId" = $1 AND id = 'atera-a'`, [WA]);
  await owner.query('COMMIT');
  assert.equal(await fenceVersion(runtime, WA), a0 + 2, 'derived from the affected rows, not from app.workspace_id');
  assert.equal(await fenceVersion(runtime, WB), b0);
});

test('FORCE RLS confines the non-superuser owner on action tables: unscoped it sees and writes nothing; the scoped runtime observes the request', async () => {
  const { owner } = db();
  const input = await files.input({ connectionId: 'atera-a', title: 'Owner confinement', description: 'Body', idempotencyKey: '21111111-2222-4333-8444-555555555555' });
  const credential = actionCredential(tokens.requester!);
  const preview = await previewAction(prisma, MOCK, credential, CA, input, files.out('owner-preview.json'));
  const stored = await requestAction(prisma, MOCK, credential, CA, input, preview.inputHash);
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM "ActionRequest"`)).rows[0].n, 0, 'owner without scope: zero rows');
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM "ActionAuthorityFence"`)).rows[0].n, 0, 'nor any fence row');
  assert.equal((await owner.query(`UPDATE "ActionRequest" SET state = 'APPROVED'`)).rowCount, 0, 'no visible row to change');
  await assert.rejects(owner.query(`INSERT INTO "ActionAuthorityFence" ("workspaceId", version) VALUES ('act-ghost', 0)`), /row-level security/);
  assert.deepEqual((await scoped(runtime, WA, CA, `SELECT id, state FROM "ActionRequest"`)).map(r => [r.id, r.state]), [[stored.requestId, 'AWAITING_APPROVAL']]);
  assert.deepEqual(await scoped(runtime, '', '', `SELECT id FROM "ActionRequest"`), [], 'blank runtime scope: zero');
});

test('a missing fence row rolls the owner\'s write back (ACTION_FENCE_NOT_READY) and fails trusted provisioning; an offline repair keeps the epoch', async () => {
  const { owner } = db();
  const before = await fenceVersion(runtime, WA) as number;
  // Offline owner DDL (outside supported operation) simulates a lost row; the self-guard is restored immediately.
  await owner.query('BEGIN');
  await owner.query(`ALTER TABLE "ActionAuthorityFence" DISABLE TRIGGER "ActionAuthorityFence_guard"`);
  await owner.query(`SELECT set_config('app.workspace_id', $1, true)`, [WA]);
  assert.equal((await owner.query(`DELETE FROM "ActionAuthorityFence" WHERE "workspaceId" = $1`, [WA])).rowCount, 1);
  await owner.query(`ALTER TABLE "ActionAuthorityFence" ENABLE ALWAYS TRIGGER "ActionAuthorityFence_guard"`);
  await owner.query('COMMIT');
  await assert.rejects(owner.query(`UPDATE "Actor" SET "displayName" = 'lost' WHERE "workspaceId" = $1 AND id = 'reader'`, [WA]),
    (e: { code?: string; message?: string }) => e.code === 'AT001' && e.message === 'ACTION_FENCE_NOT_READY');
  await assert.rejects(owner.query(`INSERT INTO "ApiToken" ("workspaceId", id, "actorId", "tokenHash") VALUES ($1, 'tok-x', 'reader', $2)`, [WA, 'e'.repeat(64)]),
    (e: { code?: string }) => e.code === 'AT001');
  assert.deepEqual((await owner.query(`SELECT "displayName" FROM "Actor" WHERE "workspaceId" = $1 AND id = 'reader'`, [WA])).rows, [{ displayName: 'renamed' }], 'rolled back');
  await assert.rejects(reprovision(), /action authority fence is incomplete/);
  await owner.query('ROLLBACK');
  await assert.rejects(previewAction(prisma, MOCK, actionCredential(tokens.requester!), CA,
    await files.input({ connectionId: 'atera-a', title: 'x', description: 'y', idempotencyKey: '31111111-2222-4333-8444-555555555555' }), files.out('lost.json')),
    /ACTION_FENCE_NOT_READY/);
  // Separately reviewed offline repair: the same monotonic version, never a reset to 0
  await owner.query('BEGIN');
  await owner.query(`ALTER TABLE "ActionAuthorityFence" DISABLE TRIGGER "ActionAuthorityFence_guard"`);
  await owner.query(`SELECT set_config('app.workspace_id', $1, true)`, [WA]);
  await owner.query(`INSERT INTO "ActionAuthorityFence" ("workspaceId", version) VALUES ($1, $2)`, [WA, before]);
  await owner.query(`ALTER TABLE "ActionAuthorityFence" ENABLE ALWAYS TRIGGER "ActionAuthorityFence_guard"`);
  await owner.query('COMMIT');
  await reprovision();
  await assertRuntimeRole(prisma);
  await owner.query(`UPDATE "Actor" SET "displayName" = 'repaired' WHERE "workspaceId" = $1 AND id = 'reader'`, [WA]);
  assert.equal(await fenceVersion(runtime, WA), before + 1);
});
