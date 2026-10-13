import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { mockPlan } from '../../packages/ask/planner.ts';
import { CLIENT, WS, addActor, askBody, askDatabase, count, getCapability, inProcessApi, postAsk, rawHttp } from '../support/ask-pg.ts';
import type { AskDb, InProcessApi } from '../support/ask-pg.ts';

// ASK-A Q6 on actual HTTP + real PostgreSQL 17: provisional owners reserved at ingress on BOTH routes (>4 mixed GET/POST,
// valid/invalid credentials) behind a real authentication lock barrier, disconnects that keep owners until the underlying
// transaction settles, four ignored-abort planners holding all capacity past their public 504, a never-settling planner,
// the original deadline starting before the body, and rolling admission timing. The boundary's budget is observed directly.

let db: AskDb; let api: InProcessApi;
let gate: Promise<void> = Promise.resolve(); let openGate: () => void = () => undefined;
const closeGate = () => { gate = new Promise(resolve => { openGate = resolve; }); };
const planner = {
  plan: async (input: any, _signal: AbortSignal) => {
    if (input.question === 'never settles') return new Promise(() => undefined);
    if (input.question === 'gated') await gate; // ignores the abort signal on purpose
    return mockPlan(input);
  }
};
const tokens: string[] = [];
before(async () => {
  db = await askDatabase();
  for (let i = 0; i < 10; i += 1) tokens.push(await addActor(db.pgdb.owner, `q6-${i}`, ['context:read']));
  api = await inProcessApi(db.pgdb.runtimeUrl, planner);
});
after(async () => { openGate(); await api?.close(); await db?.pgdb.drop(); });

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await check()) return; await sleep(10); }
  assert.fail(`timed out waiting for ${what}`);
}
const waitingOnLock = async () => Number((await db.pgdb.owner.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = $1 AND wait_event_type = 'Lock'`,
  [db.pgdb.runtimeRole])).rows[0].n);
const askAudits = () => count(db.pgdb.owner, 'AuditEvent', `"eventType" LIKE 'ask.%'`);
const UNKNOWN = 'atl_wellformed_but_unknown_000000000000000000';

test('provisional owners: >4 mixed GET/POST behind a real auth lock — 4 held, the rest 429 at ingress; disconnect keeps owners until the transaction settles', async () => {
  const blocker = new pg.Client({ connectionString: db.pgdb.ownerUrl });
  await blocker.connect();
  const releasesBefore = api.budget.releases; const auditsBefore = await askAudits();
  const aborts = [new AbortController(), new AbortController()];
  try {
    await blocker.query('BEGIN');
    await blocker.query(`LOCK TABLE "ApiToken" IN ACCESS EXCLUSIVE MODE`);
    const held = [
      postAsk(api.base, tokens[0]!, CLIENT, askBody('What needs attention?'), { signal: aborts[0]!.signal }).catch(() => 'aborted'),
      getCapability(api.base, UNKNOWN),
      postAsk(api.base, UNKNOWN, CLIENT, { not: 'even valid' }),
      postAsk(api.base, tokens[1]!, CLIENT, askBody('What needs attention?'), { signal: aborts[1]!.signal }).catch(() => 'aborted')];
    await waitFor(async () => api.budget.active === 4 && await waitingOnLock() === 4, 'four provisional owners blocked in private authentication');
    const refused = await Promise.all([getCapability(api.base, tokens[2]!), postAsk(api.base, tokens[3]!, CLIENT, askBody('What needs attention?')),
      postAsk(api.base, null, CLIENT, askBody('x')), getCapability(api.base, null)]);
    for (const r of refused) { assert.equal(r.status, 429); assert.equal(r.json.code, 'ASK_BUSY'); assert.equal(r.headers.get('x-atlas-correlation-id'), r.json.correlationId); }
    aborts.forEach(a => a.abort());
    await sleep(100);
    assert.equal(api.budget.active, 4, 'disconnected requests keep their owners while their authentication transaction is pending');
    assert.equal((await getCapability(api.base, tokens[4]!)).status, 429, 'no replacement owner');
    await blocker.query('COMMIT');
    const results = await Promise.all(held);
    assert.deepEqual(results.map(r => typeof r === 'string' ? r : r.status), ['aborted', 401, 401, 'aborted']);
    await waitFor(() => api.budget.active === 0, 'every owner released after settlement');
    assert.equal(api.budget.releases - releasesBefore, 4, 'exactly one release per reserved owner');
    assert.equal(await askAudits(), auditsBefore, 'no phase1, read or audit after the terminal state');
    assert.equal(api.budget.admissions(WS, 'q6-0'), 0); assert.equal(api.budget.admissions(WS, 'q6-1'), 0);
  } finally { await blocker.end(); }
  assert.equal((await postAsk(api.base, tokens[0]!, CLIENT, askBody('What needs attention?'))).status, 200, 'recovered');
});

test('four ignored-abort planners: public 504 + ask.failed at 2 s, owners retained until the planners settle; same and new actors 429; exact recovery', async () => {
  closeGate();
  const auditsBefore = await askAudits(); const releasesBefore = api.budget.releases;
  const started = Date.now();
  const first = postAsk(api.base, tokens[5]!, CLIENT, askBody('gated'));
  await waitFor(() => api.budget.active === 1 && api.budget.admissions(WS, 'q6-5') === 1, 'first planner running');
  const sameActor = await getCapability(api.base, tokens[5]!);
  assert.equal(sameActor.status, 429, 'one bound owner per actor, a capability too');
  assert.equal((await getCapability(api.base, tokens[9]!)).status, 200, 'another actor still has capacity; capability is never charged');
  assert.equal(api.budget.admissions(WS, 'q6-9'), 0);
  const four = [first, ...[6, 7, 8].map(i => postAsk(api.base, tokens[i]!, CLIENT, askBody('gated')))];
  await waitFor(() => api.budget.active === 4, 'four planners running');
  assert.equal((await postAsk(api.base, tokens[9]!, CLIENT, askBody('What needs attention?'))).status, 429, 'global capacity');
  const replies = await Promise.all(four);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 1900 && elapsed < 5000, `bounded by the 2 s planner phase, not by the ignored abort (${elapsed} ms)`);
  for (const r of replies) { assert.equal(r.status, 504); assert.equal(r.json.code, 'ASK_DEADLINE'); }
  assert.equal(await askAudits(), auditsBefore + 4, 'each admitted planner failure was audited while its planner drains');
  await sleep(200);
  assert.equal(api.budget.active, 4, 'still draining: capacity stays occupied after the public 504');
  assert.equal((await getCapability(api.base, tokens[9]!)).status, 429, 'no replacement while draining');
  openGate();
  await waitFor(() => api.budget.active === 0, 'planners settled → owners released');
  // Four planners, the refused same-actor capability (provisional owner refused at binding) and the other actor's capability;
  // the two 429s at full global capacity reserved nothing. Each owner was released exactly once.
  assert.equal(api.budget.releases - releasesBefore, 6);
  assert.equal(await askAudits(), auditsBefore + 4, 'late planner results start no phase or audit');
  assert.equal((await postAsk(api.base, tokens[9]!, CLIENT, askBody('What needs attention?'))).status, 200, 'recovered');
});

test('a never-settling planner keeps its slot until restart; the remaining three slots keep working', async () => {
  const r = await postAsk(api.base, tokens[4]!, CLIENT, askBody('never settles'));
  assert.equal(r.status, 504);
  await sleep(100);
  assert.equal(api.budget.active, 1);
  const parallel = await Promise.all([2, 3, 9].map(i => postAsk(api.base, tokens[i]!, CLIENT, askBody('What needs attention?'))));
  assert.deepEqual(parallel.map(p => p.status), [200, 200, 200]);
  assert.equal(api.budget.active, 1, 'never released, never replaced');
});

test('the original 8 s deadline starts at ingress: a slow body consumes it; the planner bound shrinks; exhaustion → 504 with no final transaction', async () => {
  closeGate();
  const auditsBefore = await askAudits();
  const body = JSON.stringify(askBody('gated'));
  const head = `POST /clients/${CLIENT}/ask HTTP/1.1\r\nHost: 127.0.0.1:${api.port}\r\nAuthorization: Bearer ${tokens[7]}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
  const started = Date.now();
  const { connect } = await import('node:net');
  const reply = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const socket = connect(api.port, '127.0.0.1', () => {
      socket.write(head + body.slice(0, 10));
      setTimeout(() => socket.write(body.slice(10)), 6300);
    });
    let data = '';
    socket.on('data', c => { data += String(c); });
    socket.on('error', reject);
    socket.on('close', () => resolve({ status: Number(data.split(' ')[1]), body: data.split('\r\n\r\n')[1] ?? '' }));
  });
  const elapsed = Date.now() - started;
  assert.equal(reply.status, 504); assert.equal(JSON.parse(reply.body).code, 'ASK_DEADLINE');
  assert.ok(elapsed >= 7900 && elapsed < 9000, `published at the original deadline (${elapsed} ms), not 2 s after the planner started`);
  assert.equal(await askAudits(), auditsBefore, 'an exhausted original budget starts no final transaction (no ask.failed)');
  openGate();
  await waitFor(() => api.budget.active === 1, 'only the never-settling slot remains');
  const stalled = await rawHttp(api.port, `POST /clients/${CLIENT}/ask HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${tokens[8]}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"contr`);
  assert.equal(stalled.status, 504); assert.match(stalled.head, /Connection: close/i);
  assert.equal(JSON.parse(stalled.body).code, 'ASK_DEADLINE');
  await waitFor(() => api.budget.active === 1, 'the stalled upload released its owner');
});

test('rolling admission: denied/invalid/capability never charge; source failure consumes; 10 per 60 s then 429 at binding', async () => {
  const token = await addActor(db.pgdb.owner, 'q6-rolling', ['context:read']);
  assert.equal((await postAsk(api.base, token, 'other-client', askBody('What needs attention?'))).status, 403);
  assert.equal((await postAsk(api.base, token, CLIENT, { bad: true })).status, 400);
  assert.equal((await getCapability(api.base, token)).status, 200);
  assert.equal(api.budget.admissions(WS, 'q6-rolling'), 0);
  await db.pgdb.owner.query(`UPDATE "RawEvent" SET normalized = normalized || '{"summary":5}' WHERE id = 'ev-ask-low'`);
  try { assert.equal((await postAsk(api.base, token, CLIENT, askBody('What needs attention?'))).status, 503); }
  finally { await db.pgdb.owner.query(`UPDATE "RawEvent" SET normalized = normalized || '{"summary":"Low disk warning (synthetic)"}' WHERE id = 'ev-ask-low'`); }
  assert.equal(api.budget.admissions(WS, 'q6-rolling'), 1, 'charged after positive phase1 authority, before the source read');
  for (let i = 0; i < 9; i += 1) assert.equal((await postAsk(api.base, token, CLIENT, askBody('What needs attention?'))).status, 200);
  const capped = await postAsk(api.base, token, CLIENT, askBody('What needs attention?'));
  assert.equal(capped.status, 429); assert.equal(capped.json.code, 'ASK_BUSY');
  assert.equal((await getCapability(api.base, token)).status, 200, 'capability is never limited by the question window');
  assert.equal(api.budget.admissions(WS, 'q6-rolling'), 10);
});

test('HEAD/OPTIONS on Ask paths are an ordinary synchronous 404: no owner, no authentication, no controller', async () => {
  const releases = api.budget.releases;
  for (const [method, path] of [['HEAD', '/ask/capabilities'], ['OPTIONS', '/ask/capabilities'], ['OPTIONS', `/clients/${CLIENT}/ask`], ['HEAD', `/CLIENTS/${CLIENT}/ASK/`]]) {
    const r = await rawHttp(api.port, `${method} ${path} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${tokens[0]}\r\nConnection: close\r\n\r\n`);
    assert.equal(r.status, 404, `${method} ${path}`);
    assert.doesNotMatch(r.head, /x-atlas-correlation-id|allow:/i);
  }
  assert.equal(api.budget.releases, releases, 'nothing was reserved');
});
