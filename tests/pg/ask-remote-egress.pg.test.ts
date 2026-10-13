import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { AskStopped } from '../../packages/ask/service.ts';
import { CLIENT, WS, addActor } from '../support/ask-pg.ts';
import { revise } from '../support/ask-remote-pg.ts';
import { openSession, waitUntilBlocked } from '../support/pg-race.ts';
import { ScriptedProvider, currentConsent, directFlow, envelope, ledger, remoteBody, remoteDatabase, response } from '../support/ask-remote-api.ts';

// ASK-REMOTE R-B egress admission on PostgreSQL 17 (04 "Egress is a separate current authority boundary", 05 "Dispatch time
// floor"): the production orchestration and DB port over the real confined runtime role, each request with its own ORIGINAL
// budget. Real lock waits (pg_locks, never a sleep ordering) prove the floor INSIDE the reservation routine (after the
// counter waits and before RETURN), post-INSERT credential/policy checks, rollback of everything below the floor, and the
// commit boundary: only a confirmed COMMIT dispatches; unknown commit never dispatches or refunds; commit latency or a
// terminal run after COMMIT settles a proven in-process no-dispatch 0. A test-only deferred trigger slows/fails COMMIT.

const db = await remoteDatabase();
const owner = db.pgdb.owner;
const observer = await openSession(db.pgdb.ownerUrl);
const holder = await openSession(db.pgdb.ownerUrl);
const prisma = new PrismaClient({ datasourceUrl: db.pgdb.runtimeUrl });
const provider = new ScriptedProvider();
const flow = directFlow(prisma, provider.seams());
after(async () => { await prisma.$disconnect(); await observer.client.end(); await holder.client.end().catch(() => undefined); await db.pgdb.drop(); });
const tokens = [db.tokens.both, ...await Promise.all([1, 2, 3, 4, 5].map(i => addActor(owner, `rem-eg-${i}`, ['context:read', 'ask:remote'])))];
let turn = 0;
const token = () => tokens[turn++ % tokens.length]!;
const body = async (question = 'What needs attention?') => remoteBody(question, null, await currentConsent(owner));
const snapshot = async () => ledger(owner, WS);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** The holder session keeps `sql` row locks until release(); no sleep decides the ordering. */
async function hold(sql: string, params: unknown[] = []): Promise<() => Promise<void>> {
  await holder.client.query('BEGIN');
  await holder.client.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true)`, [WS, CLIENT]);
  await holder.client.query(sql, params);
  return async () => { await holder.client.query('COMMIT'); };
}
/** The financial drain after a terminal run is held by its owner: wait until every owner of this flow is released. */
async function drained(): Promise<void> {
  for (let i = 0; i < 400 && flow.budget.active > 0; i += 1) await sleep(10);
  assert.equal(flow.budget.active, 0, 'every owner released after its physical work settled');
}
/**
 * Test-only INSERT probe: an AFTER INSERT trigger (owner's SECURITY DEFINER function, EXECUTE not PUBLIC) advances a sequence,
 * and sequence advances survive ROLLBACK. It distinguishes "the attempt INSERT never executed" (the routine's pre-INSERT
 * floor) from "executed, then rolled back" (a later check), which identical 504 replies cannot.
 */
async function insertProbe(): Promise<{ count(): Promise<number>; drop(): Promise<void> }> {
  await owner.query(`CREATE SEQUENCE public.rb_test_insert_seq`);
  await owner.query(`CREATE FUNCTION public.rb_test_insert_probe() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    BEGIN PERFORM nextval('public.rb_test_insert_seq'); RETURN NULL; END $$`);
  await owner.query(`REVOKE ALL ON FUNCTION public.rb_test_insert_probe() FROM PUBLIC`);
  await owner.query(`CREATE TRIGGER rb_test_insert_probe AFTER INSERT ON "RemoteAskAttempt" FOR EACH ROW EXECUTE FUNCTION public.rb_test_insert_probe()`);
  return {
    count: async () => Number((await owner.query(`SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS n FROM public.rb_test_insert_seq`)).rows[0].n),
    drop: async () => {
      await owner.query(`DROP TRIGGER rb_test_insert_probe ON "RemoteAskAttempt"`);
      await owner.query(`DROP FUNCTION public.rb_test_insert_probe()`);
      await owner.query(`DROP SEQUENCE public.rb_test_insert_seq`);
    }
  };
}
const MONTH_LOCK = `SELECT 1 FROM "RemoteAskPeriodCounter" WHERE "workspaceId" = $1 AND kind = 'MONTH' FOR UPDATE`;

test('baseline success creates the UTC counters; original remaining <4500 ms before egress → 504, no transaction, nothing reserved', async () => {
  provider.next = () => response(envelope('SUMMARY'));
  const ok = await flow.ask(token(), await body());
  assert.equal(ok.reply!.status, 200);
  const before = await snapshot(); const calls = provider.captures.length;
  const r = await flow.ask(token(), await body(), { totalMs: 4400 });
  assert.deepEqual([r.reply!.status, r.code], [504, 'ASK_DEADLINE']);
  assert.deepEqual(await snapshot(), before); assert.equal(provider.captures.length, calls);
});

test('floor INSIDE the routine: a MONTH counter lock wait past the floor → AR011 → 504; the attempt INSERT never executed; nothing sent', async () => {
  const before = await snapshot(); const calls = provider.captures.length;
  const probe = await insertProbe();
  const release = await hold(MONTH_LOCK, [WS]);
  const started = Date.now();
  const pending = flow.ask(token(), await body(), { totalMs: 4500 + 700 });
  await waitUntilBlocked(observer.client, null);
  await sleep(Math.max(0, 900 - (Date.now() - started)));
  await release();
  const r = await pending;
  assert.deepEqual([r.reply!.status, r.code], [504, 'ASK_DEADLINE']);
  assert.ok(Date.now() - started < 2000, 'refused by the floor, not by the 2 s phase end');
  assert.equal(await probe.count(), 0, 'refused BEFORE the attempt INSERT (not merely rolled back after it)');
  await probe.drop();
  assert.deepEqual(await snapshot(), before, 'no attempt INSERT and no counter increment survived');
  assert.equal(provider.captures.length, calls);
});

test('the same real lock wait released BEFORE the floor is admitted: the wait happened, the request succeeds', async () => {
  const release = await hold(MONTH_LOCK, [WS]);
  provider.next = () => response(envelope('SUMMARY'));
  const pending = flow.ask(token(), await body(), { totalMs: 4500 + 2500 });
  await waitUntilBlocked(observer.client, null);
  await sleep(200);
  await release();
  const r = await pending;
  assert.equal(r.reply!.status, 200);
  assert.equal((await snapshot()).attempts.at(-1)!.outcome, 'USAGE_VERIFIED');
});

test('pre-RETURN floor: an FK key-share wait between the pre-INSERT check and the INSERT is caught before the routine returns', async () => {
  const before = await snapshot(); const calls = provider.captures.length;
  const actor = 'rem-eg-fk';
  const fkToken = await addActor(owner, actor, ['context:read', 'ask:remote']);
  const probe = await insertProbe();
  const release = await hold(`SELECT 1 FROM "Actor" WHERE "workspaceId" = $1 AND id = $2 FOR UPDATE`, [WS, actor]);
  const started = Date.now();
  const pending = flow.ask(fkToken, await body(), { totalMs: 4500 + 700 });
  await waitUntilBlocked(observer.client, null);
  await sleep(Math.max(0, 900 - (Date.now() - started)));
  await release();
  const r = await pending;
  assert.deepEqual([r.reply!.status, r.code], [504, 'ASK_DEADLINE']);
  assert.equal(await probe.count(), 1, 'the INSERT executed after the wait and was rolled back by the pre-RETURN floor');
  await probe.drop();
  assert.deepEqual(await snapshot(), before); assert.equal(provider.captures.length, calls);
});

test('post-INSERT: a credential that expires during the reservation wait (DB clock) → 401 and full rollback', async () => {
  const before = await snapshot(); const calls = provider.captures.length;
  const expiring = await addActor(owner, 'rem-eg-expire', ['context:read', 'ask:remote'], { expiresAt: new Date(Date.now() + 1200).toISOString() });
  const release = await hold(MONTH_LOCK, [WS]);
  const pending = flow.ask(expiring, await body(), { totalMs: 8000 });
  await waitUntilBlocked(observer.client, null);
  await sleep(1300);
  await release();
  const r = await pending;
  assert.deepEqual([r.reply!.status, r.code], [401, 'ASK_AUTHENTICATION_FAILED']);
  assert.deepEqual(await snapshot(), before, 'the attempt INSERT and counter increments rolled back');
  assert.equal(provider.captures.length, calls);
});

test('linearization: a token revocation (an owner write that bumps the shared fence) waits for the egress COMMIT; the admitted call is sent, its cost stays, no answer', async () => {
  const actor = 'rem-eg-revoke';
  const revoked = await addActor(owner, actor, ['context:read', 'ask:remote']);
  const calls = provider.captures.length;
  const release = await hold(MONTH_LOCK, [WS]);
  provider.next = () => response(envelope('SUMMARY'));
  const pending = flow.ask(revoked, await body(), { totalMs: 8000 });
  await waitUntilBlocked(observer.client, null);
  const revocation = owner.query(`UPDATE "ApiToken" SET "revokedAt" = now() WHERE id = $1`, [`token-${actor}`]);
  await waitUntilBlocked(observer.client, null);
  await release();
  await revocation;
  const r = await pending;
  assert.equal(provider.captures.length, calls + 1, 'the committed admission is the egress linearization point');
  assert.deepEqual([r.reply!.status, r.code], [401, 'ASK_AUTHENTICATION_FAILED'], 'the final phase refuses publication');
  const a = (await snapshot()).attempts.at(-1)!;
  assert.deepEqual([a.state, a.outcome], ['SETTLED', 'USAGE_VERIFIED'], 'sent data and its cost are not retracted');
});

test('policy expiry during the reservation wait (DB clock) → 503 ASK_REMOTE_NOT_ADMITTED; nothing reserved', async () => {
  await revise(owner, WS, { expiresAt: new Date(Date.now() + 1500).toISOString() });
  const before = await snapshot(); const calls = provider.captures.length;
  const release = await hold(MONTH_LOCK, [WS]);
  const pending = flow.ask(token(), await body(), { totalMs: 8000 });
  await waitUntilBlocked(observer.client, null);
  await sleep(1600);
  await release();
  const r = await pending;
  assert.deepEqual([r.reply!.status, r.code], [503, 'ASK_REMOTE_NOT_ADMITTED']);
  assert.deepEqual(await snapshot(), before); assert.equal(provider.captures.length, calls);
  await revise(owner, WS, { expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString() });
});

/** Test-only deferred constraint trigger on the attempt table: sleeps (and optionally fails) AT COMMIT. EXECUTE not PUBLIC. */
async function slowCommit(seconds: number, fail = false): Promise<() => Promise<void>> {
  await owner.query(`CREATE FUNCTION public.rb_test_slow_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(${seconds});
    ${fail ? `RAISE EXCEPTION 'RB_TEST_COMMIT_FAILED';` : ''} RETURN NULL; END $$`);
  await owner.query(`REVOKE ALL ON FUNCTION public.rb_test_slow_commit() FROM PUBLIC`);
  await owner.query(`CREATE CONSTRAINT TRIGGER rb_test_slow_commit AFTER INSERT ON "RemoteAskAttempt" DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION public.rb_test_slow_commit()`);
  return async () => {
    await owner.query(`DROP TRIGGER rb_test_slow_commit ON "RemoteAskAttempt"`);
    await owner.query(`DROP FUNCTION public.rb_test_slow_commit()`);
  };
}

test('commit latency drops the original time below 4500 ms → no dispatch; proven in-process no-dispatch settles 0; 504', async () => {
  const drop = await slowCommit(0.6);
  try {
    const calls = provider.captures.length; const before = await snapshot();
    const r = await flow.ask(token(), await body(), { totalMs: 4500 + 450 });
    assert.deepEqual([r.reply!.status, r.code], [504, 'ASK_DEADLINE']);
    const after = await snapshot();
    assert.equal(after.attempts.length, before.attempts.length + 1, 'the attempt committed');
    assert.deepEqual([after.attempts.at(-1)!.state, after.attempts.at(-1)!.outcome, after.attempts.at(-1)!.accounted], ['SETTLED', 'NO_DISPATCH', '0']);
    assert.deepEqual(after.counters, before.counters, 'the reservation was released in the ORIGINAL periods');
    assert.equal(provider.captures.length, calls, 'never dispatched');
  } finally { await drop(); }
});

test('terminal run during COMMIT → no dispatch, financial-only drain settles 0, nothing published', async () => {
  const drop = await slowCommit(0.4);
  try {
    const calls = provider.captures.length; const audits = (await owner.query(`SELECT count(*)::int AS n FROM "AuditEvent" WHERE "workspaceId" = $1`, [WS])).rows[0].n;
    const r = await flow.ask(token(), await body(), { onRun: run => { setTimeout(() => run.end(), 200); } });
    assert.ok(r.error instanceof AskStopped);
    await drained();
    const a = (await snapshot()).attempts.at(-1)!;
    assert.deepEqual([a.state, a.outcome, a.accounted], ['SETTLED', 'NO_DISPATCH', '0']);
    assert.equal(provider.captures.length, calls);
    assert.equal((await owner.query(`SELECT count(*)::int AS n FROM "AuditEvent" WHERE "workspaceId" = $1`, [WS])).rows[0].n, audits, 'no completion audit');
  } finally { await drop(); }
});

test('unknown COMMIT (slower than the phase, or failing at COMMIT): never dispatches, never infers no-dispatch, retains any reservation', async () => {
  for (const [seconds, fail] of [[2.6, false], [0, true]] as const) {
    const drop = await slowCommit(seconds, fail);
    try {
      const calls = provider.captures.length; const before = await snapshot();
      const r = await flow.ask(token(), await body(), { totalMs: 8000 });
      assert.deepEqual([r.reply!.status, r.code], [503, 'ASK_REMOTE_UNAVAILABLE'], `${seconds}s fail=${fail}`);
      await sleep(fail ? 50 : 1000);
      const after = await snapshot();
      assert.equal(provider.captures.length, calls, 'no dispatch without a confirmed commit');
      if (after.attempts.length > before.attempts.length) {
        const a = after.attempts.at(-1)!;
        assert.deepEqual([a.state, a.outcome, a.accounted], ['EGRESS_COMMITTED', null, '300000'], 'a late commit keeps the whole reservation');
      } else assert.deepEqual(after, before, 'a failed commit reserved nothing');
      assert.ok(after.attempts.every(a => a.outcome !== 'NO_DISPATCH' || before.attempts.some(b => b.id === a.id)), 'no new NO_DISPATCH refund');
    } finally { await drop(); }
  }
});
