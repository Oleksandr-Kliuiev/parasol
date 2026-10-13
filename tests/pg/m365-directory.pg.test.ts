import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AtlasError } from '../../packages/core/contracts.ts';
import { m365TokenCache } from '../../connectors/microsoft365/auth.ts';
import type { GraphTransport } from '../../connectors/microsoft365/http.ts';
import { disableM365Connection } from '../../packages/connections/m365-disable.ts';
import { claimDirectoryGeneration, publishDirectoryGeneration, syncM365Directory, traverseAndStage } from '../../packages/m365/directory.ts';
import { directoryView } from '../../packages/m365/status.ts';
import { gasta } from '../support/graph-fixtures.ts';
import { KARI_OBJECT, M365_CONNECTION, M365_TENANT, m365Actors } from '../support/m365-fixtures.ts';
import { deviceRow, mockM365, page, userRow } from '../support/m365-graph-mock.ts';
import type { MockOptions, Reply } from '../support/m365-graph-mock.ts';
import { addActiveM365Connection, connectionRow, directoryState, ioOf, setupM365Database } from '../support/m365-pg.ts';
import { guid } from '../m365-sql-invariants.ts';

// Stage 2 task 2.5, B3 on PostgreSQL 17 (runtime role, captured mock Graph): durable directory generations — complete
// traversal publishes atomically with typed mirrors; second-page failure, cap, malformed or contradictory data and
// revocation during I/O never publish, never infer deletion and keep the last complete generation (STALE).
const { pgdb, db } = await setupM365Database();
after(async () => { await db.$disconnect(); await pgdb.drop(); });
beforeEach(() => m365TokenCache.clear());
const { syncer, admin } = m365Actors;
const U = (c: string) => guid(c);
const next = (n: number) => `https://graph.microsoft.com/v1.0/users?$select=id&$top=500&$skiptoken=p${n}`;
const usersPages = (pages: unknown[][], extra: (n: number) => Reply | undefined = () => undefined): MockOptions['route'] =>
  (url, n) => url.pathname !== '/v1.0/users' ? undefined : extra(n) ?? page(pages[n] ?? [], n + 1 < pages.length ? next(n + 1) : undefined);
let c = 0;
const fresh = async () => { const id = `m365-dir-${++c}`; const tenant = guid('123456acdef'[c - 1]!); await addActiveM365Connection(pgdb, id, tenant); return { id, tenant }; };
// TIMESTAMP(3) holds UTC; epoch milliseconds avoid pg's local-time parsing of timestamp without time zone.
const generation = async (id: string) => {
  const g = (await pgdb.owner.query(`SELECT state, "rowCount", "safeErrorCode" AS code, (extract(epoch FROM "completedAt") * 1000)::float8 AS completed,
    (extract(epoch FROM "expiresAt") * 1000)::float8 AS expires FROM "M365DirectoryGeneration" WHERE id = $1`, [id])).rows[0];
  return g && { ...g, completedAt: new Date(g.completed), expiresAt: new Date(g.expires) };
};
const view = async (connectionId: string, type = 'm365_user') => {
  const s = await directoryState(pgdb, type, connectionId);
  const g = s?.active ? await generation(s.active) : null;
  const { status, reasonCodes } = directoryView(s ? { status: s.status, safeErrorCode: s.code, activeGenerationId: s.active, latestStartedSeq: s.started,
    latestPublishedSeq: s.published } : null, g, new Date());
  return { status, reasonCodes }; // budget counters: m365-directory-budget.pg.test.ts
};
const mirrors = async (connectionId: string) => (await pgdb.owner.query(`SELECT id, "externalId", attributes, "observedAt" FROM "ExternalEntity" WHERE "connectionId" = $1 ORDER BY "externalId"`, [connectionId])).rows;
const fails = (code: string) => (e: unknown) => e instanceof AtlasError && e.code === code;

test('complete two-page read publishes atomically: pointer, counts, typed mirrors (existing reused), allowlisted DTOs, audit', async () => {
  const mock = mockM365(M365_TENANT, { route: usersPages([[userRow(KARI_OBJECT, { mail: 'drop@example.invalid' }), userRow(U('1'), { userType: 'Guest', accountEnabled: false })],
    [userRow(U('2'), { userType: 'Partner', accountEnabled: null })]]) });
  const before = (await mirrors(M365_CONNECTION)).find(m => m.externalId === KARI_OBJECT);
  const result = await syncM365Directory(db, syncer, gasta, M365_CONNECTION, 'm365_user', ioOf(mock));
  assert.equal(result.status, 'PUBLISHED'); assert.equal(result.rowCount, 3); assert.equal(result.attemptSeq, 1);
  assert.deepEqual(mock.requests.map(r => r.method + ' ' + new URL(r.url).pathname), ['POST /' + M365_TENANT + '/oauth2/v2.0/token', 'GET /v1.0/organization', 'GET /v1.0/users', 'GET /v1.0/users']);
  assert.equal(mock.gets('/v1.0/users')[1]!.url, next(1), 'the validated nextLink, as returned');
  const s = await directoryState(pgdb, 'm365_user');
  assert.deepEqual({ ...s, lastSuccessAt: undefined }, { started: 1, recorded: 1, published: 1, active: result.generationId, status: 'OK', code: null, lastSuccessAt: undefined });
  assert.deepEqual(await generation(result.generationId).then(g => [g.state, g.rowCount]), ['PUBLISHED', 3]);
  const ms = await mirrors(M365_CONNECTION);
  const kari = ms.find(m => m.externalId === KARI_OBJECT);
  assert.equal(kari.id, 'm365-user-kari', 'the existing mirror (and its links) is reused');
  assert.ok(kari.observedAt > before.observedAt, 'observedAt advances on accepted publication');
  assert.deepEqual(ms.filter(m => m.externalId !== guid('b')).map(m => [m.externalId, m.attributes]).sort(),
    [[U('1'), { userType: 'GUEST', accountEnabled: 'FALSE' }], [U('2'), { userType: 'UNKNOWN' }], [KARI_OBJECT, { userType: 'MEMBER', accountEnabled: 'TRUE' }]].sort());
  const objects = (await pgdb.owner.query(`SELECT dto, "externalEntityId" FROM "M365DirectoryObject" WHERE "generationId" = $1`, [result.generationId])).rows;
  assert.ok(objects.every(o => o.externalEntityId && Object.keys(o.dto).sort().join() === 'accountEnabled,displayName,id,userPrincipalName,userType'));
  assert.ok(!JSON.stringify(ms).includes('example.invalid') && !JSON.stringify(ms).includes('Synthetic User'), 'no name or UPN in a mirror');
  const audit = (await pgdb.owner.query(`SELECT metadata FROM "AuditEvent" WHERE "eventType" = 'm365.directory_published'`)).rows;
  assert.deepEqual(audit.map(a => a.metadata), [{ connectionId: M365_CONNECTION, system: 'microsoft365', resourceType: 'm365_user', attemptSeq: '1', rowCount: '3' }]);
  assert.deepEqual(await view(M365_CONNECTION), { status: 'OK', reasonCodes: [] });
});

test('B3: second-page failure, malformed DTO and page cap keep the last complete generation (STALE); nothing staged is visible', async () => {
  const { id, tenant } = await fresh();
  const good = await syncM365Directory(db, syncer, gasta, id, 'm365_user', ioOf(mockM365(tenant, { route: usersPages([[userRow(U('1')), userRow(U('2'))]]) })));
  assert.equal(good.status, 'PUBLISHED');
  const before = await directoryState(pgdb, 'm365_user', id);
  const cases: [string, MockOptions['route']][] = [
    ['M365_UPSTREAM_UNAVAILABLE', usersPages([[userRow(U('1'))], []], n => n === 1 ? { status: 503 } : undefined)],
    ['UPSTREAM_CONTRACT_MISMATCH', usersPages([[userRow(U('1'))], [{ id: 'not-a-guid' }]])],
    ['SYNC_LIMIT_EXCEEDED', usersPages(Array.from({ length: 41 }, (_, i) => [userRow(guid(i.toString(16).padStart(1, '0').slice(-1)))]))],
  ];
  let seq = 1; let t = Date.now();
  for (const [code, route] of cases) {
    m365TokenCache.clear();
    const mock = mockM365(tenant, { route });
    const result = await syncM365Directory(db, syncer, gasta, id, 'm365_user', ioOf(mock), () => new Date(t));
    if (result.retryAt) t = result.retryAt.getTime(); // the persisted transient backoff is honoured (review RC2-R1)
    seq++;
    assert.deepEqual([result.status, result.safeErrorCode, result.recorded, result.attemptSeq], ['FAILED', code, true, seq], code);
    if (code === 'SYNC_LIMIT_EXCEEDED') assert.equal(mock.gets('/v1.0/users').length, 40, 'the 41st page is never requested');
    const s = await directoryState(pgdb, 'm365_user', id);
    assert.deepEqual([s.active, s.published, s.status, s.code, s.lastSuccessAt.getTime()], [good.generationId, 1, 'ERROR', code, before.lastSuccessAt.getTime()]);
    assert.equal((await generation(result.generationId)).state, 'FAILED');
    assert.deepEqual(await view(id), { status: 'STALE', reasonCodes: ['DIRECTORY_STALE', code] });
  }
  assert.deepEqual((await mirrors(id)).map(m => m.externalId).sort(), [U('1'), U('2')], 'partial reads created no mirrors and deleted none');
});

test('B3: empty directory is a published zero-row generation; 403 is an access failure, distinct from empty, with no data', async () => {
  const { id, tenant } = await fresh();
  const empty = await syncM365Directory(db, syncer, gasta, id, 'm365_device', ioOf(mockM365(tenant, { route: url => url.pathname === '/v1.0/devices' ? page([]) : undefined })));
  assert.deepEqual([empty.status, empty.rowCount], ['PUBLISHED', 0]);
  assert.deepEqual(await view(id, 'm365_device'), { status: 'OK', reasonCodes: [] });
  m365TokenCache.clear();
  const denied = await syncM365Directory(db, syncer, gasta, id, 'm365_user', ioOf(mockM365(tenant, { route: url => url.pathname === '/v1.0/users' ? { status: 403 } : undefined })));
  assert.deepEqual([denied.status, denied.safeErrorCode, denied.errorKind], ['FAILED', 'M365_ACCESS_DENIED', 'PERMANENT']);
  assert.deepEqual(await view(id), { status: 'ERROR', reasonCodes: ['M365_ACCESS_DENIED'] }, 'never an empty success');
});

test('duplicates across pages: identical rows deduplicate, a contradictory row fails the whole read', async () => {
  const { id, tenant } = await fresh();
  const same = await syncM365Directory(db, syncer, gasta, id, 'm365_user', ioOf(mockM365(tenant, { route: usersPages([[userRow(U('1')), userRow(U('2'))], [userRow(U('2'))]]) })));
  assert.deepEqual([same.status, same.rowCount], ['PUBLISHED', 2]);
  m365TokenCache.clear();
  const contradictory = await syncM365Directory(db, syncer, gasta, id, 'm365_user',
    ioOf(mockM365(tenant, { route: usersPages([[userRow(U('1')), userRow(U('2'))], [userRow(U('2'), { accountEnabled: false })]]) })));
  assert.deepEqual([contradictory.status, contradictory.safeErrorCode], ['FAILED', 'M365_DUPLICATE_CONFLICT']);
  assert.equal((await directoryState(pgdb, 'm365_user', id)).active, same.generationId);
});

test('a disappearing object leaves the active generation (NOT_CURRENT), but its mirror is not deleted and not re-observed', async () => {
  const { id, tenant } = await fresh();
  await syncM365Directory(db, syncer, gasta, id, 'm365_device', ioOf(mockM365(tenant, { route: url => url.pathname === '/v1.0/devices' ? page([deviceRow(U('1'), U('3')), deviceRow(U('2'), null)]) : undefined })));
  const observed = (await mirrors(id)).find(m => m.externalId === U('2')).observedAt;
  m365TokenCache.clear();
  const second = await syncM365Directory(db, syncer, gasta, id, 'm365_device', ioOf(mockM365(tenant, { route: url => url.pathname === '/v1.0/devices' ? page([deviceRow(U('1'), U('3'))]) : undefined })));
  const active = (await pgdb.owner.query(`SELECT "sourceObjectId", "deviceId" FROM "M365DirectoryObject" WHERE "generationId" = $1`, [second.generationId])).rows;
  assert.deepEqual(active, [{ sourceObjectId: U('1'), deviceId: U('3') }]);
  const gone = (await mirrors(id)).find(m => m.externalId === U('2'));
  assert.ok(gone, 'absence is NOT_CURRENT, not a proven deletion');
  assert.equal(gone.observedAt.getTime(), observed.getTime());
});

test('B1/B3: revocation during I/O stops the read before the next page and prevents publication; the failure is recorded safely', async () => {
  const { id, tenant } = await fresh();
  await syncM365Directory(db, syncer, gasta, id, 'm365_user', ioOf(mockM365(tenant, { route: usersPages([[userRow(U('1'))]]) })));
  const before = await directoryState(pgdb, 'm365_user', id);
  m365TokenCache.clear();
  const mock = mockM365(tenant, { route: usersPages([[userRow(U('1'))], [userRow(U('2'))]]) });
  let revoked = false;
  const graph: GraphTransport = async (url, init) => {
    const response = await mock.graph(url, init);
    if (!revoked && url.includes('/v1.0/users')) { revoked = true; await disableM365Connection(db, admin, gasta, id); }
    return response;
  };
  const result = await syncM365Directory(db, syncer, gasta, id, 'm365_user', { ...ioOf(mock), graph });
  assert.deepEqual([result.status, result.safeErrorCode], ['FAILED', 'M365_CONNECTION_CHANGED']);
  assert.equal(mock.gets('/v1.0/users').length, 1);
  const s = await directoryState(pgdb, 'm365_user', id);
  assert.deepEqual([s.active, s.published], [before.active, 1]);
  assert.deepEqual(await connectionRow(pgdb, id), { status: 'DISABLED', v: 2 });
  await assert.rejects(syncM365Directory(db, syncer, gasta, id, 'm365_user', ioOf(mock)), fails('CONNECTION_NOT_LIVE'), 'a disabled connection claims nothing');
});

test('crash after staging, before the final commit: nothing published, no mirror, no audit; after-commit success stands', async () => {
  const { id, tenant } = await fresh();
  const first = await syncM365Directory(db, syncer, gasta, id, 'm365_user', ioOf(mockM365(tenant, { route: usersPages([[userRow(U('1'))]]) })));
  const mirrorsBefore = await mirrors(id);
  m365TokenCache.clear();
  const claim = await claimDirectoryGeneration(db, syncer, gasta, id, 'm365_user');
  await traverseAndStage(db, syncer, claim, ioOf(mockM365(tenant, { route: usersPages([[userRow(U('1')), userRow(U('5'))]]) })), () => new Date());
  await assert.rejects(publishDirectoryGeneration(db, syncer, claim, () => new Date(), { beforeCommit: async () => { throw new Error('process crash'); } }), /process crash/);
  const s = await directoryState(pgdb, 'm365_user', id);
  assert.deepEqual([s.active, s.published, s.status], [first.generationId, 1, 'OK']);
  assert.equal((await generation(claim.generationId)).state, 'STAGING', 'the crashed claim leaves only staging rows');
  assert.deepEqual(await mirrors(id), mirrorsBefore);
  assert.equal(Number((await pgdb.owner.query(`SELECT count(*) AS n FROM "AuditEvent" WHERE "eventType" = 'm365.directory_published' AND metadata->>'connectionId' = $1`, [id])).rows[0].n), 1);
  assert.deepEqual(await view(id), { status: 'STALE', reasonCodes: ['DIRECTORY_STALE'] }, 'a newer pending attempt makes the retained generation STALE');
  // Restart: a new claim publishes; the crashed claim can never publish over it afterwards
  m365TokenCache.clear();
  const restart = await syncM365Directory(db, syncer, gasta, id, 'm365_user', ioOf(mockM365(tenant, { route: usersPages([[userRow(U('1')), userRow(U('6'))]]) })));
  assert.equal(restart.status, 'PUBLISHED');
  await assert.rejects(publishDirectoryGeneration(db, syncer, claim), fails('M365_ATTEMPT_SUPERSEDED'));
  assert.equal((await directoryState(pgdb, 'm365_user', id)).active, restart.generationId, 'after-commit success stands');
});

test('429 returns the exact Retry-After (above Stage 1’s one-hour clamp); wrong tenant sends no collection request', async () => {
  const { id, tenant } = await fresh();
  const limited = await syncM365Directory(db, syncer, gasta, id, 'm365_user', ioOf(mockM365(tenant, { route: url => url.pathname === '/v1.0/users'
    ? { status: 429, headers: { 'retry-after': '5400' } } : undefined })));
  assert.deepEqual([limited.status, limited.safeErrorCode, limited.errorKind, limited.retryAfterSeconds], ['FAILED', 'M365_RATE_LIMITED', 'TRANSIENT', '5400']);
  m365TokenCache.clear();
  // (the persisted throttle itself is covered in m365-directory-retry.pg.test.ts; continue after it)
  const later = () => new Date(limited.retryAt!.getTime() + 1);
  const wrong = mockM365(tenant, { route: usersPages([[userRow(U('1'))]]), organization: () => ({ status: 200, body: { value: [{ id: M365_TENANT }] } }) });
  const mismatch = await syncM365Directory(db, syncer, gasta, id, 'm365_user', ioOf(wrong), later);
  assert.deepEqual([mismatch.status, mismatch.safeErrorCode], ['FAILED', 'M365_TENANT_MISMATCH']);
  assert.deepEqual(wrong.collectionGets(), []);
  await assert.rejects(syncM365Directory(db, m365Actors.admin, gasta, id, 'm365_user', ioOf(wrong)), fails('PERMISSION_DENIED'), 'sync needs events:ingest too');
});
