import assert from 'node:assert/strict';
import { SET_SCOPE_SQL } from '../packages/graph/scope-context.ts';
import { M365_RUNTIME_UPDATE_COLUMNS, M365_TABLES, DEFINER_CONNECTION_COLUMNS, DEFINER_DELETE_TABLES } from '../packages/graph/runtime-role.ts';
import { rejects } from './sql-invariants.ts';
import type { SqlRunner } from './sql-invariants.ts';
import type { RoleNames } from './support/roles-sql.ts';

/**
 * Stage 2 SQL invariants (migrations 202610081000-1200, prisma/roles.sql), shared by the PGlite test and the real
 * PostgreSQL 17 check like tests/sql-invariants.ts. Synthetic data only. Runs after seedGraph (workspace w, clients c1/c2).
 */
export const guid = (c: string) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
const USER = guid('a'); const DEVICE_OBJECT = guid('b'); const DEVICE_REG = guid('c');
const userDto = (id = USER, extra = '') => `{"id":"${id}","displayName":"Kari synthetic","userPrincipalName":"kari@example.invalid","userType":"MEMBER","accountEnabled":true${extra}}`;
const deviceDto = `{"id":"${DEVICE_OBJECT}","deviceId":"${DEVICE_REG}","displayName":"GASTA-LT-07","accountEnabled":true,"operatingSystem":"Windows"}`;
const signInDto = (id: string, at: string, extra = '') =>
  `jsonb_build_object('id','${id}','createdDateTime',${at},'userId','${USER}','deviceId','${DEVICE_REG}','appId',NULL,'errorCode',0,'isInteractive',true)${extra}`;

/** Owner: two M365 tenants on client c1 (m1, m1b) and one on c2 (m2), all ACTIVE at lifecycleVersion 1. */
export async function seedM365(owner: SqlRunner): Promise<void> {
  await owner.exec(`INSERT INTO "Connection" ("workspaceId","clientId","id","system","externalTenantId","secretRef","status","boundBy","boundAt","lifecycleVersion") VALUES
    ('w','c1','m1','microsoft365','${guid('1')}','env://M365_A','ACTIVE','admin',now(),1),
    ('w','c1','m1b','microsoft365','${guid('2')}','env://M365_B','ACTIVE','admin',now(),1),
    ('w','c2','m2','microsoft365','${guid('3')}','env://M365_C','ACTIVE','admin',now(),1)`);
}
const mirror = (client: string, id: string, conn: string, type: string, externalId: string, attributes = '{}') =>
  `INSERT INTO "ExternalEntity" VALUES ('w','${client}','${id}','${conn}','${type}','${externalId}','${attributes}',now())`;
const generation = (conn: string, id: string, seq: number, version: number, extra = '', values = '') =>
  `INSERT INTO "M365DirectoryGeneration" ("workspaceId","clientId","connectionId","resourceType","id","attemptSeq","lifecycleVersion","claimToken","leaseExpiresAt","expiresAt"${extra})
   VALUES ('w','c1','${conn}','m365_user','${id}',${seq},${version},gen_random_uuid(),now() + interval '10 minutes',now() + interval '23 hours'${values})`;
const object = (gen: string, dto: string, mirrorId: string | null, client = 'c1', conn = 'm1', type = 'm365_user', source = USER, deviceId: string | null = null) =>
  `INSERT INTO "M365DirectoryObject" VALUES ('w','${client}','${conn}','${type}','${gen}','${source}',${mirrorId === null ? 'NULL' : `'${mirrorId}'`},
   ${deviceId === null ? 'NULL' : `'${deviceId}'`},'${dto}')`;
const publish = (id: string, rows = 1) => `UPDATE "M365DirectoryGeneration" SET state = 'PUBLISHED', "completedAt" = now(), "claimToken" = NULL,
  "leaseExpiresAt" = NULL, "rowCount" = ${rows}, "expiresAt" = now() + interval '24 hours' WHERE id = '${id}'`;
const bumpConnection = (id: string, status = 'ACTIVE') => `UPDATE "Connection" SET status = '${status}', "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = '${id}'`;

/** Connection lifecycle, vocabulary, typed mirrors and links, directory generations. Owner (triggers apply to it too). */
export async function checkM365Structure(owner: SqlRunner): Promise<void> {
  await seedM365(owner);
  // Connection: the M365 tenant is a lower-case GUID; the shared vocabulary gains m365:read only
  await rejects(owner.exec(`INSERT INTO "Connection" ("workspaceId","clientId","id","system","externalTenantId","secretRef") VALUES ('w','c1','m-bad','microsoft365','contoso.example','env://X')`), /m365_tenant_check/);
  await rejects(owner.exec(`INSERT INTO "Connection" ("workspaceId","clientId","id","system","externalTenantId","secretRef") VALUES ('w','c1','m-up','microsoft365','${guid('A')}','env://X')`), /m365_tenant_check/);
  await owner.exec(`INSERT INTO "Actor" ("workspaceId","id","displayName") VALUES ('w','m365-tech','M365 technician')`);
  await owner.exec(`INSERT INTO "ClientMembership" ("workspaceId","clientId","actorId","permissions") VALUES ('w','c1','m365-tech',ARRAY['context:read','m365:read'])`);
  await rejects(owner.exec(`UPDATE "ClientMembership" SET permissions = ARRAY['m365:write'] WHERE "actorId" = 'm365-tech'`), /permissions_check/);

  // ExternalEntity mirrors: M365 types only on microsoft365 connections, opaque GUID, attribute codes only, never sign-ins
  await rejects(owner.exec(mirror('c1', 'x-bad1', 'a', 'm365_user', USER)), /connection system/);
  await rejects(owner.exec(mirror('c1', 'x-bad2', 'm1', 'agent', 'agent-1')), /connection system/);
  await rejects(owner.exec(mirror('c1', 'x-bad3', 'm1', 'm365_user', 'kari@example.invalid')), /m365_mirror_check/);
  await rejects(owner.exec(mirror('c1', 'x-bad4', 'm1', 'm365_user', USER, '{"displayName":"Kari synthetic"}')), /m365_mirror_check/);
  await rejects(owner.exec(mirror('c1', 'x-bad5', 'm1', 'm365_signin', USER)), /m365_mirror_check|connection system/);
  await owner.exec(mirror('c1', 'xu1', 'm1', 'm365_user', USER, '{"userType":"MEMBER"}'));
  await owner.exec(mirror('c1', 'xd1', 'm1', 'm365_device', DEVICE_OBJECT));
  await owner.exec(mirror('c1', 'xu1b', 'm1b', 'm365_user', USER)); // same directory object ID in another tenant: a distinct identity
  await rejects(owner.exec(mirror('c1', 'xu1-dup', 'm1', 'm365_user', USER)), /duplicate key/);

  // Typed links: m365_user-PERSON and m365_device-DEVICE, manual only, the claimed type must be the mirror's own
  const link = (id: string, entity: string, external: string, type: string, kind: string, method = 'MANUAL') =>
    `INSERT INTO "EntityLink" ("workspaceId","clientId","id","entityId","externalEntityId","resourceType","entityKind","method") VALUES ('w','c1','${id}','${entity}','${external}','${type}','${kind}','${method}')`;
  await rejects(owner.exec(link('ml-bad1', 'd1', 'xu1', 'm365_user', 'DEVICE')), /type_compat_check|foreign key/);
  await rejects(owner.exec(link('ml-bad2', 'd2', 'xd1', 'm365_device', 'DEVICE', 'HOSTNAME_EXACT')), /m365_manual_check/);
  await rejects(owner.exec(link('ml-bad3', 'd2', 'xu1', 'm365_device', 'DEVICE')), /external_typed_fkey/);
  await owner.exec(link('ml1', 'p1', 'xu1', 'm365_user', 'PERSON'));
  await owner.exec(link('ml2', 'd2', 'xd1', 'm365_device', 'DEVICE'));

  // Directory read state: scoped to its own connection, sequence order, PENDING before the first outcome
  const state = `INSERT INTO "M365ResourceState" ("workspaceId","clientId","connectionId","resourceType","latestStartedSeq")`;
  await rejects(owner.exec(`${state} VALUES ('w','c1','m2','m365_user',1)`), /foreign key/, 'a connection of another client');
  await rejects(owner.exec(`${state} VALUES ('w','c1','m1','agent',1)`), /resource_type_check/);
  await owner.exec(`${state} VALUES ('w','c1','m1','m365_user',1)`);
  await rejects(owner.exec(`UPDATE "M365ResourceState" SET "latestRecordedSeq" = 1 WHERE "connectionId" = 'm1'`), /pending_check/, 'PENDING has no outcome');
  await rejects(owner.exec(`UPDATE "M365ResourceState" SET "latestRecordedSeq" = 2, status = 'ERROR', "safeErrorCode" = 'GRAPH_FORBIDDEN' WHERE "connectionId" = 'm1'`),
    /seq_check/, 'only a started attempt is recorded');

  // Generations: the newly allocated sequence, a claim while staged, bounded retention
  await rejects(owner.exec(generation('m1', 'g-bad', 2, 1)), /newly allocated/);
  await rejects(owner.exec(generation('m1', 'g-bad', 1, 1).replace(`now() + interval '23 hours'`, `now() + interval '25 hours'`)), /retention_check/);
  await rejects(owner.exec(generation('m1', 'g-bad', 1, 1).replace('gen_random_uuid()', 'NULL')), /claim_check/);
  await owner.exec(generation('m1', 'g1', 1, 1));
  // Objects: composite scope, allowlisted DTO, typed mirror of the same connection/type/source ID
  await rejects(owner.exec(object('g1', userDto(), null, 'c2')), /needs its STAGING generation to exist first/, 'a generation of another client');
  await rejects(owner.exec(object('g1', userDto(USER, ',"mail":"kari@example.invalid"'), null)), /dto_check/, 'only allowlisted fields');
  await rejects(owner.exec(object('g1', userDto(guid('d')), null)), /dto_check/, 'DTO id is the source object ID');
  await rejects(owner.exec(object('g1', userDto(), 'xu1b')), /mirror_fkey/, 'mirror of another tenant');
  await rejects(owner.exec(object('g1', userDto(), 'xd1')), /mirror_fkey/, 'mirror of another type');
  await rejects(owner.exec(object('g1', deviceDto, null, 'c1', 'm1', 'm365_user', DEVICE_OBJECT)), /dto_check/, 'device DTO is not a user DTO');
  await owner.exec(object('g1', userDto(), null));
  await rejects(owner.exec(publish('g1')), /typed ExternalEntity mirror/, 'no publication with an absent mirror');
  await owner.exec(`UPDATE "M365DirectoryObject" SET "externalEntityId" = 'xu1' WHERE "generationId" = 'g1'`);
  await rejects(owner.exec(`UPDATE "M365DirectoryObject" SET dto = '${userDto(USER).replace('Kari', 'Ola')}' WHERE "generationId" = 'g1'`), /only gains its mirror/);
  await rejects(owner.exec(publish('g1', 2)), /rowCount/);
  // Publication fence: ACTIVE connection of the claimed lifecycleVersion
  await owner.exec(bumpConnection('m1', 'DISABLED'));
  await rejects(owner.exec(publish('g1')), /ACTIVE connection/);
  await owner.exec(bumpConnection('m1'));
  await rejects(owner.exec(publish('g1')), /lifecycleVersion/, 'a capability of the old version cannot publish after disable and reactivation');
  await owner.exec(`UPDATE "M365DirectoryGeneration" SET state = 'FAILED', "completedAt" = now(), "claimToken" = NULL, "leaseExpiresAt" = NULL, "safeErrorCode" = 'LIFECYCLE_CHANGED' WHERE id = 'g1'`);
  // Order: an older attempt cannot publish once a newer one started
  await owner.exec(`UPDATE "M365ResourceState" SET "latestStartedSeq" = 2, "attemptsUsed" = "attemptsUsed" + 1 WHERE "connectionId" = 'm1'`);
  await owner.exec(generation('m1', 'g2', 2, 3));
  await owner.exec(object('g2', userDto(), 'xu1'));
  await owner.exec(`UPDATE "M365ResourceState" SET "latestStartedSeq" = 3, "attemptsUsed" = "attemptsUsed" + 1 WHERE "connectionId" = 'm1'`);
  await owner.exec(generation('m1', 'g3', 3, 3));
  await owner.exec(object('g3', userDto(), 'xu1'));
  await rejects(owner.exec(publish('g2')), /newest started/);
  // The pointer names only the published generation of latestPublishedSeq (g2 is still STAGING)
  await rejects(owner.exec(`UPDATE "M365ResourceState" SET "activeGenerationId" = 'g2', "latestPublishedSeq" = 2, "latestRecordedSeq" = 3, status = 'OK',
    "lastAttemptAt" = now(), "lastSuccessAt" = now() WHERE "connectionId" = 'm1'`), /pointer names/);
  // Commit atomicity: a publication never commits without the pointer that publishes it (deferred check)
  await rejects(owner.exec(publish('g3')), /only together with its pointer/);
  const point = (gen: string, at: number) => `UPDATE "M365ResourceState" SET "activeGenerationId" = '${gen}', "latestPublishedSeq" = ${at},
    "latestRecordedSeq" = ${at}, status = 'OK', "attemptsUsed" = 0, "lastAttemptAt" = now(), "lastSuccessAt" = now() WHERE "connectionId" = 'm1' AND "resourceType" = 'm365_user'`;
  await owner.exec(`BEGIN; ${publish('g3')}; ${point('g3', 3)}; COMMIT;`);
  // Published membership is immutable; failed generations too
  await rejects(owner.exec(object('g3', userDto(guid('e')), null, 'c1', 'm1', 'm365_user', guid('e'))), /immutable/);
  await rejects(owner.exec(`UPDATE "M365DirectoryObject" SET "externalEntityId" = NULL WHERE "generationId" = 'g3'`), /immutable/);
  await rejects(owner.exec(`UPDATE "M365DirectoryGeneration" SET "rowCount" = 0 WHERE id = 'g3'`), /immutable/);
  await rejects(owner.exec(`UPDATE "M365DirectoryGeneration" SET "safeErrorCode" = 'OTHER' WHERE id = 'g1'`), /immutable/);
  // Pointer: never withdrawn before expiry (only the published generation of latestPublishedSeq: checked before g3 above)
  // Pointer linearization: a disable or a newer start between publication and pointer, even in one transaction, refuses it
  await owner.exec(`UPDATE "M365ResourceState" SET "latestStartedSeq" = 4, "attemptsUsed" = "attemptsUsed" + 1 WHERE "connectionId" = 'm1'`);
  await owner.exec(generation('m1', 'g4', 4, 3));
  await owner.exec(object('g4', userDto(), 'xu1'));
  await rejects(owner.exec(`BEGIN; ${publish('g4')}; ${bumpConnection('m1', 'DISABLED')}; ${point('g4', 4)}; COMMIT;`), /ACTIVE connection/);
  await owner.exec('ROLLBACK').catch(() => undefined);
  await rejects(owner.exec(`BEGIN; ${publish('g4')}; UPDATE "M365ResourceState" SET "latestStartedSeq" = 5, "attemptsUsed" = "attemptsUsed" + 1 WHERE "connectionId" = 'm1';
    ${point('g4', 4)}; COMMIT;`), /newest started attempt/);
  await owner.exec('ROLLBACK').catch(() => undefined);
  assert.deepEqual(await owner.query(`SELECT "activeGenerationId" AS g, "latestStartedSeq" AS s FROM "M365ResourceState" WHERE "connectionId" = 'm1'`),
    [{ g: 'g3', s: 4 }], 'the retained pointer and order survive both refusals');
  await rejects(owner.exec(`UPDATE "M365ResourceState" SET "activeGenerationId" = NULL, status = 'MISSING', "safeErrorCode" = 'RETENTION_EXPIRED' WHERE "connectionId" = 'm1'`),
    /cannot be withdrawn/);
  await rejects(owner.exec(`UPDATE "M365ResourceState" SET "latestStartedSeq" = 1 WHERE "connectionId" = 'm1'`), /monotonic|seq_check/);
  await rejects(owner.exec(`UPDATE "M365ResourceState" SET "lastSuccessAt" = now() - interval '1 day' WHERE "connectionId" = 'm1'`), /monotonic/);
  // Retention: nothing unexpired is deleted, by anyone; truncation never
  await rejects(owner.exec(`DELETE FROM "M365DirectoryObject" WHERE "generationId" = 'g3'`), /retained/);
  await rejects(owner.exec(`DELETE FROM "M365DirectoryGeneration" WHERE id = 'g1'`), /retained/);
  await rejects(owner.exec(`TRUNCATE "M365DirectoryObject"`), /never truncated/);
  await checkM365DtoShapes(owner);
  await checkM365SignInStructure(owner);
}

/**
 * Exact DTO predicates hold only when TRUE (review F4): `{}`, an incomplete shape or an absent/null required ID would
 * otherwise evaluate to SQL NULL, which a CHECK accepts. Every allowed optional value may be an explicit JSON null.
 * Runs on its own synthetic connection m1c so it leaves the other fixtures alone.
 */
async function checkM365DtoShapes(owner: SqlRunner): Promise<void> {
  await owner.exec(`INSERT INTO "Connection" ("workspaceId","clientId","id","system","externalTenantId","secretRef","status","boundBy","boundAt","lifecycleVersion")
    VALUES ('w','c1','m1c','microsoft365','${guid('4')}','env://M365_D','ACTIVE','admin',now(),1)`);
  for (const type of ['m365_user', 'm365_device']) {
    await owner.exec(`INSERT INTO "M365ResourceState" ("workspaceId","clientId","connectionId","resourceType","latestStartedSeq") VALUES ('w','c1','m1c','${type}',1);
      INSERT INTO "M365DirectoryGeneration" ("workspaceId","clientId","connectionId","resourceType","id","attemptSeq","lifecycleVersion","claimToken","leaseExpiresAt","expiresAt")
      VALUES ('w','c1','m1c','${type}','gd-${type}',1,1,gen_random_uuid(),now() + interval '10 minutes',now() + interval '23 hours')`);
  }
  const obj = (type: string, source: string, dto: string, deviceId = 'NULL') =>
    `INSERT INTO "M365DirectoryObject" VALUES ('w','c1','m1c','${type}','gd-${type}','${source}',NULL,${deviceId},'${dto}')`;
  const U = guid('5'); const D = guid('6');
  for (const [label, dto] of [['empty', '{}'], ['id absent', `{"displayName":null,"userPrincipalName":null,"userType":null,"accountEnabled":null}`],
    ['id null', `{"id":null,"displayName":null,"userPrincipalName":null,"userType":null,"accountEnabled":null}`],
    ['incomplete', `{"id":"${U}","displayName":null,"userPrincipalName":null,"accountEnabled":null}`],
    ['bad userType', `{"id":"${U}","displayName":null,"userPrincipalName":null,"userType":"ADMIN","accountEnabled":null}`]]) {
    await rejects(owner.exec(obj('m365_user', U, dto)), /dto_check/, `user DTO ${label}`);
  }
  for (const [label, dto] of [['empty', '{}'], ['incomplete', `{"id":"${D}","displayName":null,"accountEnabled":null,"operatingSystem":null}`],
    ['id null', `{"id":null,"deviceId":null,"displayName":null,"accountEnabled":null,"operatingSystem":null}`]]) {
    await rejects(owner.exec(obj('m365_device', D, dto)), /dto_check/, `device DTO ${label}`);
  }
  await owner.exec(obj('m365_user', U, `{"id":"${U}","displayName":null,"userPrincipalName":null,"userType":null,"accountEnabled":null}`));
  await owner.exec(obj('m365_device', D, `{"id":"${D}","deviceId":null,"displayName":null,"accountEnabled":null,"operatingSystem":null}`));
  const ev = (id: string, dto: string) => `INSERT INTO "M365SignInEvidence" ("workspaceId","clientId","connectionId","id","sourceId","contentHash","dto","occurredAt","expiresAt")
    VALUES ('w','c1','m1c','${id}','signin-shape','${'d'.repeat(64)}','${dto}',now(),now() + interval '1 day')`;
  const allNull = `"appId":null,"createdDateTime":"2026-10-08T10:00:00Z","deviceId":null,"errorCode":null,"isInteractive":null,"userId":null`;
  for (const [label, dto] of [['empty', '{}'], ['id absent', `{${allNull}}`], ['id null', `{"id":null,${allNull}}`],
    ['incomplete', `{"id":"signin-shape","createdDateTime":"2026-10-08T10:00:00Z","deviceId":null,"errorCode":null,"isInteractive":null,"userId":null}`],
    ['createdDateTime null', `{"id":"signin-shape",${allNull.replace('"2026-10-08T10:00:00Z"', 'null')}}`]]) {
    await rejects(owner.exec(ev(`ev-shape-${label.replace(/\W/g, '')}`, dto)), /dto_check/, `sign-in DTO ${label}`);
  }
  await owner.exec(ev('ev-shape-ok', `{"id":"signin-shape",${allNull}}`));
}

const R = `date_trunc('hour', now()) - interval '2 hours'`;
const at = (minutes: number) => `(${R} + interval '${minutes} minutes')`;
const leaf = (id: string, parent: string | null, from: number, to: number, attempt = 'att1') =>
  `INSERT INTO "M365WindowLeaf" ("workspaceId","clientId","connectionId","windowId","attemptId","id","parentLeafId","fromInclusive","toExclusive")
   VALUES ('w','c1','m1','win1','${attempt}','${id}',${parent === null ? 'NULL' : `'${parent}'`},${at(from)},${at(to)})`;
const setLeaf = (id: string, state: string, attempt = 'att1') => `UPDATE "M365WindowLeaf" SET state = '${state}' WHERE "attemptId" = '${attempt}' AND id = '${id}'`;
const evidence = (id: string, source: string, hash: string, minute: number, extra = '', expires = `${at(minute)} + interval '7 days'`) =>
  `INSERT INTO "M365SignInEvidence" ("workspaceId","clientId","connectionId","id","sourceId","contentHash","dto","occurredAt","userId","deviceId","expiresAt")
   VALUES ('w','c1','m1','${id}','${source}','${hash.repeat(64)}',${signInDto(source, `to_char(${at(minute)}, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`, extra)},${at(minute)},'${USER}','${DEVICE_REG}',${expires})`;
const member = (leafId: string, evidenceId: string, attempt = 'att1') =>
  `INSERT INTO "M365WindowEvidence" VALUES ('w','c1','m1','win1','${attempt}','${leafId}','${evidenceId}')`;
const attempt = (id: string, seq: number, version: string, from = 0, to = 60, rootFrom = R) =>
  `INSERT INTO "M365WindowAttempt" ("workspaceId","clientId","connectionId","windowId","id","rootFrom","requestId","attemptSeq","lifecycleVersion","coveredFrom",
   "coveredTo","configVersion","claimToken","leaseExpiresAt","deadlineAt","expiresAt") VALUES ('w','c1','m1','win1','${id}',${rootFrom},'req1',${seq},${version},
   ${at(from)},${at(to)},'m365-sync.1',gen_random_uuid(),now() + interval '10 minutes',now() + interval '10 minutes',now() + interval '1 hour')`;
/** Publication of attempt `id` with its true counts (the trigger requires published counts to equal the rows). */
const completeAttempt = (id: string) => `UPDATE "M365WindowAttempt" a SET state = 'COMPLETE', "completedAt" = now(), "publishedAt" = now(), "claimToken" = NULL,
  "leaseExpiresAt" = NULL, "expiresAt" = "coveredTo" + interval '7 days',
  "evidenceCount" = (SELECT count(*) FROM "M365WindowEvidence" m WHERE m."attemptId" = a.id AND m."windowId" = a."windowId"),
  "stagedRows" = (SELECT count(*) FROM "M365WindowEvidence" m WHERE m."attemptId" = a.id AND m."windowId" = a."windowId"),
  "leafCount" = (SELECT count(*) FROM "M365WindowLeaf" l WHERE l."attemptId" = a.id AND l."windowId" = a."windowId") WHERE id = '${id}'`;
const version = `(SELECT "lifecycleVersion" FROM "Connection" WHERE id = 'm1')`;

/** Sign-in roots, requests, attempts, leaf partitions, immutable evidence and memberships. Owner, after the directory part. */
async function checkM365SignInStructure(owner: SqlRunner): Promise<void> {
  const window = (id: string, from: string, to = `${from} + interval '1 hour'`) =>
    `INSERT INTO "M365SignInWindow" ("workspaceId","clientId","connectionId","id","rootFrom","rootTo") VALUES ('w','c1','m1','${id}',${from},${to})`;
  await rejects(owner.exec(window('win-x', `${R} + interval '5 minutes'`)), /root_check/, 'roots are UTC-hour aligned');
  await rejects(owner.exec(window('win-x', R, `${R} + interval '2 hours'`)), /root_check/, 'rootTo = rootFrom + 1h');
  await owner.exec(window('win1', R));
  await rejects(owner.exec(window('win-dup', R)), /duplicate key/, 'one root per connection and hour');
  const request = (id: string, hours: number, roots = 1) => `INSERT INTO "M365SyncRequest" ("workspaceId","clientId","connectionId","id","requestedFrom","requestedTo",
    "configVersion","rootCount","createdBy") VALUES ('w','c1','m1','${id}',${R},${R} + interval '${hours} hours','m365-sync.1',${roots},'m365-tech')`;
  await rejects(owner.exec(request('req-x', 25)), /interval_check/);
  await rejects(owner.exec(request('req-x', 1, 26)), /caps_check/);
  await owner.exec(request('req1', 1));
  await rejects(owner.exec(`INSERT INTO "M365SyncRootJob" ("workspaceId","clientId","connectionId","requestId","windowId","maxAttempts") VALUES ('w','c1','m1b','req1','win1',5)`),
    /foreign key/, 'a root job pins its connection');
  await owner.exec(`INSERT INTO "M365SyncRootJob" ("workspaceId","clientId","connectionId","requestId","windowId","maxAttempts") VALUES ('w','c1','m1','req1','win1',5)`);
  // Attempts: newly allocated sequence, bounds fixed inside the root, the root's own start
  await owner.exec(`UPDATE "M365SignInWindow" SET "latestStartedSeq" = 1 WHERE id = 'win1'`);
  await rejects(owner.exec(attempt('att-x', 2, version)), /newly allocated/);
  await rejects(owner.exec(attempt('att-x', 1, version, 0, 61)), /bounds_check/);
  await rejects(owner.exec(attempt('att-x', 1, version, 0, 60, `${R} + interval '1 hour'`)), /foreign key|bounds_check/);
  await owner.exec(attempt('att1', 1, version));
  // Leaves: one root with the attempt bounds; children inside a SPLIT parent, never overlapping, at least 1 minute
  await rejects(owner.exec(leaf('L-x', null, 0, 30)), /root leaf/);
  await owner.exec(leaf('L0', null, 0, 60));
  await rejects(owner.exec(leaf('L0b', null, 0, 60)), /one_root|duplicate key/);
  await rejects(owner.exec(leaf('L1', 'L0', 0, 30)), /SPLIT parent/);
  await owner.exec(setLeaf('L0', 'SPLIT'));
  await owner.exec(leaf('L1', 'L0', 0, 30));
  await owner.exec(leaf('L2', 'L0', 30, 60));
  await rejects(owner.exec(leaf('L3', 'L0', 20, 40)), /overlap/);
  await owner.exec(setLeaf('L1', 'SPLIT'));
  await rejects(owner.exec(`INSERT INTO "M365WindowLeaf" ("workspaceId","clientId","connectionId","windowId","attemptId","id","parentLeafId","fromInclusive","toExclusive")
    VALUES ('w','c1','m1','win1','att1','L-short','L1',${at(0)},${at(0)} + interval '30 seconds')`), /bounds_check/);
  await owner.exec(leaf('L1a', 'L1', 0, 15));
  // Evidence: allowlisted DTO, bounded retention, columns equal to the DTO references, one row per ID + hash
  await rejects(owner.exec(evidence('ev-x', 'signin-1', 'a', 5, ` || jsonb_build_object('ipAddress','192.0.2.1')`)), /dto_check/, 'no IP address');
  await rejects(owner.exec(evidence('ev-x', 'signin-1', 'a', 5, '', `${at(5)} + interval '8 days'`)), /retention_check/);
  await owner.exec(evidence('ev1', 'signin-1', 'a', 5));
  await rejects(owner.exec(evidence('ev1-dup', 'signin-1', 'a', 5)), /duplicate key/);
  await owner.exec(evidence('ev1b', 'signin-1', 'b', 5)); // changed content of the same sign-in: another immutable version
  await owner.exec(evidence('ev2', 'signin-2', 'c', 40));
  await rejects(owner.exec(member('L1a', 'ev1')), /running leaf/);
  await owner.exec(setLeaf('L1a', 'RUNNING'));
  await rejects(owner.exec(member('L1a', 'ev2')), /outside its leaf/);
  await owner.exec(member('L1a', 'ev1'));
  await owner.exec(setLeaf('L1a', 'COMPLETE'));
  await owner.exec(setLeaf('L2', 'RUNNING')); await owner.exec(setLeaf('L2', 'COMPLETE'));
  // Publication: the COMPLETE nonsplit leaves must partition the bounds exactly (L1 is split but has only [0,15))
  await rejects(owner.exec(completeAttempt('att1')), /gap or overlap|cover the attempt bounds/);
  await owner.exec(leaf('L1b', 'L1', 15, 30));
  await rejects(owner.exec(completeAttempt('att1')), /COMPLETE or a SPLIT/, 'a pending leaf blocks publication');
  await owner.exec(setLeaf('L1b', 'RUNNING')); await owner.exec(setLeaf('L1b', 'COMPLETE'));
  // Commit atomicity: completion never commits without the window pointer that publishes it (deferred check)
  await rejects(owner.exec(completeAttempt('att1')), /only together with its window pointer/);
  await rejects(owner.exec(`UPDATE "M365SignInWindow" SET "publishedAttemptId" = 'att-none', "latestPublishedSeq" = 1, "latestRecordedSeq" = 1, status = 'OK',
    "lastAttemptAt" = now(), "lastSuccessAt" = now() WHERE id = 'win1'`), /foreign key|COMPLETE attempt/);
  await owner.exec(`BEGIN; ${completeAttempt('att1')}; UPDATE "M365SignInWindow" SET "publishedAttemptId" = 'att1', "latestPublishedSeq" = 1,
    "latestRecordedSeq" = 1, status = 'OK', "lastAttemptAt" = now(), "lastSuccessAt" = now() WHERE id = 'win1'; COMMIT;`);
  // After publication: attempt, leaves, memberships and evidence content are immutable; nothing unexpired is removed
  await rejects(owner.exec(member('L2', 'ev2')), /running leaf/);
  await rejects(owner.exec(`UPDATE "M365WindowEvidence" SET "leafId" = 'L2'`), /immutable/);
  await rejects(owner.exec(`DELETE FROM "M365WindowEvidence"`), /retained/);
  await rejects(owner.exec(`UPDATE "M365WindowAttempt" SET "coveredTo" = "coveredTo" - interval '1 minute' WHERE id = 'att1'`), /fixed bounds/);
  await rejects(owner.exec(`UPDATE "M365WindowAttempt" SET state = 'SUPERSEDED' WHERE id = 'att1'`), /pointer moved/);
  await rejects(owner.exec(setLeaf('L2', 'FAILED')), /immutable/);
  await rejects(owner.exec(`UPDATE "M365SignInEvidence" SET dto = dto || '{"errorCode":50126}' WHERE id = 'ev1'`), /immutable/);
  await rejects(owner.exec(`UPDATE "M365SignInEvidence" SET "lastSeenAt" = "lastSeenAt" - interval '1 minute' WHERE id = 'ev1'`), /only increases/);
  await rejects(owner.exec(`UPDATE "M365SignInEvidence" SET "expiresAt" = "expiresAt" + interval '1 minute' WHERE id = 'ev2'`), /never extended|retention_check/);
  await owner.exec(`UPDATE "M365SignInEvidence" SET "lastSeenAt" = "lastSeenAt" + interval '1 minute' WHERE id = 'ev1'`);
  await rejects(owner.exec(`DELETE FROM "M365SignInEvidence" WHERE id = 'ev2'`), /retained/);
  await rejects(owner.exec(`UPDATE "M365SignInWindow" SET "publishedAttemptId" = NULL, status = 'MISSING', "safeErrorCode" = 'RETENTION_EXPIRED' WHERE id = 'win1'`), /cannot be withdrawn/);
  await rejects(owner.exec(`TRUNCATE "M365WindowEvidence"`), /never truncated/);
  // A refresh is a new attempt; the old version's capability loses the fence after the connection changed
  await owner.exec(`UPDATE "M365SignInWindow" SET "latestStartedSeq" = 2 WHERE id = 'win1'`);
  await owner.exec(attempt('att2', 2, version));
  await owner.exec(leaf('L0', null, 0, 60, 'att2'));
  await owner.exec(setLeaf('L0', 'RUNNING', 'att2')); await owner.exec(setLeaf('L0', 'COMPLETE', 'att2'));
  await owner.exec(`UPDATE "Connection" SET "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = 'm1'`);
  await rejects(owner.exec(completeAttempt('att2')), /lifecycleVersion/);
  await rejects(owner.exec(`UPDATE "M365SignInWindow" SET "publishedAttemptId" = 'att2', "latestPublishedSeq" = 2, "latestRecordedSeq" = 2 WHERE id = 'win1'`), /COMPLETE attempt/);
  // Retry budget is consumed; only an explicit requeue of a FAILED job resets it. Request caps are never refunded.
  await owner.exec(`UPDATE "M365SyncRootJob" SET "attemptsUsed" = 2, state = 'RUNNING' WHERE "windowId" = 'win1'`);
  await rejects(owner.exec(`UPDATE "M365SyncRootJob" SET "attemptsUsed" = 1 WHERE "windowId" = 'win1'`), /requeue/);
  await owner.exec(`UPDATE "M365SyncRootJob" SET state = 'FAILED', "safeErrorCode" = 'SYNC_LIMIT_EXCEEDED' WHERE "windowId" = 'win1'`);
  await owner.exec(`UPDATE "M365SyncRootJob" SET state = 'PENDING', "safeErrorCode" = NULL, "attemptsUsed" = 0 WHERE "windowId" = 'win1'`);
  await owner.exec(`UPDATE "M365SyncRequest" SET "totalStagedRows" = 10 WHERE id = 'req1'`);
  await rejects(owner.exec(`UPDATE "M365SyncRequest" SET "totalStagedRows" = 5 WHERE id = 'req1'`), /never refunded/);
}

/** Grants from prisma/roles.sql, read from the catalog (owner session). */
export async function checkM365Privileges(owner: SqlRunner, roles: RoleNames): Promise<void> {
  const yes = async (sql: string, params: unknown[]) => (await owner.query<{ ok: boolean }>(`SELECT ${sql} AS ok`, params))[0]?.ok === true;
  const table = (role: string, t: string, p: string) => yes(`has_table_privilege($1, $2, $3)`, [role, `"${t}"`, p]);
  const column = (role: string, t: string, c: string, p: string) => yes(`has_column_privilege($1, $2, $3, $4)`, [role, `"${t}"`, c, p]);
  const routine = 'public.atlas_m365_cleanup(text)';
  for (const t of M365_TABLES) {
    for (const p of ['DELETE', 'TRUNCATE']) assert.equal(await table(roles.runtime, t, p), false, `runtime ${p} ${t}`);
    assert.equal(await table(roles.runtime, t, 'UPDATE'), false, `runtime has no table-level UPDATE on ${t}`);
    for (const c of M365_RUNTIME_UPDATE_COLUMNS[t] ?? []) assert.equal(await column(roles.runtime, t, c, 'UPDATE'), true, `runtime UPDATE ${t}.${c}`);
    assert.equal(await yes(`has_any_column_privilege($1, $2, 'SELECT')`, [roles.runner, `"${t}"`]), false, `runner reads nothing of ${t}`);
  }
  for (const [t, c] of [['M365SignInEvidence', 'dto'], ['M365SignInEvidence', 'contentHash'], ['M365DirectoryObject', 'dto'], ['M365WindowEvidence', 'evidenceId'],
    ['M365WindowAttempt', 'coveredFrom'], ['M365DirectoryGeneration', 'attemptSeq']] as const) {
    assert.equal(await column(roles.runtime, t, c, 'UPDATE'), false, `runtime cannot UPDATE ${t}.${c}`);
  }
  assert.equal(await yes(`has_function_privilege($1, $2, 'EXECUTE')`, [roles.runtime, routine]), false, 'runtime cannot execute cleanup');
  assert.equal(await yes(`has_function_privilege($1, $2, 'EXECUTE')`, [roles.runner, routine]), true, 'runner executes cleanup');
  assert.equal(await yes(`NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = $1::regprocedure AND a.grantee = 0) AND (SELECT proacl FROM pg_proc WHERE oid = $1::regprocedure) IS NOT NULL`,
    [routine]), true, 'PUBLIC cannot execute cleanup');
  assert.equal(await yes(`(SELECT proowner::regrole::text FROM pg_proc WHERE oid = $1::regprocedure) = $2`, [routine, roles.definer]), true, 'definer owns the routine');
  const definer = (await owner.query<Record<string, boolean>>(`SELECT rolcanlogin, rolsuper, rolbypassrls, rolinherit FROM pg_roles WHERE rolname = $1`, [roles.definer]))[0];
  assert.deepEqual(definer, { rolcanlogin: false, rolsuper: false, rolbypassrls: false, rolinherit: false });
  assert.equal(await yes(`NOT EXISTS (SELECT 1 FROM pg_class c WHERE pg_has_role($1, c.relowner, 'MEMBER') AND c.relnamespace = 'public'::regnamespace)`, [roles.definer]), true,
    'definer owns no relation, directly or by membership');
  for (const role of [roles.runner, roles.runtime]) assert.equal(await yes(`pg_has_role($1, $2, 'MEMBER')`, [role, roles.definer]), false, `${role} cannot SET ROLE to the definer`);
  // Definer's Connection access: the six columns for SELECT and UPDATE(id) for the lock; nothing else
  for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) assert.equal(await table(roles.definer, 'Connection', p), false, `definer table-level ${p} on Connection`);
  for (const c of DEFINER_CONNECTION_COLUMNS) assert.equal(await column(roles.definer, 'Connection', c, 'SELECT'), true, `definer SELECT Connection.${c}`);
  for (const c of ['secretRef', 'externalTenantId', 'boundBy']) assert.equal(await column(roles.definer, 'Connection', c, 'SELECT'), false, `definer SELECT Connection.${c}`);
  assert.equal(await column(roles.definer, 'Connection', 'id', 'UPDATE'), true);
  for (const c of ['status', 'lifecycleVersion', 'externalTenantId']) assert.equal(await column(roles.definer, 'Connection', c, 'UPDATE'), false, `definer UPDATE Connection.${c}`);
  for (const t of DEFINER_DELETE_TABLES) assert.equal(await table(roles.definer, t, 'DELETE'), true, `definer DELETE ${t}`);
  for (const t of ['AuditEvent', 'ExternalEntity', 'EntityLink', 'RawEvent', 'M365ResourceState', 'M365SignInWindow', 'M365SyncRootJob']) {
    assert.equal(await table(roles.definer, t, 'DELETE'), false, `definer cannot DELETE ${t}`);
  }
  assert.equal(await table(roles.definer, 'AuditEvent', 'INSERT'), true);
  assert.equal(await column(roles.definer, 'M365ResourceState', 'lastSuccessAt', 'UPDATE'), false, 'cleanup never writes a new success time');
}

/** A1 for every M365 table through a CONFINED runner: no context → nothing; one client → only its rows; no foreign writes. */
export async function checkM365Rls(app: SqlRunner): Promise<void> {
  const count = async (t: string) => Number((await app.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${t}"`))[0]?.n ?? 0);
  for (const t of M365_TABLES) assert.equal(await count(t), 0, `${t}: no context must deny reads`);
  await app.exec('BEGIN');
  await app.query(SET_SCOPE_SQL, ['w', 'c2']);
  for (const t of M365_TABLES) assert.equal(await count(t), 0, `${t}: client c2 sees none of c1's M365 rows`);
  await app.exec('ROLLBACK');
  const scoped = (client: string, sql: string) => `BEGIN; SELECT set_config('app.workspace_id', 'w', true), set_config('app.client_ids', '${client}', true); ${sql}; COMMIT;`;
  await rejects(app.exec(scoped('c2', mirror('c1', 'x-foreign', 'm1', 'm365_user', guid('f')))), /row-level security/, 'no write into another client');
  await app.exec('ROLLBACK').catch(() => undefined);
  await app.exec('BEGIN');
  await app.query(SET_SCOPE_SQL, ['w', 'c1']);
  for (const t of ['M365ResourceState', 'M365DirectoryGeneration', 'M365DirectoryObject', 'M365SignInWindow', 'M365WindowAttempt', 'M365SignInEvidence', 'M365WindowEvidence']) {
    assert.ok(await count(t) > 0, `${t}: the scoped client sees its own rows`);
  }
  await app.exec('ROLLBACK');
  await rejects(app.exec(scoped('c1', `DELETE FROM "M365SignInEvidence"`)), /permission denied/, 'the runtime cannot delete payload');
  await app.exec('ROLLBACK').catch(() => undefined);
  await rejects(app.exec(scoped('c1', `UPDATE "M365SignInEvidence" SET dto = '{}'`)), /permission denied/, 'nor update a DTO');
  await app.exec('ROLLBACK').catch(() => undefined);
}
