import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AtlasError } from '../../packages/core/contracts.ts';
import { m365TokenCache } from '../../connectors/microsoft365/auth.ts';
import { claimRootAttempt, createM365SignInRequest, publishRootAttempt } from '../../packages/m365/windows.ts';
import type { RootClaim } from '../../packages/m365/windows.ts';
import { runM365SignInRequest, runRootAttempt } from '../../packages/m365/ingest.ts';
import { gasta } from '../support/graph-fixtures.ts';
import { m365Actors } from '../support/m365-fixtures.ts';
import { mockM365, signInRow } from '../support/m365-graph-mock.ts';
import { addActiveM365Connection, ioOf, setupM365Database } from '../support/m365-pg.ts';
import { hourStart, iso, signInRoute } from '../support/m365-signin-mock.ts';
import { attemptOf, jobOf, requestOf, windowOf } from '../support/m365-window-rows.ts';
import { guid } from '../m365-sql-invariants.ts';

// Review F5/F7 (S2-B repair) on PostgreSQL 17: every row of a cap-crossing page is validated against the current leaf
// before the split decision (an out-of-window row fails the attempt permanently even though valid child responses would
// follow); a cap-crossing page still consumes the request/root retrieval budget; the sign-in hard deadline and fixed bounds
// come from the persisted attempt, not from the caller-held descriptor. Lower leaf caps are configuration within hard bounds.
const { pgdb, db } = await setupM365Database();
after(async () => { await db.$disconnect(); await pgdb.drop(); });
beforeEach(() => m365TokenCache.clear());
const { syncer } = m365Actors;
const HOUR = 3_600_000; const MIN = 60_000;
const fails = (code: string) => (e: unknown) => e instanceof AtlasError && e.code === code;
let c = 0;
const fresh = async () => { const id = `m365-lim-${++c}`; const tenant = guid('123456acdef'[c - 1]!); await addActiveM365Connection(pgdb, id, tenant); return { id, tenant }; };
const at = (t: number) => () => new Date(t);

test('F5: 500-row pages (parser maximum); the page crossing the leaf cap carries one out-of-window row → permanent failure, no split, no publication', async () => {
  const { id, tenant } = await fresh();
  const root = hourStart(3); const t0 = Date.now();
  const rootTo = new Date(root.getTime() + HOUR);
  // 1,500 valid rows spread over the hour: smaller child windows would all be valid on their own
  const data = Array.from({ length: 1500 }, (_, i) => ({ id: `sig-${i}`, at: iso(root, Math.floor(i * HOUR / 1500)) }));
  const seen = new Map<string, number>();
  const crossing = { status: 200, body: { value: [...Array.from({ length: 499 }, (_, i) => signInRow(`x-${i}`, iso(root, 30 * MIN + i))), signInRow('outside', iso(root, -1))],
    '@odata.nextLink': `https://graph.microsoft.com/v1.0/auditLogs/signIns?$skiptoken=1500` } };
  const mock = mockM365(tenant, { route: signInRoute(() => data, { seen,
    inject: (from, to, pageIndex) => from.getTime() === root.getTime() && to.getTime() === rootTo.getTime() && pageIndex === 2 ? crossing : undefined }) });
  const r = await createM365SignInRequest(db, syncer, gasta, id, root, rootTo, at(t0));
  const [result] = await runM365SignInRequest(db, syncer, gasta, id, r.requestId, ioOf(mock), at(t0), { leafLimits: { maxRowsPerLeaf: 1000 } });
  assert.deepEqual([result!.outcome, result!.safeErrorCode], ['FAILED', 'M365_SIGNIN_OUT_OF_WINDOW']);
  const windowId = r.roots[0]!.windowId;
  assert.deepEqual(await jobOf(pgdb, r.requestId, windowId), { state: 'FAILED', attemptsUsed: 1, retryAt: null, code: 'M365_SIGNIN_OUT_OF_WINDOW' }, 'permanent');
  assert.equal((await windowOf(pgdb, windowId)).pointer, null);
  assert.deepEqual([...seen.keys()], [`${root.toISOString()}|${rootTo.toISOString()}`], 'no child leaf was ever requested');
  assert.equal(Number((await pgdb.owner.query(`SELECT count(*) AS n FROM "M365WindowLeaf" WHERE "windowId" = $1`, [windowId])).rows[0].n), 1, 'no split persisted');
});

test('F5: a valid cap-crossing page (with an exact-upper-bound row) consumes the request/root budget, stays out of the capped leaf, then splits', async () => {
  const { id, tenant } = await fresh();
  const root = hourStart(3); const t0 = Date.now(); const rootTo = new Date(root.getTime() + HOUR);
  const data = [...Array.from({ length: 5 }, (_, i) => ({ id: `sig-${i}`, at: iso(root, (i + 1) * MIN) })), { id: 'upper', at: rootTo.toISOString() }];
  const mock = mockM365(tenant, { route: signInRoute(() => data, { pageSize: 3 }) });
  const r = await createM365SignInRequest(db, syncer, gasta, id, root, rootTo, at(t0));
  const [result] = await runM365SignInRequest(db, syncer, gasta, id, r.requestId, ioOf(mock), at(t0), { leafLimits: { maxRowsPerLeaf: 5 } });
  assert.deepEqual([result!.outcome, result!.evidenceCount], ['PUBLISHED', 5]);
  const attempt = await attemptOf(pgdb, (await windowOf(pgdb, r.roots[0]!.windowId)).pointer);
  const leaves = (await pgdb.owner.query(`SELECT state, "parentLeafId" IS NULL AS root, "pagesRead", "rowCount" FROM "M365WindowLeaf" WHERE "attemptId" = $1
    ORDER BY root DESC, "fromInclusive"`, [attempt.id])).rows;
  assert.deepEqual(leaves.map(l => [l.state, l.root, l.pagesRead, l.rowCount]), [['SPLIT', true, 1, 3], ['COMPLETE', false, 2, 5], ['COMPLETE', false, 1, 1]],
    'the capped root leaf counts only its accepted page; the crossing page is not in it');
  // Retrieval: root page 1 (3) + crossing page (3, incl. the exact-upper-bound row) + first half (5) + second half (its upper bound, 1)
  assert.equal(attempt.stagedRows, 12);
  assert.deepEqual(await requestOf(pgdb, r.requestId), { totalLeaves: 3, totalStagedRows: 12, state: 'OPEN' });
  await assert.rejects(runM365SignInRequest(db, syncer, gasta, id, r.requestId, ioOf(mock), at(t0), { leafLimits: { maxRowsPerLeaf: 10_001 } }), fails('M365_LIMIT_INVALID'),
    'limits can only be lowered within the hard bounds');
  await assert.rejects(runM365SignInRequest(db, syncer, gasta, id, r.requestId, ioOf(mock), at(t0), { leafLimits: { maxPagesPerLeaf: 21 } }), fails('M365_LIMIT_INVALID'));
});

test('F7: the sign-in hard deadline and fixed bounds are the persisted ones; descriptor dates changed by the caller extend nothing', async () => {
  const { id, tenant } = await fresh();
  const root = hourStart(3); const t0 = Date.now(); const rootTo = new Date(root.getTime() + HOUR);
  const mock = mockM365(tenant, { route: signInRoute(() => [{ id: 'sig-1', at: iso(root, MIN) }]) });
  const r = await createM365SignInRequest(db, syncer, gasta, id, root, rootTo, at(t0));
  const outcome = await claimRootAttempt(db, syncer, gasta, id, r.requestId, r.roots[0]!.windowId, at(t0));
  assert.ok('claimed' in outcome);
  const claim: RootClaim = outcome.claimed;
  claim.deadlineAt.setTime(t0 + 24 * HOUR); claim.leaseExpiresAt.setTime(t0 + 24 * HOUR); claim.coveredTo.setTime(t0 + 48 * HOUR);
  await assert.rejects(runRootAttempt(db, syncer, claim, ioOf(mock), at(t0 + 10 * MIN)), (e: unknown) => fails('SYNC_LIMIT_EXCEEDED')(e) && (e as AtlasError).details.limit === 'deadline');
  assert.deepEqual(mock.collectionGets(), [], 'past the persisted deadline no sign-in request is sent');
  await runRootAttempt(db, syncer, claim, ioOf(mock), at(t0 + MIN));
  await assert.rejects(publishRootAttempt(db, syncer, claim, at(t0 + 10 * MIN + 1)), fails('SYNC_LIMIT_EXCEEDED'));
  await publishRootAttempt(db, syncer, claim, at(t0 + 2 * MIN));
  const attempt = await attemptOf(pgdb, claim.attemptId);
  assert.equal(attempt.coveredTo.getTime(), rootTo.getTime());
  assert.equal(attempt.expiresAt.getTime(), rootTo.getTime() + 7 * 24 * HOUR, 'retention from the persisted bounds, not the tampered descriptor');
});
