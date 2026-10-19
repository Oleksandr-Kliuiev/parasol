import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { AtlasError } from '../packages/core/contracts.ts';
import { defaultDecisionConfig } from '../packages/decisions/provider.ts';
import { processShadowJobs } from '../packages/events/shadow.ts';
import { normalizeHuntress } from '../connectors/huntress/normalizer.ts';
import { actor, scope } from '../fixtures/gasta.ts';
import { CountingProvider } from './support/events-fixtures.ts';

const at = '2026-10-16T12:00:00.000Z';
const event = normalizeHuntress(scope, 'synthetic-connection', { id: 'synthetic-incident', revision: '1', agentId: 'synthetic-agent',
  at, signal: 'Synthetic shadow clock incident', severity: 'LOW' }, at);

function clockFixture(claimClock: Date, outcomeClock: Date, claimed = false) {
  let transaction = 0;
  const calls: { sql: string; dates: Date[]; transaction: number }[] = [];
  const writes: { nextAttemptAt?: Date; finishedAt?: Date; status: string }[] = [];
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      calls.push({ sql, dates: values.filter((v): v is Date => v instanceof Date), transaction });
      if (sql.includes('clock_timestamp()')) return [{ instant: transaction === 1 ? claimClock : outcomeClock }];
      if (sql.includes('attempts = j.attempts + 1')) return claimed ? [{ eventId: 'synthetic-event', attempts: 1, claimToken: 'synthetic-claim' }] : [];
      if (sql.trim().startsWith('SELECT "eventId"')) return [{ eventId: 'synthetic-event' }];
      return [];
    },
    rawEvent: { findMany: async () => [{ id: 'synthetic-event', normalized: event }] },
    decisionRun: { create: async () => ({ id: 'synthetic-run' }) },
    shadowJob: { updateMany: async (write: { data: typeof writes[number] }) => { writes.push(write.data); return { count: 1 }; } },
  };
  const db = { $transaction: async (run: (value: typeof tx) => Promise<unknown>) => { transaction++; return run(tx); } } as unknown as PrismaClient;
  return { db, calls, writes };
}

for (const explicit of [undefined, new Date('2030-01-01T00:00:00.001Z')]) {
  test(`shadow eligibility and lease preserve ${explicit ? 'an explicit caller clock' : 'the scoped database clock'}`, async () => {
    const instant = new Date('2040-01-02T03:04:05.006Z');
    const { db, calls } = clockFixture(instant, instant);
    const provider = new CountingProvider('shadow');
    assert.deepEqual(await processShadowJobs(db, actor, scope, { workerId: 'synthetic-shadow', provider, config: defaultDecisionConfig, leaseMs: 5000 }, explicit), []);
    const now = explicit ?? instant;
    const clockReads = calls.filter(c => c.sql.includes('clock_timestamp'));
    assert.equal(clockReads.length, explicit ? 0 : 1);
    assert.match(calls[0]!.sql, /set_config/);
    const selections = calls.filter(c => c.sql.includes('WITH picked'));
    assert.deepEqual(selections[0]!.dates.map(d => d.getTime()), [now.getTime(), now.getTime(), now.getTime()]);
    assert.deepEqual(selections[1]!.dates.map(d => d.getTime()), [now.getTime(), now.getTime(), now.getTime() + 5000]);
    assert.equal(provider.calls, 0);
  });

  test(`shadow retry backoff uses ${explicit ? 'the explicit caller clock' : 'the failure transaction database clock'} despite process-clock skew`, async () => {
    const claimClock = new Date('2040-01-02T03:04:05.006Z');
    const outcomeClock = new Date('2040-01-02T03:04:10.006Z');
    const { db, calls, writes } = clockFixture(claimClock, outcomeClock, true);
    const provider = new CountingProvider('shadow', 'openai', () => { throw new AtlasError('SYNTHETIC_TIMEOUT', 'TRANSIENT'); });
    assert.deepEqual(await processShadowJobs(db, actor, scope, { workerId: 'synthetic-shadow', provider, config: defaultDecisionConfig,
      retryDelayMs: () => 30_000 }, explicit), [{ eventId: 'synthetic-event', status: 'RETRY', safeErrorCode: 'SYNTHETIC_TIMEOUT' }]);
    assert.equal(writes.length, 1); assert.equal(writes[0]!.status, 'RETRY');
    assert.equal(writes[0]!.nextAttemptAt!.getTime(), (explicit ?? outcomeClock).getTime() + 30_000);
    const clocks = calls.filter(c => c.sql.includes('clock_timestamp'));
    assert.deepEqual(clocks.map(c => c.transaction), explicit ? [] : [1, 2]);
    assert.equal(provider.calls, 1);
  });
}
