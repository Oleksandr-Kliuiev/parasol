import assert from 'node:assert/strict';
import { rejects } from './sql-invariants.ts';
import type { SqlRunner } from './sql-invariants.ts';
import { guid, seedM365 } from './m365-sql-invariants.ts';

/**
 * The confined cleanup routine (migration 202610081200) at S2-A: who may call it and what one call does. Shared by the
 * PGlite test and the real PostgreSQL test (where the runner is a LOGIN role with its own credential). Task 2.9 adds the
 * operator entry, crash/retry and the full retention acceptance. Synthetic data only; times are relative to now().
 */
const DAY9 = `date_trunc('hour', now()) - interval '9 days'`;
const HOUR3 = `date_trunc('hour', now()) - interval '3 hours'`;
const signIn = (id: string) => `jsonb_build_object('id','${id}','createdDateTime','2026-01-01T00:00:00Z','userId',NULL,'deviceId',NULL,'appId',NULL,'errorCode',NULL,'isInteractive',NULL)`;

async function directory(owner: SqlRunner, client: string, conn: string, type: 'm365_user' | 'm365_device', gen: string, ageHours: number): Promise<void> {
  const objectId = guid(conn === 'm1' ? 'd' : conn === 'm1b' ? 'e' : 'f');
  const dto = type === 'm365_device'
    ? `{"id":"${objectId}","deviceId":null,"displayName":"SYNTH-PC","accountEnabled":true,"operatingSystem":"Windows"}`
    : `{"id":"${objectId}","displayName":"Synthetic user","userPrincipalName":null,"userType":"MEMBER","accountEnabled":true}`;
  const started = `now() - interval '${ageHours + 1} hours'`; const completed = `now() - interval '${ageHours} hours'`;
  await owner.exec(`
    INSERT INTO "ExternalEntity" VALUES ('w','${client}','mx-${conn}','${conn}','${type}','${objectId}','{}',now());
    INSERT INTO "M365ResourceState" ("workspaceId","clientId","connectionId","resourceType","latestStartedSeq") VALUES ('w','${client}','${conn}','${type}',1);
    INSERT INTO "M365DirectoryGeneration" ("workspaceId","clientId","connectionId","resourceType","id","attemptSeq","lifecycleVersion","claimToken","leaseExpiresAt","startedAt","expiresAt")
      VALUES ('w','${client}','${conn}','${type}','${gen}',1,1,gen_random_uuid(),${started} + interval '10 minutes',${started},${started} + interval '1 hour');
    INSERT INTO "M365DirectoryObject" VALUES ('w','${client}','${conn}','${type}','${gen}','${objectId}','mx-${conn}',NULL,'${dto}');
    UPDATE "M365DirectoryGeneration" SET state = 'PUBLISHED', "completedAt" = ${completed}, "claimToken" = NULL, "leaseExpiresAt" = NULL, "rowCount" = 1,
      "expiresAt" = ${completed} + interval '24 hours' WHERE "connectionId" = '${conn}' AND id = '${gen}';
    UPDATE "M365ResourceState" SET "activeGenerationId" = '${gen}', "latestPublishedSeq" = 1, "latestRecordedSeq" = 1, status = 'OK',
      "lastAttemptAt" = ${completed}, "lastSuccessAt" = ${completed} WHERE "connectionId" = '${conn}' AND "resourceType" = '${type}';`);
}
async function window(owner: SqlRunner, client: string, conn: string, root: string): Promise<void> {
  const k = (s: string) => `${s}-${conn}`; const started = `${root} + interval '65 minutes'`;
  await owner.exec(`
    INSERT INTO "M365SignInWindow" ("workspaceId","clientId","connectionId","id","rootFrom","rootTo","latestStartedSeq") VALUES ('w','${client}','${conn}','${k('win')}',${root},${root} + interval '1 hour',1);
    INSERT INTO "M365SyncRequest" ("workspaceId","clientId","connectionId","id","requestedFrom","requestedTo","configVersion","rootCount","createdBy","createdAt")
      VALUES ('w','${client}','${conn}','${k('req')}',${root},${root} + interval '1 hour','m365-sync.1',1,'m365-op',${started});
    INSERT INTO "M365SyncRootJob" ("workspaceId","clientId","connectionId","requestId","windowId","maxAttempts","attemptsUsed","state") VALUES ('w','${client}','${conn}','${k('req')}','${k('win')}',5,1,'RUNNING');
    INSERT INTO "M365WindowAttempt" ("workspaceId","clientId","connectionId","windowId","id","rootFrom","requestId","attemptSeq","lifecycleVersion","coveredFrom","coveredTo",
      "configVersion","claimToken","leaseExpiresAt","deadlineAt","startedAt","expiresAt") VALUES ('w','${client}','${conn}','${k('win')}','${k('att')}',${root},'${k('req')}',1,1,
      ${root},${root} + interval '1 hour','m365-sync.1',gen_random_uuid(),${started} + interval '5 minutes',${started} + interval '5 minutes',${started},${started} + interval '1 hour');
    INSERT INTO "M365WindowLeaf" ("workspaceId","clientId","connectionId","windowId","attemptId","id","fromInclusive","toExclusive","state")
      VALUES ('w','${client}','${conn}','${k('win')}','${k('att')}','L0',${root},${root} + interval '1 hour','PENDING');
    UPDATE "M365WindowLeaf" SET state = 'RUNNING' WHERE "connectionId" = '${conn}';
    INSERT INTO "M365SignInEvidence" ("workspaceId","clientId","connectionId","id","sourceId","contentHash","dto","occurredAt","expiresAt")
      VALUES ('w','${client}','${conn}','${k('ev')}','${k('signin')}','${'e'.repeat(64)}',${signIn(k('signin'))},${root} + interval '5 minutes',${root} + interval '5 minutes' + interval '7 days');
    INSERT INTO "M365WindowEvidence" VALUES ('w','${client}','${conn}','${k('win')}','${k('att')}','L0','${k('ev')}');
    UPDATE "M365WindowLeaf" SET state = 'COMPLETE' WHERE "connectionId" = '${conn}';
    UPDATE "M365WindowAttempt" SET state = 'COMPLETE', "completedAt" = ${started} + interval '1 minute', "publishedAt" = ${started} + interval '1 minute', "claimToken" = NULL,
      "leaseExpiresAt" = NULL, "evidenceCount" = 1, "stagedRows" = 1, "leafCount" = 1, "expiresAt" = "coveredTo" + interval '7 days' WHERE "connectionId" = '${conn}';
    UPDATE "M365SignInWindow" SET "publishedAttemptId" = '${k('att')}', "latestPublishedSeq" = 1, "latestRecordedSeq" = 1, status = 'OK',
      "lastAttemptAt" = ${started}, "lastSuccessAt" = ${started} WHERE "connectionId" = '${conn}';`);
}
/**
 * Owner, after seedGraph. Client c1: m1 holds an EXPIRED directory generation (completed 29h ago) and an expired published
 * sign-in hour (9 days old); m1b holds fresh ones. Client c2 (m2) holds expired rows that a c1 cleanup must not touch.
 */
export async function seedRetentionFixtures(owner: SqlRunner): Promise<void> {
  await seedM365(owner);
  await directory(owner, 'c1', 'm1', 'm365_device', 'gen-old', 29);
  await directory(owner, 'c1', 'm1b', 'm365_user', 'gen-fresh', 1);
  await directory(owner, 'c2', 'm2', 'm365_device', 'gen-other', 29);
  await window(owner, 'c1', 'm1', DAY9);
  await window(owner, 'c1', 'm1b', HOUR3);
  await window(owner, 'c2', 'm2', DAY9);
}

const CONTEXT = (clients: string, actor = 'm365-op') =>
  `SELECT set_config('app.workspace_id', 'w', true), set_config('app.client_ids', '${clients}', true), set_config('app.actor_id', '${actor}', true)`;
const counts = `SELECT (SELECT count(*) FROM "M365DirectoryObject")::int AS objects, (SELECT count(*) FROM "M365DirectoryGeneration")::int AS generations,
  (SELECT count(*) FROM "M365WindowEvidence")::int AS memberships, (SELECT count(*) FROM "M365WindowLeaf")::int AS leaves,
  (SELECT count(*) FROM "M365WindowAttempt")::int AS attempts, (SELECT count(*) FROM "M365SignInEvidence")::int AS evidence,
  (SELECT count(*) FROM "ExternalEntity" WHERE "resourceType" LIKE 'm365%')::int AS mirrors, (SELECT count(*) FROM "AuditEvent" WHERE "eventType" = 'retention.completed')::int AS audits`;
const connectionsSnapshot = `SELECT string_agg(id || ':' || status || ':' || "lifecycleVersion" || ':' || "externalTenantId", ',' ORDER BY id) AS s FROM "Connection"`;

/** `cleanupRunner` is the EXECUTE-only runner, `runtime` the API/worker role; `owner` inspects the outcome. */
export async function checkCleanupRoutine(owner: SqlRunner, cleanupRunner: SqlRunner, runtime: SqlRunner): Promise<void> {
  const call = `SELECT atlas_m365_cleanup('corr-retention-1') AS result`;
  const before = (await owner.query<Record<string, number>>(counts))[0];
  const connections = (await owner.query<{ s: string }>(connectionsSnapshot))[0]?.s;
  // Authority: the runtime role cannot execute it at all; the runner needs exactly one client and an actor in its context
  await rejects(runtime.exec(`BEGIN; ${CONTEXT('c1')}; ${call}; COMMIT;`), /permission denied/);
  await runtime.exec('ROLLBACK').catch(() => undefined);
  await rejects(cleanupRunner.exec(call), /M365_CLEANUP_SCOPE_REQUIRED/, 'no context');
  await rejects(cleanupRunner.exec(`BEGIN; ${CONTEXT('c1,c2')}; ${call}; COMMIT;`), /M365_CLEANUP_SCOPE_REQUIRED/, 'two clients');
  await cleanupRunner.exec('ROLLBACK').catch(() => undefined);
  await rejects(cleanupRunner.exec(`BEGIN; ${CONTEXT('c1')}; SELECT atlas_m365_cleanup('short'); COMMIT;`), /INVALID_CORRELATION/);
  await cleanupRunner.exec('ROLLBACK').catch(() => undefined);
  await rejects(cleanupRunner.exec(`SELECT count(*) FROM "Connection"`), /permission denied/, 'the runner has no direct table access');
  await rejects(cleanupRunner.exec(`DELETE FROM "M365SignInEvidence"`), /permission denied/);
  // Rollback restores pointer, payload and audit together
  await cleanupRunner.exec(`BEGIN; ${CONTEXT('c1')}; ${call}; ROLLBACK;`);
  assert.deepEqual((await owner.query(counts))[0], before, 'a rolled-back cleanup changes nothing');
  // One committed call: only c1's expired rows go; pointers withdrawn with MISSING/RETENTION_EXPIRED; one audit per connection
  await cleanupRunner.exec(`BEGIN; ${CONTEXT('c1')}; ${call}; COMMIT;`);
  const after = (await owner.query<Record<string, number>>(counts))[0]!;
  assert.deepEqual(after, { ...before, objects: before!.objects - 1, generations: before!.generations - 1, memberships: before!.memberships - 1,
    leaves: before!.leaves - 1, attempts: before!.attempts - 1, evidence: before!.evidence - 1, audits: 2 });
  const state = (await owner.query<{ s: string }>(`SELECT string_agg("clientId" || '/' || "connectionId" || ':' || status || ':' || coalesce("safeErrorCode", '-') || ':' ||
    coalesce("activeGenerationId", '-') || ':' || ("lastSuccessAt" IS NOT NULL)::text, ',' ORDER BY "clientId", "connectionId") AS s FROM "M365ResourceState"`))[0]?.s;
  assert.equal(state, 'c1/m1:MISSING:RETENTION_EXPIRED:-:true,c1/m1b:OK:-:gen-fresh:true,c2/m2:OK:-:gen-other:true',
    'expired pointer cleared (last success kept), fresh and other-client pointers untouched');
  const windows = (await owner.query<{ s: string }>(`SELECT string_agg("connectionId" || ':' || status || ':' || coalesce("publishedAttemptId", '-'), ',' ORDER BY "clientId", "connectionId") AS s
    FROM "M365SignInWindow"`))[0]?.s;
  assert.equal(windows, 'm1:MISSING:-,m1b:OK:att-m1b,m2:OK:att-m2');
  assert.equal((await owner.query<{ s: string }>(connectionsSnapshot))[0]?.s, connections, 'Connection rows are locked, never changed');
  const audit = await owner.query<{ actorId: string; metadata: Record<string, string> }>(
    `SELECT "actorId", metadata FROM "AuditEvent" WHERE "eventType" = 'retention.completed' ORDER BY metadata->>'connectionId'`);
  assert.deepEqual(audit.map(a => [a.actorId, a.metadata.connectionId, a.metadata.deletedEvidence, a.metadata.clearedPointers]),
    [['m365-op', 'm1', '1', '2'], ['m365-op', 'm1b', '0', '0']]);
  assert.ok(audit.every(a => Object.keys(a.metadata).every(k => /^(connectionId|system|clearedPointers|deleted[A-Za-z]+)$/.test(k))), 'counts and local IDs only');
  assert.ok(!JSON.stringify(audit).includes(guid('1')) && !JSON.stringify(audit).includes('signin'), 'no tenant or source ID in the audit');
  // Idempotent: a second pass finds nothing more to delete
  await cleanupRunner.exec(`BEGIN; ${CONTEXT('c1')}; ${call}; COMMIT;`);
  const again = (await owner.query<Record<string, number>>(counts))[0]!;
  assert.deepEqual({ ...again, audits: 0 }, { ...after, audits: 0 });
}
