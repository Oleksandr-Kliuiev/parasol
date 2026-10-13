import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { AtlasError } from '../../packages/core/contracts.ts';
import { openRuntimeDatabase, runM365Cleanup } from '../../packages/m365/maintenance.ts';
import { setupM365Database } from '../support/m365-pg.ts';
import { urlFor } from '../support/pg-harness.ts';
import { gasta } from '../support/graph-fixtures.ts';
import { M365_CONNECTION, m365Actors } from '../support/m365-fixtures.ts';
import { publishGeneration } from '../support/correlation-fixtures.ts';
import { guid } from '../m365-sql-invariants.ts';

// The cleanup runner target binding and confinement (tests/pg/m365-cleanup-target.pg.test.ts): two correctly provisioned
// databases with matching scope IDs — a runner URL for B with the authenticated runtime of A fails before any context,
// routine, audit or mutation in B; a same-target runner URL differing only in host case/default port gets the runtime URL
// with substituted credentials; a runner with any table privilege (or the owner itself) is refused as not confined.
const a = await setupM365Database(); const b = await setupM365Database();
const runtimeA = openRuntimeDatabase(a.pgdb.runtimeUrl);
after(async () => { await runtimeA.db.$disconnect(); await a.db.$disconnect(); await b.db.$disconnect(); await a.pgdb.drop(); await b.pgdb.drop(); });
for (const { pgdb } of [a, b]) await publishGeneration(pgdb.owner, 'm365_device', 'exp-gen', [{ source: guid('b'), mirror: 'm365-device-07', deviceId: guid('c') }], 300, 100);
const env = (url: string, extra: Record<string, string> = {}) => ({ ATLAS_M365_CLEANUP_RUNNER_SECRET_REF: 'env://RUNNER_URL', RUNNER_URL: url, ...extra });
const fails = (code: string) => (e: unknown) => e instanceof AtlasError && e.code === code;
const snapshot = async (pgdb: typeof a.pgdb) => JSON.stringify([(await pgdb.owner.query(`SELECT count(*)::int AS n FROM "AuditEvent"`)).rows,
  (await pgdb.owner.query(`SELECT count(*)::int AS n FROM "M365DirectoryObject"`)).rows,
  (await pgdb.owner.query(`SELECT "activeGenerationId", status FROM "M365ResourceState" WHERE "connectionId" = $1 ORDER BY "resourceType"`, [M365_CONNECTION])).rows]);

test('a runner URL of database B with the runtime of database A is refused before any runner I/O; B is untouched', async () => {
  const beforeB = await snapshot(b.pgdb); const beforeA = await snapshot(a.pgdb);
  await assert.rejects(runM365Cleanup(runtimeA, m365Actors.syncer, gasta, { env: env(b.pgdb.runnerUrl) }), fails('M365_CLEANUP_CONFIG_INVALID'));
  assert.deepEqual([await snapshot(b.pgdb), await snapshot(a.pgdb)], [beforeB, beforeA]);
  const extraOption = new URL(a.pgdb.runnerUrl); extraOption.searchParams.set('sslmode', 'disable');
  await assert.rejects(runM365Cleanup(runtimeA, m365Actors.syncer, gasta, { env: env(extraOption.toString()) }), fails('M365_CLEANUP_CONFIG_INVALID'), 'routing/SSL options must match');
  const fragment = `${a.pgdb.runnerUrl}#x`;
  await assert.rejects(runM365Cleanup(runtimeA, m365Actors.syncer, gasta, { env: env(fragment) }), fails('M365_CLEANUP_CONFIG_INVALID'));
  for (const timeout of ['29999', '600001', '5m', '-1']) {
    await assert.rejects(runM365Cleanup(runtimeA, m365Actors.syncer, gasta, { env: env(a.pgdb.runnerUrl, { ATLAS_M365_CLEANUP_TIMEOUT_MS: timeout }) }),
      fails('M365_CLEANUP_CONFIG_INVALID'));
  }
  assert.deepEqual(await snapshot(a.pgdb), beforeA);
});

test('same target, different spelling (host case, explicit default port) → the runtime URL with the runner credentials substituted, and the pass runs', async () => {
  const variant = new URL(a.pgdb.runnerUrl);
  variant.hostname = variant.hostname.toUpperCase();
  if (variant.port === '') variant.port = '5432';
  const result = await runM365Cleanup(runtimeA, m365Actors.syncer, gasta, { env: env(variant.toString(), { ATLAS_M365_CLEANUP_TIMEOUT_MS: '30000' }) });
  assert.equal(result.status, 'COMPLETED');
  assert.equal((await a.pgdb.owner.query(`SELECT count(*)::int AS n FROM "M365DirectoryObject" WHERE "generationId" = 'exp-gen'`)).rows[0].n, 0);
  assert.equal((await b.pgdb.owner.query(`SELECT count(*)::int AS n FROM "M365DirectoryObject" WHERE "generationId" = 'exp-gen'`)).rows[0].n, 1, 'B never touched');
});

test('confinement: a runner with a table privilege, the runtime role or the owner as "runner" is refused before the routine; workspace denial is not used', async () => {
  await a.pgdb.owner.query(`GRANT SELECT ON "Client" TO "${a.pgdb.runnerRole}"`);
  try {
    await assert.rejects(runM365Cleanup(runtimeA, m365Actors.syncer, gasta, { env: env(a.pgdb.runnerUrl) }), fails('M365_CLEANUP_RUNNER_NOT_CONFINED'));
  } finally { await a.pgdb.owner.query(`REVOKE SELECT ON "Client" FROM "${a.pgdb.runnerRole}"`); }
  await assert.rejects(runM365Cleanup(runtimeA, m365Actors.syncer, gasta, { env: env(a.pgdb.runtimeUrl) }), fails('M365_CLEANUP_CONFIG_INVALID'), 'same role as runtime');
  await assert.rejects(runM365Cleanup(runtimeA, m365Actors.syncer, gasta, { env: env(a.pgdb.ownerUrl) }), fails('M365_CLEANUP_RUNNER_NOT_CONFINED'));
  await assert.rejects(runM365Cleanup(runtimeA, m365Actors.syncer, gasta, { env: env(urlFor(a.pgdb.runnerUrl, a.pgdb.runnerRole, 'wrong-password')) }),
    fails('M365_CLEANUP_RUNNER_UNAVAILABLE'));
  const m365 = (await a.pgdb.owner.query(`SELECT count(*)::int AS n FROM "Connection" WHERE "clientId" = 'demo-gasta' AND system = 'microsoft365'`)).rows[0].n;
  assert.equal((await a.pgdb.owner.query(`SELECT count(*)::int AS n FROM "AuditEvent" WHERE "eventType" = 'retention.completed'`)).rows[0].n, m365,
    'only the one confined pass (one row per M365 connection of the client)');
  assert.equal((await a.pgdb.owner.query(`SELECT count(*)::int AS n FROM "SecurityAuditEvent"`)).rows[0].n, 0);
});
