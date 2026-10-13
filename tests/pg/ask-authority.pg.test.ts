import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PrismaClient } from '@prisma/client';
import { hashToken } from '../../packages/auth/token.ts';
import { dbAskPort } from '../../packages/ask/authority.ts';
import { AskBudget, AskDeadline } from '../../packages/ask/budget.ts';
import { MOCK_PLANNER, mockPlan } from '../../packages/ask/planner.ts';
import type { AskPlanner, AskPlannerInputV1 } from '../../packages/ask/planner.ts';
import { AskRun, runQuestion } from '../../packages/ask/service.ts';
import { CLIENT, WS, addActor, addWorkspace, askBody, askDatabase, count, fenceVersion } from '../support/ask-pg.ts';
import type { AskDb } from '../support/ask-pg.ts';

// ASK-A Q2 on real PostgreSQL 17, confined runtime role, the actual DB port (no HTTP mock): credential/scope matrix with
// exactly one workspace denial, barriers while phase1 waits on the fence and while the planner runs, epoch change after a
// permission restore, token DELETE+INSERT rebinding (also into another workspace with a coincident epoch), post-INSERT
// expiry/deadline rollback, audit/commit failures and the Ask-only shared fence lock. Every refusal is checked in tables.

let db: AskDb; let prisma: PrismaClient; let port: ReturnType<typeof dbAskPort>; let budget: AskBudget;
before(async () => {
  db = await askDatabase();
  prisma = new PrismaClient({ datasourceUrl: db.pgdb.runtimeUrl });
  port = dbAskPort(prisma);
  budget = new AskBudget();
  await addWorkspace(db.pgdb.owner, 'ws-other', 'other-client');
});
after(async () => { await prisma?.$disconnect(); await db?.pgdb.drop(); });

const owner = () => db.pgdb.owner;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let seq = 0;
const actor = async (permissions: string[] | null = ['context:read'], options: Parameters<typeof addActor>[3] = {}) => {
  const id = `q2-${++seq}`;
  return { id, token: await addActor(owner(), id, permissions, options) };
};
async function ask(token: string, options: { clientId?: string; question?: string; focus?: string | null; planner?: AskPlanner; deadline?: AskDeadline } = {}) {
  const o = budget.reserve();
  assert.ok(o, 'capacity');
  const run = new AskRun(o, options.deadline);
  const work = runQuestion(run, port, options.planner ?? MOCK_PLANNER,
    { authorization: `Bearer ${token}`, clientId: options.clientId ?? CLIENT, body: askBody(options.question ?? 'What needs attention?', options.focus ?? null) });
  o.hold(work); o.finish();
  const reply = await work;
  return { status: reply.status, json: JSON.parse(reply.json), correlationId: run.correlationId };
}
const askAudits = () => count(owner(), 'AuditEvent', `"eventType" LIKE 'ask.%'`);
const denials = (where = 'true') => count(owner(), 'SecurityAuditEvent', `"eventType" = 'ask.scope_denied' AND ${where}`);
/** A planner that stops at a gate (abort ignored) and then plans like the MOCK, or returns `override`. */
function gated() {
  let reached!: () => void; let open!: () => void;
  const atGate = new Promise<void>(r => { reached = r; });
  const gate = new Promise<void>(r => { open = r; });
  const planner: AskPlanner = { plan: async (input: AskPlannerInputV1) => { reached(); await gate; return mockPlan(input); } };
  return { planner, atGate, open };
}
/** The planner gate is reached, or the request already ended without reaching it (a fail-closed phase1): never wait forever. */
async function reached(atGate: Promise<void>, pending: Promise<{ status: number }>) {
  const early = pending.then(r => assert.fail(`planner never reached: request ended ${r.status}`));
  await Promise.race([atGate, early]);
  early.catch(() => undefined);
}
async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await check()) return; await sleep(20); }
  assert.fail(`timed out waiting for ${what}`);
}
const runtimeWaitingOnLock = async (n = 1) => Number((await owner().query(`SELECT count(*)::int AS n FROM pg_stat_activity
  WHERE usename = $1 AND wait_event_type = 'Lock'`, [db.pgdb.runtimeRole])).rows[0].n) >= n;
async function session(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: db.pgdb.ownerUrl });
  await client.connect();
  return client;
}

test('credentials: unknown/revoked/expired/inactive → 401 with no audit, denial or rolling charge', async () => {
  const before = { audits: await askAudits(), denials: await denials() };
  const unknown = await ask('atl_wellformed_but_unknown_token_000000000000');
  assert.equal(unknown.status, 401); assert.equal(unknown.json.code, 'ASK_AUTHENTICATION_FAILED');
  const revoked = await actor(); await owner().query(`UPDATE "ApiToken" SET "revokedAt" = now() WHERE id = $1`, [`token-${revoked.id}`]);
  const expired = await actor(['context:read'], { expiresAt: new Date(Date.now() + 300).toISOString() }); // CHECK: expiresAt > createdAt
  const disabled = await actor(); await owner().query(`UPDATE "Actor" SET status = 'DISABLED' WHERE id = $1`, [disabled.id]);
  await sleep(600);
  for (const a of [revoked, expired, disabled]) {
    const r = await ask(a.token);
    assert.equal(r.status, 401, a.id); assert.deepEqual(Object.keys(r.json), ['contractVersion', 'code', 'correlationId']);
    assert.equal(budget.admissions(WS, a.id), 0);
  }
  assert.equal(await askAudits(), before.audits); assert.equal(await denials(), before.denials);
});

test('scope: nonmember/malformed/cross-workspace → SCOPE_DENIED, member without context:read → PERMISSION_DENIED; exactly one workspace denial each', async () => {
  const nonmember = await actor(null);
  const lacking = await actor(['events:ingest']);
  const cases = [[nonmember, CLIENT, 'SCOPE_DENIED'], [lacking, CLIENT, 'PERMISSION_DENIED'], [nonmember, 'bad id!\u0000', 'SCOPE_DENIED'],
    [nonmember, 'other-client', 'SCOPE_DENIED'], [nonmember, 'x'.repeat(129), 'SCOPE_DENIED']] as const;
  for (const [a, clientId, reason] of cases) {
    const before = { audits: await askAudits(), denials: await denials() };
    const r = await ask(a.token, { clientId });
    assert.equal(r.status, 403); assert.equal(r.json.code, 'ASK_SCOPE_DENIED');
    assert.equal(await denials(), before.denials + 1); assert.equal(await askAudits(), before.audits, 'no client audit/data on denial');
    const row = (await owner().query(`SELECT * FROM "SecurityAuditEvent" WHERE "correlationId" = $1`, [r.json.correlationId])).rows;
    assert.equal(row.length, 1);
    assert.equal(row[0].workspaceId, WS); assert.equal(row[0].actorId, a.id); assert.equal(row[0].reasonCode, reason);
    assert.equal(row[0].eventType, 'ask.scope_denied'); assert.deepEqual(row[0].metadata, {}); assert.equal(row[0].outcome, 'DENIED');
    assert.equal(row[0].requestedClientId, clientId.replace('\u0000', '\\u0000').slice(0, 200));
    assert.equal(budget.admissions(WS, a.id), 0, 'denied requests never charge');
  }
  const foreign = { id: 'q2-foreign', token: await addActor(owner(), 'q2-foreign', ['context:read'], { workspace: 'ws-other', client: 'other-client' }) };
  const r = await ask(foreign.token);
  assert.equal(r.status, 403);
  assert.equal(await count(owner(), 'SecurityAuditEvent', `"workspaceId" = 'ws-other' AND "correlationId" = '${r.json.correlationId}'`), 1);
  assert.equal(await count(owner(), 'SecurityAuditEvent', `"workspaceId" = '${WS}' AND "correlationId" = '${r.json.correlationId}'`), 0);
});

test('phase1 barrier: revoke / expire / permission loss while waiting on the fence are seen after the lock; nothing read or charged', async () => {
  for (const [label, mutate, status] of [
    ['revoke', (a: { id: string }) => `UPDATE "ApiToken" SET "revokedAt" = now() WHERE id = 'token-${a.id}'`, 401],
    ['expire', (a: { id: string }) => `UPDATE "ApiToken" SET "expiresAt" = now() WHERE id = 'token-${a.id}'`, 401],
    ['permission', (a: { id: string }) => `UPDATE "ClientMembership" SET permissions = ARRAY['events:ingest'] WHERE "actorId" = '${a.id}'`, 403]] as const) {
    const a = await actor();
    const blocker = await session();
    try {
      await blocker.query('BEGIN');
      await blocker.query(`SELECT version FROM "ActionAuthorityFence" WHERE "workspaceId" = $1 FOR UPDATE`, [WS]);
      const pending = ask(a.token);
      await waitFor(() => runtimeWaitingOnLock(), `${label}: phase1 waiting on the fence`);
      await blocker.query(mutate(a));
      await blocker.query('COMMIT');
      const r = await pending;
      assert.equal(r.status, status, label);
      assert.equal(budget.admissions(WS, a.id), 0, `${label}: no rolling charge before positive authority`);
    } finally { await blocker.end(); }
  }
});

test('planner barrier: revoke/expire → 401, permission loss → 403 (one denial), restored permission + new epoch → 409; never an audit', async () => {
  const scenarios: [string, (a: { id: string }) => Promise<void>, number, number][] = [
    ['revoke', async a => { await owner().query(`UPDATE "ApiToken" SET "revokedAt" = now() WHERE id = $1`, [`token-${a.id}`]); }, 401, 0],
    ['expire', async a => { await owner().query(`UPDATE "ApiToken" SET "expiresAt" = now() WHERE id = $1`, [`token-${a.id}`]); }, 401, 0],
    ['permission', async a => { await owner().query(`UPDATE "ClientMembership" SET permissions = ARRAY['events:ingest'] WHERE "actorId" = $1`, [a.id]); }, 403, 1],
    ['restore', async a => {
      await owner().query(`UPDATE "ClientMembership" SET permissions = ARRAY['events:ingest'] WHERE "actorId" = $1`, [a.id]);
      await owner().query(`UPDATE "ClientMembership" SET permissions = ARRAY['context:read'] WHERE "actorId" = $1`, [a.id]);
    }, 409, 0]];
  for (const [label, mutate, status, denied] of scenarios) {
    const a = await actor();
    const { planner, atGate, open } = gated();
    const before = { audits: await askAudits(), denials: await denials() };
    const pending = ask(a.token, { planner });
    await reached(atGate, pending);
    await mutate(a);
    open();
    const r = await pending;
    assert.equal(r.status, status, label);
    if (status === 409) assert.equal(r.json.code, 'ASK_SCOPE_CHANGED');
    assert.equal(await askAudits(), before.audits, `${label}: no completion audit`);
    assert.equal(await denials(), before.denials + denied, `${label}: denials`);
    assert.equal(budget.admissions(WS, a.id), 1, `${label}: the admitted read consumed its admission, never refunded`);
  }
});

test('token rebinding by owner DELETE+INSERT of the same digest (another actor; another workspace at a coincident epoch) → 401, never the new scope', async () => {
  const victim = await actor();
  const other = await actor();
  const foreignActor = 'q2-rebound';
  await owner().query(`INSERT INTO "Actor" ("workspaceId",id,"displayName","workspacePermissions") VALUES ('ws-other',$1,'Synthetic',ARRAY[]::text[])`, [foreignActor]);
  await owner().query(`INSERT INTO "ClientMembership" ("workspaceId","clientId","actorId",permissions) VALUES ('ws-other','other-client',$1,ARRAY['context:read'])`, [foreignActor]);
  for (const target of ['same-workspace', 'cross-workspace'] as const) {
    const a = target === 'same-workspace' ? victim : await actor();
    const { planner, atGate, open } = gated();
    const before = await askAudits();
    const pending = ask(a.token, { planner });
    await reached(atGate, pending);
    const captured = await fenceVersion(owner());
    await owner().query(`DELETE FROM "ApiToken" WHERE id = $1`, [`token-${a.id}`]);
    if (target === 'same-workspace') {
      await owner().query(`INSERT INTO "ApiToken" ("workspaceId",id,"actorId","tokenHash") VALUES ($1,'rebound-same',$2,$3)`, [WS, other.id, hashToken(a.token)]);
    } else {
      await owner().query(`INSERT INTO "ApiToken" ("workspaceId",id,"actorId","tokenHash") VALUES ('ws-other','rebound-cross',$1,$2)`, [foreignActor, hashToken(a.token)]);
      // Make the other workspace's epoch coincide with the epoch phase1 captured in this workspace.
      while (await fenceVersion(owner(), 'ws-other') < captured) await owner().query(`UPDATE "Actor" SET "displayName" = "displayName" WHERE id = $1`, [foreignActor]);
      assert.equal(await fenceVersion(owner(), 'ws-other'), captured);
    }
    open();
    const r = await pending;
    assert.equal(r.status, 401, target); assert.equal(await askAudits(), before, `${target}: no audit in either scope`);
    await owner().query(`DELETE FROM "ApiToken" WHERE id IN ('rebound-same', 'rebound-cross')`);
  }
  const ordinaryMove = await owner().query(`UPDATE "ApiToken" SET "actorId" = $1 WHERE id = $2`, [victim.id, `token-${other.id}`]).then(() => 'moved', (e: { code?: string }) => e.code);
  assert.equal(ordinaryMove, 'AT002', 'an ordinary UPDATE move is refused by the accepted identity guard, hence DELETE+INSERT above');
});

test('post-INSERT checks: expiry during the final audit INSERT wait → 401 and rollback; original deadline passing there → 504 and rollback', async () => {
  const t0 = Date.now();
  const expiring = await actor(['context:read'], { expiresAt: new Date(t0 + 3500).toISOString() });
  const { planner, atGate, open } = gated();
  const before = await askAudits();
  const pending = ask(expiring.token, { planner });
  await reached(atGate, pending);
  const blocker = await session();
  try {
    await blocker.query('BEGIN');
    await blocker.query(`SELECT 1 FROM "Client" WHERE "workspaceId" = $1 AND id = $2 FOR UPDATE`, [WS, CLIENT]);
    await sleep(Math.max(0, t0 + 2500 - Date.now())); // phase2 starts ~1 s before the token's expiry, its INSERT then waits past it
    open();
    await waitFor(() => runtimeWaitingOnLock(), 'the final audit INSERT waiting on its FK lock');
    await waitFor(async () => (await owner().query(`SELECT now() > "expiresAt" AS gone FROM "ApiToken" WHERE id = $1`, [`token-${expiring.id}`])).rows[0].gone, 'expiry', 4000);
    await blocker.query('COMMIT');
  } finally { await blocker.end(); }
  const r = await pending;
  assert.equal(r.status, 401); assert.equal(await askAudits(), before, 'the audit INSERT was rolled back');

  let now = 0; const clock = () => now;
  const a = await actor();
  const second = gated();
  const pending2 = ask(a.token, { planner: second.planner, deadline: new AskDeadline(8000, clock) });
  await reached(second.atGate, pending2);
  const blocker2 = await session();
  try {
    await blocker2.query('BEGIN');
    await blocker2.query(`SELECT 1 FROM "Client" WHERE "workspaceId" = $1 AND id = $2 FOR UPDATE`, [WS, CLIENT]);
    second.open();
    await waitFor(() => runtimeWaitingOnLock(), 'the final audit INSERT waiting');
    now = 8001;
    await blocker2.query('COMMIT');
  } finally { await blocker2.end(); }
  const late = await pending2;
  assert.equal(late.status, 504); assert.equal(late.json.code, 'ASK_DEADLINE'); assert.equal(await askAudits(), before);
});

test('denial post-INSERT expiry: the token expiring during the denial INSERT wait → 401 and no denial row', async () => {
  const lacking = await actor(['events:ingest'], { expiresAt: new Date(Date.now() + 1500).toISOString() });
  const before = await denials();
  const blocker = await session();
  let pending: ReturnType<typeof ask>;
  try {
    await blocker.query('BEGIN');
    await blocker.query(`SELECT 1 FROM "Workspace" WHERE id = $1 FOR UPDATE`, [WS]);
    pending = ask(lacking.token);
    await waitFor(() => runtimeWaitingOnLock(), 'the denial INSERT waiting on its FK lock');
    await waitFor(async () => (await owner().query(`SELECT now() > "expiresAt" AS gone FROM "ApiToken" WHERE id = $1`, [`token-${lacking.id}`])).rows[0].gone, 'expiry', 3000);
    await blocker.query('COMMIT');
  } finally { await blocker.end(); }
  const r = await pending!;
  assert.equal(r.status, 401); assert.equal(await denials(), before);
});

test('final audit failures: refused INSERT and a commit-time failure → 503 ASK_AUDIT_FAILED, no answer, no row, no retry', async () => {
  const runtime = db.pgdb.runtimeRole;
  const before = await askAudits();
  await owner().query(`REVOKE INSERT ON "AuditEvent" FROM "${runtime}"`);
  try {
    const r = await ask((await actor()).token);
    assert.equal(r.status, 503); assert.equal(r.json.code, 'ASK_AUDIT_FAILED'); assert.equal(r.json.status, undefined);
  } finally { await owner().query(`GRANT INSERT ON "AuditEvent" TO "${runtime}"`); }
  await owner().query(`CREATE FUNCTION ask_test_commit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic commit fault'; END $$;
    REVOKE EXECUTE ON FUNCTION ask_test_commit_fault() FROM PUBLIC;
    CREATE CONSTRAINT TRIGGER ask_test_commit_fault AFTER INSERT ON "AuditEvent" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ask_test_commit_fault();`);
  try {
    const r = await ask((await actor()).token);
    assert.equal(r.status, 503); assert.equal(r.json.code, 'ASK_AUDIT_FAILED');
  } finally { await owner().query(`DROP TRIGGER ask_test_commit_fault ON "AuditEvent"; DROP FUNCTION ask_test_commit_fault();`); }
  assert.equal(await askAudits(), before);
  assert.equal((await ask((await actor()).token)).status, 200, 'recovered without retrying the failed request');
});

test('shared fence lock: concurrent Ask phase1 readers hold FOR SHARE together; authority UPDATE and a Stage 3 FOR UPDATE wait; no other explicit lock', async () => {
  const [a, b, c] = [await actor(), await actor(), await actor()];
  const blocker = await session(); const mutation = await session(); const stage3 = new pg.Client({ connectionString: db.pgdb.runtimeUrl });
  await stage3.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query(`LOCK TABLE "Observation" IN ACCESS EXCLUSIVE MODE`);
    const asks = [ask(a.token), ask(b.token)];
    await waitFor(() => runtimeWaitingOnLock(2), 'both Ask readers past the fence, waiting on the source read');
    const locks = (await owner().query(`SELECT l.mode, c.relname, l.locktype FROM pg_locks l JOIN pg_stat_activity s ON s.pid = l.pid
      LEFT JOIN pg_class c ON c.oid = l.relation WHERE s.usename = $1 AND l.granted AND l.locktype IN ('relation', 'tuple', 'advisory')`, [db.pgdb.runtimeRole])).rows;
    const explicit = locks.filter(l => l.mode !== 'AccessShareLock');
    assert.deepEqual([...new Set(explicit.map(l => `${l.relname}:${l.mode}`))].sort(), ['ActionAuthorityFence:RowShareLock', 'ActionAuthorityFence_pkey:RowShareLock'],
      'FOR SHARE on the fence is the only lock above AccessShare');
    assert.equal(locks.some(l => l.locktype === 'advisory'), false);
    await mutation.query('BEGIN');
    const update = mutation.query(`UPDATE "Actor" SET "displayName" = 'Synthetic renamed' WHERE "workspaceId" = $1 AND id = $2`, [WS, c.id]);
    await stage3.query(`BEGIN; SELECT set_config('app.workspace_id', '${WS}', true)`);
    const admission = stage3.query(`SELECT version FROM "ActionAuthorityFence" WHERE "workspaceId" = $1 FOR UPDATE`, [WS]);
    await waitFor(async () => Number((await owner().query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock'
      AND (usename = $1 OR pid = $2)`, [db.pgdb.runtimeRole, (mutation as unknown as { processID: number }).processID])).rows[0].n) >= 4, 'authority UPDATE and Stage 3 admission queued');
    await blocker.query('COMMIT');
    // Both writers obtain the fence only after both phase1 readers committed; PostgreSQL decides which goes first.
    const first = await Promise.race([update.then(() => 'update' as const), admission.then(() => 'admission' as const)]);
    if (first === 'update') { await mutation.query('ROLLBACK'); await admission; await stage3.query('ROLLBACK'); }
    else { await stage3.query('ROLLBACK'); await update; await mutation.query('ROLLBACK'); }
    const results = await Promise.all(asks);
    assert.deepEqual(results.map(r => r.status), [200, 200], 'the waiting writers rolled back: epoch unchanged, both answers publish');
  } finally { await blocker.end(); await mutation.end(); await stage3.end(); }
});

test('runtime confinement and the missing-Client row: the port runs as the confined role; a membership without its Client row → 404, no audit', async () => {
  const [facts] = await prisma.$queryRawUnsafe<{ who: string; superuser: boolean; bypass: boolean }[]>(
    `SELECT current_user AS who, rolsuper AS superuser, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`);
  assert.deepEqual(facts, { who: db.pgdb.runtimeRole, superuser: false, bypass: false });
  const a = await actor();
  const before = { audits: await askAudits(), denials: await denials() };
  // Only reachable by bypassing the accepted foreign keys (superuser replica mode in this disposable database).
  await owner().query(`BEGIN; SET LOCAL session_replication_role = replica; DELETE FROM "Client" WHERE "workspaceId" = '${WS}' AND id = '${CLIENT}'; COMMIT;`);
  const r = await ask(a.token);
  assert.equal(r.status, 404); assert.equal(r.json.code, 'ASK_CONTEXT_UNAVAILABLE');
  assert.deepEqual({ audits: await askAudits(), denials: await denials() }, before);
});
