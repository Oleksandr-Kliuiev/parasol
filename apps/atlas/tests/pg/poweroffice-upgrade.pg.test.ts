import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { generateToken } from '../../packages/auth/token.ts';
import { actionCredential, withFencedAdmission } from '../../packages/actions/authority.ts';
import { ACTION_FENCE_READY_SQL, actionFenceProblems } from '../../packages/graph/fence-role.ts';
import type { ActionFenceFacts } from '../../packages/graph/fence-role.ts';
import { assertRuntimeRole } from '../../packages/graph/scoped-db.ts';
import { powerOfficeCredential, withPowerOfficeAuthority } from '../../packages/poweroffice/authority.ts';
import { migrationNames } from '../support/migrations.ts';
import { PRISMA_CLI, createTestDatabase, runSeed, runWithDatabase, urlFor } from '../support/pg-harness.ts';
import { readRolesSql, readS3cRolesSql, renderRolesSql, renderStage3RolesSql } from '../support/roles-sql.ts';

// S4-A R2 on PostgreSQL 17: a populated deployment of the accepted Stage 3 (all 20 migrations, the byte-exact accepted S3-C
// roles.sql, seeded actors/tokens/connections, fences) upgrades with `prisma migrate deploy`. Immediately after the new
// migrations and BEFORE role provisioning, the Stage 3 fence readiness still passes (no PUBLIC routine, no new fence-definer
// privilege) and Stage 3 admissions keep working, while the runtime startup check and every PowerOffice admission refuse.
// The current roles.sql then provisions the two PowerOffice roles; data, fences, memberships, credentials and the runtime's
// Connection privileges are preserved, the permission vocabulary only grows and nothing is assigned automatically.
const S3_LAST = '202610091100_stage3_action_requests';
const pgdb = await createTestDatabase({ migrateThrough: S3_LAST });
after(async () => { await pgdb.drop(); });
const owner = pgdb.owner;
const secrets = () => ({ runtimePassword: randomBytes(18).toString('hex'), runnerPassword: randomBytes(18).toString('hex') });
const snapshotOf = async () => ({
  fences: (await owner.query(`SELECT "workspaceId", version FROM "ActionAuthorityFence" ORDER BY 1`)).rows,
  memberships: (await owner.query(`SELECT "workspaceId", "clientId", "actorId", permissions FROM "ClientMembership" ORDER BY 1, 2, 3`)).rows,
  counts: (await owner.query(`SELECT (SELECT count(*)::int FROM "Connection") AS c, (SELECT count(*)::int FROM "ApiToken") AS t, (SELECT count(*)::int FROM "Actor") AS a,
    (SELECT count(*)::int FROM "AuditEvent") AS e, (SELECT count(*)::int FROM "Observation") AS o`)).rows[0],
  connectionPrivileges: (await owner.query(`SELECT a.attname, has_column_privilege($1, 'public."Connection"'::regclass, a.attnum, 'UPDATE') AS u,
      has_column_privilege($1, 'public."Connection"'::regclass, a.attnum, 'SELECT') AS s FROM pg_attribute a
     WHERE a.attrelid = 'public."Connection"'::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY 1`, [pgdb.runtimeRole])).rows,
  owners: (await owner.query(`SELECT proname, proowner::regrole::text AS o FROM pg_proc WHERE proname IN ('atlas_m365_cleanup', 'atlas_action_authority_fence') ORDER BY 1`)).rows,
});

test('accepted S3-C deployment → S4-A: fence readiness holds before provisioning, PowerOffice refuses until roles.sql, accepted state preserved', async () => {
  const password = randomBytes(18).toString('hex');
  await owner.query(renderStage3RolesSql(await readS3cRolesSql(), pgdb.roles, { runtimePassword: password, runnerPassword: randomBytes(18).toString('hex') }));
  const technician = generateToken();
  runSeed(pgdb.ownerUrl, { ATLAS_DEMO_TOKEN: technician });
  const before = await snapshotOf();
  const runtime = new PrismaClient({ datasourceUrl: urlFor(pgdb.ownerUrl, pgdb.runtimeRole, password) });
  try {
    await assert.rejects(assertRuntimeRole(runtime), /RLS_NOT_ENABLED/, 'this code refuses a database without the PowerOffice tables');
    runWithDatabase(pgdb.ownerUrl, process.execPath, [PRISMA_CLI, 'migrate', 'deploy']);
    assert.deepEqual((await owner.query(`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY 1`)).rows.map(r => r.migration_name),
      await migrationNames());
    // Post-migration, pre-provisioning: Stage 3 fence readiness and admissions are unaffected.
    const fence = (await runtime.$queryRawUnsafe<ActionFenceFacts[]>(ACTION_FENCE_READY_SQL))[0];
    assert.deepEqual(actionFenceProblems(fence), [], 'no PUBLIC routine, no new fence-definer privilege');
    assert.equal((await owner.query(`SELECT count(*)::int AS n FROM pg_proc p WHERE p.proname LIKE 'atlas\\_poweroffice\\_%'
      AND EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0)`)).rows[0].n, 0);
    assert.equal(await withFencedAdmission(runtime, actionCredential(technician), 'demo-gasta', { permissions: ['context:read'], deniedEvent: 'upgrade.probe' },
      async () => ({ ok: 'admitted' })), 'admitted', 'a Stage 3 admission still runs between deploy and provisioning');
    await assert.rejects(assertRuntimeRole(runtime), /RUNTIME_ROLE_NOT_CONFINED/, 'broad default grants / unowned routine until roles.sql');
    await assert.rejects(withPowerOfficeAuthority(runtime, powerOfficeCredential(technician), { clientId: 'demo-gasta', connectionId: 'x', operation: 'read' },
      { lock: async () => undefined, run: async () => ({ ok: 'data' }) }), /POWEROFFICE_RUNTIME_NOT_READY/);
    assert.deepEqual(await snapshotOf(), before, 'migrations changed no accepted row, fence, membership, grant or routine owner');

    await owner.query(renderRolesSql(await readRolesSql(), pgdb.roles, secrets()));
    await assertRuntimeRole(runtime);
    await owner.query(renderRolesSql(await readRolesSql(), pgdb.roles, secrets()));
    await assertRuntimeRole(runtime);
    assert.deepEqual(await snapshotOf(), before, 'provisioning (twice) preserved data, fences, memberships, the runtime\'s Connection privileges and routine owners');
    assert.deepEqual((await owner.query(`SELECT polname FROM pg_policy WHERE polrelid = '"ActionAuthorityFence"'::regclass ORDER BY 1`)).rows.map(r => r.polname),
      ['ActionAuthorityFence_definer', 'ActionAuthorityFence_scope']);
    // Vocabulary grows; nothing is assigned automatically; the runtime credential was kept.
    assert.equal((await owner.query(`SELECT count(*)::int AS n FROM "ClientMembership" WHERE permissions && ARRAY['poweroffice:read','poweroffice:sync','poweroffice:maintain']`)).rows[0].n, 0);
    await assert.rejects(withPowerOfficeAuthority(runtime, powerOfficeCredential(technician), { clientId: 'demo-gasta', connectionId: 'x', operation: 'read' },
      { lock: async () => undefined, run: async () => ({ ok: 'data' }) }), /PERMISSION_DENIED/, 'existing members do not gain PowerOffice access');
    await owner.query(`UPDATE "ClientMembership" SET permissions = permissions || ARRAY['poweroffice:read'] WHERE "clientId" = 'demo-gasta' AND 'context:read' = ANY(permissions)`);
    await assert.rejects(owner.query(`UPDATE "ClientMembership" SET permissions = permissions || ARRAY['poweroffice:admin'] WHERE "clientId" = 'demo-gasta'`), /permissions_check/);
    assert.equal(await withPowerOfficeAuthority(runtime, powerOfficeCredential(technician), { clientId: 'demo-gasta', connectionId: 'x', operation: 'read' },
      { lock: async () => undefined, run: async () => ({ ok: 'admitted' }) }), 'admitted', 'an explicitly granted permission admits');
  } finally { await runtime.$disconnect(); }
});
