import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { AtlasError } from '../../packages/core/contracts.ts';
import { m365TokenCache } from '../../connectors/microsoft365/auth.ts';
import type { GraphTransport } from '../../connectors/microsoft365/http.ts';
import { claimDirectoryGeneration, publishDirectoryGeneration, recordDirectoryFailure, syncM365Directory, traverseAndStage } from '../../packages/m365/directory.ts';
import { resetM365DirectoryRetry } from '../../packages/m365/directory-retry.ts';
import { directoryView } from '../../packages/m365/status.ts';
import { gasta, WS } from '../support/graph-fixtures.ts';
import { m365Actors } from '../support/m365-fixtures.ts';
import { mockM365, page, syntheticSecrets, userRow } from '../support/m365-graph-mock.ts';
import { addActiveM365Connection, ioOf, setupM365Database } from '../support/m365-pg.ts';
import { inFlight, waitUntilBlocked } from '../support/pg-race.ts';
import { guid } from '../m365-sql-invariants.ts';

// Review RC2-R1/R2 (approved policy S2B_RETRY_REPAIR_PLAN_RC2) on PostgreSQL 17: finite durable directory retry chain —
// exponential transient backoff capped at 15m persisted on every TRANSIENT failure (also the final one), 8 charged attempts
// (crashes and superseded claims count), exhaustion before any write or I/O, explicit audited reset (never before
// retryAt, never over a live claim; fences older claims; keeps last good data); atomic first-state admission.
const { pgdb, db } = await setupM365Database();
after(async () => { await db.$disconnect(); await pgdb.drop(); });
beforeEach(() => m365TokenCache.clear());
const { syncer } = m365Actors;
const MIN = 60_000;
const fails = (code: string) => (e: unknown) => e instanceof AtlasError && e.code === code;
let c = 0;
const fresh = async () => { const id = `m365-bud-${++c}`; const tenant = guid('123456acdef'[c - 1]!); await addActiveM365Connection(pgdb, id, tenant); return { id, tenant }; };
const at = (t: number) => () => new Date(t);
const users = (url: URL) => url.pathname === '/v1.0/users' ? page([userRow(guid('1'))]) : undefined;
const state = async (id: string) => (await pgdb.owner.query(`SELECT "latestStartedSeq" AS started, "latestRecordedSeq" AS recorded, "attemptsUsed" AS used,
  status, "safeErrorCode" AS code, "activeGenerationId" AS active, "latestPublishedSeq" AS published,
  (extract(epoch FROM "retryAt") * 1000)::float8 AS "retryAt" FROM "M365ResourceState" WHERE "connectionId" = $1 AND "resourceType" = 'm365_user'`, [id])).rows[0];
const generations = async (id: string) => Number((await pgdb.owner.query(`SELECT count(*) AS n FROM "M365DirectoryGeneration" WHERE "connectionId" = $1`, [id])).rows[0].n);
/** Graph transport failing every collection request with 503, a network error or a timeout (by attempt number). */
const collectionCalls = { n: 0 };
function failing(mock: ReturnType<typeof mockM365>, n: number): GraphTransport {
  return async (url, init) => {
    if (!url.includes('/v1.0/users')) return mock.graph(url, init);
    collectionCalls.n++;
    if (n % 3 === 1) throw Object.assign(new Error('socket hang up'), { name: 'Error' });
    if (n % 3 === 2) throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    return new Response(null, { status: 503 });
  };
}

test('R1: transient failures persist exponential retry times (cap 15m, also the 8th); the 9th claim is exhausted with no write or I/O; last good data stays', async () => {
  const { id, tenant } = await fresh();
  let t = Date.now();
  const good = await syncM365Directory(db, syncer, gasta, id, 'm365_user', ioOf(mockM365(tenant, { route: users })), at(t));
  assert.deepEqual([good.status, good.attemptsUsed, (await state(id)).used], ['PUBLISHED', 1, 0], 'publication resets the budget');
  const codes = { 0: 'M365_UPSTREAM_UNAVAILABLE', 1: 'M365_UPSTREAM_UNAVAILABLE', 2: 'M365_UPSTREAM_TIMEOUT' } as Record<number, string>;
  for (let n = 1; n <= 8; n++) {
    m365TokenCache.clear();
    const mock = mockM365(tenant); collectionCalls.n = 0;
    const r = await syncM365Directory(db, syncer, gasta, id, 'm365_user', { ...ioOf(mock), graph: failing(mock, n) }, at(t));
    const base = Math.min(15 * MIN, 30_000 * 2 ** (n - 1));
    const delay = r.retryAt!.getTime() - t;
    assert.deepEqual([r.status, r.safeErrorCode, r.attemptsUsed, r.maxAttempts], ['FAILED', codes[n % 3], n, 8], `attempt ${n}`);
    assert.ok(delay >= base && delay <= Math.min(15 * MIN, base + 10_000), `attempt ${n}: ${delay}ms`);
    assert.equal(collectionCalls.n, 1, 'one collection request per charged attempt');
    const s = await state(id);
    assert.deepEqual([s.used, s.retryAt, s.active, s.published], [n, r.retryAt!.getTime(), good.generationId, 1], 'persisted; last good pointer kept');
    if (n < 8) t = r.retryAt!.getTime();
  }
  // Exhaustion is decided first — before the throttle — and also after the persisted retry time has passed, in a new process
  const restarted = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
  try {
    const before = await state(id);
    for (const when of [t + MIN, before.retryAt, before.retryAt + 24 * 60 * MIN]) {
      const mock = mockM365(tenant, { route: users }); const secrets = syntheticSecrets();
      const error = await syncM365Directory(restarted, syncer, gasta, id, 'm365_user', ioOf(mock, secrets), at(when)).catch(e => e) as AtlasError;
      assert.ok(fails('M365_ATTEMPTS_EXHAUSTED')(error)); assert.equal(error.kind, 'PERMANENT');
      assert.deepEqual([error.details.attemptsUsed, error.details.maxAttempts], ['8', '8']);
      assert.deepEqual([mock.requests, secrets.calls], [[], []]);
    }
    assert.deepEqual(await state(id), before, 'no write: sequence, budget, status and retry time unchanged');
  } finally { await restarted.$disconnect(); }
  const s = await state(id);
  const g = (await pgdb.owner.query(`SELECT (extract(epoch FROM "completedAt") * 1000)::float8 AS c, (extract(epoch FROM "expiresAt") * 1000)::float8 AS e
    FROM "M365DirectoryGeneration" WHERE id = $1`, [good.generationId])).rows[0];
  const view = directoryView({ status: s.status, safeErrorCode: s.code, activeGenerationId: s.active, latestStartedSeq: s.started, latestPublishedSeq: s.published,
    attemptsUsed: s.used }, { completedAt: new Date(g.c), expiresAt: new Date(g.e) }, new Date(t));
  assert.deepEqual(view, { status: 'STALE', reasonCodes: ['DIRECTORY_STALE', 'M365_UPSTREAM_TIMEOUT', 'M365_ATTEMPTS_EXHAUSTED'], attemptsUsed: 8, maxAttempts: 8 });
  // Reset: never before the source's retry time; afterwards a new fenced chain, same last good data, audited
  await assert.rejects(resetM365DirectoryRetry(db, syncer, gasta, id, 'm365_user', at(s.retryAt - 1)), fails('M365_RETRY_NOT_DUE'));
  const reset = await resetM365DirectoryRetry(db, syncer, gasta, id, 'm365_user', at(s.retryAt));
  assert.deepEqual(reset, { resourceType: 'm365_user', attemptSeq: s.started + 1, previousAttemptsUsed: 8, attemptsUsed: 0, status: 'ERROR', safeErrorCode: 'M365_UPSTREAM_TIMEOUT' });
  const after = await state(id);
  assert.deepEqual([after.started, after.recorded, after.used, after.retryAt, after.active, after.code], [s.started + 1, s.started + 1, 0, null, good.generationId, 'M365_UPSTREAM_TIMEOUT']);
  const audit = (await pgdb.owner.query(`SELECT metadata FROM "AuditEvent" WHERE "eventType" = 'm365.directory_retry_reset' AND metadata->>'connectionId' = $1`, [id])).rows;
  assert.deepEqual(audit.map(a => a.metadata), [{ connectionId: id, system: 'microsoft365', resourceType: 'm365_user', attemptSeq: String(s.started + 1), attemptsUsed: '8' }]);
  const again = await syncM365Directory(db, syncer, gasta, id, 'm365_user', ioOf(mockM365(tenant, { route: users })), at(s.retryAt));
  assert.deepEqual([again.status, again.attemptsUsed, (await state(id)).used], ['PUBLISHED', 1, 0]);
});

test('R1: crashed and superseded claims are charged; a 429 keeps its exact delay even on the final attempt', async () => {
  const { id, tenant } = await fresh();
  const t0 = Date.now();
  for (let n = 1; n <= 6; n++) await claimDirectoryGeneration(db, syncer, gasta, id, 'm365_user', at(t0)); // crashed or superseded workers
  assert.equal((await state(id)).used, 6);
  const seventh = await claimDirectoryGeneration(db, syncer, gasta, id, 'm365_user', at(t0));
  const eighth = await claimDirectoryGeneration(db, syncer, gasta, id, 'm365_user', at(t0));
  assert.deepEqual((await recordDirectoryFailure(db, syncer, seventh, new AtlasError('M365_UPSTREAM_UNAVAILABLE', 'TRANSIENT'), at(t0))).recorded, false, 'superseded');
  const last = await recordDirectoryFailure(db, syncer, eighth, new AtlasError('M365_RATE_LIMITED', 'TRANSIENT', { retryAfterSeconds: '7200' }), at(t0));
  assert.deepEqual([last.recorded, last.retryAt!.getTime(), last.attemptsUsed], [true, t0 + 7_200_000, 8], 'exact Retry-After on the final attempt, above the cap');
  const mock = mockM365(tenant, { route: users });
  await assert.rejects(syncM365Directory(db, syncer, gasta, id, 'm365_user', ioOf(mock), at(t0 + 7_200_000)), fails('M365_ATTEMPTS_EXHAUSTED'));
  assert.deepEqual(mock.requests, []);
  assert.equal(await generations(id), 8);
});

test('R1 reset: zero budget, live claim and missing permission are refused; an expired outstanding claim is reset, normalized and fenced', async () => {
  const { id, tenant } = await fresh();
  const t0 = Date.now();
  await syncM365Directory(db, syncer, gasta, id, 'm365_user', ioOf(mockM365(tenant, { route: users })), at(t0));
  await assert.rejects(resetM365DirectoryRetry(db, syncer, gasta, id, 'm365_user', at(t0)), fails('M365_RESET_NOT_ELIGIBLE'), 'already zero after publication');
  const old = await claimDirectoryGeneration(db, syncer, gasta, id, 'm365_user', at(t0 + MIN));
  await traverseAndStage(db, syncer, old, ioOf(mockM365(tenant, { route: users })), at(t0 + MIN));
  await assert.rejects(resetM365DirectoryRetry(db, syncer, gasta, id, 'm365_user', at(t0 + 2 * MIN)), fails('M365_CLAIM_HELD'), 'a live claim is never reset');
  const denials = async () => (await pgdb.owner.query(`SELECT "requestedClientId", "reasonCode", metadata FROM "SecurityAuditEvent" WHERE "eventType" = 'm365.directory_reset_denied'`)).rows;
  await assert.rejects(resetM365DirectoryRetry(db, m365Actors.admin, gasta, id, 'm365_user', at(t0 + 13 * MIN)), fails('PERMISSION_DENIED'));
  assert.deepEqual(await denials(), [{ requestedClientId: 'demo-gasta', reasonCode: 'PERMISSION_DENIED', metadata: {} }]);
  const reset = await resetM365DirectoryRetry(db, syncer, gasta, id, 'm365_user', at(t0 + 13 * MIN)); // the claim's lease expired
  assert.deepEqual([reset.status, reset.safeErrorCode, reset.previousAttemptsUsed], ['ERROR', 'M365_CLAIM_EXPIRED', 1], 'an unrecorded OK chain is normalized');
  await assert.rejects(publishDirectoryGeneration(db, syncer, old, at(t0 + 13 * MIN)), /M365_CLAIM_EXPIRED|M365_ATTEMPT_SUPERSEDED/);
  assert.equal((await recordDirectoryFailure(db, syncer, old, 'M365_UPSTREAM_UNAVAILABLE', at(t0 + 13 * MIN))).recorded, false, 'the old claim records nothing');
  const s = await state(id);
  assert.deepEqual([s.used, s.started, s.recorded, s.published], [0, 3, 3, 1]);
});

test('R1 reset of a first-ever crashed claim: before any publication and after cleanup removed its expired generation', async () => {
  const before = await fresh();
  const t0 = Date.now();
  const crashed = await claimDirectoryGeneration(db, syncer, gasta, before.id, 'm365_user', at(t0));
  const r = await resetM365DirectoryRetry(db, syncer, gasta, before.id, 'm365_user', at(t0 + 13 * MIN));
  assert.deepEqual([r.status, r.safeErrorCode, r.attemptSeq], ['ERROR', 'M365_CLAIM_EXPIRED', 2], 'PENDING never keeps a recorded sequence');
  await assert.rejects(publishDirectoryGeneration(db, syncer, crashed, at(t0 + 13 * MIN)), /M365_CLAIM_EXPIRED|M365_ATTEMPT_SUPERSEDED/);
  // After cleanup: a claim 25 hours ago whose STAGING generation expired and was deleted by the maintenance routine
  const cleaned = await fresh();
  await claimDirectoryGeneration(db, syncer, gasta, cleaned.id, 'm365_user', at(t0 - 25 * 60 * MIN));
  const runner = new pg.Client({ connectionString: pgdb.runnerUrl }); await runner.connect();
  try {
    await runner.query('BEGIN');
    await runner.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', 'demo-gasta', true), set_config('app.actor_id', 'demo-m365-syncer', true)`, [WS]);
    await runner.query(`SELECT atlas_m365_cleanup('corr-budget-cleanup-1')`);
    await runner.query('COMMIT');
  } finally { await runner.end(); }
  assert.equal(await generations(cleaned.id), 0, 'the expired generation is gone');
  const after = await resetM365DirectoryRetry(db, syncer, gasta, cleaned.id, 'm365_user', at(t0));
  assert.deepEqual([after.status, after.safeErrorCode, after.attemptSeq, after.previousAttemptsUsed], ['ERROR', 'M365_CLAIM_EXPIRED', 2, 1]);
});

test('R2: a concurrent first claim waits for the first state row and is refused by its persisted retry time — no sequence, generation, secret or I/O', async () => {
  const { id, tenant } = await fresh();
  const t0 = Date.now();
  const barrier = new pg.Client({ connectionString: pgdb.ownerUrl }); await barrier.connect();
  const mock = mockM365(tenant, { route: users }); const secrets = syntheticSecrets();
  try {
    // Worker A (test-only barrier): creates the first state, is charged, records a 429 for two hours — not yet committed
    await barrier.query('BEGIN');
    await barrier.query(`INSERT INTO "M365ResourceState" ("workspaceId","clientId","connectionId","resourceType") VALUES ($1,'demo-gasta',$2,'m365_user')`, [WS, id]);
    await barrier.query(`UPDATE "M365ResourceState" SET "latestStartedSeq" = 1, "attemptsUsed" = 1 WHERE "connectionId" = $1 AND "resourceType" = 'm365_user'`, [id]);
    await barrier.query(`UPDATE "M365ResourceState" SET "latestRecordedSeq" = 1, status = 'ERROR', "safeErrorCode" = 'M365_RATE_LIMITED', "retryAt" = $2
      WHERE "connectionId" = $1 AND "resourceType" = 'm365_user'`, [id, new Date(t0 + 7_200_000).toISOString().replace('T', ' ').replace('Z', '')]);
    const b = inFlight(() => syncM365Directory(db, syncer, gasta, id, 'm365_user', ioOf(mock, secrets), at(t0)));
    await waitUntilBlocked(pgdb.owner, null);
    assert.equal(b.settled(), false, 'B waits on the uncommitted first state instead of reading its absence');
    await barrier.query('COMMIT');
    await assert.rejects(b.result(), fails('M365_RETRY_NOT_DUE'));
  } finally { await barrier.end(); }
  assert.deepEqual([mock.requests, secrets.calls], [[], []]);
  const s = await state(id);
  assert.deepEqual([s.started, s.used, s.retryAt], [1, 1, t0 + 7_200_000]);
  assert.equal(await generations(id), 0);
});
