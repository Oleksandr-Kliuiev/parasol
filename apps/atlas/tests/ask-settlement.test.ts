import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dbAskPort } from '../packages/ask/authority.ts';
import { AskBudget, AskDeadline } from '../packages/ask/budget.ts';
import { AskFailure } from '../packages/ask/contracts.ts';
import { bearerCredential } from '../packages/ask/credential.ts';
import { AskRun } from '../packages/ask/service.ts';

// ASK-A Q6 settlement branch that real PostgreSQL cannot provoke deterministically: the driver rejects the transaction
// wrapper (Prisma P2028 interactive-transaction timeout) BEFORE the callback's in-flight query settles. The owner must
// stay occupied until that callback actually settles — a rejected wrapper never releases capacity. Real-PG ownership and
// cleanup are proven in tests/pg/ask-budget.pg.test.ts; this driver stand-in only orders promises, it grants no authority.

const tick = () => new Promise(resolve => setImmediate(resolve));
function driver() {
  let releaseQuery!: () => void;
  const query = new Promise<unknown[]>(resolve => { releaseQuery = () => resolve([]); });
  const tx = { $executeRawUnsafe: async () => 1, $queryRaw: () => query, $queryRawUnsafe: () => query };
  const db = {
    $transaction: (fn: (t: typeof tx) => Promise<unknown>, options: { timeout: number; maxWait: number }) => {
      const body = fn(tx);
      return new Promise((resolve, reject) => {
        setTimeout(() => reject(Object.assign(new Error('Transaction already closed'), { code: 'P2028', clientVersion: '6.19.0' })), options.timeout);
        body.then(resolve, reject);
      });
    }
  };
  return { db, releaseQuery };
}

test('a transaction wrapper rejected before its callback settles keeps the owner until the callback settles; exactly one release', async () => {
  const { db, releaseQuery } = driver();
  const budget = new AskBudget();
  const owner = budget.reserve()!;
  let now = 0;
  const run = new AskRun(owner, new AskDeadline(60, () => now));
  const port = dbAskPort(db as never);
  const started = Date.now();
  await assert.rejects(port.authenticate(run, bearerCredential('Bearer abcdefghijklmnopqrstuvwxyz0123')!),
    (e: unknown) => e instanceof AskFailure && e.code === 'ASK_DEADLINE');
  assert.ok(Date.now() - started < 1000, 'bounded by min(2 s, remaining original budget)');
  owner.finish();
  await tick();
  assert.equal(owner.released, false, 'the in-flight query of the abandoned callback still owns the slot');
  assert.equal(budget.active, 1);
  now = 100;
  releaseQuery();
  await tick(); await tick(); await tick();
  assert.equal(owner.released, true); assert.equal(budget.active, 0); assert.equal(budget.releases, 1);
});

test('the pool wait and transaction bounds follow min(phase cap, remaining original budget)', async () => {
  const seen: { timeout: number; maxWait: number }[] = [];
  const db = { $transaction: (_fn: unknown, options: { timeout: number; maxWait: number }) => { seen.push(options); return Promise.resolve(null); } };
  const budget = new AskBudget();
  for (const remaining of [8000, 1500, 300]) {
    const owner = budget.reserve()!;
    let now = 0;
    const run = new AskRun(owner, new AskDeadline(remaining, () => now));
    assert.equal(await dbAskPort(db as never).authenticate(run, bearerCredential('Bearer abcdefghijklmnopqrstuvwxyz0123')!), null);
    owner.finish(); now = remaining;
  }
  assert.deepEqual(seen, [{ maxWait: 500, timeout: 2000 }, { maxWait: 500, timeout: 1500 }, { maxWait: 300, timeout: 300 }]);
});

test('a hung driver that never rejects on its own: the caller still fails at the phase end; the owner waits for the driver', async () => {
  let settle!: () => void;
  const hung = new Promise<unknown[]>(resolve => { settle = () => resolve([]); });
  const tx = { $executeRawUnsafe: async () => 1, $queryRaw: () => hung, $queryRawUnsafe: () => hung };
  const db = { $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) };
  const budget = new AskBudget();
  const owner = budget.reserve()!;
  let now = 0;
  const run = new AskRun(owner, new AskDeadline(80, () => now));
  const started = Date.now();
  const outcome = await Promise.race([
    dbAskPort(db as never).authenticate(run, bearerCredential('Bearer abcdefghijklmnopqrstuvwxyz0123')!).then(() => 'SETTLED', (e: unknown) => e instanceof AskFailure ? e.code : 'OTHER'),
    new Promise(resolve => setTimeout(() => resolve('NO CALLER-VISIBLE BOUND'), 1000))]);
  assert.equal(outcome, 'ASK_DEADLINE');
  assert.ok(Date.now() - started < 500);
  owner.finish(); await tick();
  assert.equal(budget.active, 1, 'the hung statement still owns the slot');
  now = 1000; settle();
  await tick(); await tick(); await tick();
  assert.equal(budget.active, 0); assert.equal(budget.releases, 1);
});
