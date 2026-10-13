import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { m365TokenCache } from '../../connectors/microsoft365/auth.ts';
import { AtlasError } from '../../packages/core/contracts.ts';
import { claimRootAttempt, createM365SignInRequest, recordRootFailure } from '../../packages/m365/windows.ts';
import { runM365SignInRequest } from '../../packages/m365/ingest.ts';
import type { RootResult } from '../../packages/m365/ingest.ts';
import { gasta } from '../support/graph-fixtures.ts';
import { m365Actors } from '../support/m365-fixtures.ts';
import { mockM365, syntheticSecrets } from '../support/m365-graph-mock.ts';
import { addActiveM365Connection, ioOf, setupM365Database } from '../support/m365-pg.ts';
import { hourStart, iso, signInRoute } from '../support/m365-signin-mock.ts';
import { guid } from '../m365-sql-invariants.ts';

// Review RC2-R3 on PostgreSQL 17: a repeat sign-in pass reports each root's stored outcome — COMPLETE → DONE/null,
// FAILED → FAILED with its stored safe code (permanent below the bound vs. exhausted at used == max), RETRY before
// retryAt → NOT_DUE, a live claim → HELD — with budget counters, and none of them claims, charges, uses secrets, performs
// I/O or touches evidence/history (the terminal check precedes expired-attempt maintenance).
const { pgdb, db } = await setupM365Database();
after(async () => { await db.$disconnect(); await pgdb.drop(); });
beforeEach(() => m365TokenCache.clear());
const { syncer } = m365Actors;
const HOUR = 3_600_000; const MIN = 60_000;
let c = 0;
const fresh = async () => { const id = `m365-out-${++c}`; const tenant = guid('123456acdef'[c - 1]!); await addActiveM365Connection(pgdb, id, tenant); return { id, tenant }; };
const at = (t: number) => () => new Date(t);
const history = async (id: string) => (await pgdb.owner.query(`SELECT
  (SELECT count(*)::int FROM "M365WindowAttempt" WHERE "connectionId" = $1) AS attempts,
  (SELECT count(*)::int FROM "M365WindowAttempt" WHERE "connectionId" = $1 AND state = 'RUNNING') AS running,
  (SELECT count(*)::int FROM "M365SignInEvidence" WHERE "connectionId" = $1) AS evidence,
  (SELECT coalesce(sum("attemptsUsed"), 0)::int FROM "M365SyncRootJob" WHERE "connectionId" = $1) AS budget`, [id])).rows[0];
const pick = (r: RootResult) => [r.outcome, r.safeErrorCode, r.attemptsUsed, r.maxAttempts, r.attemptSeq];

test('R3: COMPLETE, permanent 403, exhausted, not-due and held roots each keep a distinct repeat result with no claim, charge or I/O', async () => {
  const { id, tenant } = await fresh();
  const t0 = Date.now();
  const roots = [hourStart(6), hourStart(5), hourStart(4), hourStart(3), hourStart(2)];
  const [completeRoot, deniedRoot, exhaustedRoot, retryRoot, heldRoot] = roots;
  const route = signInRoute(() => [{ id: 'sig-1', at: iso(completeRoot!, MIN) }], { inject: from => {
    const t = from.getTime();
    if (t >= deniedRoot!.getTime() && t < deniedRoot!.getTime() + HOUR) return { status: 403 };
    if (t >= exhaustedRoot!.getTime() && t < retryRoot!.getTime() + HOUR) return { status: 503 };
    return undefined;
  } });
  const mock = mockM365(tenant, { route });
  const r = await createM365SignInRequest(db, syncer, gasta, id, completeRoot!, new Date(heldRoot!.getTime() + HOUR), at(t0));
  const held = r.roots[4]!;
  // Another worker holds the last root before our first pass (live lease)
  const holder = await claimRootAttempt(db, syncer, gasta, id, r.requestId, held.windowId, at(t0));
  assert.ok('claimed' in holder);
  let t = t0;
  let pass = await runM365SignInRequest(db, syncer, gasta, id, r.requestId, ioOf(mock), at(t));
  assert.deepEqual(pass.map(pick), [['PUBLISHED', null, 1, 5, 1], ['FAILED', 'M365_ACCESS_DENIED', 1, 5, 1], ['RETRY', 'M365_UPSTREAM_UNAVAILABLE', 1, 5, 1],
    ['RETRY', 'M365_UPSTREAM_UNAVAILABLE', 1, 5, 1], ['HELD', null, 1, 5, null]]);
  // Drive only the exhausted root to its fifth failure (the retry root stays in its first backoff window)
  for (let n = 2; n <= 5; n++) {
    t = pass[2]!.retryAt!.getTime();
    const outcome = await claimRootAttempt(db, syncer, gasta, id, r.requestId, r.roots[2]!.windowId, at(t));
    assert.ok('claimed' in outcome);
    const f = await recordRootFailure(db, syncer, outcome.claimed, new AtlasError('M365_UPSTREAM_UNAVAILABLE', 'TRANSIENT'), at(t));
    pass = [...pass.slice(0, 2), { ...pass[2]!, retryAt: f.retryAt, attemptsUsed: f.attemptsUsed }, ...pass.slice(3)];
  }
  // Repeat pass while the retry root is not due and the holder's lease is live
  const before = await history(id); const sent = mock.requests.length; const secrets = syntheticSecrets();
  const repeat = await runM365SignInRequest(db, syncer, gasta, id, r.requestId, ioOf(mock, secrets), at(t0 + 1_000)); // inside the 30s first backoff
  assert.deepEqual(repeat.map(pick), [['DONE', null, 1, 5, null], ['FAILED', 'M365_ACCESS_DENIED', 1, 5, null], ['FAILED', 'M365_UPSTREAM_UNAVAILABLE', 5, 5, null],
    ['NOT_DUE', null, 1, 5, null], ['HELD', null, 1, 5, null]]);
  assert.equal(repeat[3]!.retryAt!.getTime(), pass[3]!.retryAt!.getTime());
  assert.deepEqual([mock.requests.length, secrets.calls], [sent, []], 'no secret use and no upstream request');
  assert.deepEqual(await history(id), before, 'no claim, budget charge, evidence or attempt change');
});

test('R3: a terminal root reports before expired-attempt maintenance — another request\'s crashed attempt on the same root stays untouched', async () => {
  const { id, tenant } = await fresh();
  const t0 = Date.now(); const root = hourStart(3);
  const mock = mockM365(tenant, { route: signInRoute(() => [], { inject: () => ({ status: 403 }) }) });
  const failed = await createM365SignInRequest(db, syncer, gasta, id, root, new Date(root.getTime() + HOUR), at(t0));
  assert.equal((await runM365SignInRequest(db, syncer, gasta, id, failed.requestId, ioOf(mock), at(t0)))[0]!.outcome, 'FAILED');
  const other = await createM365SignInRequest(db, syncer, gasta, id, root, new Date(root.getTime() + HOUR), at(t0 + MIN));
  const crashed = await claimRootAttempt(db, syncer, gasta, id, other.requestId, other.roots[0]!.windowId, at(t0 + MIN));
  assert.ok('claimed' in crashed);
  const repeat = await runM365SignInRequest(db, syncer, gasta, id, failed.requestId, ioOf(mock), at(t0 + 30 * MIN)); // its lease expired long ago
  assert.deepEqual(pick(repeat[0]!), ['FAILED', 'M365_ACCESS_DENIED', 1, 5, null]);
  const attempt = (await pgdb.owner.query(`SELECT state FROM "M365WindowAttempt" WHERE id = $1`, [crashed.claimed.attemptId])).rows[0];
  assert.equal(attempt.state, 'RUNNING', 'the terminal pass performed no maintenance on history');
});
