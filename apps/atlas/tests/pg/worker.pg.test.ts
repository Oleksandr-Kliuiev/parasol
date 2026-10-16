import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { AtlasError } from '../../packages/core/contracts.ts';
import { ingestEvent, listInbox, requeueDeadLetter } from '../../packages/events/inbox.ts';
import { claimEvents, prepareEvent, processPending } from '../../packages/events/worker.ts';
import type { WorkerOptions } from '../../packages/events/worker.ts';
import { getClientContext } from '../../packages/graph/prisma-context.ts';
import { createTestDatabase, runSeed } from '../support/pg-harness.ts';
import { actors, gasta } from '../support/graph-fixtures.ts';
import { CountingProvider, incident, liveHuntressWithConfirmedAgent } from '../support/events-fixtures.ts';

// Task 1.6 durable worker on PostgreSQL 17 through the runtime role: two phases, leases, two workers, restart recovery,
// retry of the final transaction without a second provider call, bounded retry → visible dead letter, explicit requeue.
const pgdb = await createTestDatabase();
const db = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
const db2 = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
after(async () => { await db.$disconnect(); await db2.$disconnect(); await pgdb.drop(); });
runSeed(pgdb.ownerUrl);
const { connection } = await liveHuntressWithConfirmedAgent(db);
const options = (provider: CountingProvider, extra: Partial<WorkerOptions> = {}): WorkerOptions => ({ workerId: 'worker-a', provider, retryDelayMs: () => 0, ...extra });
const join = `JOIN "RawEvent" r ON r."workspaceId" = x."workspaceId" AND r."clientId" = x."clientId" AND r.id = x."eventId"`;
const observations = async (id: string) => (await pgdb.owner.query(`SELECT x.severity||'|'||x.priority||'|'||x.route||'|'||coalesce(x."entityId",'-')||'|'||array_to_string(x."reasonCodes", ',') AS s
  FROM "Observation" x ${join} WHERE r."externalEventId" = $1 ORDER BY x."createdAt"`, [id])).rows.map(r => r.s);
const runs = async (id: string) => (await pgdb.owner.query(`SELECT x.provider||'|'||x.applied||'|'||x.status AS s FROM "DecisionRun" x ${join} WHERE r."externalEventId" = $1 ORDER BY x."createdAt", x.provider`, [id])).rows.map(r => r.s);
const inbox = async (id: string) => (await pgdb.owner.query(`SELECT status||'|'||attempts||'|'||coalesce("lastErrorCode",'-')||'|'||coalesce("leaseOwner",'-') AS s FROM "RawEvent" WHERE "externalEventId" = $1`, [id])).rows.map(r => r.s);
const audits = async (eventType: string) => (await pgdb.owner.query(`SELECT metadata FROM "AuditEvent" WHERE "eventType" = $1`, [eventType])).rows.map(r => r.metadata as Record<string, string>);

test('two phases: one observation per event with its applied run, audit row and inbox completion; the context lists it', async () => {
  const provider = new CountingProvider();
  await ingestEvent(db, actors.sync, connection, incident(connection, 'w-1', 'CRITICAL'));
  await ingestEvent(db, actors.sync, connection, incident(connection, 'w-2', 'LOW', { agent: '207999' }));
  assert.deepEqual((await processPending(db, actors.sync, gasta, options(provider))).map(o => o.status), ['PROCESSED', 'PROCESSED']);
  assert.deepEqual(await observations('w-1'), ['CRITICAL|URGENT|HUMAN_REVIEW|demo-device-07|RULES_BASELINE,SOURCE_URGENCY_FLOOR']);
  assert.deepEqual(await observations('w-2'), ['LOW|NORMAL|HUMAN_REVIEW|-|RULES_BASELINE,UNRESOLVED_DEVICE']);
  assert.deepEqual([await runs('w-1'), await runs('w-2')], [['rules|true|OK'], ['rules|true|OK']]);
  assert.deepEqual([await inbox('w-1'), await inbox('w-2')], [['PROCESSED|1|-|-'], ['PROCESSED|1|-|-']]);
  assert.equal((await audits('observation.created')).length, 2);
  assert.equal(provider.calls, 2);
  const ctx = await getClientContext(db, actors.reader, gasta);
  assert.deepEqual(ctx.observations.items.map(o => `${o.externalEventId}:${o.severity}`), ['w-1:CRITICAL', 'w-2:LOW']);
});

test('two workers on two pools take disjoint batches; every event is processed exactly once', async () => {
  const provider = new CountingProvider();
  for (let i = 0; i < 12; i++) await ingestEvent(db, actors.sync, connection, incident(connection, `pair-${i}`, 'LOW'));
  const done: string[] = [];
  for (let round = 0; round < 6; round++) {
    const [a, b] = await Promise.all([processPending(db, actors.sync, gasta, options(provider, { workerId: 'worker-a', batchSize: 4 })),
      processPending(db2, actors.sync, gasta, options(provider, { workerId: 'worker-b', batchSize: 4 }))]);
    done.push(...[...a, ...b].filter(o => o.status === 'PROCESSED').map(o => o.eventKey));
    if (a.length + b.length === 0) break;
  }
  assert.equal(done.length, 12); assert.equal(new Set(done).size, 12);
  assert.equal(provider.calls, 12);
  const counts = (await pgdb.owner.query(`SELECT (SELECT count(*)::int FROM "Observation" x ${join} WHERE r."externalEventId" LIKE 'pair-%') AS o,
    (SELECT count(*)::int FROM "DecisionRun" x ${join} WHERE r."externalEventId" LIKE 'pair-%' AND x.applied) AS a`)).rows[0];
  assert.deepEqual([counts.o, counts.a], [12, 12]);
});

test('restart: a worker that dies after phase 1 leaves its decision; once the lease expires another worker commits it without calling the provider again', async () => {
  const provider = new CountingProvider();
  const stored = await ingestEvent(db, actors.sync, connection, incident(connection, 'crash-1', 'HIGH'));
  // The explicit clock controls lease recovery; anchor it to the exact persisted eligibility time, not a host-clock race.
  const t0 = new Date(Number((await pgdb.owner.query('SELECT extract(epoch FROM "nextAttemptAt") * 1000 AS instant FROM "RawEvent" WHERE "workspaceId"=$1 AND "clientId"=$2 AND "eventKey"=$3',
    [gasta.workspaceId, gasta.clientId, stored.eventKey])).rows[0].instant));
  const [claimed] = (await claimEvents(db, actors.sync, gasta, { workerId: 'worker-dead', leaseMs: 1_000 }, t0)).claimed;
  assert.ok(claimed);
  await prepareEvent(db, actors.sync, gasta, claimed, options(provider)); // phase 1 stored; the worker dies here
  assert.equal(provider.calls, 1);
  assert.deepEqual(await processPending(db, actors.sync, gasta, options(provider, { workerId: 'worker-b' }), t0), [], 'the lease is still held');
  const [outcome] = await processPending(db, actors.sync, gasta, options(provider, { workerId: 'worker-b' }), new Date(t0.getTime() + 2_000));
  assert.equal(outcome?.status, 'PROCESSED');
  assert.equal(provider.calls, 1, 'the stored decision was reused');
  assert.deepEqual([await runs('crash-1'), await inbox('crash-1'), (await observations('crash-1')).length], [['rules|true|OK'], ['PROCESSED|2|-|-'], 1]);
});

test('a TRANSIENT failure in the final transaction rolls it back (RETRY); the retry reuses the decision: one provider call, one applied run, one observation', async () => {
  const provider = new CountingProvider();
  let failNext = true;
  const hook = async () => { if (failNext) { failNext = false; throw new AtlasError('INJECTED_COMMIT_FAILURE', 'TRANSIENT'); } };
  await ingestEvent(db, actors.sync, connection, incident(connection, 'commit-1', 'CRITICAL'));
  const [first] = await processPending(db, actors.sync, gasta, options(provider, { beforeFinalCommit: hook }));
  assert.deepEqual([first?.status, first?.safeErrorCode], ['RETRY', 'INJECTED_COMMIT_FAILURE']);
  assert.deepEqual([await observations('commit-1'), await runs('commit-1'), await inbox('commit-1')], [[], ['rules|false|OK'], ['RETRY|1|INJECTED_COMMIT_FAILURE|-']]);
  const [second] = await processPending(db, actors.sync, gasta, options(provider, { beforeFinalCommit: hook }));
  assert.equal(second?.status, 'PROCESSED');
  assert.equal(provider.calls, 1);
  assert.deepEqual([await runs('commit-1'), (await observations('commit-1')).length], [['rules|true|OK'], 1]);
  assert.ok((await audits('event.retry_scheduled')).some(m => m.safeErrorCode === 'INJECTED_COMMIT_FAILURE' && m.attempts === '1'));
});

test('bounded retry ends in a visible dead letter, a corrupt stored payload is dead-lettered at once, and only an explicit requeue reprocesses', async () => {
  const provider = new CountingProvider();
  const always = async () => { throw new AtlasError('INJECTED_COMMIT_FAILURE', 'TRANSIENT'); };
  const stored = await ingestEvent(db, actors.sync, connection, incident(connection, 'dlq-1', 'LOW'));
  const statuses: (string | undefined)[] = [];
  for (let i = 0; i < 3; i++) statuses.push((await processPending(db, actors.sync, gasta, options(provider, { maxAttempts: 3, beforeFinalCommit: always })))[0]?.status);
  assert.deepEqual(statuses, ['RETRY', 'RETRY', 'DEAD_LETTER']);
  assert.equal(provider.calls, 1);
  assert.deepEqual(await inbox('dlq-1'), ['DEAD_LETTER|3|INJECTED_COMMIT_FAILURE|-']);
  assert.ok((await audits('event.dead_lettered')).some(m => m.eventKey === stored.eventKey && m.attempts === '3' && m.inboxStatus === 'DEAD_LETTER'));
  assert.ok((await listInbox(db, actors.reader, gasta)).some(v => v.eventKey === stored.eventKey && v.status === 'DEAD_LETTER' && v.lastErrorCode === 'INJECTED_COMMIT_FAILURE'));
  assert.deepEqual(await processPending(db, actors.sync, gasta, options(provider)), [], 'a dead letter is not reprocessed implicitly');
  await ingestEvent(db, actors.sync, connection, incident(connection, 'dlq-2', 'LOW'));
  await pgdb.owner.query(`UPDATE "RawEvent" SET normalized = '{"kind":"UNKNOWN"}' WHERE "externalEventId" = 'dlq-2'`);
  const [corrupt] = await processPending(db, actors.sync, gasta, options(provider));
  assert.deepEqual([corrupt?.status, corrupt?.safeErrorCode], ['DEAD_LETTER', 'INVALID_EVENT'], 'PERMANENT: no retry of a bug');
  await assert.rejects(requeueDeadLetter(db, actors.reader, gasta, stored.eventKey), /PERMISSION_DENIED/);
  await requeueDeadLetter(db, actors.sync, gasta, stored.eventKey);
  assert.deepEqual((await processPending(db, actors.sync, gasta, options(provider))).map(o => `${o.eventKey === stored.eventKey}:${o.status}`), ['true:PROCESSED']);
  assert.equal((await audits('event.requeued')).length, 1);
});

test('each newly stored event is eligible on an immediate database-clock pass without sleeps or retries', async () => {
  const provider = new CountingProvider();
  for (let index = 0; index < 100; index++) {
    const stored = await ingestEvent(db, actors.sync, connection, incident(connection, `immediate-clock-${index}`, 'LOW'));
    const outcomes = await processPending(db, actors.sync, gasta, options(provider));
    assert.deepEqual(outcomes.map(o => [o.eventKey, o.status]), [[stored.eventKey, 'PROCESSED']], `independent case ${index}`);
  }
  assert.equal(provider.calls, 100);
});

test('default retry backoff starts on the database clock after the failed work; immediate reclaim is refused', async () => {
  const provider = new CountingProvider(); const delay = 30_000;
  let failedAt = 0; let fail = true;
  const stored = await ingestEvent(db, actors.sync, connection, incident(connection, 'database-retry-clock', 'LOW'));
  const hook = async () => {
    if (!fail) return;
    fail = false;
    await new Promise(resolve => setTimeout(resolve, 100));
    failedAt = Number((await pgdb.owner.query('SELECT extract(epoch FROM clock_timestamp()) * 1000 AS instant')).rows[0].instant);
    throw new AtlasError('SYNTHETIC_FAILED_WORK', 'TRANSIENT');
  };
  const workerOptions = options(provider, { retryDelayMs: () => delay, beforeFinalCommit: hook });
  const [first] = await processPending(db, actors.sync, gasta, workerOptions);
  assert.deepEqual([first?.eventKey, first?.status], [stored.eventKey, 'RETRY']);
  const retryAt = Number((await pgdb.owner.query('SELECT extract(epoch FROM "nextAttemptAt") * 1000 AS instant FROM "RawEvent" WHERE "eventKey"=$1',
    [stored.eventKey])).rows[0].instant);
  assert.ok(retryAt >= Math.round(failedAt) + delay, 'the delay begins after failure, including the work duration');
  assert.deepEqual(await processPending(db, actors.sync, gasta, workerOptions), [], 'the database clock has not reached the persisted retry deadline');
  assert.deepEqual((await processPending(db, actors.sync, gasta, workerOptions, new Date(retryAt + 1))).map(o => o.status), ['PROCESSED']);
  assert.equal(provider.calls, 1, 'the retry retains the stored decision');
});
