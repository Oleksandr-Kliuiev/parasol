import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { AtlasError } from '../../packages/core/contracts.ts';
import { m365TokenCache } from '../../connectors/microsoft365/auth.ts';
import { claimRootAttempt, createM365SignInRequest, publishRootAttempt, recordRootFailure } from '../../packages/m365/windows.ts';
import type { RootClaim } from '../../packages/m365/windows.ts';
import { runM365SignInRequest, runRootAttempt } from '../../packages/m365/ingest.ts';
import { rootCoverage } from '../../packages/m365/status.ts';
import { gasta } from '../support/graph-fixtures.ts';
import { m365Actors } from '../support/m365-fixtures.ts';
import { mockM365 } from '../support/m365-graph-mock.ts';
import { addActiveM365Connection, ioOf, setupM365Database } from '../support/m365-pg.ts';
import { hourStart, iso, signInRoute } from '../support/m365-signin-mock.ts';
import { attemptOf, jobOf, publishedMembers, windowOf } from '../support/m365-window-rows.ts';
import { inFlight, waitUntilBlocked } from '../support/pg-race.ts';
import { guid } from '../m365-sql-invariants.ts';

// Stage 2 task 2.6, B5a/B5b/B1b on PostgreSQL 17: only a whole root with an exact COMPLETE leaf partition swaps the
// pointer; a failed split half publishes nothing and the old membership/retrieval time stay exactly; old and new attempts
// race; independent roots; SQL root shape; gapped partitions refused (also after restart); disable wins the fence;
// a new publication never narrows prior unexpired coverage except at the retention boundary.
const { pgdb, db } = await setupM365Database();
after(async () => { await db.$disconnect(); await pgdb.drop(); });
beforeEach(() => m365TokenCache.clear());
const { syncer } = m365Actors;
const HOUR = 3_600_000; const MIN = 60_000;
const fails = (code: string) => (e: unknown) => e instanceof AtlasError && e.code === code;
let c = 0;
const fresh = async () => { const id = `m365-pub-${++c}`; const tenant = guid('123456acdef'[c - 1]!); await addActiveM365Connection(pgdb, id, tenant); return { id, tenant }; };
const at = (t: number) => () => new Date(t);
const request = (id: string, root: Date, t: number) => createM365SignInRequest(db, syncer, gasta, id, root, new Date(root.getTime() + HOUR), at(t));
const claimOf = async (id: string, requestId: string, windowId: string, t: number): Promise<RootClaim> => {
  const outcome = await claimRootAttempt(db, syncer, gasta, id, requestId, windowId, at(t));
  assert.ok('claimed' in outcome, JSON.stringify(outcome));
  return outcome.claimed;
};

test('B5a: published hour, crashed refresh, then a split refresh with a failed half: the exact old membership and time stay (STALE)', async () => {
  const { id, tenant } = await fresh();
  const root = hourStart(3); const t0 = Date.now();
  let data = [{ id: 'sig-1', at: iso(root, MIN) }, { id: 'sig-2', at: iso(root, 45 * MIN) }];
  let failHalf = false;
  const mock = mockM365(tenant, { route: signInRoute(() => data, { pageSize: 1, inject: from => failHalf && from.getTime() > root.getTime() ? { status: 503 } : undefined }) });
  const first = await request(id, root, t0);
  const windowId = first.roots[0]!.windowId;
  await runM365SignInRequest(db, syncer, gasta, id, first.requestId, ioOf(mock), at(t0));
  const published = await windowOf(pgdb, windowId); const members = await publishedMembers(pgdb, windowId);
  const old = await attemptOf(pgdb, published.pointer);
  // Refresh 1 crashes mid-way (claimed, never recorded)
  const crash = await request(id, root, t0 + MIN);
  await claimOf(id, crash.requestId, windowId, t0 + MIN);
  // Refresh 2 after the lease expired: the root splits; the first half completes, the second fails
  data = [...data, ...Array.from({ length: 20 }, (_, i) => ({ id: `fill-${i}`, at: iso(root, 31 * MIN + i * 1000) }))];
  failHalf = true;
  const split = await request(id, root, t0 + 13 * MIN);
  const [r] = await runM365SignInRequest(db, syncer, gasta, id, split.requestId, ioOf(mock), at(t0 + 13 * MIN));
  assert.deepEqual([r!.outcome, r!.safeErrorCode], ['RETRY', 'M365_UPSTREAM_UNAVAILABLE']);
  const w = await windowOf(pgdb, windowId);
  assert.deepEqual([w.pointer, w.published, w.status, w.lastSuccessAt!.getTime()], [published.pointer, 1, 'ERROR', published.lastSuccessAt!.getTime()]);
  assert.deepEqual(await publishedMembers(pgdb, windowId), members, 'exact old membership');
  assert.equal((await attemptOf(pgdb, published.pointer)).publishedAt.getTime(), old.publishedAt.getTime(), 'old retrieval time, never advanced');
  const completedChild = Number((await pgdb.owner.query(`SELECT count(*) AS n FROM "M365WindowLeaf" l JOIN "M365WindowAttempt" a ON a.id = l."attemptId"
    WHERE a."requestId" = $1 AND l.state = 'COMPLETE'`, [split.requestId])).rows[0].n);
  assert.equal(completedChild, 1, 'the completed half exists only as staging');
  const coverage = rootCoverage({ rootFrom: root, rootTo: new Date(root.getTime() + HOUR), latestStartedSeq: w.started, latestPublishedSeq: w.published,
    status: w.status, safeErrorCode: w.code }, old, new Date(t0 + 13 * MIN));
  assert.deepEqual([coverage.coverage, coverage.freshness, coverage.retrievedAt!.getTime(), coverage.reasonCodes],
    ['COMPLETE', 'STALE', old.publishedAt.getTime(), ['M365_UPSTREAM_UNAVAILABLE']]);
});

test('B5a: old and new attempts race (both finish orders): only the newest started publishes; the loser records nothing for it', async () => {
  const { id, tenant } = await fresh();
  const t0 = Date.now();
  const mock = mockM365(tenant, { route: signInRoute(() => []) });
  for (const [hours, order] of [[3, 'older-first'], [4, 'newer-first']] as const) {
    const root = hourStart(hours);
    const r1 = await request(id, root, t0); const r2 = await request(id, root, t0);
    const windowId = r1.roots[0]!.windowId;
    const older = await claimOf(id, r1.requestId, windowId, t0);
    await runRootAttempt(db, syncer, older, ioOf(mock), at(t0));
    const newer = await claimOf(id, r2.requestId, windowId, t0);
    await runRootAttempt(db, syncer, newer, ioOf(mock), at(t0));
    if (order === 'newer-first') await publishRootAttempt(db, syncer, newer, at(t0));
    await assert.rejects(publishRootAttempt(db, syncer, older, at(t0)), fails('M365_ATTEMPT_SUPERSEDED'));
    const lost = await recordRootFailure(db, syncer, older, new AtlasError('M365_ATTEMPT_SUPERSEDED', 'PERMANENT'), at(t0));
    assert.deepEqual([lost.recorded, lost.jobState], [true, 'FAILED'], 'its own job ends; the window is not its to record');
    if (order === 'older-first') await publishRootAttempt(db, syncer, newer, at(t0));
    const w = await windowOf(pgdb, windowId);
    assert.deepEqual([w.pointer, w.status, w.recorded], [newer.attemptId, 'OK', 2], order);
    assert.equal((await jobOf(pgdb, r2.requestId, windowId)).state, 'COMPLETE');
  }
});

test('B5a: independent roots of one request: one published, one failed → a partial request, each root explicit', async () => {
  const { id, tenant } = await fresh();
  const t0 = Date.now(); const from = hourStart(5);
  const mock = mockM365(tenant, { route: signInRoute(() => [{ id: 'sig-1', at: iso(from, MIN) }], { inject: f => f.getTime() >= from.getTime() + HOUR ? { status: 403 } : undefined }) });
  const r = await createM365SignInRequest(db, syncer, gasta, id, from, new Date(from.getTime() + 2 * HOUR), at(t0));
  const results = await runM365SignInRequest(db, syncer, gasta, id, r.requestId, ioOf(mock), at(t0));
  assert.deepEqual(results.map(x => [x.outcome, x.safeErrorCode]), [['PUBLISHED', null], ['FAILED', 'M365_ACCESS_DENIED']]);
  assert.ok((await windowOf(pgdb, r.roots[0]!.windowId)).pointer);
  assert.equal((await windowOf(pgdb, r.roots[1]!.windowId)).pointer, null);
});

test('B5b: SQL refuses non-hour-aligned roots and rootTo ≠ rootFrom + 1h', async () => {
  const insert = (from: string, to: string) => pgdb.owner.query(`INSERT INTO "M365SignInWindow" ("workspaceId","clientId","connectionId",id,"rootFrom","rootTo")
    VALUES ('demo-vardahei','demo-gasta','gasta-m365',$1,$2,$3)`, [`w-${from}`, from, to]);
  await assert.rejects(insert('2026-10-01 10:30:00', '2026-10-01 11:30:00'), /M365SignInWindow_root_check/);
  await assert.rejects(insert('2026-10-01 10:00:00', '2026-10-01 12:00:00'), /M365SignInWindow_root_check/);
  await assert.rejects(insert('2026-10-01 10:00:00.001', '2026-10-01 11:00:00.001'), /M365SignInWindow_root_check/);
});

/** Owner-side writes in one transaction, the attempt locked first (as the triggers require). */
async function asOwner(claim: RootClaim, statements: [string, unknown[]][]): Promise<void> {
  const o = new pg.Client({ connectionString: pgdb.ownerUrl }); await o.connect();
  try {
    await o.query('BEGIN');
    await o.query(`SELECT 1 FROM "M365WindowAttempt" WHERE id = $1 FOR UPDATE`, [claim.attemptId]);
    for (const [sql, params] of statements) await o.query(sql, params);
    await o.query('COMMIT');
  } catch (error) { await o.query('ROLLBACK'); throw error; } finally { await o.end(); }
}
const child = (claim: RootClaim, id: string, fromMin: number, toMin: number): [string, unknown[]] => [`INSERT INTO "M365WindowLeaf" ("workspaceId","clientId",
  "connectionId","windowId","attemptId",id,"parentLeafId","fromInclusive","toExclusive") SELECT "workspaceId","clientId","connectionId","windowId","attemptId",$2,id,
  "fromInclusive" + make_interval(secs => $3::float8 * 60), "fromInclusive" + make_interval(secs => $4::float8 * 60) FROM "M365WindowLeaf" WHERE id = $1`, [claim.rootLeafId, id, fromMin, toMin]];
/** Root leaf → SPLIT with one COMPLETE child covering only the first half: a gap. */
const gappedPartition = (claim: RootClaim) => asOwner(claim, [
  [`UPDATE "M365WindowLeaf" SET state = 'RUNNING' WHERE id = $1`, [claim.rootLeafId]], [`UPDATE "M365WindowLeaf" SET state = 'SPLIT' WHERE id = $1`, [claim.rootLeafId]],
  child(claim, `half-${claim.attemptId}`, 0, 30),
  [`UPDATE "M365WindowLeaf" SET state = 'RUNNING' WHERE id = $1`, [`half-${claim.attemptId}`]], [`UPDATE "M365WindowLeaf" SET state = 'COMPLETE' WHERE id = $1`, [`half-${claim.attemptId}`]]]);

test('B5b: publication refuses a gapped/overlapping partition, also after a restart; the old pointer stays', async () => {
  const { id, tenant } = await fresh();
  const root = hourStart(3); const t0 = Date.now();
  const mock = mockM365(tenant, { route: signInRoute(() => []) });
  const first = await request(id, root, t0);
  const windowId = first.roots[0]!.windowId;
  await runM365SignInRequest(db, syncer, gasta, id, first.requestId, ioOf(mock), at(t0));
  const pointer = (await windowOf(pgdb, windowId)).pointer;
  const refresh = await request(id, root, t0 + MIN);
  let last: RootClaim | null = null;
  for (const t of [t0 + MIN, t0 + 14 * MIN]) { // the second claim is the restart after the first one's lease expired
    const claim = await claimOf(id, refresh.requestId, windowId, t);
    await gappedPartition(claim);
    await assert.rejects(publishRootAttempt(db, syncer, claim, at(t)), /cover the attempt bounds exactly/);
    assert.equal((await windowOf(pgdb, windowId)).pointer, pointer);
    last = claim;
  }
  await assert.rejects(asOwner(last!, [child(last!, 'overlap', 20, 50)]), /never overlap/);
  await assert.rejects(asOwner(last!, [child(last!, 'zero', 40, 40)]), /M365WindowLeaf_bounds_check/);
  await assert.rejects(asOwner(last!, [child(last!, 'short', 40, 40.5)]), /M365WindowLeaf_bounds_check/, 'children are at least one minute');
});

test('B1b: a disable winning the Connection lock fails the waiting window publication; the retained pointer is unchanged', async () => {
  const { id, tenant } = await fresh();
  const root = hourStart(3); const t0 = Date.now();
  const mock = mockM365(tenant, { route: signInRoute(() => []) });
  const first = await request(id, root, t0);
  const windowId = first.roots[0]!.windowId;
  await runM365SignInRequest(db, syncer, gasta, id, first.requestId, ioOf(mock), at(t0));
  const pointer = (await windowOf(pgdb, windowId)).pointer;
  const refresh = await request(id, root, t0 + MIN);
  const claim = await claimOf(id, refresh.requestId, windowId, t0 + MIN);
  await runRootAttempt(db, syncer, claim, ioOf(mock), at(t0 + MIN));
  const disabler = new pg.Client({ connectionString: pgdb.ownerUrl }); await disabler.connect();
  try {
    await disabler.query('BEGIN');
    await disabler.query(`UPDATE "Connection" SET status = 'DISABLED', "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = $1`, [id]);
    const publishing = inFlight(() => publishRootAttempt(db, syncer, claim, at(t0 + MIN)));
    await waitUntilBlocked(pgdb.owner, null);
    await disabler.query('COMMIT');
    await assert.rejects(publishing.result(), fails('M365_CONNECTION_CHANGED'));
  } finally { await disabler.end(); }
  assert.equal((await windowOf(pgdb, windowId)).pointer, pointer);
  const failure = await recordRootFailure(db, syncer, claim, new AtlasError('M365_CONNECTION_CHANGED', 'PERMANENT'), at(t0 + MIN));
  assert.deepEqual([failure.recorded, failure.jobState], [true, 'FAILED'], 'the failure of a disabled connection is still recorded');
  assert.equal((await windowOf(pgdb, windowId)).pointer, pointer);
});

test('coverage: a new publication cannot narrow prior unexpired coverage, except where the retention boundary advanced', async () => {
  const { id, tenant } = await fresh();
  const mock = mockM365(tenant, { route: signInRoute(() => []) });
  const current = hourStart(0);
  const wide = await request(id, current, current.getTime() + 30 * MIN); // covers [root, root+25m)
  const windowId = wide.roots[0]!.windowId;
  await runM365SignInRequest(db, syncer, gasta, id, wide.requestId, ioOf(mock), at(current.getTime() + 30 * MIN));
  const pointer = (await windowOf(pgdb, windowId)).pointer;
  const narrow = await request(id, current, current.getTime() + 20 * MIN); // an earlier clock would cover only [root, root+15m)
  const [refused] = await runM365SignInRequest(db, syncer, gasta, id, narrow.requestId, ioOf(mock), at(current.getTime() + 20 * MIN));
  assert.deepEqual([refused!.outcome, refused!.safeErrorCode], ['FAILED', 'M365_COVERAGE_NARROWED']);
  assert.equal((await windowOf(pgdb, windowId)).pointer, pointer);
  const wider = await request(id, current, current.getTime() + 40 * MIN);
  assert.equal((await runM365SignInRequest(db, syncer, gasta, id, wider.requestId, ioOf(mock), at(current.getTime() + 40 * MIN)))[0]!.outcome, 'PUBLISHED');
  // Retention boundary: an old root published while fully retained may later be republished clipped at the new floor
  const old = hourStart(24 * 7 - 1); const week = 7 * 24 * HOUR;
  const r1 = await request(id, old, old.getTime() + week - 30 * MIN);
  await runM365SignInRequest(db, syncer, gasta, id, r1.requestId, ioOf(mock), at(old.getTime() + week - 30 * MIN));
  const r2 = await createM365SignInRequest(db, syncer, gasta, id, old, new Date(old.getTime() + HOUR), at(old.getTime() + week + 10 * MIN));
  const [clipped] = await runM365SignInRequest(db, syncer, gasta, id, r2.requestId, ioOf(mock), at(old.getTime() + week + 10 * MIN));
  assert.equal(clipped!.outcome, 'PUBLISHED');
  const a = await attemptOf(pgdb, (await windowOf(pgdb, r2.roots[0]!.windowId)).pointer);
  assert.equal(a.coveredFrom.getTime(), old.getTime() + 10 * MIN, 'narrowed only at the advancing retention floor');
});
