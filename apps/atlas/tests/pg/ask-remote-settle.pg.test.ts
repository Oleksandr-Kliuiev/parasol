import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { AskStopped } from '../../packages/ask/service.ts';
import type { AskRun } from '../../packages/ask/service.ts';
import { CLIENT, WS, addActor, postAsk } from '../support/ask-pg.ts';
import { revise } from '../support/ask-remote-pg.ts';
import { openSession } from '../support/pg-race.ts';
import { DEFAULT_COST, ScriptedProvider, currentConsent, directFlow, envelope, ledger, remoteApi, remoteBody, remoteDatabase, response }
  from '../support/ask-remote-api.ts';

// ASK-REMOTE R-B settlement, drain, post-egress revocation and physical ownership on PostgreSQL 17 (04 "Normal order" and
// "Financial settlement is allowed during drain"): settlement uses only usage validated inside the provider phase and its OWN
// 2 s clock (also after the public terminal state); a failed settlement keeps the reservation and does not suppress a valid
// current answer; a revocation after the egress COMMIT discards the answer (fixed 401/403/409) but keeps the cost; a late
// provider success is discarded; an ignored abort / never-settling transport keeps its owner. Scripted provider seam only.

const db = await remoteDatabase();
const owner = db.pgdb.owner;
const holder = await openSession(db.pgdb.ownerUrl);
const prisma = new PrismaClient({ datasourceUrl: db.pgdb.runtimeUrl });
const provider = new ScriptedProvider();
const flow = directFlow(prisma, provider.seams());
after(async () => { await prisma.$disconnect(); await holder.client.end().catch(() => undefined); await db.pgdb.drop(); });
const tokens = await Promise.all([1, 2, 3, 4, 5, 6].map(i => addActor(owner, `rem-st-${i}`, ['context:read', 'ask:remote'])));
let turn = 0;
const token = () => tokens[turn++ % tokens.length]!;
const body = async () => remoteBody('What needs attention?', null, await currentConsent(owner));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const last = async () => (await ledger(owner, WS)).attempts.at(-1)!;
const completedAudits = async () => Number((await owner.query(`SELECT count(*)::int AS n FROM "AuditEvent" WHERE "workspaceId" = $1 AND "eventType" = 'ask.completed'`, [WS])).rows[0].n);
async function drained(budget: { active: number }): Promise<void> {
  for (let i = 0; i < 500 && budget.active > 0; i += 1) await sleep(10);
  assert.equal(budget.active, 0);
}

test('drain: usage validated before the public terminal state settles AFTER it on its own clock; nothing is published', async () => {
  let run: AskRun | undefined;
  provider.next = () => { setImmediate(() => run!.end()); return response(envelope('SUMMARY')); };
  const audits = await completedAudits();
  const r = await flow.ask(token(), await body(), { onRun: x => { run = x; } });
  assert.ok(r.error instanceof AskStopped);
  await drained(flow.budget);
  const a = await last();
  assert.deepEqual([a.state, a.outcome, a.accounted], ['SETTLED', 'USAGE_VERIFIED', DEFAULT_COST]);
  assert.equal(await completedAudits(), audits, 'no completion audit after terminal');
});

test('post-egress revocation: ask:remote removed → 403, policy revised → 409; the admitted call was sent and its verified cost stays', async () => {
  const cases = [['membership', 403, 'ASK_SCOPE_DENIED'], ['policy', 409, 'ASK_SCOPE_CHANGED']] as const;
  for (const [what, status, code] of cases) {
    const actor = `rem-st-rev-${what}`;
    const revoked = await addActor(owner, actor, ['context:read', 'ask:remote']);
    const calls = provider.captures.length; const audits = await completedAudits();
    provider.next = async () => {
      if (what === 'membership') await owner.query(`UPDATE "ClientMembership" SET permissions = ARRAY['context:read'] WHERE "workspaceId" = $1 AND "actorId" = $2`, [WS, actor]);
      else await revise(owner, WS, { ownerApprovalRef: `synthetic-owner-approval-${Date.now()}` });
      return response(envelope('SUMMARY'));
    };
    const r = await flow.ask(revoked, await body());
    assert.deepEqual([r.reply!.status, r.code], [status, code], what);
    assert.equal(provider.captures.length, calls + 1);
    const a = await last();
    assert.deepEqual([a.state, a.outcome, a.accounted], ['SETTLED', 'USAGE_VERIFIED', DEFAULT_COST], `${what}: the cost of the admitted call stays`);
    assert.equal(await completedAudits(), audits, 'no answer, no completion audit');
  }
});

test('settlement failure (counter locked past its own 2 s clock): the valid answer is still published; the whole reservation stays', async () => {
  provider.next = async () => {
    await holder.client.query('BEGIN');
    await holder.client.query(`SELECT set_config('app.workspace_id', $1, true)`, [WS]);
    await holder.client.query(`SELECT 1 FROM "RemoteAskPeriodCounter" WHERE "workspaceId" = $1 AND kind = 'MONTH' FOR UPDATE`, [WS]);
    return response(envelope('SUMMARY'));
  };
  const started = Date.now();
  const r = await flow.ask(token(), await body());
  assert.equal(r.reply!.status, 200, 'a known settlement failure alone does not suppress a valid current answer');
  assert.ok(Date.now() - started < 4000);
  await holder.client.query('COMMIT');
  await drained(flow.budget);
  const a = await last();
  assert.deepEqual([a.state, a.outcome, a.accounted], ['EGRESS_COMMITTED', null, '300000'], 'no retry, no assumed refund');
});

test('provider phase ≤2 s: a late success is discarded (never parsed into a refund/answer); whole reserve retained; 503', async () => {
  provider.next = async () => { await sleep(2300); return response(envelope('SUMMARY')); };
  const r = await flow.ask(token(), await body());
  assert.deepEqual([r.reply!.status, r.code], [503, 'ASK_REMOTE_UNAVAILABLE']);
  assert.equal(provider.captures.at(-1)!.signal.aborted, true, 'the provider phase end aborted the transport');
  await sleep(400);
  const a = await last();
  assert.deepEqual([a.state, a.outcome, a.accounted], ['UNKNOWN', 'DELIVERY_UNKNOWN', '300000']);
});

test('HTTP: a never-settling transport (ignored abort) and a client disconnect keep their owners until restart; reserves retained', async () => {
  const hung = new ScriptedProvider(); hung.hang = true;
  const api = await remoteApi(db.pgdb.runtimeUrl, hung.seams());
  try {
    const consent = await currentConsent(owner);
    const r = await postAsk(api.base, token(), CLIENT, remoteBody('What needs attention?', null, consent));
    assert.deepEqual([r.status, r.json.code], [503, 'ASK_REMOTE_UNAVAILABLE']);
    await sleep(100);
    assert.equal(api.budget.active, 1, 'the owner of the never-settling physical call is held');
    assert.deepEqual([(await last()).state, (await last()).outcome], ['UNKNOWN', 'DELIVERY_UNKNOWN']);
    const controller = new AbortController();
    const pending = postAsk(api.base, token(), CLIENT, remoteBody('What needs attention?', null, consent), { signal: controller.signal }).catch(() => 'aborted');
    for (let i = 0; i < 200 && hung.captures.length < 2; i += 1) await sleep(10);
    controller.abort();
    assert.equal(await pending, 'aborted');
    for (let i = 0; i < 200 && !hung.captures[1]!.signal.aborted; i += 1) await sleep(10);
    assert.equal(hung.captures[1]!.signal.aborted, true, 'disconnect → terminal → transport aborted (courtesy)');
    await sleep(300);
    assert.equal(api.budget.active, 2, 'an ignored abort never frees the slot');
    const a = await last();
    assert.deepEqual([a.state, a.outcome, a.accounted], ['UNKNOWN', 'DELIVERY_UNKNOWN', '300000'], 'drained settlement after the disconnect');
  } finally { await api.close(); }
});
