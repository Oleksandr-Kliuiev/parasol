import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PAUSE_SQL, RESERVE_SQL, SETTLE_SQL, ledgerErrorCode, pauseParams, reserveParams, settleParams } from '../../packages/ask/remote/ledger-sql.ts';
import type { SettlementOutcome } from '../../packages/ask/remote/budget.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { inFlight, openSession, rollbackQuietly, waitUntilBlocked } from '../support/pg-race.ts';
import type { Session } from '../support/pg-race.ts';
import { PRICE, activate, connectAs, ledger, policyRow, reserveOnce, revise, sqlstate } from '../support/ask-remote-pg.ts';

// ASK-REMOTE R-A atomic billing under real concurrency on PostgreSQL 17 (05 "Atomic billing"): two sessions with
// deterministic lock-wait orderings (pg_locks, never sleeps) for the absent-counter insert, the last day dollar with commit
// and rollback winners, fence-first pause before/after admission; separate OS processes racing for the last month dollar
// through the production egress transaction; a mixed reserve/settle storm without deadlock or invariant breach; and
// settlement never waiting for an open policy revision (it takes no fence). One synthetic project per scenario.
const pgdb = await createTestDatabase();
const owner = pgdb.owner;
const sessions: Session[] = [];
const observer = await connectAs(pgdb.ownerUrl);
after(async () => {
  for (const s of sessions) await s.client.end().catch(() => undefined);
  await observer.end().catch(() => undefined);
  await pgdb.drop();
});
const session = async () => { const s = await openSession(pgdb.runtimeUrl); sessions.push(s); return s; };
const total = async (ws: string, kind: string) => (await ledger(owner, ws)).counters.filter(c => c.kind === kind).reduce((a, c) => a + BigInt(c.charged), 0n);
interface Project { ws: string; client: string; actor: string; consent: { admissionId: string; policyVersion: string } }
let projects = 0;
/** A fresh synthetic workspace/client/actor with its own ACTIVE policy (trusted routines only). */
async function project(dayCap = '2000000', monthCap = '10000000'): Promise<Project> {
  const n = ++projects; const ws = `rem-race-${n}`; const client = `rem-race-client-${n}`; const actor = `rem-race-actor-${n}`;
  await owner.query(`INSERT INTO "Workspace" (id, name) VALUES ($1, 'Race workspace')`, [ws]);
  await owner.query(`INSERT INTO "Client" ("workspaceId", id, name) VALUES ($1, $2, 'C')`, [ws, client]);
  await owner.query(`INSERT INTO "Actor" ("workspaceId", id, "displayName") VALUES ($1, $2, 'Synthetic actor')`, [ws, actor]);
  const p = await activate(owner, ws, [client], { dayCap, monthCap });
  return { ws, client, actor, consent: { admissionId: p.admissionId, policyVersion: p.policyVersion } };
}
const begin = async (s: Session, p: Project) => {
  await s.client.query('BEGIN');
  await s.client.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true)`, [p.ws, p.client]);
};
/** One egress admission in `s` (scope → fence FOR SHARE → reserve) left OPEN; the caller commits or rolls back. */
async function reserveOpen(s: Session, p: Project, consent = p.consent): Promise<string> {
  await begin(s, p);
  const fence = (await s.client.query(`SELECT version FROM public."ActionAuthorityFence" WHERE "workspaceId" = $1 FOR SHARE`, [p.ws])).rows[0].version as number;
  return (await s.client.query(RESERVE_SQL, reserveParams({ workspaceId: p.ws, clientId: p.client, actorId: p.actor, admissionId: consent.admissionId,
    policyVersion: consent.policyVersion, fenceVersion: fence, priceRevision: PRICE, correlationId: randomUUID() }))).rows[0].attemptId as string;
}
const rows = async (p: Project) => (await ledger(owner, p.ws)).counters.map(c => [c.kind, c.charged]);

test('absent counters: concurrent first reservations serialize on the unique key (winner rolls back, then winner commits)', async () => {
  const [a, b] = [await session(), await session()];
  const p1 = await project();
  await reserveOpen(a, p1);
  const waiter = inFlight(() => reserveOpen(b, p1));
  await waitUntilBlocked(observer, b.pid);
  await a.client.query('ROLLBACK');
  await waiter.result(); await b.client.query('COMMIT');
  assert.deepEqual(await rows(p1), [['DAY', '300000'], ['MONTH', '300000']], 'the waiter created the rows itself; rollback charged nothing');
  const p2 = await project();
  await reserveOpen(a, p2);
  const second = inFlight(() => reserveOpen(b, p2));
  await waitUntilBlocked(observer, b.pid);
  await a.client.query('COMMIT');
  await second.result(); await b.client.query('COMMIT');
  assert.deepEqual(await rows(p2), [['DAY', '600000'], ['MONTH', '600000']], 'exactly one row per period, both charges');
  assert.equal((await ledger(owner, p2.ws)).attempts.length, 2);
});

test('last day dollar between two sessions: the committed winner takes it, the waiter is refused; a rolled-back winner admits the waiter', async () => {
  const [a, b] = [await session(), await session()];
  const p = await project('600000');
  await reserveOnce(a.client, p.ws, p.client, p.consent, { actor: p.actor });
  await reserveOpen(a, p);
  const waiter = inFlight(() => reserveOpen(b, p));
  await waitUntilBlocked(observer, b.pid);
  await a.client.query('COMMIT');
  assert.equal(await sqlstate(waiter.result()), 'AR003');
  await rollbackQuietly(b);
  assert.equal(await total(p.ws, 'DAY'), 600_000n, 'exactly the cap');
  const q = await project('300000');
  await reserveOpen(a, q);
  const admitted = inFlight(() => reserveOpen(b, q));
  await waitUntilBlocked(observer, b.pid);
  await a.client.query('ROLLBACK');
  await admitted.result(); await b.client.query('COMMIT');
  assert.equal(await total(q.ws, 'DAY'), 300_000n);
  assert.equal((await ledger(owner, q.ws)).attempts.length, 1);
});

test('last month dollar across five OS processes through the production egress transaction: exactly three admitted', async () => {
  const p = await project('2000000', '900000');
  const barrier = String(Math.floor(Math.random() * 1e9) + 1);
  await observer.query('SELECT pg_advisory_lock($1::bigint)', [barrier]);
  const child = fileURLToPath(new URL('../support/ask-remote-child.ts', import.meta.url));
  const runs = Array.from({ length: 5 }, () => new Promise<{ code?: string; ok?: boolean }>((resolve, reject) => {
    const proc = spawn(process.execPath, ['--experimental-strip-types', child, p.ws, p.client, p.actor, p.consent.admissionId, p.consent.policyVersion, PRICE, barrier],
      { cwd: fileURLToPath(new URL('../../', import.meta.url)), env: { ...process.env, ATLAS_RA_CHILD_URL: pgdb.runtimeUrl }, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = ''; proc.stdout.on('data', d => { out += String(d); });
    proc.on('error', reject);
    proc.on('close', () => { try { resolve(JSON.parse(out.trim())); } catch (error) { reject(error); } });
  }));
  try {
    const deadline = Date.now() + 20_000;
    while ((await observer.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database =
        (SELECT oid FROM pg_database WHERE datname = current_database())`)).rows[0].n < 5) {
      if (Date.now() > deadline) throw new Error('children never reached the barrier');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  } finally { await observer.query('SELECT pg_advisory_unlock($1::bigint)', [barrier]); }
  const results = await Promise.all(runs);
  assert.equal(results.filter(r => r.ok).length, 3, JSON.stringify(results));
  assert.deepEqual(results.filter(r => !r.ok).map(r => r.code), ['ASK_REMOTE_BUDGET', 'ASK_REMOTE_BUDGET']);
  assert.equal(await total(p.ws, 'MONTH'), 900_000n);
  assert.equal((await ledger(owner, p.ws)).attempts.length, 3);
});

test('mixed reserve/settle storm on separate sessions: no deadlock, caps never exceeded, counters equal the sum of accounted', async () => {
  const p = await project('2000000', '2000000');
  const seed = await session();
  const committed = [];
  for (let i = 0; i < 4; i++) committed.push(await reserveOnce(seed.client, p.ws, p.client, p.consent, { actor: p.actor }));
  const outcomes: SettlementOutcome[] = ['USAGE_VERIFIED', 'NO_DISPATCH', 'DELIVERY_UNKNOWN', 'USAGE_VERIFIED'];
  const sessionsFor = await Promise.all(Array.from({ length: 10 }, () => session()));
  const code = (error: unknown) => ledgerErrorCode(error) ?? String((error as { code?: string }).code);
  const ops = [
    ...committed.map((a, i) => async () => {
      const s = sessionsFor[i]!; await begin(s, p);
      try {
        await s.client.query(SETTLE_SQL, settleParams({ workspaceId: p.ws, clientId: p.client, attemptId: a.attemptId, correlationId: a.correlationId,
          outcome: outcomes[i]!, usage: outcomes[i] === 'USAGE_VERIFIED' ? { promptTokens: 500 + i, completionTokens: 20 } : null }));
        await s.client.query('COMMIT'); return 'settled';
      } catch (error) { await rollbackQuietly(s); return code(error); }
    }),
    ...Array.from({ length: 6 }, (_, i) => async () => {
      const s = sessionsFor[4 + i]!;
      try { await reserveOpen(s, p); await s.client.query('COMMIT'); return 'reserved'; } catch (error) { await rollbackQuietly(s); return code(error); }
    }),
  ];
  const results = await Promise.all(ops.map(op => op()));
  assert.ok(results.every(r => ['settled', 'reserved', 'ASK_REMOTE_BUDGET'].includes(r)), JSON.stringify(results));
  assert.equal(results.filter(r => r === 'settled').length, 4, 'every settlement committed (no deadlock victim)');
  assert.ok(results.filter(r => r === 'reserved').length >= 2, 'at least the capacity left before any refund');
  const l = await ledger(owner, p.ws);
  const accounted = l.attempts.reduce((x, a) => x + BigInt(a.accounted!), 0n);
  assert.equal(await total(p.ws, 'DAY'), accounted); assert.equal(await total(p.ws, 'MONTH'), accounted);
  assert.ok(accounted <= 2_000_000n);
  assert.equal(l.attempts.length, 4 + results.filter(r => r === 'reserved').length);
});

test('fence-first pause: an admission holding the shared fence finishes first; a pause holding the fence makes the waiter see a stale tuple', async () => {
  const [a, b] = [await session(), await session()];
  const p = await project();
  const admitted = await reserveOpen(a, p);
  const pause = inFlight(async () => { await begin(b, p);
    const v = (await b.client.query(PAUSE_SQL, pauseParams({ workspaceId: p.ws, admissionId: p.consent.admissionId, reason: 'MODEL_MISMATCH' }))).rows[0].policyVersion as string;
    await b.client.query('COMMIT'); return v; });
  await waitUntilBlocked(observer, b.pid);
  await a.client.query('COMMIT');
  const paused = await pause.result();
  assert.equal(BigInt(paused), BigInt(p.consent.policyVersion) + 1n);
  assert.ok((await ledger(owner, p.ws)).attempts.some(x => x.id === admitted && x.state === 'EGRESS_COMMITTED'), 'admitted before the pause: liability kept');
  const reactivated = await revise(owner, p.ws, { state: 'ACTIVE' });
  // Pause first, holding the fence FOR UPDATE: the admission waits at its fence lock, then sees the advanced version.
  await begin(b, p);
  await b.client.query(PAUSE_SQL, pauseParams({ workspaceId: p.ws, admissionId: p.consent.admissionId, reason: 'UPSTREAM_AUTH' }));
  const late = inFlight(() => reserveOpen(a, p, { ...p.consent, policyVersion: reactivated }));
  await waitUntilBlocked(observer, a.pid);
  await b.client.query('COMMIT');
  assert.equal(await sqlstate(late.result()), 'AR002');
  await rollbackQuietly(a);
  assert.equal((await ledger(owner, p.ws)).attempts.length, 1, 'nothing reserved after the pause');
});

test('settlement takes no fence/policy lock: it completes while an owner revision holds them; refunds stay on the original counters', async () => {
  const a = await session();
  const p = await project();
  const r = await reserveOnce(a.client, p.ws, p.client, p.consent, { actor: p.actor });
  const cur = (await policyRow(owner, p.ws))!;
  await owner.query('BEGIN');
  await owner.query(`SELECT set_config('app.workspace_id', $1, true)`, [p.ws]);
  await owner.query(`SELECT public.atlas_ask_remote_policy_revise($1, $2::uuid, $3::bigint, 'ACTIVE', $4, $5, $6, $7, $8, $9, $10, 1000000, $11, $12::timestamptz)`,
    [p.ws, cur.admissionId, cur.policyVersion, cur.secretRef, cur.ownerApprovalRef, cur.retentionAttestationRef, cur.priceRevision, cur.promptSha256,
      cur.schemaSha256, cur.packageSha256, cur.monthCapMicroUsd, cur.expiresAt]);
  try {
    const settled = inFlight(async () => { await begin(a, p);
      const v = (await a.client.query(SETTLE_SQL, settleParams({ workspaceId: p.ws, clientId: p.client, attemptId: r.attemptId, correlationId: r.correlationId,
        outcome: 'USAGE_VERIFIED', usage: { promptTokens: 2000, completionTokens: 100 } }))).rows[0].accountedMicroUsd as string;
      await a.client.query('COMMIT'); return v; });
    assert.equal(await settled.result(), '633');
  } finally { await owner.query('COMMIT'); }
  assert.deepEqual(await rows(p), [['DAY', '633'], ['MONTH', '633']]);
});
