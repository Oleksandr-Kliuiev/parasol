import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AskPhase, phaseSql } from '../packages/ask/phase.ts';
import { AskFailure } from '../packages/ask/contracts.ts';

// ASK-A rc2 R1/R2 + rc3 R2a (pure part): one absolute phase end shared by every ACTUAL statement (statement_timeout
// re-bounded to the time LEFT, never reset), run/phase checks before and after each await — also at the internal awaits of
// a reused multi-statement helper such as currentToken — and no statement after a stop. Physical PostgreSQL behavior:
// tests/pg/ask-physical.pg.test.ts and tests/pg/ask-helper-boundary.pg.test.ts.

function harness(ms = 2000) {
  let now = 0;
  let terminal = false;
  const log: string[] = [];
  const effects: Record<string, () => void | Promise<void>> = {};
  const tx = {
    $executeRawUnsafe: async (sql: string, ...args: string[]) => { log.push(sql.includes('statement_timeout') ? `timeout ${args[0]}` : `set ${args[1]}`); await effects[`set ${args[1]}`]?.(); return 1; },
    $queryRaw: async (label: string) => { log.push(label); await effects[label]?.(); return [label]; },
    actor: { findUnique: async (query: { id: string }) => { log.push(`actor ${query.id}`); await effects.actor?.(); return { id: query.id }; } }
  };
  const run = { check: () => { if (terminal) throw new Error('STOPPED'); } };
  const phase = new AskPhase(run, ms, () => now);
  const sql = phaseSql(tx as never, phase);
  return { sql, phase, log, effects, advance: (n: number) => { now += n; }, end: () => { terminal = true; } };
}
/** Shape of the accepted shared currentToken: three separately awaited statements on the SAME transaction object. */
async function tokenHelper(t: any) {
  await t.$executeRawUnsafe('SELECT set_config($1, $2, true)', 'app.token_hash', 'digest');
  const rows = await t.$queryRaw('token select');
  await t.$executeRawUnsafe('SELECT set_config($1, $2, true)', 'app.token_hash', '');
  return rows;
}
const deadline = (e: unknown) => e instanceof AskFailure && e.code === 'ASK_DEADLINE';
const stopped = (e: unknown) => e instanceof Error && e.message === 'STOPPED';

test('sequential statements share one absolute phase budget: each actual statement gets only the time left', async () => {
  const h = harness();
  h.effects.token = () => h.advance(1150);
  h.effects.actor = () => h.advance(600);
  await h.sql(t => (t as any).$queryRaw('token'));
  await h.sql(t => (t as any).actor.findUnique({ id: 'a' }));
  await h.sql(t => (t as any).$queryRaw('membership'));
  assert.deepEqual(h.log, ['timeout 2000ms', 'token', 'timeout 850ms', 'actor a', 'timeout 250ms', 'membership']);
  assert.equal(h.phase.remaining(), 250);
});

test('R2a: a reused multi-statement helper is bounded per ACTUAL statement, not as one unit', async () => {
  const h = harness();
  h.effects['set digest'] = () => h.advance(700);
  await h.sql(t => tokenHelper(t));
  assert.deepEqual(h.log, ['timeout 2000ms', 'set digest', 'timeout 1300ms', 'token select', 'timeout 1300ms', 'set ']);
});

test('R2a: terminal or deadline during the digest-setting await → the token SELECT never starts', async () => {
  for (const [variant, effect, expected] of [
    ['terminal', (h: ReturnType<typeof harness>) => h.end(), stopped],
    ['original/phase deadline', (h: ReturnType<typeof harness>) => h.advance(2001), deadline],
    ['phase stopped by its timer', (h: ReturnType<typeof harness>) => h.phase.stop(), deadline]] as const) {
    const h = harness();
    h.effects['set digest'] = () => effect(h);
    await assert.rejects(h.sql(t => tokenHelper(t)), expected, variant);
    assert.deepEqual(h.log, ['timeout 2000ms', 'set digest'], `${variant}: no later statement`);
  }
});

test('a statement ending past the phase end is discarded; nothing starts after the end or a stop', async () => {
  const h = harness();
  h.effects.late = () => h.advance(2001);
  await assert.rejects(h.sql(t => (t as any).$queryRaw('late')), deadline);
  await assert.rejects(h.sql(t => (t as any).$queryRaw('must not run')), deadline);
  const s = harness();
  s.phase.stop();
  await assert.rejects(s.sql(t => (t as any).$queryRaw('must not run')), deadline);
  assert.throws(() => s.sql.check(), deadline);
  assert.deepEqual([...h.log.filter(l => l === 'must not run'), ...s.log], []);
});

test('a terminal run stops at the next boundary: after an in-flight statement and before any other', async () => {
  const h = harness();
  h.effects.first = () => h.end();
  await assert.rejects(h.sql(t => (t as any).$queryRaw('first')), stopped);
  await assert.rejects(h.sql(t => (t as any).$queryRaw('must not run')), stopped);
  assert.deepEqual(h.log, ['timeout 2000ms', 'first']);
});
