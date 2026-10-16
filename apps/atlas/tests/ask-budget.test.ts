import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AskBudget, AskDeadline } from '../packages/ask/budget.ts';

// ASK-A Q6 (pure part): ≤4 global owners reserved synchronously, ≤1 bound owner per exact (workspace, actor), ≤64 tracked
// entries, 10 charged questions per rolling 60 s, exactly-once release only after held work actually settles, and the
// original monotonic deadline. Real PostgreSQL/HTTP ownership is proven in tests/pg/ask-budget.pg.test.ts.

function clock(start = 1000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}
function deferred() {
  let resolve!: () => void; let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('global: four owners at most, the fifth reservation is refused synchronously; release is exactly once', async () => {
  const budget = new AskBudget();
  const owners = [1, 2, 3, 4].map(() => budget.reserve());
  assert.ok(owners.every(o => o !== null));
  assert.equal(budget.reserve(), null);
  owners[0]!.finish(); owners[0]!.finish();
  await tick();
  assert.equal(budget.active, 3); assert.equal(budget.releases, 1);
  assert.notEqual(budget.reserve(), null);
  assert.equal(budget.reserve(), null);
});

test('held work keeps the slot after finish(); release happens once, when the last held promise settles either way', async () => {
  const budget = new AskBudget();
  const owner = budget.reserve()!;
  const tx = deferred(); const planner = deferred();
  owner.hold(tx.promise); owner.hold(planner.promise);
  owner.finish();
  await tick();
  assert.equal(owner.released, false); assert.equal(budget.active, 1);
  tx.reject(new Error('rolled back')); await tick();
  assert.equal(owner.released, false, 'a rejected wrapper does not release while other work is pending');
  planner.resolve(); await tick();
  assert.equal(owner.released, true); assert.equal(budget.active, 0); assert.equal(budget.releases, 1);
  owner.finish(); owner.hold(Promise.resolve()); await tick();
  assert.equal(budget.releases, 1, 'late callbacks cannot release again');
});

test('never-settling work retains its slot: capacity fails closed without accumulating replacements', async () => {
  const budget = new AskBudget();
  for (let i = 0; i < 4; i += 1) { const o = budget.reserve()!; o.hold(new Promise(() => undefined)); o.finish(); }
  await tick();
  assert.equal(budget.active, 4);
  for (let i = 0; i < 10; i += 1) assert.equal(budget.reserve(), null);
  assert.equal(budget.active, 4);
});

test('actor binding: the same owner binds once; one bound owner per exact (workspace, actor); no concatenation collision', async () => {
  const budget = new AskBudget();
  const a = budget.reserve()!; const b = budget.reserve()!; const c = budget.reserve()!; const d = budget.reserve()!;
  assert.equal(a.bind('w', 'actor', false), 'BOUND');
  assert.equal(a.bind('w', 'actor', false), 'BUSY', 'an owner binds once');
  assert.equal(b.bind('w', 'actor', false), 'BUSY', 'only one owner per actor, even a capability');
  assert.equal(c.bind('w:a', 'ctor', false), 'BOUND');
  assert.equal(d.bind('wa', 'ctor', false), 'BOUND');
  a.finish(); await tick();
  const e = budget.reserve()!;
  assert.equal(e.bind('w', 'actor', true), 'BOUND', 'the actor is free again after release');
  assert.equal(budget.entries, 3);
});

test('rolling 10 per 60 s: charged only explicitly, never refunded; the 11th is refused at binding and at charge', async () => {
  const time = clock();
  const budget = new AskBudget(time.now);
  for (let i = 0; i < 10; i += 1) {
    const owner = budget.reserve()!;
    assert.equal(owner.bind('w', 'x', true), 'BOUND');
    assert.equal(owner.charge(), true);
    owner.finish(); await tick();
    time.advance(1000);
  }
  assert.equal(budget.admissions('w', 'x'), 10);
  const capped = budget.reserve()!;
  assert.equal(capped.bind('w', 'x', true), 'BUSY', 'rate check at binding');
  assert.equal(capped.bind('w', 'x', false), 'BOUND', 'a capability never needs or consumes a question');
  assert.equal(capped.charge(), false, 'recheck at charge');
  capped.finish(); await tick();
  assert.equal(budget.admissions('w', 'x'), 10);
  time.advance(50_001); // the first admission is now ≥60 s old
  const next = budget.reserve()!;
  assert.equal(next.bind('w', 'x', true), 'BOUND');
  assert.equal(next.charge(), true);
  const unbound = budget.reserve()!;
  assert.equal(unbound.charge(), false, 'no charge without a bound actor');
});

test('64 tracked entries: uncharged entries leave on release, charged ones only when idle ≥60 s; the 65th is 429; active entries never evicted', async () => {
  const time = clock();
  const budget = new AskBudget(time.now);
  for (let i = 0; i < 64; i += 1) {
    const o = budget.reserve()!; assert.equal(o.bind('w', `a${i}`, true), 'BOUND'); assert.equal(o.charge(), true); o.finish(); await tick();
  }
  assert.equal(budget.entries, 64);
  const refused = budget.reserve()!;
  assert.equal(refused.bind('w', 'a64', true), 'BUSY', '65th entry while every entry has a recent admission');
  refused.finish(); await tick();
  const uncharged = budget.reserve()!;
  assert.equal(uncharged.bind('w', 'a0', false), 'BOUND', 'an existing entry still binds');
  uncharged.finish(); await tick();
  assert.equal(budget.entries, 64, 'a charged entry stays during its window');
  time.advance(60_000);
  const active = budget.reserve()!; assert.equal(active.bind('w', 'a1', false), 'BOUND');
  const newcomer = budget.reserve()!;
  assert.equal(newcomer.bind('w', 'a65', true), 'BOUND', 'idle expired entries are pruned on demand');
  assert.equal(budget.entries, 2, 'only the bound (active) and the new entry remain');
  assert.equal(budget.active, 2);
});

test('uncharged entries are removed immediately on release; denied requests never allocate unboundedly', async () => {
  const budget = new AskBudget();
  for (let i = 0; i < 200; i += 1) {
    const o = budget.reserve()!; assert.equal(o.bind('w', `denied-${i}`, true), 'BOUND'); o.finish(); await tick();
  }
  assert.equal(budget.entries, 0); assert.equal(budget.active, 0); assert.equal(budget.releases, 200);
});

test('original deadline: monotonic, never reset, phase bound = min(cap, remaining)', () => {
  const time = clock(0);
  const deadline = new AskDeadline(8000, time.now);
  assert.equal(deadline.phase(2000), 2000);
  time.advance(7000);
  assert.equal(deadline.phase(2000), 1000);
  assert.equal(deadline.expired(), false);
  time.advance(1000);
  assert.equal(deadline.expired(), true); assert.equal(deadline.remaining(), 0); assert.equal(deadline.phase(2000), 0);
});
