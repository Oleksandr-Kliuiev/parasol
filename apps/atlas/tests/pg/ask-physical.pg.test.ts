import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PrismaClient } from '@prisma/client';
import { dbAskPort } from '../../packages/ask/authority.ts';
import { AskBudget } from '../../packages/ask/budget.ts';
import { AskFailure } from '../../packages/ask/contracts.ts';
import { bearerCredential } from '../../packages/ask/credential.ts';
import { mockPlan } from '../../packages/ask/planner.ts';
import { AskRun } from '../../packages/ask/service.ts';
import type { AskAdmission, AskIdentity } from '../../packages/ask/service.ts';
import { CLIENT, WS, addActor, askBody, askDatabase, count, inProcessApi, postAsk } from '../support/ask-pg.ts';
import type { AskDb, InProcessApi } from '../support/ask-pg.ts';

// ASK-A rc2 R1/R2 physical work on real PostgreSQL 17, confined runtime role. R1: two sequential lock waits inside ONE
// private phase (authentication, phase1, phase2) share one absolute min(2 s, remaining) end — the caller fails with
// ASK_DEADLINE by then — while the SAME owner is held until PostgreSQL work has actually drained (sampled invariant), then
// released exactly once and capacity recovers. R2: after an HTTP disconnect a blocked statement completes, but no later
// Actor/Entity/audit statement, charge or phase starts; the owner drains and is released exactly once.

let db: AskDb; let prisma: PrismaClient; let api: InProcessApi;
const tokens: string[] = [];
let gate: Promise<void> = Promise.resolve(); let openGate: () => void = () => undefined; let reached = false;
const planner = { plan: async (input: any) => { if (input.question === 'gated') { reached = true; await gate; } return mockPlan(input); } };
before(async () => {
  db = await askDatabase();
  for (let i = 0; i < 8; i += 1) tokens.push(await addActor(db.pgdb.owner, `phys-${i}`, ['context:read']));
  prisma = new PrismaClient({ datasourceUrl: db.pgdb.runtimeUrl });
  api = await inProcessApi(db.pgdb.runtimeUrl, planner);
});
after(async () => { openGate(); await api?.close(); await prisma?.$disconnect(); await db?.pgdb.drop(); });

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await check()) return; await sleep(5); }
  assert.fail(`timed out waiting for ${what}`);
}
/** Runtime-role statements currently waiting on a lock whose text names `table`. */
const waitingOn = async (table: string) => Number((await db.pgdb.owner.query(`SELECT count(*)::int AS n FROM pg_stat_activity
  WHERE usename = $1 AND wait_event_type = 'Lock' AND query LIKE $2`, [db.pgdb.runtimeRole, `%${table}%`])).rows[0].n);
/** Runtime-role backends still inside a transaction or a statement (the physical work an owner covers). */
const busyBackends = async () => Number((await db.pgdb.owner.query(`SELECT count(*)::int AS n FROM pg_stat_activity
  WHERE usename = $1 AND pid <> pg_backend_pid() AND state IN ('active', 'idle in transaction', 'idle in transaction (aborted)')`, [db.pgdb.runtimeRole])).rows[0].n);
async function lockSession(statement: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: db.pgdb.ownerUrl });
  await client.connect();
  await client.query('BEGIN');
  await client.query(statement);
  return client;
}
const LOCK = (table: string) => `LOCK TABLE "${table}" IN ACCESS EXCLUSIVE MODE`;
const FENCE = `SELECT version FROM "ActionAuthorityFence" WHERE "workspaceId" = '${WS}' FOR UPDATE`;
const CLIENT_ROW = `SELECT 1 FROM "Client" WHERE "workspaceId" = '${WS}' AND id = '${CLIENT}' FOR UPDATE`;
const release = async (c: pg.Client) => { await c.query('ROLLBACK').catch(() => undefined); await c.end().catch(() => undefined); };

/**
 * Runs one bounded phase while the first lock is released after ~1.15 s and the second stays held. Asserts: the caller
 * fails with ASK_DEADLINE before 2.3 s from phase start (not ~3.2 s as with a per-statement timeout); from then until the
 * owner is released, every sample with the owner released also shows no busy runtime backend; exactly one release.
 */
async function sequentialPhase(label: string, first: { lock: string; waits: string }, second: { lock: string; waits: string },
  phase: (run: AskRun) => Promise<unknown>, setup?: (run: AskRun) => Promise<void>) {
  const budget = new AskBudget();
  const owner = budget.reserve()!;
  const run = new AskRun(owner);
  if (setup) await setup(run);
  const a = await lockSession(first.lock); const b = await lockSession(second.lock);
  let failedAt = -1; let code = 'NONE';
  const started = performance.now();
  const work = phase(run).then(() => { code = 'SUCCESS'; }, (e: unknown) => { code = e instanceof AskFailure ? e.code : String(e); })
    .finally(() => { failedAt = performance.now() - started; });
  owner.hold(work); owner.finish();
  const samples: { t: number; held: boolean; busy: number }[] = [];
  try {
    await waitFor(async () => await waitingOn(first.waits) === 1, `${label}: first lock wait`);
    await sleep(1150);
    await a.query('ROLLBACK');
    await waitFor(async () => await waitingOn(second.waits) === 1, `${label}: second lock wait in the same phase`);
    await work;
    assert.equal(code, 'ASK_DEADLINE', label);
    assert.ok(failedAt < 2300, `${label}: caller saw the phase end after ${Math.round(failedAt)} ms (bound min(2 s, remaining))`);
    const until = performance.now() + 3000;
    while (performance.now() < until) {
      const held = !owner.released; const busy = await busyBackends();
      samples.push({ t: Math.round(performance.now() - started), held, busy });
      if (!held) break;
      await sleep(2);
    }
    const last = samples.at(-1)!;
    assert.equal(last.held, false, `${label}: the owner is released once the work settled`);
    assert.equal(last.busy, 0, `${label}: released only after PostgreSQL work drained`);
    assert.ok(last.t < 2400, `${label}: the physical work itself ended within the phase budget (released at ${last.t} ms), not per-statement`);
    assert.equal(await waitingOn(second.waits), 0, `${label}: the blocked statement was cancelled within the phase budget`);
    assert.equal(budget.releases, 1); assert.equal(budget.active, 0);
    return { failedAt: Math.round(failedAt), samples: samples.length, releasedAt: last.t };
  } finally { await release(a); await release(b); }
}

test('R1 authentication: ApiToken then Actor lock waits share one 2 s phase; owner held until drain; exact recovery', async () => {
  const port = dbAskPort(prisma);
  const result = await sequentialPhase('authenticate', { lock: LOCK('ApiToken'), waits: '"ApiToken"' }, { lock: LOCK('Actor'), waits: '"Actor"' },
    run => port.authenticate(run, bearerCredential(`Bearer ${tokens[0]}`)!));
  console.log(JSON.stringify({ event: 'r1-authenticate', ...result }));
  const budget = new AskBudget(); const owner = budget.reserve()!;
  assert.deepEqual(await port.authenticate(new AskRun(owner), bearerCredential(`Bearer ${tokens[0]}`)!), { workspaceId: WS, actorId: 'phys-0' }, 'recovered');
});

test('R1 phase1: fence then source lock waits share one 2 s phase; owner held until drain', async () => {
  const port = dbAskPort(prisma);
  let identity!: AskIdentity;
  const result = await sequentialPhase('admit', { lock: FENCE, waits: 'ActionAuthorityFence' }, { lock: LOCK('Observation'), waits: '"Observation"' },
    run => port.admit(run, identity, bearerCredential(`Bearer ${tokens[1]}`)!, CLIENT, null),
    async run => { identity = (await port.authenticate(run, bearerCredential(`Bearer ${tokens[1]}`)!))!; assert.equal(run.owner.bind(WS, identity.actorId, true), 'BOUND'); });
  console.log(JSON.stringify({ event: 'r1-admit', ...result }));
});

test('R1 phase2: fence then final-audit FK lock waits share one 2 s phase; no audit row; owner held until drain', async () => {
  const port = dbAskPort(prisma);
  const credential = bearerCredential(`Bearer ${tokens[2]}`)!;
  let identity!: AskIdentity; let admission!: AskAdmission;
  const audits = await count(db.pgdb.owner, 'AuditEvent', `"eventType" LIKE 'ask.%'`);
  const result = await sequentialPhase('publish', { lock: FENCE, waits: 'ActionAuthorityFence' }, { lock: CLIENT_ROW, waits: '"AuditEvent"' },
    run => port.publish(run, identity, credential, admission, { event: 'completed', status: 'ANSWER', itemCount: 1 }),
    async run => {
      identity = (await port.authenticate(run, credential))!; assert.equal(run.owner.bind(WS, identity.actorId, true), 'BOUND');
      admission = await port.admit(run, identity, credential, CLIENT, null);
    });
  console.log(JSON.stringify({ event: 'r1-publish', ...result }));
  assert.equal(await count(db.pgdb.owner, 'AuditEvent', `"eventType" LIKE 'ask.%'`), audits, 'the audit INSERT never committed');
});

/** HTTP disconnect while `first` blocks; `second` is separately blocked so any later statement on it would be visible. */
async function disconnectBarrier(label: string, first: string, firstWaits: string, second: string, secondWaits: string, token: string, question = 'What needs attention?') {
  const a = await lockSession(first); const b = await lockSession(second);
  const abort = new AbortController();
  const releases = api.budget.releases;
  const audits = await count(db.pgdb.owner, 'AuditEvent', `"eventType" LIKE 'ask.%'`);
  const request = postAsk(api.base, token, CLIENT, askBody(question), { signal: abort.signal }).catch(() => 'aborted');
  let laterStatement = false;
  try {
    await waitFor(async () => await waitingOn(firstWaits) === 1, `${label}: first blocked statement`);
    abort.abort();
    assert.equal(await request, 'aborted');
    await sleep(80);
    assert.equal(api.budget.active, 1, `${label}: the owner is still held after the disconnect`);
    await a.query('ROLLBACK');
    const end = Date.now() + 700;
    while (Date.now() < end) { if (await waitingOn(secondWaits) > 0) { laterStatement = true; break; } await sleep(5); }
    assert.equal(laterStatement, false, `${label}: no new ${secondWaits} statement after the terminal state`);
    await waitFor(() => api.budget.active === 0, `${label}: drain and release`);
    assert.equal(api.budget.releases - releases, 1, `${label}: released exactly once`);
    assert.equal(await count(db.pgdb.owner, 'AuditEvent', `"eventType" LIKE 'ask.%'`), audits, `${label}: no audit after terminal`);
    assert.equal(await busyBackends(), 0, `${label}: transaction rolled back`);
  } finally { await release(a); await release(b); await request; }
}

test('R2 source read: disconnect while the Observation page blocks → no later Entity/resource read, charge, audit or phase', async () => {
  await disconnectBarrier('phase1 source', LOCK('Observation'), '"Observation"', LOCK('Entity'), '"Entity"', tokens[3]!);
  assert.equal(api.budget.admissions(WS, 'phys-3'), 1, 'the single admission charged before the read; no later charge');
});

test('R2 private authentication: disconnect while the token lookup blocks → no later Actor statement', async () => {
  await disconnectBarrier('authenticate', LOCK('ApiToken'), '"ApiToken"', LOCK('Actor'), '"Actor"', tokens[4]!);
  assert.equal(api.budget.admissions(WS, 'phys-4'), 0);
});

test('R2 phase2: disconnect while phase2 waits on the fence → no final audit INSERT, no audit row', async () => {
  gate = new Promise(resolve => { openGate = resolve; }); reached = false;
  const b = await lockSession(CLIENT_ROW);
  let a: pg.Client | undefined;
  const abort = new AbortController();
  const releases = api.budget.releases;
  const audits = await count(db.pgdb.owner, 'AuditEvent', `"eventType" LIKE 'ask.%'`);
  const request = postAsk(api.base, tokens[5]!, CLIENT, askBody('gated'), { signal: abort.signal }).catch(() => 'aborted');
  let laterInsert = false;
  try {
    await waitFor(() => reached, 'planner reached (phase1 committed)');
    a = await lockSession(FENCE);
    openGate();
    await waitFor(async () => await waitingOn('ActionAuthorityFence') === 1, 'phase2 waiting on the fence');
    abort.abort(); await request; await sleep(80);
    assert.equal(api.budget.active, 1);
    await a!.query('ROLLBACK');
    const end = Date.now() + 700;
    while (Date.now() < end) { if (await waitingOn('"AuditEvent"') > 0) { laterInsert = true; break; } await sleep(5); }
    assert.equal(laterInsert, false, 'no final audit INSERT after the terminal state');
    await waitFor(() => api.budget.active === 0, 'drain and release');
    assert.equal(api.budget.releases - releases, 1);
    assert.equal(await count(db.pgdb.owner, 'AuditEvent', `"eventType" LIKE 'ask.%'`), audits);
  } finally { openGate(); if (a) await release(a); await release(b); await request; }
  assert.equal((await postAsk(api.base, tokens[6]!, CLIENT, askBody('What needs attention?'))).status, 200, 'recovered');
});
