import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AtlasError } from '../../packages/core/contracts.ts';
import { m365TokenCache } from '../../connectors/microsoft365/auth.ts';
import { createM365SignInRequest } from '../../packages/m365/windows.ts';
import { runM365SignInRequest } from '../../packages/m365/ingest.ts';
import { rootCoverage } from '../../packages/m365/status.ts';
import { gasta } from '../support/graph-fixtures.ts';
import { m365Actors } from '../support/m365-fixtures.ts';
import { mockM365 } from '../support/m365-graph-mock.ts';
import { addActiveM365Connection, ioOf, setupM365Database } from '../support/m365-pg.ts';
import { hourStart, iso, signInRoute } from '../support/m365-signin-mock.ts';
import type { SignInData } from '../support/m365-signin-mock.ts';
import { guid } from '../m365-sql-invariants.ts';
import { attemptOf, evidenceOf, jobOf, requestOf, windowOf } from '../support/m365-window-rows.ts';

// Stage 2 task 2.6, B6 on PostgreSQL 17 (runtime role, mock Graph): sign-in requests and root jobs, the ge/le query with
// local [from, to), exact-upper-bound rows counted but discarded, out-of-window rows failing the attempt, persisted
// Retry-After above the backoff cap, 403 distinct from a complete empty root, bounded splitting and the gap left by an
// unsplittable capped leaf, not-yet-collectable roots, bounded 401.
const { pgdb, db } = await setupM365Database();
after(async () => { await db.$disconnect(); await pgdb.drop(); });
beforeEach(() => m365TokenCache.clear());
const { syncer } = m365Actors;
const HOUR = 3_600_000; const MIN = 60_000;
const fails = (code: string) => (e: unknown) => e instanceof AtlasError && e.code === code;
let c = 0;
const fresh = async () => { const id = `m365-win-${++c}`; const tenant = guid('123456acdef'[c - 1]!); await addActiveM365Connection(pgdb, id, tenant); return { id, tenant }; };
const fixed = (t: Date) => () => t;
async function oneRoot(id: string, root: Date, clock: () => Date) {
  const request = await createM365SignInRequest(db, syncer, gasta, id, root, new Date(root.getTime() + HOUR), clock);
  return { requestId: request.requestId, windowId: request.roots[0]!.windowId, request };
}

test('request: server-generated ID, ≤24h, ≤25 canonical UTC-hour roots, retained/collectable bounds, windows shared across requests', async () => {
  const { id } = await fresh();
  const now = new Date(); const clock = fixed(now);
  const from = new Date(hourStart(30).getTime() + 17 * MIN);
  const r = await createM365SignInRequest(db, syncer, gasta, id, from, new Date(from.getTime() + 24 * HOUR), clock);
  assert.match(r.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(r.roots.length, 25, 'an unaligned 24h interval touches 25 hours');
  assert.ok(r.roots.every(x => x.rootFrom.getTime() % HOUR === 0));
  assert.equal(r.retrievalFrom!.getTime(), hourStart(30).getTime());
  assert.equal(r.retrievalTo!.getTime(), Math.min(r.roots.at(-1)!.rootFrom.getTime() + HOUR, now.getTime() - 5 * MIN));
  const again = await createM365SignInRequest(db, syncer, gasta, id, hourStart(30), hourStart(29), clock);
  assert.equal(again.roots[0]!.windowId, r.roots[0]!.windowId, 'one window per connection and root');
  assert.notEqual(again.requestId, r.requestId);
  await assert.rejects(createM365SignInRequest(db, syncer, gasta, id, hourStart(30), new Date(hourStart(30).getTime() + 24 * HOUR + 1), clock), fails('M365_INTERVAL_INVALID'));
  await assert.rejects(createM365SignInRequest(db, syncer, gasta, id, hourStart(24 * 8), hourStart(24 * 7 + 2), clock), fails('M365_INTERVAL_NOT_RETAINED'));
  await assert.rejects(createM365SignInRequest(db, syncer, gasta, id, new Date(now.getTime() - MIN), new Date(now.getTime() + HOUR), clock), fails('M365_INTERVAL_NOT_COLLECTABLE'));
  await assert.rejects(createM365SignInRequest(db, m365Actors.admin, gasta, id, hourStart(3), hourStart(2), clock), fails('PERMISSION_DENIED'));
  const audit = (await pgdb.owner.query(`SELECT metadata FROM "AuditEvent" WHERE "eventType" = 'm365.signin_requested' AND metadata->>'connectionId' = $1`, [id])).rows;
  assert.deepEqual(audit.map(a => Object.keys(a.metadata).sort()), [['connectionId', 'lifecycleVersion', 'requestId', 'system'], ['connectionId', 'lifecycleVersion', 'requestId', 'system']]);
});

test('B6: one root publishes; exact-upper-bound row counted and discarded; duplicates deduplicate; changed content is another version', async () => {
  const { id, tenant } = await fresh();
  const root = hourStart(3); const clock = fixed(new Date());
  const data: SignInData[] = [{ id: 'sig-a', at: iso(root, 0) }, { id: 'sig-b', at: iso(root, 10 * MIN) }, { id: 'sig-b', at: iso(root, 10 * MIN) },
    { id: 'sig-c', at: iso(root, 20 * MIN) }, { id: 'sig-c', at: iso(root, 20 * MIN), extra: { status: { errorCode: 50126 } } },
    { id: 'sig-upper', at: iso(root, HOUR) }];
  const mock = mockM365(tenant, { route: signInRoute(() => data) });
  const { requestId, windowId } = await oneRoot(id, root, clock);
  const [result] = await runM365SignInRequest(db, syncer, gasta, id, requestId, ioOf(mock), clock);
  assert.deepEqual([result!.outcome, result!.attemptSeq, result!.evidenceCount], ['PUBLISHED', 1, 4]);
  const w = await windowOf(pgdb, windowId);
  assert.deepEqual([w.status, w.code, w.started, w.recorded, w.published], ['OK', null, 1, 1, 1]);
  const a = await attemptOf(pgdb, w.pointer);
  assert.deepEqual([a.state, a.evidenceCount, a.leafCount, a.stagedRows], ['COMPLETE', 4, 1, 6], 'all six received rows count; four versions are members');
  assert.equal(a.expiresAt.getTime(), root.getTime() + HOUR + 7 * 24 * HOUR);
  assert.deepEqual(await jobOf(pgdb, requestId, windowId), { state: 'COMPLETE', attemptsUsed: 1, retryAt: null, code: null });
  assert.deepEqual(await requestOf(pgdb, requestId), { totalLeaves: 1, totalStagedRows: 6, state: 'OPEN' });
  const evidence = await evidenceOf(pgdb, id);
  assert.deepEqual(evidence.map(e => e.sourceId).sort(), ['sig-a', 'sig-b', 'sig-c', 'sig-c']);
  assert.ok(!JSON.stringify(evidence).match(/203\.0\.113|DROP-ME|drop@example/));
  const coverage = rootCoverage({ rootFrom: root, rootTo: new Date(root.getTime() + HOUR), latestStartedSeq: 1, latestPublishedSeq: 1, status: 'OK', safeErrorCode: null },
    { coveredFrom: a.coveredFrom, coveredTo: a.coveredTo, publishedAt: a.publishedAt, expiresAt: a.expiresAt }, clock());
  assert.deepEqual([coverage.coverage, coverage.freshness, coverage.gaps], ['COMPLETE', 'FRESH', []]);
  const later = rootCoverage({ rootFrom: root, rootTo: new Date(root.getTime() + HOUR), latestStartedSeq: 1, latestPublishedSeq: 1, status: 'OK', safeErrorCode: null },
    { coveredFrom: a.coveredFrom, coveredTo: a.coveredTo, publishedAt: a.publishedAt, expiresAt: a.expiresAt }, new Date(clock().getTime() + 16 * MIN));
  assert.deepEqual([later.coverage, later.freshness], ['COMPLETE', 'STALE'], 'freshness ages; traversal coverage does not');
  const audit = (await pgdb.owner.query(`SELECT metadata FROM "AuditEvent" WHERE "eventType" = 'm365.signin_window_published' AND metadata->>'requestId' = $1`, [requestId])).rows;
  assert.deepEqual(audit.map(x => x.metadata), [{ connectionId: id, system: 'microsoft365', requestId, attemptSeq: '1', evidenceCount: '4', leafCount: '1' }]);
});

test('B6: a row outside [from, to] fails the whole attempt; nothing is published and no membership exists', async () => {
  const { id, tenant } = await fresh();
  const root = hourStart(3); const clock = fixed(new Date());
  const mock = mockM365(tenant, { route: signInRoute(() => [{ id: 'in', at: iso(root, MIN) }], {
    inject: () => ({ status: 200, body: { value: [{ id: 'in', createdDateTime: iso(root, MIN) }, { id: 'out', createdDateTime: iso(root, -1) }] } }) }) });
  const { requestId, windowId } = await oneRoot(id, root, clock);
  const [result] = await runM365SignInRequest(db, syncer, gasta, id, requestId, ioOf(mock), clock);
  assert.deepEqual([result!.outcome, result!.safeErrorCode], ['FAILED', 'M365_SIGNIN_OUT_OF_WINDOW']);
  const w = await windowOf(pgdb, windowId);
  assert.deepEqual([w.pointer, w.status, w.code], [null, 'ERROR', 'M365_SIGNIN_OUT_OF_WINDOW']);
  assert.equal(Number((await pgdb.owner.query(`SELECT count(*) AS n FROM "M365WindowEvidence" WHERE "windowId" = $1`, [windowId])).rows[0].n), 0);
  assert.deepEqual(await jobOf(pgdb, requestId, windowId), { state: 'FAILED', attemptsUsed: 1, retryAt: null, code: 'M365_SIGNIN_OUT_OF_WINDOW' });
});

test('B6: 429 Retry-After of two hours is persisted exactly; an earlier pass sends nothing; at retryAt the next budget unit is claimed', async () => {
  const { id, tenant } = await fresh();
  const root = hourStart(3); const t0 = new Date();
  let limited = true;
  const mock = mockM365(tenant, { route: signInRoute(() => [{ id: 'sig-1', at: iso(root, MIN) }], {
    inject: () => limited ? { status: 429, headers: { 'retry-after': '7200' } } : undefined }) });
  const { requestId, windowId } = await oneRoot(id, root, fixed(t0));
  const [first] = await runM365SignInRequest(db, syncer, gasta, id, requestId, ioOf(mock), fixed(t0));
  assert.deepEqual([first!.outcome, first!.safeErrorCode, first!.retryAt!.getTime()], ['RETRY', 'M365_RATE_LIMITED', t0.getTime() + 7_200_000]);
  assert.deepEqual(await jobOf(pgdb, requestId, windowId), { state: 'RETRY', attemptsUsed: 1, retryAt: new Date(t0.getTime() + 7_200_000), code: 'M365_RATE_LIMITED' });
  const sent = mock.requests.length;
  const [early] = await runM365SignInRequest(db, syncer, gasta, id, requestId, ioOf(mock), fixed(new Date(t0.getTime() + 20 * MIN)));
  assert.equal(early!.outcome, 'NOT_DUE', 'beyond the generic 15m cap, still not retried early');
  assert.equal(mock.requests.length, sent);
  limited = false;
  const [due] = await runM365SignInRequest(db, syncer, gasta, id, requestId, ioOf(mock), fixed(new Date(t0.getTime() + 7_200_000)));
  assert.deepEqual([due!.outcome, due!.attemptSeq], ['PUBLISHED', 2]);
  assert.equal((await jobOf(pgdb, requestId, windowId)).attemptsUsed, 2);
});

test('B6: sign-in 403 is an access failure, distinct from a fully read empty root (COMPLETE with zero evidence)', async () => {
  const { id, tenant } = await fresh();
  const clock = fixed(new Date());
  const empty = await oneRoot(id, hourStart(4), clock);
  const [ok] = await runM365SignInRequest(db, syncer, gasta, id, empty.requestId, ioOf(mockM365(tenant, { route: signInRoute(() => []) })), clock);
  assert.deepEqual([ok!.outcome, ok!.evidenceCount], ['PUBLISHED', 0]);
  m365TokenCache.clear();
  const denied = await oneRoot(id, hourStart(5), clock);
  const [no] = await runM365SignInRequest(db, syncer, gasta, id, denied.requestId, ioOf(mockM365(tenant, { route: signInRoute(() => [], { inject: () => ({ status: 403 }) }) })), clock);
  assert.deepEqual([no!.outcome, no!.safeErrorCode], ['FAILED', 'M365_ACCESS_DENIED']);
  assert.equal((await windowOf(pgdb, denied.windowId)).pointer, null);
  m365TokenCache.clear();
  const unauthorized = await oneRoot(id, hourStart(6), clock);
  const always401 = mockM365(tenant, { route: signInRoute(() => [], { inject: () => ({ status: 401 }) }) });
  const [auth] = await runM365SignInRequest(db, syncer, gasta, id, unauthorized.requestId, ioOf(always401), clock);
  assert.deepEqual([auth!.outcome, auth!.safeErrorCode], ['FAILED', 'M365_AUTH_FAILED']);
  assert.equal(always401.posts().length, 2, 'one reacquisition per attempt, no loop');
});

test('B6: a leaf over its page cap is split into persisted halves that all complete; the root publishes their exact partition', async () => {
  const { id, tenant } = await fresh();
  const root = hourStart(3); const clock = fixed(new Date());
  const data = Array.from({ length: 30 }, (_, i) => ({ id: `sig-${i}`, at: iso(root, i * 2 * MIN) }));
  const mock = mockM365(tenant, { route: signInRoute(() => data, { pageSize: 1 }) });
  const { requestId, windowId } = await oneRoot(id, root, clock);
  const [result] = await runM365SignInRequest(db, syncer, gasta, id, requestId, ioOf(mock), clock);
  assert.deepEqual([result!.outcome, result!.evidenceCount], ['PUBLISHED', 30]);
  const leaves = (await pgdb.owner.query(`SELECT state, "parentLeafId" IS NULL AS root, (extract(epoch FROM "toExclusive" - "fromInclusive"))::int AS secs, "pagesRead"
    FROM "M365WindowLeaf" WHERE "attemptId" = $1 ORDER BY "fromInclusive", root DESC`, [(await windowOf(pgdb, windowId)).pointer])).rows;
  assert.deepEqual(leaves.map(l => [l.state, l.root, l.secs]), [['SPLIT', true, 3600], ['COMPLETE', false, 1800], ['COMPLETE', false, 1800]]);
  assert.equal(leaves[0].pagesRead, 20, 'the capped leaf stopped at 20 pages');
  // 20 rows read by the capped root leaf stay counted; the first half also receives the row exactly at its upper bound
  // (Graph's inclusive le), counted and discarded: 20 + 16 + 15.
  assert.deepEqual(await requestOf(pgdb, requestId), { totalLeaves: 3, totalStagedRows: 51, state: 'OPEN' });
});

test('B6: split down to the one-minute minimum and still capped → SYNC_LIMIT_EXCEEDED, explicit gap, no partial child publication', async () => {
  const { id, tenant } = await fresh();
  const root = hourStart(3); const clock = fixed(new Date());
  const data = [...Array.from({ length: 21 }, (_, i) => ({ id: `burst-${i}`, at: iso(root, 40 * MIN + i * 1000) })), { id: 'early', at: iso(root, MIN) }];
  const mock = mockM365(tenant, { route: signInRoute(() => data, { pageSize: 1 }) });
  const { requestId, windowId } = await oneRoot(id, root, clock);
  const [result] = await runM365SignInRequest(db, syncer, gasta, id, requestId, ioOf(mock), clock);
  assert.deepEqual([result!.outcome, result!.safeErrorCode], ['FAILED', 'SYNC_LIMIT_EXCEEDED']);
  const w = await windowOf(pgdb, windowId);
  assert.equal(w.pointer, null);
  const completed = Number((await pgdb.owner.query(`SELECT count(*) AS n FROM "M365WindowLeaf" WHERE "windowId" = $1 AND state = 'COMPLETE'`, [windowId])).rows[0].n);
  assert.ok(completed > 0, 'some children were read completely ...');
  assert.equal(Number((await pgdb.owner.query(`SELECT count(*) AS n FROM "M365WindowAttempt" WHERE "windowId" = $1 AND state = 'COMPLETE'`, [windowId])).rows[0].n), 0, '... yet nothing published');
  const coverage = rootCoverage({ rootFrom: root, rootTo: new Date(root.getTime() + HOUR), latestStartedSeq: w.started, latestPublishedSeq: w.published, status: w.status, safeErrorCode: w.code }, null, clock());
  assert.deepEqual([coverage.coverage, coverage.gaps.length, coverage.reasonCodes], ['UNAVAILABLE', 1, ['SYNC_LIMIT_EXCEEDED']]);
});

test('a root that is not yet collectable is an explicit RETRY gap without consuming budget; collectable roots proceed', async () => {
  const { id, tenant } = await fresh();
  const current = hourStart(0); const now = new Date(current.getTime() + 3 * MIN);
  const request = await createM365SignInRequest(db, syncer, gasta, id, new Date(current.getTime() - HOUR), new Date(current.getTime() + HOUR), fixed(now));
  const results = await runM365SignInRequest(db, syncer, gasta, id, request.requestId, ioOf(mockM365(tenant, { route: signInRoute(() => []) })), fixed(now));
  assert.deepEqual(results.map(r => r.outcome), ['PUBLISHED', 'NOT_YET_COLLECTABLE']);
  const pending = await jobOf(pgdb, request.requestId, request.roots[1]!.windowId);
  assert.deepEqual([pending.state, pending.attemptsUsed, pending.code], ['RETRY', 0, 'M365_NOT_YET_COLLECTABLE']);
  const done = await attemptOf(pgdb, (await windowOf(pgdb, request.roots[0]!.windowId)).pointer);
  assert.equal(done.coveredTo.getTime(), now.getTime() - 5 * MIN, 'the last hour is clipped at now − 5m (PARTIAL coverage with a gap)');
});
