import type pg from 'pg';
import type { Actor } from '../../packages/core/contracts.ts';
import { guid } from '../m365-sql-invariants.ts';
import { WS } from './graph-fixtures.ts';

/**
 * Synthetic Microsoft 365 rows for the PostgreSQL tests (owner writes; the triggers still apply). No ID here exists in any
 * real tenant. The directory rows are written as task 2.5 will publish them: claim → staged objects → typed mirrors →
 * PUBLISHED with the ACTIVE connection's lifecycleVersion → pointer.
 */
export const M365_CONNECTION = 'gasta-m365';
export const M365_FIXTURE_CONNECTION = 'gasta-m365-fixture';
export const M365_TENANT = guid('7');
export const KARI_OBJECT = guid('a'); export const LAPTOP_OBJECT = guid('b'); export const LAPTOP_REGISTRATION = guid('c');

const actor = (id: string, permissions: string[], clientId = 'demo-gasta'): Actor => ({ id, workspaceId: WS, workspacePermissions: [], memberships: [{ clientId, permissions }] });
export const m365Actors = {
  /** context:read only: sees no M365 identifier anywhere. */
  reader: actor('demo-reader', ['context:read']),
  /** mapping:review without m365:read: the generic queue without M365 links. */
  reviewer: actor('demo-reviewer', ['context:read', 'mapping:review']),
  /** M365 reviewer: both permissions on the same client. */
  m365Reviewer: actor('demo-m365-reviewer', ['context:read', 'mapping:review', 'm365:read']),
  /** Split permissions across two clients never combine. */
  split: { ...actor('demo-split', ['mapping:review']), memberships: [{ clientId: 'demo-gasta', permissions: ['mapping:review', 'context:read'] },
    { clientId: 'demo-other', permissions: ['m365:read'] }] } as Actor,
  admin: actor('demo-admin', ['connections:manage']),
  /** M365 sync operator (S2-B): events:ingest + connections:manage on Gasta. */
  syncer: actor('demo-m365-syncer', ['events:ingest', 'connections:manage']),
};

/** Actor rows for the in-transaction authority recheck (m365-disable reads the CURRENT membership). */
export async function addM365Actors(owner: pg.Client): Promise<void> {
  for (const a of Object.values(m365Actors)) {
    await owner.query(`INSERT INTO "Actor" ("workspaceId","id","displayName") VALUES ($1,$2,'Synthetic actor') ON CONFLICT DO NOTHING`, [WS, a.id]);
    for (const m of a.memberships) {
      await owner.query(`INSERT INTO "ClientMembership" ("workspaceId","clientId","actorId","permissions") VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [WS, m.clientId, a.id, m.permissions]);
    }
  }
}

const userDto = (id: string, name: string) => JSON.stringify({ id, displayName: name, userPrincipalName: 'kari@example.invalid', userType: 'MEMBER', accountEnabled: true });
const deviceDto = (id: string) => JSON.stringify({ id, deviceId: LAPTOP_REGISTRATION, displayName: 'GASTA-LT-07', accountEnabled: true, operatingSystem: 'Windows' });

/** After runSeed (+ addMappingFixtures for demo-other): M365 connections, mirrors and CANDIDATE links on Gasta. */
export async function addM365Fixtures(owner: pg.Client): Promise<void> {
  await owner.query(`INSERT INTO "Connection" ("workspaceId","clientId","id","system","externalTenantId","secretRef","status","boundBy","boundAt","lifecycleVersion") VALUES
    ($1,'demo-gasta',$2,'microsoft365',$3,'env://M365_GASTA','ACTIVE','demo-admin',now(),1),
    ($1,'demo-gasta',$4,'microsoft365',$5,'fixture://no-credentials','FIXTURE',NULL,NULL,0)`, [WS, M365_CONNECTION, M365_TENANT, M365_FIXTURE_CONNECTION, guid('8')]);
  await owner.query(`INSERT INTO "ExternalEntity" VALUES ($1,'demo-gasta','m365-user-kari',$2,'m365_user',$3,'{"userType":"MEMBER"}',now()),
    ($1,'demo-gasta','m365-device-07',$2,'m365_device',$4,'{}',now())`, [WS, M365_CONNECTION, KARI_OBJECT, LAPTOP_OBJECT]);
  await owner.query(`INSERT INTO "EntityLink" ("workspaceId","clientId","id","entityId","externalEntityId","resourceType","entityKind","method","createdBy") VALUES
    ($1,'demo-gasta','link-m365-user','demo-kari','m365-user-kari','m365_user','PERSON','MANUAL','demo-m365-reviewer'),
    ($1,'demo-gasta','link-m365-device','demo-device-07','m365-device-07','m365_device','DEVICE','MANUAL','demo-m365-reviewer')`, [WS]);
}

/**
 * Publishes generation `gen` (sequence `seq`) of one directory resource, completed `completedMinutesAgo` minutes ago, with
 * the given mirrored objects (none = the object disappeared from the directory).
 */
export async function publishDirectory(owner: pg.Client, type: 'm365_user' | 'm365_device', gen: string, seq: number,
  objects: { source: string; mirror: string }[], completedMinutesAgo = 5, expiresAfterMinutes = 24 * 60): Promise<void> {
  const version = Number((await owner.query(`SELECT "lifecycleVersion" AS v FROM "Connection" WHERE id = $1`, [M365_CONNECTION])).rows[0].v);
  await owner.query(`INSERT INTO "M365ResourceState" ("workspaceId","clientId","connectionId","resourceType","latestStartedSeq") VALUES ($1,'demo-gasta',$2,$3,$4)
    ON CONFLICT ("workspaceId","clientId","connectionId","resourceType") DO UPDATE SET "latestStartedSeq" = EXCLUDED."latestStartedSeq",
    "attemptsUsed" = "M365ResourceState"."attemptsUsed" + (EXCLUDED."latestStartedSeq" - "M365ResourceState"."latestStartedSeq")`, [WS, M365_CONNECTION, type, seq]);
  const started = `now() - make_interval(mins => ${completedMinutesAgo + 1})`; const completed = `now() - make_interval(mins => ${completedMinutesAgo})`;
  await owner.query(`INSERT INTO "M365DirectoryGeneration" ("workspaceId","clientId","connectionId","resourceType","id","attemptSeq","lifecycleVersion","claimToken",
    "leaseExpiresAt","startedAt","expiresAt") VALUES ($1,'demo-gasta',$2,$3,$4,$5,$6,gen_random_uuid(),now() + interval '10 minutes',${started},${started} + interval '1 hour')`,
    [WS, M365_CONNECTION, type, gen, seq, version]);
  for (const o of objects) {
    await owner.query(`INSERT INTO "M365DirectoryObject" VALUES ($1,'demo-gasta',$2,$3,$4,$5,$6,$7,$8)`, [WS, M365_CONNECTION, type, gen, o.source, o.mirror,
      type === 'm365_device' ? LAPTOP_REGISTRATION : null, type === 'm365_device' ? deviceDto(o.source) : userDto(o.source, 'Kari (synthetic)')]);
  }
  // Publication and pointer in one transaction (the deferred commit check refuses either one alone)
  await owner.query('BEGIN');
  try {
    await owner.query(`UPDATE "M365DirectoryGeneration" SET state = 'PUBLISHED', "completedAt" = ${completed}, "claimToken" = NULL, "leaseExpiresAt" = NULL,
      "rowCount" = $3, "expiresAt" = ${completed} + make_interval(mins => $4) WHERE "connectionId" = $1 AND id = $2`, [M365_CONNECTION, gen, objects.length, expiresAfterMinutes]);
    await owner.query(`UPDATE "M365ResourceState" SET "activeGenerationId" = $3, "latestPublishedSeq" = $4, "latestRecordedSeq" = $4, status = 'OK', "attemptsUsed" = 0,
      "safeErrorCode" = NULL, "lastAttemptAt" = ${completed}, "lastSuccessAt" = ${completed} WHERE "connectionId" = $1 AND "resourceType" = $2`, [M365_CONNECTION, type, gen, seq]);
    await owner.query('COMMIT');
  } catch (error) { await owner.query('ROLLBACK'); throw error; }
}
/** A newer directory attempt has started (pending or about to fail): the published generation is no longer fresh. */
export async function startDirectoryAttempt(owner: pg.Client, type: 'm365_user' | 'm365_device'): Promise<void> {
  await owner.query(`UPDATE "M365ResourceState" SET "latestStartedSeq" = "latestStartedSeq" + 1, "attemptsUsed" = "attemptsUsed" + 1 WHERE "connectionId" = $1 AND "resourceType" = $2`, [M365_CONNECTION, type]);
}
