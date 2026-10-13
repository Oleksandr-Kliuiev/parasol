import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PrismaClient } from '@prisma/client';
import { hashToken } from '../../packages/auth/token.ts';
import { dbAskPort } from '../../packages/ask/authority.ts';
import { AskBudget, AskDeadline } from '../../packages/ask/budget.ts';
import { AskFailure } from '../../packages/ask/contracts.ts';
import { bearerCredential } from '../../packages/ask/credential.ts';
import { AskRun, AskStopped } from '../../packages/ask/service.ts';
import type { AskAdmission, AskIdentity } from '../../packages/ask/service.ts';
import { CLIENT, WS, addActor, askDatabase, count } from '../support/ask-pg.ts';
import type { AskDb } from '../support/ask-pg.ts';

// ASK-A rc3 R2a on real PostgreSQL 17 (confined runtime role): the accepted shared currentToken issues three separately
// awaited statements. A response-delivery seam lets the k-th digest-setting statement execute normally and holds only the
// return of its await (as a delayed driver/network delivery may), then the run becomes terminal or reaches its original or
// phase deadline at that internal await. Required: ZERO statements of any kind start afterwards (no token SELECT, actor,
// fence, charge, source, denial or audit), no token query physically reaches PostgreSQL, rows written earlier in the phase
// roll back, and the SAME owner stays held until the held work and rollback drain, then is released exactly once.

let db: AskDb; let prisma: PrismaClient;
const tokens: Record<string, string> = {};
before(async () => {
  db = await askDatabase();
  prisma = new PrismaClient({ datasourceUrl: db.pgdb.runtimeUrl });
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) tokens[name] = await addActor(db.pgdb.owner, `hb-${name}`, ['context:read']);
  tokens.denied = await addActor(db.pgdb.owner, 'hb-denied', null);
});
after(async () => { await prisma?.$disconnect(); await db?.pgdb.drop(); });

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await check()) return; await sleep(5); }
  assert.fail(`timed out waiting for ${what}`);
}
const tokenWaits = async () => Number((await db.pgdb.owner.query(`SELECT count(*)::int AS n FROM pg_stat_activity
  WHERE usename = $1 AND wait_event_type = 'Lock' AND query LIKE '%"ApiToken"%'`, [db.pgdb.runtimeRole])).rows[0].n);

/** Transaction facade recording every statement start; holds the return of the `holdAt`-th digest-setting statement. */
function seam(holdAt: number) {
  const calls: string[] = [];
  let digestSets = 0; let held = false; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const facade = {
    $transaction: (fn: (tx: unknown) => Promise<unknown>, options: unknown) => prisma.$transaction(tx => fn(new Proxy(tx, {
      get(target, key, receiver) {
        const value: any = Reflect.get(target, key, receiver);
        if (key === '$executeRawUnsafe') return async (...args: unknown[]) => {
          calls.push(`set ${String(args[1])}`);
          const result = await value.apply(target, args);
          if (args[1] === 'app.token_hash' && args[2] !== '' && ++digestSets === holdAt) { held = true; await gate; }
          return result;
        };
        if (key === '$queryRaw' || key === '$queryRawUnsafe') return (...args: unknown[]) => { calls.push(String(key)); return value.apply(target, args); };
        if (typeof key === 'string' && !key.startsWith('$') && value !== null && typeof value === 'object') {
          return new Proxy(value, { get(o, k, r) { const f = Reflect.get(o, k, r); return typeof f === 'function' ? (...a: unknown[]) => { calls.push(`${key}.${String(k)}`); return f.apply(o, a); } : f; } });
        }
        return typeof value === 'function' ? value.bind(target) : value;
      }
    })), options as never)
  };
  return { port: dbAskPort(facade as never), calls, isHeld: () => held, release: () => release() };
}

type Interrupt = 'terminal' | 'original deadline' | 'phase deadline';
interface Scenario { label: string; token: string; holdAt: number; interrupt: Interrupt; physical?: boolean; phase: (port: ReturnType<typeof dbAskPort>, run: AskRun) => Promise<unknown>;
  setup?: (run: AskRun) => Promise<void> }
async function heldDigest(s: Scenario) {
  const budget = new AskBudget(); const owner = budget.reserve()!;
  let now = 0;
  const run = new AskRun(owner, new AskDeadline(8000, () => now));
  if (s.setup) await s.setup(run);
  const { port, calls, isHeld, release } = seam(s.holdAt);
  const blocker = new pg.Client({ connectionString: db.pgdb.ownerUrl });
  await blocker.connect();
  let outcome = 'PENDING'; let marker = -1; let blockedAfter = false;
  const work = s.phase(port, run).then(() => { outcome = 'SUCCESS'; },
    (e: unknown) => { outcome = e instanceof AskStopped ? 'STOPPED' : e instanceof AskFailure ? e.code : String(e); });
  owner.hold(work); owner.finish();
  try {
    await waitFor(isHeld, `${s.label}: digest-setting return held`);
    // Physical probe only before the phase's first token SELECT: later the Ask transaction itself holds AccessShare on
    // ApiToken, so an ACCESS EXCLUSIVE probe would queue behind it; those variants rely on the driver-level start record.
    if (s.physical) { await blocker.query('BEGIN'); await blocker.query(`LOCK TABLE "ApiToken" IN ACCESS EXCLUSIVE MODE`); }
    marker = calls.length;
    if (s.interrupt === 'terminal') run.end();
    if (s.interrupt === 'original deadline') now = 8000;
    if (s.interrupt === 'phase deadline') {
      await sleep(2150);
      assert.equal(outcome, 'ASK_DEADLINE', `${s.label}: caller-visible phase end while the delivery is still held`);
      assert.equal(budget.active, 1, `${s.label}: the held work keeps the owner after the caller failed`);
    }
    release();
    await work;
    const end = Date.now() + (s.physical ? 350 : 0);
    while (Date.now() < end) { if (await tokenWaits() > 0) { blockedAfter = true; break; } await sleep(5); }
  } finally {
    release(); await blocker.query('ROLLBACK').catch(() => undefined); await blocker.end();
    await work;
  }
  await waitFor(() => budget.active === 0, `${s.label}: drain`);
  return { outcome, after: calls.slice(marker), blockedAfter, physical: s.physical === true, releases: budget.releases, admissions: budget.admissions(WS, `hb-${s.token}`) };
}
const expectedOutcome = (i: Interrupt) => i === 'terminal' ? 'STOPPED' : 'ASK_DEADLINE';
const credential = (name: string) => bearerCredential(`Bearer ${tokens[name]}`)!;
function check(label: string, interrupt: Interrupt, r: Awaited<ReturnType<typeof heldDigest>>) {
  console.log(JSON.stringify({ event: 'r2a-held-digest', label, interrupt, outcome: r.outcome, statementsAfter: r.after.length, physical: r.physical, blockedAfter: r.blockedAfter, releases: r.releases }));
  assert.equal(r.outcome, expectedOutcome(interrupt), label);
  assert.deepEqual(r.after, [], `${label}: no statement (token SELECT, actor, fence, source, audit) starts after the interrupt`);
  assert.equal(r.blockedAfter, false, `${label}: no new token query physically reached PostgreSQL`);
  assert.equal(r.releases, 1, `${label}: exactly one owner release after the held work drained`);
}

for (const interrupt of ['terminal', 'original deadline', 'phase deadline'] as const) {
  test(`R2a private authentication, ${interrupt} at the held digest-setting return: no token SELECT or actor read`, async () => {
    const r = await heldDigest({ label: 'authenticate', token: 'a', holdAt: 1, interrupt, physical: true, phase: (port, run) => port.authenticate(run, credential('a')) });
    check('authenticate', interrupt, r);
  });
}

test('R2a fenced phase1: interrupts at the hint and at the after-lock re-authentication → no fence/actor/charge/source', async () => {
  for (const [holdAt, interrupt, name] of [[1, 'terminal', 'b'], [2, 'terminal', 'c'], [2, 'original deadline', 'd']] as const) {
    let identity!: AskIdentity;
    const r = await heldDigest({ label: `admit#${holdAt}`, token: name, holdAt, interrupt, physical: holdAt === 1,
      setup: async run => { identity = (await dbAskPort(prisma).authenticate(run, credential(name)))!; assert.equal(run.owner.bind(WS, identity.actorId, true), 'BOUND'); },
      phase: (port, run) => port.admit(run, identity, credential(name), CLIENT, null) });
    check(`admit digest #${holdAt}`, interrupt, r);
    assert.equal(r.admissions, 0, 'no rolling charge after the interrupt');
  }
});

test('R2a denial and final audit: interrupt at the post-INSERT token re-check → no SELECT, the denial/audit row rolls back', async () => {
  const denials = () => count(db.pgdb.owner, 'SecurityAuditEvent', `"eventType" = 'ask.scope_denied'`);
  const audits = () => count(db.pgdb.owner, 'AuditEvent', `"eventType" LIKE 'ask.%'`);
  const deniedBefore = await denials();
  let deniedIdentity!: AskIdentity;
  const denial = await heldDigest({ label: 'denial', token: 'denied', holdAt: 3, interrupt: 'terminal',
    setup: async run => { deniedIdentity = (await dbAskPort(prisma).authenticate(run, credential('denied')))!; },
    phase: (port, run) => port.admit(run, deniedIdentity, credential('denied'), CLIENT, null) });
  check('denial post-INSERT re-check', 'terminal', denial);
  assert.equal(await denials(), deniedBefore, 'the denial INSERT rolled back');
  for (const [interrupt, name] of [['terminal', 'e'], ['original deadline', 'f']] as const) {
    const auditsBefore = await audits();
    let identity!: AskIdentity; let admission!: AskAdmission;
    const r = await heldDigest({ label: 'publish', token: name, holdAt: 3, interrupt,
      setup: async run => {
        identity = (await dbAskPort(prisma).authenticate(run, credential(name)))!; assert.equal(run.owner.bind(WS, identity.actorId, true), 'BOUND');
        admission = await dbAskPort(prisma).admit(run, identity, credential(name), CLIENT, null);
      },
      phase: (port, run) => port.publish(run, identity, credential(name), admission, { event: 'completed', status: 'ANSWER', itemCount: 1 }) });
    check(`publish post-INSERT re-check (${interrupt})`, interrupt, r);
    assert.equal(await audits(), auditsBefore, 'the final audit INSERT rolled back');
  }
});

test('nearby ordinary behavior through the guarded view: valid, revoked, rebound and expired credentials; normal publish commits', async () => {
  const fresh = () => { const b = new AskBudget(); const o = b.reserve()!; return { b, o, run: new AskRun(o) }; };
  const port = dbAskPort(prisma);
  const { run } = fresh();
  assert.deepEqual(await port.authenticate(run, credential('g')), { workspaceId: WS, actorId: 'hb-g' });
  await db.pgdb.owner.query(`UPDATE "ApiToken" SET "revokedAt" = now() WHERE id = 'token-hb-g'`);
  assert.equal(await port.authenticate(fresh().run, credential('g')), null, 'revoked');
  const expiring = await addActor(db.pgdb.owner, 'hb-expiring', ['context:read'], { expiresAt: new Date(Date.now() + 300).toISOString() });
  await sleep(500);
  assert.equal(await port.authenticate(fresh().run, bearerCredential(`Bearer ${expiring}`)!), null, 'expired (DB clock)');
  const { run: r2 } = fresh();
  const identity = (await port.authenticate(r2, credential('h')))!;
  assert.equal(r2.owner.bind(WS, identity.actorId, true), 'BOUND');
  const admission = await port.admit(r2, identity, credential('h'), CLIENT, null);
  await db.pgdb.owner.query(`DELETE FROM "ApiToken" WHERE id = 'token-hb-h'`);
  await db.pgdb.owner.query(`INSERT INTO "ApiToken" ("workspaceId",id,"actorId","tokenHash") VALUES ($1,'hb-rebound','hb-a',$2)`, [WS, hashToken(tokens.h!)]);
  await assert.rejects(port.publish(r2, identity, credential('h'), admission, { event: 'completed', status: 'ANSWER', itemCount: 1 }),
    (e: unknown) => e instanceof AskFailure && e.code === 'ASK_AUTHENTICATION_FAILED', 'rebound token');
  const { run: r3 } = fresh();
  const ok = (await port.authenticate(r3, credential('a')))!;
  assert.equal(r3.owner.bind(WS, ok.actorId, true), 'BOUND');
  const before = await count(db.pgdb.owner, 'AuditEvent', `"eventType" = 'ask.completed'`);
  await port.publish(r3, ok, credential('a'), await port.admit(r3, ok, credential('a'), CLIENT, null), { event: 'completed', status: 'ANSWER', itemCount: 1 });
  assert.equal(await count(db.pgdb.owner, 'AuditEvent', `"eventType" = 'ask.completed'`), before + 1, 'ordinary publish commits one row');
});
