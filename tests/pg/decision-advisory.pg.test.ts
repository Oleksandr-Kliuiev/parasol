import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { ingestEvent } from '../../packages/events/inbox.ts';
import { processPending } from '../../packages/events/worker.ts';
import { defaultDecisionConfig } from '../../packages/decisions/provider.ts';
import type { DecisionConfig } from '../../packages/decisions/provider.ts';
import { OpenAIDecisionProvider } from '../../packages/decisions/openai.ts';
import { DecisionGuard } from '../../packages/decisions/guard.ts';
import { decisionTelemetry } from '../../packages/decisions/telemetry.ts';
import { createTestDatabase, runSeed } from '../support/pg-harness.ts';
import { actors, gasta } from '../support/graph-fixtures.ts';
import { incident, liveHuntressWithConfirmedAgent } from '../support/events-fixtures.ts';
import { drifted, refused, routed, scriptedFetch, timedOut } from '../support/decision-fixtures.ts';
import type { Step } from '../support/decision-fixtures.ts';

// Task 1.7 advisory mode on PostgreSQL 17 through the runtime role with the real OpenAI adapter over a scripted transport
// (no network, synthetic bodies): an answer routes; the threshold and the urgency floor hold; timeout, refusal, schema drift
// and an unknown model are visible HUMAN_REVIEW with a FAILED run; an open circuit or a spent budget switches the event to
// the rules mode explicitly; telemetry counts every code.
const pgdb = await createTestDatabase();
const db = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
after(async () => { await db.$disconnect(); await pgdb.drop(); });
runSeed(pgdb.ownerUrl);
const { connection } = await liveHuntressWithConfirmedAgent(db);
const config: DecisionConfig = { ...defaultDecisionConfig, configVersion: 'decisions-test.1', mode: 'advisory' };
const join = `JOIN "RawEvent" r ON r."workspaceId" = x."workspaceId" AND r."clientId" = x."clientId" AND r.id = x."eventId"`;
const observation = async (id: string) => (await pgdb.owner.query(`SELECT x.severity||'|'||x.priority||'|'||x.route||'|'||x.provider||'|'||array_to_string(x."reasonCodes", ',') AS s
  FROM "Observation" x ${join} WHERE r."externalEventId" = $1`, [id])).rows.map(r => r.s)[0];
const runs = async (id: string) => (await pgdb.owner.query(`SELECT x.provider||'|'||x.mode||'|'||x.applied||'|'||x.status||'|'||coalesce(x."safeErrorCode",'-')||'|'||
  coalesce(x."requestedModel",'-')||'|'||coalesce(x."responseModel",'-')||'|'||coalesce(x."inputTokens"::text,'-')||'|'||coalesce(x."configVersion",'-') AS s
  FROM "DecisionRun" x ${join} WHERE r."externalEventId" = $1 ORDER BY x.applied, x.provider`, [id])).rows.map(r => r.s);
/** One event through the worker with a provider that answers with the given steps. */
async function route(id: string, severity: 'LOW' | 'CRITICAL', steps: Step[], guard?: DecisionGuard) {
  const transport = scriptedFetch(steps);
  await ingestEvent(db, actors.sync, connection, incident(connection, id, severity));
  const provider = new OpenAIDecisionProvider('mock-not-a-key', config, transport.fetch, 'advisory');
  const outcomes = await processPending(db, actors.sync, gasta, { workerId: 'worker-a', provider, config, guard, retryDelayMs: () => 0 });
  assert.deepEqual(outcomes.map(o => o.status), ['PROCESSED'], id);
  return { observation: await observation(id), runs: await runs(id), calls: transport.calls };
}
const fallback = (code: string, responseModel = '-', tokens = '-') =>
  [`openai|advisory|false|FAILED|${code}|gpt-6-luna|${responseModel}|${tokens}|decisions-test.1`, 'rules|advisory|true|OK|-|-|-|-|decisions-test.1'];

test('an answer routes; the confidence threshold and the source urgency floor hold over the model', async () => {
  const ok = await route('ad-ok', 'LOW', [routed('MONITOR', 0.95)]);
  assert.deepEqual([ok.observation, ok.runs], ['LOW|NORMAL|MONITOR|openai|MODEL_ROUTE', ['openai|advisory|true|OK|-|gpt-6-luna|gpt-6-luna|42|decisions-test.1']]);
  const input = JSON.parse((ok.calls.bodies[0] as { input: string }).input) as Record<string, unknown>;
  assert.deepEqual([(ok.calls.bodies[0] as { model: string }).model, Object.keys(input).sort()], ['gpt-6-luna', ['kind', 'source', 'sourceSeverity']],
    'configured model; only the input allowlist (diskPercent is absent for an incident), no summary or identifiers');
  assert.equal((await route('ad-floor', 'CRITICAL', [routed('MONITOR', 0.99)])).observation, 'CRITICAL|URGENT|HUMAN_REVIEW|openai|MODEL_ROUTE,SOURCE_URGENCY_FLOOR');
  assert.equal((await route('ad-low', 'LOW', [routed('MONITOR', 0.5)])).observation, 'LOW|NORMAL|HUMAN_REVIEW|openai|MODEL_ROUTE,LOW_CONFIDENCE');
});

test('timeout, refusal, schema drift and an unknown model: visible HUMAN_REVIEW with a FAILED run, both models, one applied run', async () => {
  const cases: [string, Step, string, string, string][] = [
    ['ad-timeout', timedOut, 'DECISION_TIMEOUT', '-', '-'],
    ['ad-refused', refused, 'DECISION_REFUSED', '-', '-'],
    ['ad-drift', drifted, 'INVALID_DECISION_RESPONSE', '-', '-'],
    ['ad-model', routed('MONITOR', 0.95, 'gpt-6-luna-preview'), 'MODEL_MISMATCH', 'gpt-6-luna-preview', '42'],
  ];
  for (const [id, step, code, responseModel, tokens] of cases) {
    const result = await route(id, 'LOW', [step]);
    assert.deepEqual([result.observation, result.runs], [`LOW|NORMAL|HUMAN_REVIEW|rules|PROVIDER_UNAVAILABLE_OR_INVALID,${code}`, fallback(code, responseModel, tokens)], id);
  }
  const applied = (await pgdb.owner.query(`SELECT count(*)::int AS events, count(*) FILTER (WHERE n = 1)::int AS one FROM (SELECT "eventId", count(*) FILTER (WHERE applied) AS n
    FROM "DecisionRun" GROUP BY "eventId") t`)).rows[0];
  assert.equal(applied.events, applied.one, 'exactly one applied run per event');
});

test('circuit breaker: after consecutive failures the next event switches to the rules mode explicitly, without a call; one probe closes it', async () => {
  let now = Date.now();
  const guard = new DecisionGuard({ budget: config.budget, circuitBreaker: { failureThreshold: 2, openMs: 60_000 } }, () => now);
  for (const id of ['cb-1', 'cb-2']) assert.equal((await route(id, 'LOW', [timedOut], guard)).observation, 'LOW|NORMAL|HUMAN_REVIEW|rules|PROVIDER_UNAVAILABLE_OR_INVALID,DECISION_TIMEOUT');
  assert.equal(guard.snapshot().state, 'OPEN');
  const open = await route('cb-3', 'LOW', [routed('MONITOR', 0.95)], guard);
  assert.deepEqual([open.observation, open.runs, open.calls.count],
    ['LOW|NORMAL|INVESTIGATE|rules|RULES_BASELINE,PROVIDER_CIRCUIT_OPEN', ['rules|rules|true|OK|-|-|-|-|decisions-test.1'], 0]);
  assert.equal((await route('cb-4', 'CRITICAL', [], guard)).observation, 'CRITICAL|URGENT|HUMAN_REVIEW|rules|RULES_BASELINE,PROVIDER_CIRCUIT_OPEN,SOURCE_URGENCY_FLOOR',
    'the urgency floor holds in the rules mode too');
  now += 60_000;
  const probe = await route('cb-5', 'LOW', [routed('MONITOR', 0.95)], guard);
  assert.deepEqual([probe.observation, probe.calls.count, guard.snapshot().state], ['LOW|NORMAL|MONITOR|openai|MODEL_ROUTE', 1, 'CLOSED']);
});

test('call budget: beyond maxProviderCallsPerMinute the event switches to the rules mode with PROVIDER_BUDGET_EXHAUSTED', async () => {
  const guard = new DecisionGuard({ budget: { maxProviderCallsPerEvent: 3, maxProviderCallsPerMinute: 1 }, circuitBreaker: config.circuitBreaker });
  assert.equal((await route('bud-1', 'LOW', [routed('MONITOR', 0.95)], guard)).observation, 'LOW|NORMAL|MONITOR|openai|MODEL_ROUTE');
  const spent = await route('bud-2', 'LOW', [routed('MONITOR', 0.95)], guard);
  assert.deepEqual([spent.observation, spent.calls.count], ['LOW|NORMAL|INVESTIGATE|rules|RULES_BASELINE,PROVIDER_BUDGET_EXHAUSTED', 0]);
});

test('telemetry counts every failure code with both models, latency against the deadline, input tokens, guard refusals and the review rate', async () => {
  const report = await decisionTelemetry(db, actors.reader, gasta, { since: new Date(Date.now() - 3_600_000), until: new Date(Date.now() + 60_000), deadlineMs: config.deadlineMs });
  assert.deepEqual(report.runs.filter(r => r.provider === 'openai').map(r => `${r.status}:${r.code ?? '-'}:${r.count}`), ['FAILED:DECISION_REFUSED:1',
    'FAILED:DECISION_TIMEOUT:3', 'FAILED:INVALID_DECISION_RESPONSE:1', 'FAILED:MODEL_MISMATCH:1', 'OK:-:5']);
  const ai = report.latency.find(l => l.provider === 'openai')!;
  assert.deepEqual([ai.calls, ai.withinDeadline], [11, 11]);
  assert.deepEqual(report.inputTokens, [{ provider: 'openai', callsWithUsage: 6, total: 252, perCall: 42, perEvent: 42 }]);
  assert.deepEqual(report.guardRefusals, [{ reason: 'PROVIDER_BUDGET_EXHAUSTED', count: 1 }, { reason: 'PROVIDER_CIRCUIT_OPEN', count: 2 }]);
  assert.deepEqual(report.review, { observations: 14, humanReview: 9, rate: 0.643 });
  assert.deepEqual([report.shadowAgreement, report.shadowJobs], [[], []], 'no shadow experiments in advisory mode');
});
