import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { AtlasError } from '../../packages/core/contracts.ts';
import type { Actor } from '../../packages/core/contracts.ts';
import { openRuntimeDatabase, runM365Cleanup } from '../../packages/m365/maintenance.ts';
import { claimRootAttempt, createM365SignInRequest, publishRootAttempt } from '../../packages/m365/windows.ts';
import { runRootAttempt } from '../../packages/m365/ingest.ts';
import { disableM365Connection } from '../../packages/connections/m365-disable.ts';
import { readSignIns } from '../../packages/m365/reads.ts';
import { guid } from '../m365-sql-invariants.ts';
import { addActiveM365Connection, ioOf, setupM365Database } from '../support/m365-pg.ts';
import { WS, gasta } from '../support/graph-fixtures.ts';
import { M365_CONNECTION, M365_TENANT, m365Actors } from '../support/m365-fixtures.ts';
import { mockM365 } from '../support/m365-graph-mock.ts';
import { hourStart, iso, signInRoute } from '../support/m365-signin-mock.ts';
import { KARI, OTHER_DEVICE, addReader, publishGeneration, publishSignIns, readDeps, reader, signIn } from '../support/correlation-fixtures.ts';

// C5, C5a, C5b (tests/pg/m365-privacy-retention.pg.test.ts): DTO projection drops privacy canaries everywhere; expired
// payload is unreadable before cleanup; the scoped maintenance pass on the REAL EXECUTE-only runner atomically withdraws
// expired pointers, deletes expired payload and writes the allowlisted audit — rolled back as a whole on a lock timeout,
// waiting on Connection contention, never touching fresh rows, other clients, Stage 1 rows or Connection state, and still
// allowed after disable. Runtime cannot purge; the runner cannot read tables or SET ROLE.
const { pgdb, db } = await setupM365Database();
const runtime = openRuntimeDatabase(pgdb.runtimeUrl);
after(async () => { await runtime.db.$disconnect(); await db.$disconnect(); await pgdb.drop(); });
const env = { ATLAS_M365_CLEANUP_RUNNER_SECRET_REF: 'env://ATLAS_TEST_RUNNER_URL', ATLAS_TEST_RUNNER_URL: pgdb.runnerUrl };
const q = async (sql: string, params: unknown[] = []) => (await pgdb.owner.query(sql, params)).rows;
const count = async (table: string, where = 'true') => (await q(`SELECT count(*)::int AS n FROM "${table}" WHERE ${where}`))[0].n as number;
const syncer = m365Actors.syncer;
const fails = (code: string) => (e: unknown) => e instanceof AtlasError && e.code === code;
await addReader(pgdb.owner);
await addActiveM365Connection(pgdb, 'zzz-m365', guid('3'));
await pgdb.owner.query(`INSERT INTO "Connection" ("workspaceId","clientId","id","system","externalTenantId","secretRef","status","boundBy","boundAt","lifecycleVersion")
  VALUES ($1,'demo-other','other-client-m365','microsoft365',$2,'env://M365_OTHER','ACTIVE','demo-admin',now(),1)`, [WS, guid('4')]);

/** Expired + fresh payload on gasta-m365 (sign-ins published through S2-B with a clock two hours back, 7 days old). */
async function seedPayload(tag: string): Promise<void> {
  const c = new Date(Date.now() - 2 * 3_600_000); const old = new Date(c.getTime() - 7 * 86_400_000 + 10_000);
  const passOld = await publishSignIns(db, () => [signIn(`${tag}-old-1`, old.toISOString(), KARI, OTHER_DEVICE),
    signIn(`${tag}-old-2`, new Date(old.getTime() + 1_000).toISOString(), KARI, OTHER_DEVICE, { ipAddress: '198.51.100.23', location: { city: 'CANARY-CITY' } })],
  new Date(old.getTime() - 60_000), new Date(old.getTime() + 60_000), () => new Date(Date.now() - 2 * 3_600_000));
  assert.ok(passOld.results.every(r => r.outcome === 'PUBLISHED'));
}
const R = hourStart(3);
await publishSignIns(db, () => [signIn('fresh-1', iso(R, 60_000), KARI, OTHER_DEVICE, { userPrincipalName: 'canary.upn@example.invalid',
  status: { errorCode: 50126, failureReason: 'CANARY-FREE-TEXT', additionalDetails: 'CANARY-DETAIL' }, appDisplayName: 'CANARY-APP' })], R, new Date(R.getTime() + 3_600_000));
await seedPayload('a');
await publishGeneration(pgdb.owner, 'm365_user', 'u-old', [{ source: KARI, mirror: 'm365-user-kari' }], 400, 100);
await publishGeneration(pgdb.owner, 'm365_user', 'u-new', [{ source: KARI, mirror: 'm365-user-kari' }], 60);
await publishGeneration(pgdb.owner, 'm365_device', 'd-exp', [{ source: guid('b'), mirror: 'm365-device-07', deviceId: guid('c') }], 300, 100);
await publishGeneration(pgdb.owner, 'm365_device', 'other-exp', [], 300, 100, 'other-client-m365', 'demo-other');
await publishGeneration(pgdb.owner, 'm365_user', 'zzz-gen', [], 60, 24 * 3600, 'zzz-m365');
const connections = async () => q(`SELECT id, status, "lifecycleVersion" AS v, "externalTenantId" AS t, "boundBy" AS b FROM "Connection" ORDER BY id`);
const stage1 = async () => [await count('ExternalEntity'), await count('EntityLink'), await count('RawEvent'), await count('Observation')];

test('C5: canary vendor fields never reach stored DTOs, audit, ledger or read output; expired payload is unreadable before any cleanup', async () => {
  const stored = JSON.stringify(await q(`SELECT dto FROM "M365SignInEvidence"`)) + JSON.stringify(await q(`SELECT metadata FROM "AuditEvent"`))
    + JSON.stringify(await q(`SELECT metadata FROM "SecurityAuditEvent"`));
  for (const canary of ['198.51.100.23', 'CANARY-CITY', 'canary.upn@example.invalid', 'CANARY-FREE-TEXT', 'CANARY-DETAIL', 'CANARY-APP', 'DROP-ME', 'synthetic-token',
    'skiptoken', 'nextLink']) assert.ok(!stored.includes(canary), canary);
  const old = new Date(Date.now() - 2 * 3_600_000 - 7 * 86_400_000 + 10_000);
  await assert.rejects(readSignIns(db, reader, gasta, { connectionId: M365_CONNECTION, from: new Date(old.getTime() - 1).toISOString(),
    to: new Date(old.getTime() + 60_000).toISOString() }, readDeps()), fails('CORRELATION_INTERVAL_NOT_RETAINED'), 'outside the read period');
  assert.ok(await count('M365SignInEvidence', `"sourceId" LIKE 'a-old-%' AND "expiresAt" <= now() AT TIME ZONE 'UTC'`) === 2, 'expired rows are still stored');
});

test('C5a: runtime cannot purge; the runner can neither read nor update Connection nor SET ROLE; a direct call without scope is refused', async () => {
  const runtimePg = new pg.Client({ connectionString: pgdb.runtimeUrl }); const runnerPg = new pg.Client({ connectionString: pgdb.runnerUrl });
  await runtimePg.connect(); await runnerPg.connect();
  try {
    await assert.rejects(runtimePg.query(`SELECT atlas_m365_cleanup('corr-runtime-1')`), (e: { code?: string }) => e.code === '42501');
    await assert.rejects(runnerPg.query(`SELECT id FROM "Connection"`), (e: { code?: string }) => e.code === '42501');
    await assert.rejects(runnerPg.query(`UPDATE "Connection" SET status = status`), (e: { code?: string }) => e.code === '42501');
    await assert.rejects(runnerPg.query(`SET ROLE "${pgdb.definerRole}"`), (e: { code?: string }) => e.code === '42501');
    await assert.rejects(runnerPg.query(`SELECT atlas_m365_cleanup('corr-noscope-1')`), (e: { message?: string }) => /M365_CLEANUP_SCOPE_REQUIRED/.test(String(e.message)));
  } finally { await runtimePg.end(); await runnerPg.end(); }
});

test('C5a: permission gate and current authority come first: a refusal is one workspace denial and no routine call', async () => {
  const noIngest: Actor = { ...syncer, id: 'demo-cleanup-no-ingest', memberships: [{ clientId: 'demo-gasta', permissions: ['connections:manage'] }] };
  await assert.rejects(runM365Cleanup(runtime, noIngest, gasta, { env }), fails('PERMISSION_DENIED'));
  const revoked: Actor = { ...syncer, id: 'demo-cleanup-revoked' };
  await addReader(pgdb.owner, { ...revoked, memberships: [{ clientId: 'demo-gasta', permissions: ['connections:manage'] }] });
  await assert.rejects(runM365Cleanup(runtime, revoked, gasta, { env }), fails('PERMISSION_DENIED'));
  assert.deepEqual((await q(`SELECT "actorId", "eventType" FROM "SecurityAuditEvent" WHERE "eventType" = 'm365.cleanup_denied' ORDER BY "recordedAt"`)),
    [{ actorId: noIngest.id, eventType: 'm365.cleanup_denied' }, { actorId: revoked.id, eventType: 'm365.cleanup_denied' }]);
  assert.equal(await count('AuditEvent', `"eventType" = 'retention.completed'`), 0);
  await assert.rejects(runM365Cleanup(runtime, syncer, gasta, { env: {} }), fails('M365_CLEANUP_CONFIG_INVALID'), 'runner configuration is required, lazily');
});

test('C5a: a lock timeout on a later connection rolls the whole pass back: pointers, payload and audit unchanged', async () => {
  const before = [await count('M365SignInEvidence'), await count('M365WindowEvidence'), await count('M365DirectoryObject'), await count('M365DirectoryGeneration'),
    await count('AuditEvent'), JSON.stringify(await q(`SELECT "resourceType", "activeGenerationId", status FROM "M365ResourceState" ORDER BY 1, 2`))];
  const holder = new pg.Client({ connectionString: pgdb.ownerUrl }); await holder.connect();
  await holder.query('BEGIN');
  await holder.query(`SELECT 1 FROM "M365ResourceState" WHERE "connectionId" = 'zzz-m365' FOR UPDATE`);
  try {
    const result = await runM365Cleanup(runtime, syncer, gasta, { env });
    assert.deepEqual([result.status, result.status === 'FAILED' ? result.safeErrorCode : null], ['FAILED', 'M365_CLEANUP_TIMEOUT']);
  } finally { await holder.query('ROLLBACK'); await holder.end(); }
  assert.deepEqual([await count('M365SignInEvidence'), await count('M365WindowEvidence'), await count('M365DirectoryObject'), await count('M365DirectoryGeneration'),
    await count('AuditEvent'), JSON.stringify(await q(`SELECT "resourceType", "activeGenerationId", status FROM "M365ResourceState" ORDER BY 1, 2`))], before);
});

test('C5a: Connection contention waits (released within the 5s lock timeout), then the pass atomically clears expired pointers and payload with audit', async () => {
  const conn = await connections(); const s1 = await stage1();
  const holder = new pg.Client({ connectionString: pgdb.ownerUrl }); await holder.connect();
  await holder.query('BEGIN');
  await holder.query(`SELECT 1 FROM "Connection" WHERE id = $1 FOR SHARE`, [M365_CONNECTION]);
  const started = Date.now();
  const pass = runM365Cleanup(runtime, syncer, gasta, { env, correlationId: 'corr-cleanup-pass-1' });
  await sleep(1_500); await holder.query('COMMIT'); await holder.end();
  const result = await pass;
  assert.ok(Date.now() - started >= 1_400, 'the pass waited for the Connection lock');
  assert.equal(result.status, 'COMPLETED');
  const mine = result.status === 'COMPLETED' ? result.connections.find(c => c.connectionId === M365_CONNECTION)! : null;
  assert.deepEqual([mine!.clearedPointers, mine!.deletedDirectoryObjects, mine!.deletedGenerations, mine!.deletedAttempts, mine!.deletedEvidence], [2, 2, 2, 1, 2]);
  assert.ok(mine!.deletedMemberships === 2 && mine!.deletedLeaves >= 1);
  assert.deepEqual(await q(`SELECT "resourceType", "activeGenerationId" AS g, status, "safeErrorCode" AS code FROM "M365ResourceState" WHERE "connectionId" = $1 ORDER BY 1`,
    [M365_CONNECTION]), [{ resourceType: 'm365_device', g: null, status: 'MISSING', code: 'RETENTION_EXPIRED' }, { resourceType: 'm365_user', g: 'u-new', status: 'OK', code: null }]);
  assert.equal(await count('M365SignInEvidence', `"sourceId" = 'fresh-1'`), 1, 'fresh evidence and its published root survive');
  assert.equal(await count('M365DirectoryGeneration', `id = 'other-exp'`), 1, "another client's expired rows are out of scope");
  assert.deepEqual(await q(`SELECT metadata FROM "AuditEvent" WHERE "eventType" = 'retention.completed' AND "correlationId" = 'corr-cleanup-pass-1' ORDER BY metadata->>'connectionId'`),
    result.status === 'COMPLETED' ? result.connections.map(c => ({ metadata: { connectionId: c.connectionId, system: 'microsoft365', clearedPointers: String(c.clearedPointers),
      deletedDirectoryObjects: String(c.deletedDirectoryObjects), deletedGenerations: String(c.deletedGenerations), deletedMemberships: String(c.deletedMemberships),
      deletedLeaves: String(c.deletedLeaves), deletedAttempts: String(c.deletedAttempts), deletedEvidence: String(c.deletedEvidence) } })) : []);
  assert.deepEqual([await connections(), await stage1()], [conn, s1], 'no Connection binding/status/version change; no Stage 1 row deleted');
});

test('C5a: a fresh publication racing the pass is protected (lock order), and C5b: a DISABLED connection still gets its expired payload cleaned', async () => {
  const Rf = hourStart(5);
  const mock = mockM365(M365_TENANT, { route: signInRoute(() => [signIn('race-1', iso(Rf, 60_000), KARI, OTHER_DEVICE)]) });
  const request = await createM365SignInRequest(db, syncer, gasta, M365_CONNECTION, Rf, new Date(Rf.getTime() + 3_600_000));
  const claimed = await claimRootAttempt(db, syncer, gasta, M365_CONNECTION, request.requestId, request.roots[0]!.windowId);
  assert.ok('claimed' in claimed);
  await runRootAttempt(db, syncer, claimed.claimed, ioOf(mock));
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const inside = new Promise<void>(resolve => { entered = resolve; });
  const publication = publishRootAttempt(db, syncer, claimed.claimed, undefined, { beforeCommit: async () => { entered(); await gate; } });
  await inside;
  const pass = runM365Cleanup(runtime, syncer, gasta, { env });
  await sleep(1_000); release();
  await publication;
  assert.equal((await pass).status, 'COMPLETED');
  assert.equal(await count('M365SignInEvidence', `"sourceId" = 'race-1'`), 1);
  assert.equal(await count('M365WindowEvidence', `"windowId" = '${request.roots[0]!.windowId}'`), 1);
  await seedPayload('b');
  const disabled = await disableM365Connection(db, m365Actors.admin, gasta, M365_CONNECTION);
  const result = await runM365Cleanup(runtime, syncer, gasta, { env });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(await count('M365SignInEvidence', `"sourceId" LIKE 'b-old-%'`), 0, 'disable never revokes maintenance eligibility');
  assert.deepEqual(await q(`SELECT status, "lifecycleVersion" AS v FROM "Connection" WHERE id = $1`, [M365_CONNECTION]), [{ status: 'DISABLED', v: disabled.lifecycleVersion }]);
});
