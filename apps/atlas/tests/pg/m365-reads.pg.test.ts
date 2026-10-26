import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { AtlasError } from '../../packages/core/contracts.ts';
import type { Actor } from '../../packages/core/contracts.ts';
import { readCorrelation } from '../../packages/correlation/read.ts';
import { readDirectory, readSignIns } from '../../packages/m365/reads.ts';
import { readM365Status } from '../../packages/m365/status-read.ts';
import { guid } from '../m365-sql-invariants.ts';
import { setupM365Database } from '../support/m365-pg.ts';
import { WS, gasta } from '../support/graph-fixtures.ts';
import { M365_CONNECTION, M365_FIXTURE_CONNECTION, m365Actors } from '../support/m365-fixtures.ts';
import { hourStart, iso } from '../support/m365-signin-mock.ts';
import { KARI, OTHER_DEVICE, OTHER_USER, REGISTRATION, addHuntressObservation, addReader, confirmM365Links, publishGeneration, publishScenarioDirectory,
  publishSignIns, readDeps, reader, signIn } from '../support/correlation-fixtures.ts';

// Read surfaces beside the correlation (tests/pg/m365-reads.pg.test.ts): directory list (approved DTOs of the usable active
// generation, C-collation order, generation-bound cursor), sign-in list (ALL eligible published sign-ins, approved DTOs, no
// correlation claim), m365-status (connections:manage, counts/codes only) and the permission matrix: both permissions on
// one client allowed; each single permission and split clients denied with exactly one workspace denial. Cursor
// configuration fails closed before any data query, also for a first page.
const { pgdb, db } = await setupM365Database();
after(async () => { await db.$disconnect(); await pgdb.drop(); });
const q = async (sql: string, params: unknown[] = []) => (await pgdb.owner.query(sql, params)).rows;
const contextOnly: Actor = { id: 'demo-ctx-only', workspaceId: WS, workspacePermissions: [], memberships: [{ clientId: 'demo-gasta', permissions: ['context:read'] }] };
const m365Only: Actor = { id: 'demo-m365-only', workspaceId: WS, workspacePermissions: [], memberships: [{ clientId: 'demo-gasta', permissions: ['m365:read'] }] };
const split: Actor = { id: 'demo-split-read', workspaceId: WS, workspacePermissions: [], memberships: [{ clientId: 'demo-gasta', permissions: ['context:read'] },
  { clientId: 'demo-other', permissions: ['context:read', 'm365:read'] }] };
for (const a of [reader, contextOnly, m365Only, split]) await addReader(pgdb.owner, a);
await confirmM365Links(pgdb.owner);
await publishScenarioDirectory(pgdb.owner);
const USERS = [guid('5'), KARI, guid('0'), guid('f')];
await pgdb.owner.query(`INSERT INTO "ExternalEntity" VALUES ($1,'demo-gasta','u-5',$2,'m365_user',$3,'{}',now()),($1,'demo-gasta','u-0',$2,'m365_user',$4,'{}',now()),
  ($1,'demo-gasta','u-f',$2,'m365_user',$5,'{}',now())`, [WS, M365_CONNECTION, USERS[0], USERS[2], USERS[3]]);
await publishGeneration(pgdb.owner, 'm365_user', 'gen-users-4', [{ source: USERS[0]!, mirror: 'u-5' }, { source: KARI, mirror: 'm365-user-kari' },
  { source: USERS[2]!, mirror: 'u-0' }, { source: USERS[3]!, mirror: 'u-f' }]);
await addHuntressObservation(pgdb.owner, 'obs-r');
const R = hourStart(3); const end = new Date(R.getTime() + 3_600_000);
await publishSignIns(db, () => [signIn('l-1', iso(R, 60_000), KARI, OTHER_DEVICE, { ipAddress: '203.0.113.77', userPrincipalName: 'canary@example.invalid' }),
  signIn('l-2', iso(R, 120_000), OTHER_USER, REGISTRATION), signIn('l-3', iso(R, 180_000), OTHER_USER, OTHER_DEVICE)], R, end);
const fails = (code: string) => (e: unknown) => e instanceof AtlasError && e.code === code;
const dir = (actor: Actor, extra: Record<string, unknown> = {}, deps = readDeps()) =>
  readDirectory(db, actor, gasta, { connectionId: M365_CONNECTION, resourceType: 'm365_user', ...extra }, deps);
const signIns = (actor: Actor, extra: Record<string, unknown> = {}, deps = readDeps()) =>
  readSignIns(db, actor, gasta, { connectionId: M365_CONNECTION, from: R.toISOString(), to: end.toISOString(), ...extra }, deps);

test('directory list: approved DTOs only, sourceObjectId ASC (C collation), stable total, generation-bound pages', async () => {
  const whole = await dir(reader);
  assert.deepEqual([whole.contractVersion, whole.mode, whole.resourceType, whole.resource.status, whole.total, whole.truncated, whole.nextCursor],
    ['atlas.m365-directory.v1', 'db', 'm365_user', 'OK', 4, false, null]);
  assert.deepEqual(whole.items!.map(i => i.id), [...USERS].sort());
  assert.deepEqual(Object.keys(whole.items![0]!), ['id', 'displayName', 'userPrincipalName', 'userType', 'accountEnabled']);
  const page1 = await dir(reader, { limit: 3 });
  const page2 = await dir(reader, { limit: 3, cursor: page1.nextCursor });
  assert.deepEqual([...page1.items!, ...page2.items!].map(i => i.id), whole.items!.map(i => i.id));
  assert.deepEqual([page1.total, page2.total, page2.nextCursor], [4, 4, null]);
  const again = await dir(reader, { limit: 3 });
  await publishGeneration(pgdb.owner, 'm365_user', 'gen-users-5', [{ source: KARI, mirror: 'm365-user-kari' }]);
  await assert.rejects(dir(reader, { limit: 3, cursor: again.nextCursor }), fails('CORRELATION_CHANGED'), 'a new generation invalidates the page');
  const devices = await readDirectory(db, reader, gasta, { connectionId: M365_CONNECTION, resourceType: 'm365_device' }, readDeps());
  assert.deepEqual(devices.items, [{ id: guid('b'), deviceId: REGISTRATION, displayName: 'SYNTH-LT (synthetic)', accountEnabled: true, operatingSystem: 'Windows' }]);
});

test('sign-in list: every eligible published sign-in (not correlation routes) with approved DTO fields and the coverage envelope', async () => {
  const r = await signIns(reader);
  assert.deepEqual([r.contractVersion, r.mode, r.coverage.status, r.resources.map(x => [x.resourceType, x.status]), r.total], ['atlas.m365-signins.v1', 'db', 'COMPLETE',
    [['m365_signin', 'OK']], 3]);
  assert.deepEqual(r.items!.map(i => i.evidenceRef.sourceId), ['l-3', 'l-2', 'l-1']);
  assert.deepEqual(Object.keys(r.items![0]!), ['evidenceRef', 'occurredAt', 'dto', 'evidenceState']);
  assert.deepEqual(Object.keys(r.items![0]!.dto).sort(), ['appId', 'createdDateTime', 'deviceId', 'errorCode', 'id', 'isInteractive', 'userId']);
  const text = JSON.stringify(r);
  for (const canary of ['203.0.113.77', 'canary@example.invalid', 'DROP-ME', 'canonicalPersonId', 'relationCodes', 'proof']) assert.ok(!text.includes(canary), canary);
  const p1 = await signIns(reader, { limit: 2 });
  const p2 = await signIns(reader, { limit: 2, cursor: p1.nextCursor });
  assert.deepEqual([...p1.items!, ...p2.items!].map(i => i.evidenceRef.sourceId), ['l-3', 'l-2', 'l-1']);
  await assert.rejects(readCorrelation(db, reader, gasta, { connectionId: M365_CONNECTION, observationId: 'obs-r', from: R.toISOString(), to: end.toISOString(),
    cursor: p1.nextCursor }, readDeps()), fails('CORRELATION_CHANGED'), 'a sign-in list cursor never pages another operation');
});

test('permissions: each single permission and split clients are denied with exactly one workspace denial; no client audit, no data', async () => {
  const cases: [Actor, () => Promise<unknown>, string][] = [];
  for (const actor of [contextOnly, m365Only, split]) {
    cases.push([actor, () => dir(actor), 'm365.directory_read_denied'], [actor, () => signIns(actor), 'm365.signins_read_denied'],
      [actor, () => readCorrelation(db, actor, gasta, { connectionId: M365_CONNECTION, observationId: 'obs-r', from: R.toISOString(), to: end.toISOString() }, readDeps()),
        'correlation.read_denied']);
  }
  for (const [actor, call, event] of cases) {
    const before = await q(`SELECT id FROM "SecurityAuditEvent" WHERE "workspaceId" = $1 AND "actorId" = $2`, [WS, actor.id]);
    await assert.rejects(call(), fails('PERMISSION_DENIED'));
    const after = await q(`SELECT id, "eventType", metadata FROM "SecurityAuditEvent" WHERE "workspaceId" = $1 AND "actorId" = $2`, [WS, actor.id]);
    const existingIds = new Set(before.map(row => row.id));
    // recordedAt has millisecond precision: consecutive calls can tie, and UUID order does not establish chronology.
    const inserted = after.filter(row => !existingIds.has(row.id));
    assert.deepEqual(inserted.map(({ eventType, metadata }) => ({ eventType, metadata })), [{ eventType: event, metadata: {} }]);
    assert.equal(after.length, before.length + 1, 'exactly one denial');
  }
  assert.equal((await q(`SELECT count(*)::int AS n FROM "AuditEvent" WHERE "actorId" = ANY($1)`, [[contextOnly.id, m365Only.id, split.id]]))[0].n, 0);
  await assert.rejects(readDirectory(db, split, { workspaceId: WS, clientId: 'demo-other' }, { connectionId: M365_CONNECTION, resourceType: 'm365_user' }, readDeps()),
    fails('CONNECTION_NOT_FOUND'), 'the other client holds both permissions, but this connection is not in its scope');
});

test('cursor configuration fails closed at service entry, before any data query, also for an untruncated first page', async () => {
  const before = (await q(`SELECT count(*)::int AS n FROM "AuditEvent" WHERE "actorId" = $1`, [reader.id]))[0].n;
  for (const deps of [{ cursorKey: undefined as never }, { cursorKey: () => ({ mac: () => Buffer.alloc(32) }) as never }]) {
    await assert.rejects(dir(reader, {}, deps), fails('CORRELATION_CURSOR_CONFIG_INVALID'));
    await assert.rejects(signIns(reader, {}, deps), fails('CORRELATION_CURSOR_CONFIG_INVALID'));
  }
  assert.equal((await q(`SELECT count(*)::int AS n FROM "AuditEvent" WHERE "actorId" = $1`, [reader.id]))[0].n, before, 'nothing was read or audited');
});

test('selected connection rules: FIXTURE refused, DISABLED refused for ordinary reads; status reads DISABLED with counts and safe codes only', async () => {
  await assert.rejects(readDirectory(db, reader, gasta, { connectionId: M365_FIXTURE_CONNECTION, resourceType: 'm365_user' }, readDeps()), fails('FIXTURE_CONNECTION_NOT_SUPPORTED'));
  await assert.rejects(readM365Status(db, m365Actors.admin, gasta, M365_FIXTURE_CONNECTION), fails('FIXTURE_CONNECTION_NOT_SUPPORTED'));
  await assert.rejects(readM365Status(db, reader, gasta, M365_CONNECTION), fails('PERMISSION_DENIED'), 'status needs connections:manage');
  await pgdb.owner.query(`UPDATE "Connection" SET status = 'DISABLED', "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = $1`, [M365_CONNECTION]);
  await assert.rejects(dir(reader), fails('CONNECTION_NOT_LIVE'));
  await assert.rejects(signIns(reader), fails('CONNECTION_NOT_LIVE'));
  const status = await readM365Status(db, m365Actors.admin, gasta, M365_CONNECTION);
  assert.deepEqual([status.connectionStatus, status.directory.map(d => [d.resourceType, d.status]), status.signIns.windows.total, status.request],
    ['DISABLED', [['m365_user', 'OK'], ['m365_device', 'OK']], 1, null]);
  const text = JSON.stringify(status);
  for (const canary of [guid('7'), KARI, REGISTRATION, 'synthetic@example.invalid', 'l-1']) assert.ok(!text.includes(canary), 'no tenant, vendor ID or DTO');
  await assert.rejects(readM365Status(db, m365Actors.admin, gasta, M365_CONNECTION, 'no-such-request'), fails('M365_JOB_NOT_FOUND'));
  await pgdb.owner.query(`UPDATE "Connection" SET status = 'ACTIVE', "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = $1`, [M365_CONNECTION]);
});
