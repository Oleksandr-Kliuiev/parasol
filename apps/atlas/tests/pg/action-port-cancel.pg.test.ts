import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { CREATE_DEADLINE_MS } from '../../packages/actions/contracts.ts';
import { mockActionPorts } from '../../packages/actions/mock-port.ts';
import type { PortCall } from '../../packages/actions/mock-port.ts';
import { dispatchReserved } from '../../packages/actions/execution.ts';
import { createTestDatabase, singleConnection } from '../support/pg-harness.ts';
import { CA, WA, addActionFixtures, privateDir, runtimeClient, scoped } from '../support/action-fixtures.ts';
import { actionFlow, addApprovalActors, settle } from '../support/action-approval.ts';
import { addExecutionActors, freshCall, observeExec, scriptedPorts } from '../support/action-exec.ts';

// Stage 3 S3-C RC2 repair R1 on PostgreSQL 17: the REAL built-in synthetic port (no test wrapper around its cancellation)
// honors the invocation's AbortSignal/deadline across pool acquisition and blocked SQL. The pool is a one-connection Prisma
// pool whose connection the test holds; SQL is blocked by an owner table lock. Cancelled work never commits, the promise
// settles only after the transaction ended (no write left running), no fresh window starts after waiting, and the dispatcher
// still reports a possible invocation as OUTCOME_UNKNOWN without any retry. Waits are bounded by the fixed deadlines.
const pgdb = await createTestDatabase();
const db = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
const runtime = await runtimeClient(pgdb.runtimeUrl);
const files = await privateDir();
const closers: (() => Promise<unknown>)[] = [];
after(async () => { for (const c of closers) await c().catch(() => undefined); await runtime.end(); await db.$disconnect(); await files.remove(); await pgdb.drop(); });
await addActionFixtures(pgdb.owner);
await addApprovalActors(pgdb.owner);
await addExecutionActors(pgdb.owner);
const binding = { workspaceId: WA, clientId: CA, connectionId: 'atera-a' };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** Holds the one pool connection of `client` for `seconds` (PrismaPromise is lazy: `.then` starts it now). */
const holdPool = (client: PrismaClient, seconds: number) => client.$executeRaw`SELECT pg_sleep(${seconds})`.then(() => undefined);
const single = () => { const client = new PrismaClient({ datasourceUrl: singleConnection(pgdb.runtimeUrl) }); closers.push(() => client.$disconnect()); return client; };
/** A call whose signal aborts exactly at its deadline (as the dispatcher's does), optionally earlier. */
function call(ms: number, abortAt = ms): PortCall {
  const controller = new AbortController();
  const deadline = performance.now() + ms;
  setTimeout(() => controller.abort(), abortAt);
  return { signal: controller.signal, deadline };
}
const ticket = (title: string) => ({ customerKey: 'cust-cancel', markedTitle: title, description: 'synthetic cancel probe', nonce: randomUUID() });
const rows = async (title: string) => (await scoped<{ n: number }>(runtime, WA, CA, `SELECT count(*)::int AS n FROM "ActionMockTicket" WHERE "markedTitle" = $1`, [title]))[0]!.n;
/** Owner holds a table lock until released (blocks INSERT for SHARE, every access for ACCESS EXCLUSIVE). */
async function lockTable(mode: 'SHARE' | 'ACCESS EXCLUSIVE') {
  await pgdb.owner.query('BEGIN');
  await pgdb.owner.query(`LOCK TABLE "ActionMockTicket" IN ${mode} MODE`);
  return { release: () => pgdb.owner.query('COMMIT') };
}
const timed = async <T>(p: Promise<T>) => { const t0 = performance.now(); const outcome = await settle(p); return { outcome, ms: performance.now() - t0 }; };

test('R1: an abort during pool wait stops the built-in create and read — no transaction starts later, nothing is committed', async () => {
  const pooled = single();
  const port = mockActionPorts(pooled).ticketPort(binding);
  const title = `cancel-pool-${randomUUID()}`;
  const hold = holdPool(pooled, 4); // the only pool connection, for 4 s
  await sleep(200);
  const create = await timed(port.createOne(ticket(title), call(1_500)));
  const read = await timed(port.readOne({ connectionId: 'atera-a', ticketId: randomUUID() }, call(1_000)));
  assert.equal(create.outcome, 'ACTION_OUTCOME_UNKNOWN');
  assert.equal(read.outcome, 'ACTION_VERIFICATION_FAILED');
  assert.ok(create.ms < 2_500 && read.ms < 2_000, 'settled at the original deadline, not after the pool freed');
  await hold;
  await sleep(1_000); // the pool is free again: a late-starting transaction would commit now
  assert.equal(await rows(title), 0, 'no effect after cancellation');
  assert.equal(typeof await port.createOne(ticket(`${title}-ok`), freshCall()), 'string', 'the same port still works with a live call');
});

test('R1: SQL blocked on a lock is cancelled at the deadline (rolled back, never committed); an earlier abort prevents COMMIT', async () => {
  const port = mockActionPorts(db).ticketPort(binding);
  // Blocked INSERT: settles at the 2 s deadline; the lock is released after it — the row must never appear
  const blocked = `cancel-sql-${randomUUID()}`;
  const share = await lockTable('SHARE');
  const create = await timed(port.createOne(ticket(blocked), call(2_000)));
  assert.equal(create.outcome, 'ACTION_OUTCOME_UNKNOWN');
  assert.ok(create.ms >= 1_900 && create.ms < 3_000, `cancelled at the deadline (${Math.round(create.ms)} ms)`);
  await share.release();
  await sleep(500);
  assert.equal(await rows(blocked), 0);
  // Abort at 1 s while the INSERT is blocked; the lock is released at 1.5 s (INSERT completes) — the pre-COMMIT check rolls back
  const early = `cancel-early-${randomUUID()}`;
  const share2 = await lockTable('SHARE');
  const pending = timed(port.createOne(ticket(early), call(3_000, 1_000)));
  await sleep(1_500);
  await share2.release();
  const outcome = await pending;
  assert.equal(outcome.outcome, 'ACTION_OUTCOME_UNKNOWN');
  assert.ok(outcome.ms < 2_500, 'settled once the transaction rolled back, before the deadline');
  assert.equal(await rows(early), 0, 'no new effect once cancellation could still prevent the commit');
  // Blocked read (ACCESS EXCLUSIVE) is cancelled at its deadline too
  const exclusive = await lockTable('ACCESS EXCLUSIVE');
  const read = await timed(port.readOne({ connectionId: 'atera-a', ticketId: randomUUID() }, call(1_500)));
  await exclusive.release();
  assert.equal(read.outcome, 'ACTION_VERIFICATION_FAILED');
  assert.ok(read.ms >= 1_400 && read.ms < 2_500);
  // A pool wait inside the window is no cancellation: the create still commits within its original deadline
  const pooled = single();
  const hold = holdPool(pooled, 1);
  await sleep(100);
  const ok = `cancel-ok-${randomUUID()}`;
  assert.equal(typeof await mockActionPorts(pooled).ticketPort(binding).createOne(ticket(ok), call(5_000)), 'string');
  await hold;
  assert.equal(await rows(ok), 1);
});

test('R1/C2: the actual dispatcher with the built-in port — 3 s pool wait plus a lock until 16 s: OUTCOME_UNKNOWN at 15 s, no commit, no retry', async () => {
  const flow = actionFlow(db, files);
  const r = await flow.approved();
  const { permit, expected } = await flow.reserve(r);
  const pooled = single();
  const { ports, calls } = scriptedPorts(pooled); // counting only: the built-in port receives the dispatcher's own call
  const share = await lockTable('SHARE');
  const hold = holdPool(pooled, 3);
  await sleep(100);
  const started = performance.now();
  const release = sleep(16_000).then(() => share.release());
  const dispatched = await dispatchReserved(pooled, ports, permit, expected, { lateGraceMs: 3_000 });
  const elapsed = performance.now() - started;
  assert.deepEqual([dispatched.summary.state, dispatched.code, dispatched.created, calls.create], ['OUTCOME_UNKNOWN', 'ACTION_OUTCOME_UNKNOWN', false, 1]);
  assert.ok(elapsed >= CREATE_DEADLINE_MS - 100 && elapsed < CREATE_DEADLINE_MS + 3_000, `deadline honored (${Math.round(elapsed)} ms)`);
  assert.equal(await dispatched.late, null, 'the cancelled invocation produced no late result');
  await hold; await release;
  await sleep(500);
  const see = observeExec(runtime);
  assert.deepEqual([(await see.tickets(r.requestId)).length, (await see.request(r.requestId))!.state, calls.create], [0, 'OUTCOME_UNKNOWN', 1],
    'the blocked insert was rolled back: no synthetic effect, still UNKNOWN (never NOT_DISPATCHED), never retried');
});
