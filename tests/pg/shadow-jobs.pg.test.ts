import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { AtlasError } from '../../packages/core/contracts.ts';
import { ingestEvent } from '../../packages/events/inbox.ts';
import { processPending } from '../../packages/events/worker.ts';
import { processShadowJobs } from '../../packages/events/shadow.ts';
import type { ShadowOptions } from '../../packages/events/shadow.ts';
import type { DecisionProvider } from '../../packages/decisions/provider.ts';
import { defaultDecisionConfig } from '../../packages/decisions/provider.ts';
import { DecisionGuard } from '../../packages/decisions/guard.ts';
import { decisionTelemetry } from '../../packages/decisions/telemetry.ts';
import { createTestDatabase, runSeed } from '../support/pg-harness.ts';
import { actors, gasta } from '../support/graph-fixtures.ts';
import { CountingProvider, incident, liveHuntressWithConfirmedAgent } from '../support/events-fixtures.ts';
import { calledDuring, heldShadowProvider, modelRoute } from '../support/decision-fixtures.ts';

// Task 1.7 shadow jobs on PostgreSQL 17 through the runtime role, two pools: the baseline never waits for the AI call (a
// CRITICAL event is observed while a shadow call is still running); every call is a non-applied run; retries stay within
// the per-event call budget; the guard skips calls; a taken-over runner stores nothing; telemetry from the durable records.
const pgdb = await createTestDatabase();
const db = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
const db2 = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
after(async () => { await db.$disconnect(); await db2.$disconnect(); await pgdb.drop(); });
runSeed(pgdb.ownerUrl);
const { connection } = await liveHuntressWithConfirmedAgent(db);
const config = defaultDecisionConfig;
const worker = (provider: DecisionProvider) => processPending(db, actors.sync, gasta, { workerId: 'worker-a', provider, config, retryDelayMs: () => 0 });
const shadow = (provider: DecisionProvider, extra: Partial<ShadowOptions> = {}, now?: Date) =>
  processShadowJobs(db, actors.sync, gasta, { workerId: 'shadow-a', provider, config, retryDelayMs: () => 0, ...extra }, now);
const ingest = (id: string, severity: 'LOW' | 'CRITICAL') => ingestEvent(db, actors.sync, connection, incident(connection, id, severity));
const join = `JOIN "RawEvent" r ON r."workspaceId" = x."workspaceId" AND r."clientId" = x."clientId" AND r.id = x."eventId"`;
const observations = async (id: string) => (await pgdb.owner.query(`SELECT x.severity||'|'||x.priority||'|'||x.route||'|'||array_to_string(x."reasonCodes", ',') AS s
  FROM "Observation" x ${join} WHERE r."externalEventId" = $1`, [id])).rows.map(r => r.s);
const runs = async (id: string) => (await pgdb.owner.query(`SELECT x.provider||'|'||x.mode||'|'||x.applied||'|'||x.status||'|'||coalesce(x."safeErrorCode",'-')||'|'||
  coalesce(x."requestedModel",'-')||'|'||coalesce(x."responseModel",'-')||'|'||coalesce(x."inputTokens"::text,'-')||'|'||coalesce(x."configVersion",'-') AS s
  FROM "DecisionRun" x ${join} WHERE r."externalEventId" = $1 ORDER BY x.applied, x."createdAt"`, [id])).rows.map(r => r.s);
const job = async (id: string) => (await pgdb.owner.query(`SELECT x.status||'|'||x.attempts||'|'||coalesce(x."lastErrorCode",'-')||'|'||coalesce(x."leaseOwner",'-') AS s
  FROM "ShadowJob" x ${join} WHERE r."externalEventId" = $1`, [id])).rows.map(r => r.s);
const baseline = 'rules|shadow|true|OK|-|-|-|-|builtin-test-default';
const aiRun = (route = 'OK') => `openai|shadow|false|${route}|-|gpt-6-luna|gpt-6-luna|42|builtin-test-default`;

test('the baseline never waits for the AI: a CRITICAL event is observed while a shadow call is still running; the AI run lands later, never applied', async () => {
  const held = heldShadowProvider(() => modelRoute('MONITOR'));
  await ingest('nb-1', 'LOW'); await ingest('nb-2', 'CRITICAL');
  assert.deepEqual((await worker(held.provider)).map(o => o.status), ['PROCESSED', 'PROCESSED']);
  assert.equal(held.provider.calls, 0, 'the worker never calls the provider in shadow mode');
  assert.deepEqual([...await job('nb-1'), ...await job('nb-2')], ['PENDING|0|-|-', 'PENDING|0|-|-'], 'jobs created with the baselines');
  const running = shadow(held.provider, { batchSize: 1 });
  await calledDuring(held.started, running);
  await ingest('nb-3', 'CRITICAL');
  assert.deepEqual((await worker(held.provider)).map(o => o.status), ['PROCESSED'], 'processed while the shadow call is running');
  assert.deepEqual(await observations('nb-3'), ['CRITICAL|URGENT|HUMAN_REVIEW|RULES_BASELINE,SOURCE_URGENCY_FLOOR']);
  held.release();
  assert.deepEqual((await running).map(o => o.status), ['DONE']);
  assert.deepEqual((await shadow(held.provider)).map(o => o.status), ['DONE', 'DONE']);
  for (const id of ['nb-1', 'nb-2', 'nb-3']) assert.deepEqual([await runs(id), await job(id)], [[aiRun(), baseline], ['DONE|1|-|-']], id);
  assert.deepEqual([await observations('nb-1'), await observations('nb-2')],
    [['LOW|NORMAL|INVESTIGATE|RULES_BASELINE'], ['CRITICAL|URGENT|HUMAN_REVIEW|RULES_BASELINE,SOURCE_URGENCY_FLOOR']], 'the AI route never changes the observation');
});

test('shadow failures: TRANSIENT retries within the per-event call budget, PERMANENT fails at once; every call is a non-applied run with its code', async () => {
  let n = 0;
  const flaky = new CountingProvider('shadow', 'openai', () => { if (n++ === 0) throw new AtlasError('DECISION_TIMEOUT', 'TRANSIENT', { requestedModel: 'gpt-6-luna' }); return modelRoute('MONITOR'); });
  await ingest('sf-1', 'LOW'); await worker(flaky);
  const t0 = Date.now() + 1_000;
  assert.deepEqual((await shadow(flaky, {}, new Date(t0))).map(o => `${o.status}:${o.safeErrorCode}`), ['RETRY:DECISION_TIMEOUT']);
  assert.deepEqual(await job('sf-1'), ['RETRY|1|DECISION_TIMEOUT|-']);
  assert.deepEqual((await shadow(flaky, {}, new Date(t0 + 1_000))).map(o => o.status), ['DONE']);
  assert.deepEqual(await runs('sf-1'), ['openai|shadow|false|FAILED|DECISION_TIMEOUT|gpt-6-luna|-|-|builtin-test-default', aiRun(), baseline]);
  const mismatch = new CountingProvider('shadow', 'openai', () => { throw new AtlasError('MODEL_MISMATCH', 'PERMANENT', { requestedModel: 'gpt-6-luna', responseModel: 'gpt-6-luna-preview', inputTokens: '42' }); });
  await ingest('sf-2', 'LOW'); await worker(mismatch);
  assert.deepEqual((await shadow(mismatch)).map(o => `${o.status}:${o.safeErrorCode}`), ['FAILED:MODEL_MISMATCH']);
  assert.deepEqual([await runs('sf-2'), await job('sf-2'), mismatch.calls],
    [['openai|shadow|false|FAILED|MODEL_MISMATCH|gpt-6-luna|gpt-6-luna-preview|42|builtin-test-default', baseline], ['FAILED|1|MODEL_MISMATCH|-'], 1]);
  const twoCalls = { ...config, budget: { ...config.budget, maxProviderCallsPerEvent: 2 } };
  const down = new CountingProvider('shadow', 'openai', () => { throw new AtlasError('DECISION_HTTP_503', 'TRANSIENT', { requestedModel: 'gpt-6-luna' }); });
  await ingest('sf-3', 'LOW'); await worker(down);
  const statuses = [];
  for (let i = 0; i < 3; i++) statuses.push((await shadow(down, { config: twoCalls }, new Date(t0 + 10_000 * (i + 1)))).map(o => o.status).join());
  assert.deepEqual([statuses, await job('sf-3'), down.calls], [['RETRY', 'FAILED', ''], ['FAILED|2|DECISION_HTTP_503|-'], 2], 'two calls: the per-event budget');
});

test('an open circuit or a spent call budget skips the shadow call: SKIPPED with the reason, no provider call, no run', async () => {
  const provider = new CountingProvider('shadow', 'openai', () => modelRoute('MONITOR'));
  await ingest('gs-1', 'LOW'); await ingest('gs-2', 'LOW'); await worker(provider);
  const open = new DecisionGuard({ budget: config.budget, circuitBreaker: { failureThreshold: 1, openMs: 60_000 } });
  open.admit(); open.record('DECISION_TIMEOUT');
  assert.deepEqual((await shadow(provider, { guard: open, batchSize: 1 })).map(o => `${o.status}:${o.safeErrorCode}`), ['SKIPPED:PROVIDER_CIRCUIT_OPEN']);
  const spent = new DecisionGuard({ budget: { maxProviderCallsPerEvent: 3, maxProviderCallsPerMinute: 1 }, circuitBreaker: config.circuitBreaker });
  spent.admit();
  assert.deepEqual((await shadow(provider, { guard: spent })).map(o => `${o.status}:${o.safeErrorCode}`), ['SKIPPED:PROVIDER_BUDGET_EXHAUSTED']);
  // Which of the two jobs went first depends on millisecond creation times: compare the outcomes as a set
  assert.deepEqual([provider.calls, await runs('gs-1'), await runs('gs-2'), [...await job('gs-1'), ...await job('gs-2')].sort()],
    [0, [baseline], [baseline], ['SKIPPED|1|PROVIDER_BUDGET_EXHAUSTED|-', 'SKIPPED|1|PROVIDER_CIRCUIT_OPEN|-']]);
});

test('a runner whose claim was taken over stores nothing; a job whose last claim never reported back fails as ATTEMPTS_EXHAUSTED without a call', async () => {
  const slow = heldShadowProvider(() => modelRoute('INVESTIGATE'));
  await ingest('st-1', 'LOW'); await worker(slow.provider);
  const t0 = Date.now() + 1_000;
  const stale = processShadowJobs(db, actors.sync, gasta, { workerId: 'shadow-a', provider: slow.provider, config, leaseMs: 100 }, new Date(t0));
  await calledDuring(slow.started, stale);
  const fast = new CountingProvider('shadow', 'openai', () => modelRoute('MONITOR'));
  assert.deepEqual((await processShadowJobs(db2, actors.sync, gasta, { workerId: 'shadow-b', provider: fast, config }, new Date(t0 + 200))).map(o => o.status), ['DONE']);
  slow.release();
  assert.deepEqual((await stale).map(o => o.status), ['CLAIM_LOST']);
  assert.deepEqual([await runs('st-1'), await job('st-1')], [[aiRun(), baseline], ['DONE|2|-|-']], 'only the current claim stored a run');
  await ingest('st-2', 'LOW'); await worker(fast);
  await pgdb.owner.query(`UPDATE "ShadowJob" SET attempts = 3, "leaseOwner" = 'shadow-dead', "leaseExpiresAt" = now() - interval '1 minute', "claimToken" = gen_random_uuid()
    WHERE "eventId" = (SELECT id FROM "RawEvent" WHERE "externalEventId" = 'st-2')`);
  assert.deepEqual((await shadow(fast)).map(o => `${o.status}:${o.safeErrorCode}`), ['FAILED:ATTEMPTS_EXHAUSTED']);
  assert.deepEqual([await job('st-2'), fast.calls], [['FAILED|3|ATTEMPTS_EXHAUSTED|-'], 1]);
});

test('telemetry from the durable records: shadow agreement with the baseline, job outcomes and failure codes; context:read only', async () => {
  const window = { since: new Date(Date.now() - 3_600_000), until: new Date(Date.now() + 60_000), deadlineMs: config.deadlineMs };
  await assert.rejects(decisionTelemetry(db, actors.sync, gasta, window), /PERMISSION_DENIED/);
  const report = await decisionTelemetry(db, actors.reader, gasta, window);
  assert.deepEqual(report.shadowAgreement, [{ baseline: 'HUMAN_REVIEW', shadow: 'MONITOR', count: 2 }, { baseline: 'INVESTIGATE', shadow: 'MONITOR', count: 3 }]);
  assert.deepEqual(report.shadowJobs.map(j => `${j.status}:${j.code ?? '-'}:${j.count}`), ['DONE:-:5', 'FAILED:ATTEMPTS_EXHAUSTED:1', 'FAILED:DECISION_HTTP_503:1',
    'FAILED:MODEL_MISMATCH:1', 'SKIPPED:PROVIDER_BUDGET_EXHAUSTED:1', 'SKIPPED:PROVIDER_CIRCUIT_OPEN:1']);
  assert.deepEqual(report.runs.filter(r => r.provider === 'openai').map(r => `${r.status}:${r.code ?? '-'}:${r.count}`),
    ['FAILED:DECISION_HTTP_503:2', 'FAILED:DECISION_TIMEOUT:1', 'FAILED:MODEL_MISMATCH:1', 'OK:-:5']);
  assert.deepEqual(report.runs.filter(r => r.provider === 'rules').map(r => `${r.mode}:${r.status}:${r.count}`), ['shadow:OK:10']);
  const ai = report.latency.find(l => l.provider === 'openai')!;
  assert.deepEqual([ai.calls, ai.withinDeadline, ai.p50Ms !== null && ai.p50Ms >= 0], [9, 9, true]);
  assert.deepEqual(report.inputTokens, [{ provider: 'openai', callsWithUsage: 6, total: 252, perCall: 42, perEvent: 42 }]);
});
