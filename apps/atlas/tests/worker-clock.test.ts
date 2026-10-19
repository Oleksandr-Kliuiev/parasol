import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { claimEvents, processClaimed } from '../packages/events/worker.ts';
import type { ClaimedEvent } from '../packages/events/worker.ts';
import { runWorkerPass } from '../packages/ops/worker-pass.ts';
import type { DecisionRuntime } from '../packages/decisions/runtime.ts';
import type { DecisionProvider } from '../packages/decisions/provider.ts';
import { AtlasError } from '../packages/core/contracts.ts';
import { normalizeHuntress } from '../connectors/huntress/normalizer.ts';
import { actor, scope } from '../fixtures/gasta.ts';

function clockFixture(databaseNow: Date) {
  const calls: { sql: string; dates: Date[] }[] = [];
  const transaction = { $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?'); calls.push({ sql, dates: values.filter((value): value is Date => value instanceof Date) });
    return sql.includes('clock_timestamp()') ? [{ instant: databaseNow }] : [];
  } };
  const db = { $transaction: async (run: (tx: typeof transaction) => Promise<unknown>) => run(transaction) } as unknown as PrismaClient;
  return { db, calls };
}

test('default claim eligibility and lease use the scoped database clock even when the application clock differs', async () => {
  const databaseNow = new Date('2040-01-02T03:04:05.006Z');
  const { db, calls } = clockFixture(databaseNow);
  assert.deepEqual(await claimEvents(db, actor, scope, { workerId: 'synthetic-clock-worker', leaseMs: 5000 }), { claimed: [], deadLettered: [] });
  assert.match(calls[0]!.sql, /set_config/); assert.match(calls[1]!.sql, /clock_timestamp\(\)::timestamptz\(3\)/);
  assert.deepEqual(calls[2]!.dates.map(d => d.getTime()), [databaseNow.getTime(), databaseNow.getTime()]);
  assert.deepEqual(calls[3]!.dates.map(d => d.getTime()), [databaseNow.getTime(), databaseNow.getTime(), databaseNow.getTime() + 5000]);
});

test('an explicit recovery/scheduling clock is preserved and does not read the database clock', async () => {
  const explicitNow = new Date('2030-01-02T03:04:05.006Z');
  const { db, calls } = clockFixture(new Date('2040-01-01T00:00:00Z'));
  await claimEvents(db, actor, scope, { workerId: 'synthetic-recovery-worker', leaseMs: 5000 }, explicitNow);
  assert.equal(calls.length, 3); assert.ok(!calls.some(c => c.sql.includes('clock_timestamp')));
  assert.deepEqual(calls[1]!.dates.map(d => d.getTime()), [explicitNow.getTime(), explicitNow.getTime()]);
  assert.deepEqual(calls[2]!.dates.map(d => d.getTime()), [explicitNow.getTime(), explicitNow.getTime(), explicitNow.getTime() + 5000]);
});

test('the production operator pass preserves the database-clock default and only forwards an explicit scheduling clock', async () => {
  const databaseNow = new Date('2040-01-02T03:04:05.006Z');
  const { db, calls } = clockFixture(databaseNow);
  assert.deepEqual(await runWorkerPass(db, actor, {} as DecisionRuntime, 'synthetic-operator'), [{ clientId: scope.clientId, events: {} }]);
  assert.match(calls[1]!.sql, /clock_timestamp/);
  assert.deepEqual(calls[2]!.dates.map(d => d.getTime()), [databaseNow.getTime(), databaseNow.getTime()]);
  const explicit = clockFixture(databaseNow); const given = new Date('2030-01-01T00:00:00.001Z');
  await runWorkerPass(explicit.db, actor, {} as DecisionRuntime, 'synthetic-operator', given);
  assert.ok(!explicit.calls.some(c => c.sql.includes('clock_timestamp')));
  assert.deepEqual(explicit.calls[1]!.dates.map(d => d.getTime()), [given.getTime(), given.getTime()]);
});

for (const explicit of [undefined, new Date('2030-01-01T00:00:00.001Z')]) {
  test(`failure backoff uses ${explicit ? 'the explicit scheduling' : 'the database'} clock despite process-clock skew`, async () => {
    const databaseNow = new Date('2040-01-02T03:04:05.006Z');
    let attempts = 0; let saved: Date | undefined; let clockReads = 0; let audited = false;
    const tx = {
      $queryRaw: async (strings: TemplateStringsArray) => {
        if (strings.join('').includes('clock_timestamp')) { clockReads++; return [{ instant: databaseNow }]; }
        return [];
      },
      rawEvent: { updateMany: async (write: { data: { nextAttemptAt: Date } }) => { saved = write.data.nextAttemptAt; return { count: 1 }; } },
      auditEvent: { create: async () => { audited = true; } },
    };
    const db = { $transaction: async (run: (value: typeof tx) => Promise<unknown>) => {
      if (attempts++ === 0) throw new AtlasError('DATABASE_UNAVAILABLE', 'TRANSIENT');
      return run(tx);
    } } as unknown as PrismaClient;
    const at = '2026-10-16T12:00:00.000Z';
    const claimed: ClaimedEvent = { id: 'synthetic-event', eventKey: 'synthetic-key', conflictOfEventKey: null,
      normalized: normalizeHuntress(scope, 'synthetic-connection', { id: 'synthetic-incident', revision: '1', agentId: 'synthetic-agent',
        at, signal: 'Synthetic clock incident', severity: 'LOW' }, at), attempts: 1, claimToken: 'synthetic-claim', prepared: null };
    const outcome = await processClaimed(db, actor, scope, claimed,
      { workerId: 'synthetic-retry-worker', provider: {} as DecisionProvider, retryDelayMs: () => 30_000 }, explicit);
    assert.equal(outcome.status, 'RETRY'); assert.equal(outcome.safeErrorCode, 'DATABASE_UNAVAILABLE');
    assert.equal(saved!.getTime(), (explicit ?? databaseNow).getTime() + 30_000);
    assert.equal(clockReads, explicit ? 0 : 1); assert.equal(audited, true);
    if (!explicit) assert.ok(saved!.getTime() > databaseNow.getTime(), 'backoff cannot already be due on the claim clock');
  });
}
