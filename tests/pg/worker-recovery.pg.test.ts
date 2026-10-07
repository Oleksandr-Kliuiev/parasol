import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { AtlasError } from '../../packages/core/contracts.ts';
import { ingestEvent, listInbox, requeueDeadLetter } from '../../packages/events/inbox.ts';
import { claimEvents, prepareEvent, processClaimed, processPending } from '../../packages/events/worker.ts';
import type { WorkerOptions } from '../../packages/events/worker.ts';
import { createTestDatabase, runSeed } from '../support/pg-harness.ts';
import { actors, gasta } from '../support/graph-fixtures.ts';
import { CountingProvider, incident, liveHuntressWithConfirmedAgent } from '../support/events-fixtures.ts';

// Review B1/B2 on PostgreSQL 17 through the runtime role, two pools: a worker whose lease was taken over changes nothing
// (its failure, its commit and its phase 1 are refused; the new owner completes the event once), and claims that never
// report back are bounded by maxAttempts (dead letter with audit, no provider call; requeue reuses the stored decision).
// Every session runs with generic plans, the plan a prepared statement may get after a few executions: the batch limits
// must hold under it (a LIMIT … FOR UPDATE SKIP LOCKED subquery inside IN (…) took more rows than its LIMIT there).
const pgdb = await createTestDatabase();
await pgdb.owner.query(`ALTER DATABASE "${pgdb.name}" SET plan_cache_mode = force_generic_plan`);
const db = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
const db2 = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
after(async () => { await db.$disconnect(); await db2.$disconnect(); await pgdb.drop(); });
runSeed(pgdb.ownerUrl);
const { connection } = await liveHuntressWithConfirmedAgent(db);
const options = (provider: CountingProvider, extra: Partial<WorkerOptions> = {}): WorkerOptions => ({ workerId: 'worker-a', provider, retryDelayMs: () => 0, ...extra });
const join = `JOIN "RawEvent" r ON r."workspaceId" = x."workspaceId" AND r."clientId" = x."clientId" AND r.id = x."eventId"`;
const observations = async (id: string) => Number((await pgdb.owner.query(`SELECT count(*)::int AS n FROM "Observation" x ${join} WHERE r."externalEventId" = $1`, [id])).rows[0].n);
const runs = async (id: string) => (await pgdb.owner.query(`SELECT x.provider||'|'||x.applied||'|'||x.status AS s FROM "DecisionRun" x ${join} WHERE r."externalEventId" = $1 ORDER BY x."createdAt"`, [id])).rows.map(r => r.s);
const inbox = async (id: string) => (await pgdb.owner.query(`SELECT status||'|'||attempts||'|'||coalesce("lastErrorCode",'-')||'|'||coalesce("leaseOwner",'-') AS s FROM "RawEvent" WHERE "externalEventId" = $1`, [id])).rows.map(r => r.s);
const audits = async (id: string) => (await pgdb.owner.query(`SELECT a."eventType"||':'||coalesce(a.metadata->>'safeErrorCode','-')||':'||coalesce(a.metadata->>'attempts','-') AS s
  FROM "AuditEvent" a JOIN "RawEvent" r ON a.metadata->>'eventKey' = r."eventKey" WHERE r."externalEventId" = $1 ORDER BY a."recordedAt"`, [id])).rows.map(r => r.s);
const after_ = (t0: number, ms: number) => new Date(t0 + ms);

test('B1 (reviewer\'s order): the stale worker ends with CLAIM_LOST before calling the provider; the new owner makes the one observation', async () => {
  const provider = new CountingProvider();
  await ingestEvent(db, actors.sync, connection, incident(connection, 'b1-1', 'CRITICAL'));
  const t0 = Date.now();
  const [a] = (await claimEvents(db, actors.sync, gasta, { workerId: 'worker-a', leaseMs: 100 }, after_(t0, 0))).claimed;
  const [b] = (await claimEvents(db2, actors.sync, gasta, { workerId: 'worker-b', leaseMs: 10_000 }, after_(t0, 200))).claimed;
  assert.ok(a && b, 'B claims the event once A\'s lease has expired');
  await prepareEvent(db2, actors.sync, gasta, b, options(provider, { workerId: 'worker-b' }));
  const injected = async () => { throw new AtlasError('STALE_WORKER_WRITE_FAILED', 'PERMANENT'); };
  const stale = await processClaimed(db, actors.sync, gasta, a, options(provider, { beforeFinalCommit: injected }), after_(t0, 300));
  assert.deepEqual([stale.status, stale.observationId], ['CLAIM_LOST', null]);
  assert.deepEqual(await inbox('b1-1'), ['RECEIVED|2|-|worker-b'], 'B\'s lease, no error, no state change');
  const owner = await processClaimed(db2, actors.sync, gasta, b, options(provider, { workerId: 'worker-b' }), after_(t0, 400));
  assert.equal(owner.status, 'PROCESSED');
  assert.deepEqual([await inbox('b1-1'), await runs('b1-1'), await observations('b1-1'), provider.calls], [['PROCESSED|2|-|-'], ['rules|true|OK'], 1, 1]);
  assert.deepEqual(await audits('b1-1'), ['observation.created:-:-'], 'no failure audit from the stale worker');
});

test('B1: after a takeover the stale worker\'s commit and its failure are both refused; only the current claim decides', async () => {
  const provider = new CountingProvider();
  await ingestEvent(db, actors.sync, connection, incident(connection, 'b1-2', 'HIGH'));
  const t0 = Date.now();
  const [a] = (await claimEvents(db, actors.sync, gasta, { workerId: 'worker-a', leaseMs: 100 }, after_(t0, 0))).claimed;
  assert.ok(a);
  const decided = await prepareEvent(db, actors.sync, gasta, a, options(provider)); // A decides, then stalls past its lease
  const [b] = (await claimEvents(db2, actors.sync, gasta, { workerId: 'worker-b', leaseMs: 10_000 }, after_(t0, 200))).claimed;
  assert.ok(b?.prepared, 'the new claim carries the stored decision');
  const commit = await processClaimed(db, actors.sync, gasta, { ...a, prepared: decided }, options(provider), after_(t0, 300));
  assert.deepEqual([commit.status, commit.safeErrorCode], ['CLAIM_LOST', 'CLAIM_LOST']);
  const failure = await processClaimed(db, actors.sync, gasta, { ...a, normalized: { kind: 'CORRUPT' } }, options(provider), after_(t0, 300));
  assert.deepEqual([failure.status, failure.safeErrorCode], ['CLAIM_LOST', 'INVALID_EVENT'], 'a PERMANENT error of the stale worker dead-letters nothing');
  assert.deepEqual(await inbox('b1-2'), ['RECEIVED|2|-|worker-b']);
  assert.equal((await processClaimed(db2, actors.sync, gasta, b, options(provider, { workerId: 'worker-b' }), after_(t0, 400))).status, 'PROCESSED');
  assert.deepEqual([await runs('b1-2'), await observations('b1-2'), provider.calls], [['rules|true|OK'], 1, 1]);
  assert.deepEqual(await audits('b1-2'), ['observation.created:-:-']);
});

test('B2 (reviewer\'s order): claims that never report back end in a visible dead letter at maxAttempts, without a provider call', async () => {
  const provider = new CountingProvider();
  const stored = await ingestEvent(db, actors.sync, connection, incident(connection, 'b2-1', 'CRITICAL'));
  const t0 = Date.now();
  const crash = { workerId: 'worker-crash', leaseMs: 100, maxAttempts: 3 };
  const [first] = (await claimEvents(db, actors.sync, gasta, crash, after_(t0, 0))).claimed; // dies at once
  const [second] = (await claimEvents(db, actors.sync, gasta, crash, after_(t0, 200))).claimed;
  await prepareEvent(db, actors.sync, gasta, second!, options(provider)); // stores the decision, then dies
  const [third] = (await claimEvents(db, actors.sync, gasta, crash, after_(t0, 400))).claimed; // dies at once
  assert.deepEqual([first?.attempts, second?.attempts, third?.attempts, provider.calls], [1, 2, 3, 1]);
  const outcomes = await processPending(db, actors.sync, gasta, options(provider, { maxAttempts: 3, batchSize: 1 }), after_(t0, 600));
  assert.deepEqual(outcomes.map(o => `${o.status}:${o.safeErrorCode}`), ['DEAD_LETTER:ATTEMPTS_EXHAUSTED']);
  assert.deepEqual([await inbox('b2-1'), await observations('b2-1'), provider.calls], [['DEAD_LETTER|3|ATTEMPTS_EXHAUSTED|-'], 0, 1]);
  assert.deepEqual(await audits('b2-1'), ['event.dead_lettered:ATTEMPTS_EXHAUSTED:3']);
  assert.ok((await listInbox(db, actors.reader, gasta)).some(v => v.eventKey === stored.eventKey && v.status === 'DEAD_LETTER' && v.lastErrorCode === 'ATTEMPTS_EXHAUSTED'));
  assert.deepEqual((await claimEvents(db, actors.sync, gasta, crash, after_(t0, 800))).claimed, [], 'never claimed again implicitly');
  // The decision stored before the limit stays with the event: the explicit, audited requeue completes it without a new call
  await requeueDeadLetter(db, actors.sync, gasta, stored.eventKey);
  assert.deepEqual((await processPending(db, actors.sync, gasta, options(provider), new Date(Date.now() + 1_000))).map(o => o.status), ['PROCESSED']);
  assert.deepEqual([await runs('b2-1'), await observations('b2-1'), provider.calls], [['rules|true|OK'], 1, 1]);
  assert.deepEqual(await audits('b2-1'), ['event.dead_lettered:ATTEMPTS_EXHAUSTED:3', 'event.requeued:-:3', 'observation.created:-:-']);
});

test('B2: a configured maxAttempts counts a reported failure and a silent crash alike', async () => {
  const provider = new CountingProvider();
  await ingestEvent(db, actors.sync, connection, incident(connection, 'b2-2', 'LOW'));
  const t0 = Date.now();
  const failing = async () => { throw new AtlasError('INJECTED_COMMIT_FAILURE', 'TRANSIENT'); };
  const [retry] = await processPending(db, actors.sync, gasta, options(provider, { maxAttempts: 2, leaseMs: 100, beforeFinalCommit: failing }), after_(t0, 0));
  assert.deepEqual([retry?.status, retry?.safeErrorCode], ['RETRY', 'INJECTED_COMMIT_FAILURE']);
  assert.equal((await claimEvents(db, actors.sync, gasta, { workerId: 'worker-crash', leaseMs: 100, maxAttempts: 2 }, after_(t0, 1_000))).claimed.length, 1);
  const [exhausted] = await processPending(db, actors.sync, gasta, options(provider, { maxAttempts: 2 }), after_(t0, 2_000));
  assert.deepEqual([exhausted?.status, exhausted?.safeErrorCode], ['DEAD_LETTER', 'ATTEMPTS_EXHAUSTED']);
  assert.deepEqual(await inbox('b2-2'), ['DEAD_LETTER|2|ATTEMPTS_EXHAUSTED|-']);
  assert.deepEqual(await audits('b2-2'), ['event.retry_scheduled:INJECTED_COMMIT_FAILURE:1', 'event.dead_lettered:ATTEMPTS_EXHAUSTED:2']);
});

test('B2: more exhausted events than one batch: none is claimed beyond its limit; each is dead-lettered in a later pass', async () => {
  const provider = new CountingProvider();
  for (const id of ['b2-3', 'b2-4']) await ingestEvent(db, actors.sync, connection, incident(connection, id, 'HIGH'));
  const t0 = Date.now();
  const crash = { workerId: 'worker-crash', leaseMs: 100, maxAttempts: 3 };
  for (const ms of [0, 200, 400]) assert.equal((await claimEvents(db, actors.sync, gasta, crash, after_(t0, ms))).claimed.length, 2);
  const passes: string[][] = [];
  for (const ms of [600, 800]) {
    passes.push((await processPending(db, actors.sync, gasta, options(provider, { maxAttempts: 3, batchSize: 1 }), after_(t0, ms))).map(o => `${o.status}:${o.safeErrorCode}`));
  }
  assert.deepEqual(passes, [['DEAD_LETTER:ATTEMPTS_EXHAUSTED'], ['DEAD_LETTER:ATTEMPTS_EXHAUSTED']]);
  assert.deepEqual([...await inbox('b2-3'), ...await inbox('b2-4')], ['DEAD_LETTER|3|ATTEMPTS_EXHAUSTED|-', 'DEAD_LETTER|3|ATTEMPTS_EXHAUSTED|-']);
  assert.equal(provider.calls, 0);
});

test('batch limits hold under generic plans: a claim takes at most batchSize events', async () => {
  for (const id of ['lim-1', 'lim-2', 'lim-3']) await ingestEvent(db, actors.sync, connection, incident(connection, id, 'LOW'));
  const at = new Date(Date.now() + 1_000);
  assert.equal((await claimEvents(db, actors.sync, gasta, { workerId: 'worker-a', batchSize: 1 }, at)).claimed.length, 1);
  assert.equal((await claimEvents(db2, actors.sync, gasta, { workerId: 'worker-b', batchSize: 1 }, at)).claimed.length, 1);
  assert.equal((await claimEvents(db, actors.sync, gasta, { workerId: 'worker-a', batchSize: 5 }, at)).claimed.length, 1, 'only one is left unclaimed');
});
