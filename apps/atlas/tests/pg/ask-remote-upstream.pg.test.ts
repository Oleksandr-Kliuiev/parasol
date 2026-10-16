import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT, WS, addActor, postAsk } from '../support/ask-pg.ts';
import { fenceOf, policyRow, revise } from '../support/ask-remote-pg.ts';
import { DEFAULT_COST, ScriptedProvider, currentConsent, envelope, ledger, remoteApi, remoteBody, remoteDatabase, response } from '../support/ask-remote-api.ts';

// ASK-REMOTE R-B upstream failures on PostgreSQL 17 (03 "Wire profile", 04 fault circuit/money): every non-200 is
// ASK_REMOTE_UNAVAILABLE (never browser auth/OFF), 401/403 and model/tier/usage mismatch retain the whole reservation and
// durably pause the policy (fence-first, after phase2, owner-held), malformed/overflow/unknown retain it without pause,
// refusal/invalid content settle the verified cost and never answer, no retry or MOCK/UNSUPPORTED fallback, and the real
// day cap refuses with 429 once retained unknown reservations reach it. Scripted in-process provider; no network.

const db = await remoteDatabase();
const owner = db.pgdb.owner;
const provider = new ScriptedProvider();
const api = await remoteApi(db.pgdb.runtimeUrl, provider.seams());
after(async () => { await api.close(); await db.pgdb.drop(); });
// Several synthetic actors with both permissions keep every request inside the 10/60 s rolling window of one actor.
const actors = [db.tokens.both, ...await Promise.all([1, 2, 3].map(i => addActor(owner, `rem-up-${i}`, ['context:read', 'ask:remote'])))];
let turn = 0;
const ask = async () => postAsk(api.base, actors[turn++ % actors.length]!, CLIENT, remoteBody('What needs attention?', null, await currentConsent(owner)));
const lastAttempt = async () => (await ledger(owner, WS)).attempts.at(-1)!;
const lastAudit = async () => (await owner.query(`SELECT "eventType", metadata FROM "AuditEvent" WHERE "workspaceId" = $1 ORDER BY "recordedAt" DESC, id DESC LIMIT 1`, [WS])).rows[0];
async function until(check: () => Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error(`timed out: ${label}`);
}

test('refusal / invalid content: 503 ASK_REMOTE_INVALID, verified cost settled, never an answer, policy stays active', async () => {
  for (const patch of [(e: any) => { e.choices[0].message.refusal = 'synthetic refusal'; }, (e: any) => { e.choices[0].finish_reason = 'length'; },
    (e: any) => { e.choices[0].message.content = '{"version":"AskRemoteIntentV1","intent":"SUMMARY","intent":"ENTITY"}'; }]) {
    provider.next = () => response(envelope('SUMMARY', patch));
    const r = await ask();
    assert.deepEqual([r.status, r.json.contractVersion, r.json.code], [503, 'AskErrorV1', 'ASK_REMOTE_INVALID']);
    const a = await lastAttempt();
    assert.deepEqual([a.state, a.outcome, a.accounted], ['SETTLED', 'USAGE_VERIFIED', DEFAULT_COST]);
    assert.deepEqual((await lastAudit()).metadata, { provider: 'openai', ruleVersion: 'ask-remote-intent-v1', itemCount: (await lastAudit()).metadata.itemCount,
      outcome: 'FAILED', safeErrorCode: 'ASK_REMOTE_INVALID' });
  }
  assert.equal((await policyRow(owner, WS))!.state, 'ACTIVE');
});

test('5xx/429/malformed: 503 without pause; the whole 300000 reservation is retained; exactly one call, no retry', async () => {
  for (const [result, code, outcome] of [[response(envelope(), 500), 'ASK_REMOTE_UNAVAILABLE', 'UPSTREAM_REJECTED'],
    [response(envelope(), 429), 'ASK_REMOTE_UNAVAILABLE', 'UPSTREAM_REJECTED'],
    [response(Buffer.from(envelope().toString().replace('"model":"gpt-6-luna"', '"model":"gpt-6-luna","model":"gpt-6-luna"'))), 'ASK_REMOTE_INVALID', 'DELIVERY_UNKNOWN']] as const) {
    const before = provider.captures.length;
    provider.next = () => result;
    const r = await ask();
    assert.deepEqual([r.status, r.json.code], [503, code]);
    assert.equal(provider.captures.length, before + 1, 'no retry');
    const a = await lastAttempt();
    assert.deepEqual([a.state, a.outcome, a.accounted], ['UNKNOWN', outcome, '300000']);
    assert.equal((await policyRow(owner, WS))!.state, 'ACTIVE');
  }
});

test('401/403, model or tier mismatch, invalid usage: fault code, reserve retained, durable fence-first pause, reactivation reopens', async () => {
  const faults = [[response(envelope(), 401), 'ASK_REMOTE_UNAVAILABLE', 'UPSTREAM_REJECTED', 'UPSTREAM_AUTH'],
    [response(envelope('SUMMARY', e => { e.model = 'gpt-6-luna-2026-10-01'; })), 'ASK_REMOTE_MODEL_MISMATCH', 'MODEL_MISMATCH', 'MODEL_MISMATCH'],
    [response(envelope('SUMMARY', e => { e.usage.prompt_tokens_details.cached_tokens = 5; })), 'ASK_REMOTE_USAGE_INVALID', 'USAGE_INVALID', 'USAGE_INVALID']] as const;
  for (const [index, [result, code, outcome, reason]] of faults.entries()) {
    const before = await policyRow(owner, WS);
    const fence = await fenceOf(owner, WS);
    provider.next = () => result;
    const r = await ask();
    assert.deepEqual([r.status, r.json.code], [503, code], 'never browser 401/403/404/OFF');
    const a = await lastAttempt();
    assert.deepEqual([a.state, a.outcome, a.accounted], ['UNKNOWN', outcome, '300000']);
    await until(async () => (await policyRow(owner, WS))!.state === 'PAUSED', 'durable pause');
    const paused = (await policyRow(owner, WS))!;
    assert.deepEqual([paused.stateReason, paused.policyVersion], [reason, String(BigInt(before!.policyVersion) + 1n)]);
    assert.equal(await fenceOf(owner, WS), fence + 1, 'the pause advanced the shared workspace fence');
    const blocked = await ask();
    assert.deepEqual([blocked.status, blocked.json.code], [503, 'ASK_REMOTE_NOT_ADMITTED']);
    await revise(owner, WS, { state: 'ACTIVE' });
    provider.next = () => response(envelope('SUMMARY'));
    const ok = await ask();
    // A later owner revision reopens the local circuit. The last one passes phase1 (circuit included) and reaches the real
    // day cap at egress: three 5xx/malformed and three fault reservations are retained in full (6 × 300000 + settled costs).
    if (index < faults.length - 1) assert.equal(ok.status, 200, 'reopened');
    else assert.deepEqual([ok.status, ok.json.code], [429, 'ASK_REMOTE_BUDGET'], 'reopened, then refused by the durable day cap');
  }
});

test('the real day cap: retained unknown reservations exhaust it → 429 ASK_REMOTE_BUDGET audited, nothing sent', async () => {
  const day = (await ledger(owner, WS)).counters.find(c => c.kind === 'DAY')!;
  assert.ok(BigInt(day.charged) + 300000n > 2000000n, 'six retained unknown reservations plus settled costs are within 300000 of the cap');
  const before = provider.captures.length;
  const r = await ask();
  assert.deepEqual([r.status, r.json.code], [429, 'ASK_REMOTE_BUDGET']);
  assert.equal(provider.captures.length, before);
  assert.equal((await lastAudit()).metadata.safeErrorCode, 'ASK_REMOTE_BUDGET');
  assert.deepEqual((await ledger(owner, WS)).counters.find(c => c.kind === 'DAY'), day, 'a refused reservation charges nothing');
});
