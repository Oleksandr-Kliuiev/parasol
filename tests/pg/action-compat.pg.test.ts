import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { AtlasError } from '../../packages/core/contracts.ts';
import { generateToken } from '../../packages/auth/token.ts';
import { m365TokenCache } from '../../connectors/microsoft365/auth.ts';
import { EnvSecretResolver } from '../../connectors/secrets.ts';
import { bindConnection } from '../../packages/connections/connections.ts';
import { disableM365Connection } from '../../packages/connections/m365-disable.ts';
import { activateConnection } from '../../packages/sync/activation.ts';
import { issueM365ActivationCapability, runM365Activation } from '../../packages/m365/activation.ts';
import { projectRoot } from '../support/pg-harness.ts';
import { actors, gasta, WS } from '../support/graph-fixtures.ts';
import { M365_CONNECTION, m365Actors } from '../support/m365-fixtures.ts';
import { mockM365, page } from '../support/m365-graph-mock.ts';
import { connectionRow, ioOf, setupM365Database } from '../support/m365-pg.ts';
import { gastaVendor, testSecrets } from '../support/vendor-routes.ts';
import { fenceVersion, runtimeClient } from '../support/action-fixtures.ts';
import { guid } from '../m365-sql-invariants.ts';

// Stage 3 S3-A, R1 on PostgreSQL 17: the accepted owner/runtime paths that write auth or Connection rows — bind, Stage 1
// activation, M365 activation, m365-disable (emergency disable) and the owner seed — work with a healthy fence (and move its
// epoch) and, with the workspace fence row missing, fail closed with the fixed ACTION_FENCE_NOT_READY and no partial write.
const { pgdb, db } = await setupM365Database();
const runtime = await runtimeClient(pgdb.runtimeUrl);
after(async () => { await runtime.end(); await db.$disconnect(); await pgdb.drop(); });
beforeEach(() => m365TokenCache.clear());
const owner = pgdb.owner;
const admin = m365Actors.admin;
const fails = (code: string) => (e: unknown) => e instanceof AtlasError && e.code === code && e.message === code;
const vendor = gastaVendor();
const stage1Io = { transport: vendor.transport, secrets: new EnvSecretResolver(testSecrets) };
const directory = (url: URL) => ['/v1.0/users', '/v1.0/devices', '/v1.0/auditLogs/signIns'].includes(url.pathname) ? page([]) : undefined;
const epoch = () => fenceVersion(runtime, WS) as Promise<number>;
/**
 * The owner's seed, as an actual process: exit status and output (no environment values are printed). A fresh demo token
 * makes it write (the token digest upsert); re-running without tokens on a seeded database writes nothing at all.
 */
const seed = () => spawnSync(process.execPath, ['--experimental-strip-types', 'prisma/seed.ts'],
  { cwd: projectRoot, encoding: 'utf8', env: { ...process.env, DATABASE_URL: pgdb.ownerUrl, ATLAS_DEMO_TOKEN: generateToken(), ATLAS_OPERATOR_TOKEN: '' } });
const demoTokenHash = async () => (await owner.query(`SELECT "tokenHash" FROM "ApiToken" WHERE id = 'demo-technician-local-token'`)).rows[0]?.tokenHash ?? null;
let lost: number | null = null;
/** Offline owner DDL simulating a lost fence row (outside supported operation); `restore` is the reviewed repair (same version). */
async function loseFence(): Promise<void> {
  lost = await epoch();
  await owner.query(`BEGIN; ALTER TABLE "ActionAuthorityFence" DISABLE TRIGGER "ActionAuthorityFence_guard";
    DELETE FROM "ActionAuthorityFence" WHERE "workspaceId" = '${WS}'; ALTER TABLE "ActionAuthorityFence" ENABLE ALWAYS TRIGGER "ActionAuthorityFence_guard"; COMMIT;`);
}
async function restoreFence(): Promise<void> {
  await owner.query(`BEGIN; ALTER TABLE "ActionAuthorityFence" DISABLE TRIGGER "ActionAuthorityFence_guard";
    INSERT INTO "ActionAuthorityFence" ("workspaceId", version) VALUES ('${WS}', ${lost}); ALTER TABLE "ActionAuthorityFence" ENABLE ALWAYS TRIGGER "ActionAuthorityFence_guard"; COMMIT;`);
}
const auditCount = async () => Number((await owner.query(`SELECT count(*) AS n FROM "AuditEvent"`)).rows[0].n);

test('healthy fence: bind, Stage 1 activation, M365 activation, m365-disable and the owner seed keep their accepted results and each move the epoch', async () => {
  let e = await epoch();
  assert.deepEqual(await bindConnection(db, actors.admin, gasta, { connectionId: 'compat-atera', system: 'atera', externalTenantId: '5001', secretRef: 'env://ATERA_GASTA' }),
    { connectionId: 'compat-atera', status: 'DISABLED' });
  assert.ok(await epoch() > e);
  await bindConnection(db, actors.admin, gasta, { connectionId: 'compat-huntress', system: 'huntress', externalTenantId: '7001', secretRef: 'env://HUNTRESS_GASTA' });
  e = await epoch();
  assert.deepEqual(await activateConnection(db, actors.admin, gasta, 'compat-huntress', stage1Io), { status: 'ACTIVE' });
  assert.ok(await epoch() > e); e = await epoch();
  await bindConnection(db, admin, gasta, { connectionId: 'compat-m365', system: 'microsoft365', externalTenantId: guid('5'), secretRef: 'env://M365_GASTA' });
  const result = await runM365Activation(db, admin, await issueM365ActivationCapability(db, admin, gasta, 'compat-m365'), ioOf(mockM365(guid('5'), { route: directory })));
  assert.deepEqual([result.status, result.safeErrorCode], ['ACTIVE', null]);
  assert.ok(await epoch() > e); e = await epoch();
  assert.deepEqual(await disableM365Connection(db, admin, gasta, 'compat-m365'), { connectionId: 'compat-m365', status: 'DISABLED', lifecycleVersion: 3 });
  assert.ok(await epoch() > e); e = await epoch();
  const seeded = seed();
  assert.equal(seeded.status, 0);
  assert.match(seeded.stdout, /seeded without deleting data/);
  assert.ok(await epoch() > e, 'the owner seed\'s token write increments the fence');
});

test('missing fence: every path fails closed with the fixed ACTION_FENCE_NOT_READY, writes nothing, and recovers after the reviewed repair', async () => {
  await loseFence();
  try {
    const audits = await auditCount();
    await assert.rejects(bindConnection(db, actors.admin, gasta, { connectionId: 'compat-lost', system: 'atera', externalTenantId: '5002', secretRef: 'env://ATERA_GASTA' }),
      fails('ACTION_FENCE_NOT_READY'));
    assert.equal((await owner.query(`SELECT count(*)::int AS n FROM "Connection" WHERE id = 'compat-lost'`)).rows[0].n, 0);
    assert.equal(await auditCount(), audits, 'no audit row survives the rolled-back bind');
    // Stage 1 activation of a DISABLED binding: the health check passes, the ACTIVE transition is refused as a whole
    await assert.rejects(activateConnection(db, actors.admin, gasta, 'compat-atera', stage1Io), fails('ACTION_FENCE_NOT_READY'));
    assert.deepEqual(await connectionRow(pgdb, 'compat-atera'), { status: 'DISABLED', v: 1 }, 'unchanged');
    const before = await connectionRow(pgdb, M365_CONNECTION);
    await assert.rejects(disableM365Connection(db, admin, gasta, M365_CONNECTION), fails('ACTION_FENCE_NOT_READY'), 'emergency disable depends on fence health');
    assert.deepEqual(await connectionRow(pgdb, M365_CONNECTION), before, 'still ACTIVE: nothing was half-applied');
    const capability = await issueM365ActivationCapability(db, admin, gasta, 'compat-m365');
    const activation = await runM365Activation(db, admin, capability, ioOf(mockM365(guid('5'), { route: directory })));
    assert.deepEqual([activation.status, activation.safeErrorCode], ['DISABLED', 'ACTION_FENCE_NOT_READY']);
    assert.deepEqual(await connectionRow(pgdb, 'compat-m365'), { status: 'DISABLED', v: 3 });
    const failed = (await owner.query(`SELECT metadata FROM "AuditEvent" WHERE "eventType" = 'connection.activation_failed' AND metadata->>'connectionId' = 'compat-m365'`)).rows;
    assert.deepEqual(failed.map(r => r.metadata.safeErrorCode), ['ACTION_FENCE_NOT_READY'], 'the fixed code, never SQL diagnostics');
    const digest = await demoTokenHash();
    const seeded = seed();
    assert.notEqual(seeded.status, 0);
    assert.equal(await demoTokenHash(), digest, 'the seed transaction rolled back as a whole');
    assert.match(seeded.stderr, /^ACTION_FENCE_NOT_READY: /);
    assert.doesNotMatch(seeded.stderr + seeded.stdout, /AT001|SQLSTATE|postgres|password|seeded without/);
  } finally { await restoreFence(); }
  assert.equal(await epoch(), lost, 'the repair keeps the monotonic epoch (no reset)');
  assert.deepEqual(await disableM365Connection(db, admin, gasta, M365_CONNECTION), { connectionId: M365_CONNECTION, status: 'DISABLED', lifecycleVersion: 2 });
  assert.deepEqual(await activateConnection(db, actors.admin, gasta, 'compat-atera', stage1Io), { status: 'ACTIVE' });
  assert.equal(seed().status, 0);
  assert.ok(await epoch() > (lost as number));
});
