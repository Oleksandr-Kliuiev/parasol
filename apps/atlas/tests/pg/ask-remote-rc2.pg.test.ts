import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { PrismaClient } from '@prisma/client';
import type { AskRun } from '../../packages/ask/service.ts';
import { createDirectTransport } from '../../packages/ask/remote/transport.ts';
import type { Transport } from '../../packages/ask/remote/transport.ts';
import { WS, addActor } from '../support/ask-pg.ts';
import { fenceOf, policyRow, revise } from '../support/ask-remote-pg.ts';
import { KEY, SECRET_REF, currentConsent, directFlow, ledger, remoteBody, remoteDatabase } from '../support/ask-remote-api.ts';
import { fakeHttp } from '../support/ask-remote-http-fake.ts';
import type { Script } from '../support/ask-remote-http-fake.ts';

// ASK-REMOTE R-B RC2 on PostgreSQL 17 (Astra RC1 R1/R2): the production orchestration and DB port over the real confined
// runtime role and real reservation/settlement/pause routines, with the ACTUAL direct transport driven by the in-process
// https.request stand-in (no socket/TLS/network). R2: a 401/403 with an oversized or stalled body still settles
// UPSTREAM_REJECTED (whole reserve), answers 503 and durably pauses the policy; a 5xx error body keeps it active. R1: a
// resolver that leaves exactly 4500 ms dispatches; one that leaves 4499 ms never reaches the wire, answers 504 and the
// committed attempt settles as proven no-dispatch 0 in its original periods.

const db = await remoteDatabase();
const owner = db.pgdb.owner;
const prisma = new PrismaClient({ datasourceUrl: db.pgdb.runtimeUrl });
let current: Transport = () => { throw new Error('no transport scripted'); };
let calls = 0;
let resolveHook: () => void = () => undefined;
const flow = directFlow(prisma, { resolveSecret: ref => { resolveHook(); return ref === SECRET_REF ? KEY : null; },
  transport: (bytes, key, signal) => { calls += 1; return current(bytes, key, signal); } });
after(async () => { await prisma.$disconnect(); await db.pgdb.drop(); });
const tokens = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(i => addActor(owner, `rem-rc2-${i}`, ['context:read', 'ask:remote'])));
let turn = 0;
const ask = async (o: Parameters<typeof flow.ask>[2] = {}) => flow.ask(tokens[turn++ % tokens.length]!, remoteBody('What needs attention?', null, await currentConsent(owner)), o);
const last = async () => (await ledger(owner, WS)).attempts.at(-1)!;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) { if (await check()) return; await sleep(25); }
  throw new Error(`timed out: ${label}`);
}
const script = (s: Script) => { const http = fakeHttp(s); current = createDirectTransport(http.fn); return http.h; };

test('R2: 401 oversized / 403 stalled bodies → 503 UNAVAILABLE, UPSTREAM_REJECTED 300000, durable UPSTREAM_AUTH pause, owner drained', async () => {
  for (const s of [{ status: 401, body: 'oversized' }, { status: 403, body: 'stalled' }] as Script[]) {
    const fence = await fenceOf(owner, WS);
    const h = script(s);
    const r = await ask();
    assert.deepEqual([r.reply!.status, r.code], [503, 'ASK_REMOTE_UNAVAILABLE'], `${s.status}/${s.body}`);
    const a = await last();
    assert.deepEqual([a.state, a.outcome, a.accounted], ['UNKNOWN', 'UPSTREAM_REJECTED', '300000']);
    await until(async () => (await policyRow(owner, WS))!.state === 'PAUSED', 'durable pause');
    assert.equal((await policyRow(owner, WS))!.stateReason, 'UPSTREAM_AUTH');
    assert.equal(await fenceOf(owner, WS), fence + 1);
    assert.equal(h.calls, 1, 'no retry');
    await until(async () => flow.budget.active === 0, 'owner drained after request and response closed');
    assert.ok(h.requestClosed && h.responseClosed);
    await revise(owner, WS, { state: 'ACTIVE' });
  }
});

test('R2 controls: 500 with an error body keeps the policy active (whole reserve); a 200 through the direct transport answers', async () => {
  script({ status: 500, body: 'error', type: 'text/html' });
  const r = await ask();
  assert.deepEqual([r.reply!.status, r.code], [503, 'ASK_REMOTE_UNAVAILABLE']);
  assert.deepEqual([(await last()).state, (await last()).outcome, (await last()).accounted], ['UNKNOWN', 'UPSTREAM_REJECTED', '300000']);
  await sleep(100);
  assert.equal((await policyRow(owner, WS))!.state, 'ACTIVE');
  script({ status: 200, body: 'valid' });
  const ok = await ask();
  assert.equal(ok.reply!.status, 200);
  assert.deepEqual([(await last()).state, (await last()).outcome], ['SETTLED', 'USAGE_VERIFIED']);
});

/** The original deadline clock freezes inside the secret resolver so that exactly `left` ms of the ORIGINAL budget remain. */
function frozenAt(left: number) {
  let frozen: number | null = null; let run: AskRun | undefined;
  resolveHook = () => { frozen = performance.now() + run!.deadline.remaining() - left; };
  return { clock: () => frozen ?? performance.now(), onRun: (x: AskRun) => { run = x; } };
}

test('R1: exactly 4500 ms left after secret resolution dispatches; 4499 never reaches the wire → 504, proven no-dispatch 0', async () => {
  script({ status: 200, body: 'valid' });
  const before = calls;
  const at4500 = await ask(frozenAt(4500));
  assert.equal(at4500.reply!.status, 200);
  assert.equal(calls, before + 1);
  const counters = (await ledger(owner, WS)).counters;
  const at4499 = await ask(frozenAt(4499));
  resolveHook = () => undefined;
  assert.deepEqual([at4499.reply!.status, at4499.code], [504, 'ASK_DEADLINE']);
  assert.equal(calls, before + 1, 'no wire below the floor');
  await until(async () => flow.budget.active === 0, 'drained');
  const a = await last();
  assert.deepEqual([a.state, a.outcome, a.accounted], ['SETTLED', 'NO_DISPATCH', '0']);
  assert.deepEqual((await ledger(owner, WS)).counters, counters, 'the reservation is released in its ORIGINAL periods');
});
