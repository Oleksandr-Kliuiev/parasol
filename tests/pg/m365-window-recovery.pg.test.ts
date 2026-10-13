import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AtlasError } from '../../packages/core/contracts.ts';
import { m365TokenCache } from '../../connectors/microsoft365/auth.ts';
import type { GraphTransport } from '../../connectors/microsoft365/http.ts';
import { claimRootAttempt, createM365SignInRequest, publishRootAttempt, recordRootFailure, requeueM365RootJob } from '../../packages/m365/windows.ts';
import type { RootClaim } from '../../packages/m365/windows.ts';
import { runM365SignInRequest, runRootAttempt } from '../../packages/m365/ingest.ts';
import { gasta } from '../support/graph-fixtures.ts';
import { m365Actors } from '../support/m365-fixtures.ts';
import { mockM365 } from '../support/m365-graph-mock.ts';
import type { M365Mock } from '../support/m365-graph-mock.ts';
import { addActiveM365Connection, ioOf, setupM365Database } from '../support/m365-pg.ts';
import { hourStart, iso, signInRoute } from '../support/m365-signin-mock.ts';
import type { SignInData } from '../support/m365-signin-mock.ts';
import { attemptOf, evidenceOf, jobOf, publishedMembers, windowOf } from '../support/m365-window-rows.ts';
import { guid } from '../m365-sql-invariants.ts';

// Stage 2 task 2.6, B5 on PostgreSQL 17: crash after page staging, before and after the final commit; two workers; the
// persistent retry budget (expired claims count, finite, explicit audited requeue resets it); restart from the first page
// as a new immutable attempt; no partial readable window; immutable duplicate/conflict versions, staged versions invisible.
const { pgdb, db } = await setupM365Database();
after(async () => { await db.$disconnect(); await pgdb.drop(); });
beforeEach(() => m365TokenCache.clear());
const { syncer } = m365Actors;
const HOUR = 3_600_000; const MIN = 60_000;
const fails = (code: string) => (e: unknown) => e instanceof AtlasError && e.code === code;
let c = 0;
const fresh = async () => { const id = `m365-rec-${++c}`; const tenant = guid('123456acdef'[c - 1]!); await addActiveM365Connection(pgdb, id, tenant); return { id, tenant }; };
const at = (t: number) => () => new Date(t);
const claimOf = async (id: string, requestId: string, windowId: string, t: number): Promise<RootClaim> => {
  const outcome = await claimRootAttempt(db, syncer, gasta, id, requestId, windowId, at(t));
  assert.ok('claimed' in outcome, JSON.stringify(outcome));
  return outcome.claimed;
};
/** A transport that dies (like the process) at the `n`-th sign-in request: nothing after it runs, nothing is recorded. */
function crashingAt(mock: M365Mock, n: number): GraphTransport {
  let seen = 0;
  return async (url, init) => {
    if (url.includes('/auditLogs/signIns') && ++seen === n) throw Object.assign(new Error('process crash'), { name: 'Crash' });
    return mock.graph(url, init);
  };
}
const signInGets = (mock: M365Mock) => mock.gets('/v1.0/auditLogs/signIns');

test('B5: crash after page staging → no readable window; a live lease is HELD; after expiry a new attempt restarts from the first page', async () => {
  const { id, tenant } = await fresh();
  const root = hourStart(3); const t0 = Date.now();
  const data = Array.from({ length: 3 }, (_, i) => ({ id: `sig-${i}`, at: iso(root, i * MIN) }));
  const mock = mockM365(tenant, { route: signInRoute(() => data, { pageSize: 1 }) });
  const { requestId, roots } = await createM365SignInRequest(db, syncer, gasta, id, root, new Date(root.getTime() + HOUR), at(t0));
  const windowId = roots[0]!.windowId;
  const crashed = await claimOf(id, requestId, windowId, t0);
  // The worker dies during page 2 (the transport error is sanitized); no orchestrator survives to record anything.
  await assert.rejects(runRootAttempt(db, syncer, crashed, { ...ioOf(mock), graph: crashingAt(mock, 2) }, at(t0)), fails('M365_UPSTREAM_UNAVAILABLE'));
  assert.equal(Number((await pgdb.owner.query(`SELECT "stagedRows" FROM "M365WindowAttempt" WHERE id = $1`, [crashed.attemptId])).rows[0].stagedRows), 1, 'page 1 staged');
  assert.deepEqual(await publishedMembers(pgdb, windowId), [], 'no partial readable window');
  assert.equal((await windowOf(pgdb, windowId)).pointer, null);
  const before = mock.requests.length;
  const [held] = await runM365SignInRequest(db, syncer, gasta, id, requestId, ioOf(mock), at(t0 + MIN));
  assert.equal(held!.outcome, 'HELD'); assert.equal(mock.requests.length, before, 'a live claim is never duplicated');
  const [restart] = await runM365SignInRequest(db, syncer, gasta, id, requestId, ioOf(mock), at(t0 + 12 * MIN));
  assert.deepEqual([restart!.outcome, restart!.attemptSeq, restart!.evidenceCount], ['PUBLISHED', 2, 3]);
  const gets = signInGets(mock).slice(-3);
  assert.equal(new URL(gets[0]!.url).searchParams.get('$skiptoken'), null, 'restart refetches from the first page; no stored cursor');
  assert.deepEqual([(await attemptOf(pgdb, crashed.attemptId)).state, (await attemptOf(pgdb, crashed.attemptId)).code], ['FAILED', 'M365_CLAIM_EXPIRED']);
  assert.equal((await jobOf(pgdb, requestId, windowId)).attemptsUsed, 2, 'the crashed claim consumed its budget unit');
  // The old claim can neither stage, publish nor record for its successor
  await assert.rejects(publishRootAttempt(db, syncer, crashed, at(t0 + 13 * MIN)), fails('M365_CLAIM_LOST'));
  assert.deepEqual(await recordRootFailure(db, syncer, crashed, new AtlasError('M365_UPSTREAM_UNAVAILABLE', 'TRANSIENT'), at(t0 + 13 * MIN)),
    { recorded: false, jobState: null, retryAt: null, attemptsUsed: 2, maxAttempts: 5 });
  assert.equal((await jobOf(pgdb, requestId, windowId)).state, 'COMPLETE');
});

test('B5: crash before the final commit keeps the old pointer and time; crash after the commit is a success', async () => {
  const { id, tenant } = await fresh();
  const root = hourStart(3); const t0 = Date.now();
  const mock = mockM365(tenant, { route: signInRoute(() => [{ id: 'sig-1', at: iso(root, MIN) }]) });
  const first = await createM365SignInRequest(db, syncer, gasta, id, root, new Date(root.getTime() + HOUR), at(t0));
  await runM365SignInRequest(db, syncer, gasta, id, first.requestId, ioOf(mock), at(t0));
  const windowId = first.roots[0]!.windowId;
  const published = await windowOf(pgdb, windowId);
  const members = await publishedMembers(pgdb, windowId);
  const refresh = await createM365SignInRequest(db, syncer, gasta, id, root, new Date(root.getTime() + HOUR), at(t0 + MIN));
  const claim = await claimOf(id, refresh.requestId, windowId, t0 + MIN);
  await runRootAttempt(db, syncer, claim, ioOf(mock), at(t0 + MIN));
  await assert.rejects(publishRootAttempt(db, syncer, claim, at(t0 + MIN), { beforeCommit: async () => { throw new Error('process crash'); } }), /process crash/);
  const kept = await windowOf(pgdb, windowId);
  assert.deepEqual([kept.pointer, kept.published, kept.lastSuccessAt!.getTime()], [published.pointer, 1, published.lastSuccessAt!.getTime()]);
  assert.deepEqual(await publishedMembers(pgdb, windowId), members);
  assert.equal((await attemptOf(pgdb, claim.attemptId)).state, 'RUNNING', 'rolled back entirely');
  // The same claim may still commit (no state was lost); afterwards a crash of the process changes nothing
  await publishRootAttempt(db, syncer, claim, at(t0 + 2 * MIN));
  const after = await windowOf(pgdb, windowId);
  assert.deepEqual([after.pointer, after.published], [claim.attemptId, 2]);
  assert.deepEqual([(await attemptOf(pgdb, published.pointer)).state], ['SUPERSEDED']);
  const [done] = await runM365SignInRequest(db, syncer, gasta, id, refresh.requestId, ioOf(mock), at(t0 + 30 * MIN));
  assert.equal(done!.outcome, 'DONE');
});

test('B5: two workers on one request: one attempt runs, the other is HELD or finds it DONE; one publication', async () => {
  const { id, tenant } = await fresh();
  const root = hourStart(3); const t0 = Date.now();
  const mock = mockM365(tenant, { route: signInRoute(() => [{ id: 'sig-1', at: iso(root, MIN) }]) });
  const { requestId, roots } = await createM365SignInRequest(db, syncer, gasta, id, root, new Date(root.getTime() + HOUR), at(t0));
  const outcomes = (await Promise.all([1, 2].map(() => runM365SignInRequest(db, syncer, gasta, id, requestId, ioOf(mock), at(t0))))).map(r => r[0]!.outcome).sort();
  assert.ok(outcomes.includes('PUBLISHED') && outcomes.filter(o => o === 'PUBLISHED').length === 1, outcomes.join());
  assert.ok(['DONE', 'HELD'].includes(outcomes.find(o => o !== 'PUBLISHED')!));
  assert.equal(Number((await pgdb.owner.query(`SELECT count(*) AS n FROM "M365WindowAttempt" WHERE "windowId" = $1`, [roots[0]!.windowId])).rows[0].n), 1);
  assert.equal((await jobOf(pgdb, requestId, roots[0]!.windowId)).attemptsUsed, 1);
});

test('B5: the retry budget is persistent and finite (crashed claims count); an explicit audited requeue of the existing job resets it', async () => {
  const { id, tenant } = await fresh();
  const root = hourStart(3); let t = Date.now();
  let failing = true;
  const mock = mockM365(tenant, { route: signInRoute(() => [{ id: 'sig-1', at: iso(root, MIN) }], { inject: () => failing ? { status: 503 } : undefined }) });
  const { requestId, roots } = await createM365SignInRequest(db, syncer, gasta, id, root, new Date(root.getTime() + HOUR), at(t));
  const windowId = roots[0]!.windowId;
  const crashed = await claimOf(id, requestId, windowId, t); // unit 1, then the worker dies without recording anything
  t += 12 * MIN;
  for (let unit = 2; unit <= 5; unit++) {
    const [r] = await runM365SignInRequest(db, syncer, gasta, id, requestId, ioOf(mock), at(t));
    const job = await jobOf(pgdb, requestId, windowId);
    assert.equal(job.attemptsUsed, unit);
    assert.equal(r!.outcome, unit < 5 ? 'RETRY' : 'FAILED', `unit ${unit}`);
    if (job.retryAt) t = job.retryAt.getTime();
  }
  assert.equal((await attemptOf(pgdb, crashed.attemptId)).code, 'M365_CLAIM_EXPIRED');
  const sent = mock.requests.length;
  const [exhausted] = await runM365SignInRequest(db, syncer, gasta, id, requestId, ioOf(mock), at(t + HOUR));
  // Review RC2-R3: the repeat pass reports the stored failure and the spent budget, not DONE; still no sixth attempt
  assert.deepEqual([exhausted!.outcome, exhausted!.safeErrorCode, exhausted!.attemptsUsed, exhausted!.maxAttempts], ['FAILED', 'M365_UPSTREAM_UNAVAILABLE', 5, 5]);
  assert.equal(mock.requests.length, sent, 'no sixth attempt');
  await assert.rejects(requeueM365RootJob(db, m365Actors.admin, gasta, id, requestId, windowId), fails('PERMISSION_DENIED'));
  await assert.rejects(requeueM365RootJob(db, syncer, gasta, id, requestId, guid('0')), fails('M365_JOB_NOT_FOUND'));
  assert.deepEqual(await requeueM365RootJob(db, syncer, gasta, id, requestId, windowId), { requestId, windowId, state: 'PENDING', attemptsUsed: 0 });
  const audit = (await pgdb.owner.query(`SELECT metadata FROM "AuditEvent" WHERE "eventType" = 'm365.signin_requeued' AND metadata->>'requestId' = $1`, [requestId])).rows;
  assert.deepEqual(audit.map(a => a.metadata), [{ connectionId: id, system: 'microsoft365', requestId, attemptsUsed: '5' }]);
  failing = false;
  const [ok] = await runM365SignInRequest(db, syncer, gasta, id, requestId, ioOf(mock), at(t + HOUR));
  assert.deepEqual([ok!.outcome, ok!.attemptSeq], ['PUBLISHED', 6]);
  assert.equal((await jobOf(pgdb, requestId, windowId)).attemptsUsed, 1);
  await assert.rejects(requeueM365RootJob(db, syncer, gasta, id, requestId, windowId), fails('M365_JOB_NOT_REQUEUEABLE'));
});

test('B5: versions are immutable; a changed sign-in is a new version; a staged-only version of a failed refresh stays invisible', async () => {
  const { id, tenant } = await fresh();
  const root = hourStart(3); const t0 = Date.now();
  let data: SignInData[] = [{ id: 'sig-x', at: iso(root, MIN) }, { id: 'sig-y', at: iso(root, 40 * MIN) }];
  let failSecondHalf = false;
  const mock = mockM365(tenant, { route: signInRoute(() => data, { pageSize: 1, inject: (from) => failSecondHalf && from.getTime() > root.getTime() ? { status: 400 } : undefined }) });
  const first = await createM365SignInRequest(db, syncer, gasta, id, root, new Date(root.getTime() + HOUR), at(t0));
  await runM365SignInRequest(db, syncer, gasta, id, first.requestId, ioOf(mock), at(t0));
  const windowId = first.roots[0]!.windowId;
  const v1 = await evidenceOf(pgdb, id);
  const members1 = await publishedMembers(pgdb, windowId);
  // Refresh: sig-x changed (new version), then the second half fails → the new version exists only as staged evidence
  data = [{ id: 'sig-x', at: iso(root, MIN), extra: { status: { errorCode: 50126 } } }, { id: 'sig-y', at: iso(root, 40 * MIN) },
    ...Array.from({ length: 20 }, (_, i) => ({ id: `fill-${i}`, at: iso(root, 31 * MIN + i * 1000) }))];
  failSecondHalf = true;
  const refresh = await createM365SignInRequest(db, syncer, gasta, id, root, new Date(root.getTime() + HOUR), at(t0 + MIN));
  const [failed] = await runM365SignInRequest(db, syncer, gasta, id, refresh.requestId, ioOf(mock), at(t0 + MIN));
  assert.equal(failed!.outcome, 'FAILED');
  const all = await evidenceOf(pgdb, id);
  assert.ok(all.filter(e => e.sourceId === 'sig-x').length === 2, 'the changed content is another immutable version');
  for (const old of v1) assert.deepEqual(all.find(e => e.id === old.id), old, 'existing versions never change');
  assert.deepEqual(await publishedMembers(pgdb, windowId), members1, 'the staged-only version is not visible');
  await assert.rejects(pgdb.owner.query(`UPDATE "M365SignInEvidence" SET dto = jsonb_set(dto, '{errorCode}', '1') WHERE id = $1`, [v1[0].id]), /immutable/);
});
