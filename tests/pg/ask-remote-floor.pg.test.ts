import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { ASK_REMOTE_READY_SQL, askRemoteProblems } from '../../packages/graph/ask-remote-role.ts';
import type { AskRemoteFacts } from '../../packages/graph/ask-remote-role.ts';
import { ACTION_FENCE_READY_SQL, actionFenceProblems } from '../../packages/graph/fence-role.ts';
import type { ActionFenceFacts } from '../../packages/graph/fence-role.ts';
import { RUNTIME_ROLE_CHECK_SQL, assertConfinedRuntimeRole } from '../../packages/graph/runtime-role.ts';
import { RESERVE_FLOOR_SQL, reserveFloorParams } from '../../packages/ask/remote/ledger-sql.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { ACTOR, PRICE, RA, RW, activate, addRemoteFixtures, connectAs, ledger, sqlstate } from '../support/ask-remote-pg.ts';
import { inFlight, openSession, waitUntilBlocked } from '../support/pg-race.ts';

// ASK-REMOTE R-B migration 202610121000 on PostgreSQL 17: atlas_ask_remote_reserve_floor called DIRECTLY by the confined
// runtime role. The floor is a DB-clock instant derived from a same-transaction clock_timestamp() sample. Proves: the floor
// is checked after EVERY reservation lock wait and before the attempt INSERT (the INSERT never runs: insert probe), again
// before RETURN (an FK wait after the pre-INSERT check is caught), the unchanged reserve rules otherwise, scope refusals, and
// the exact confinement (remote-definer owned, SECURITY DEFINER, fixed search_path, runtime-only EXECUTE, never PUBLIC).

const pgdb = await createTestDatabase();
const owner = pgdb.owner;
const runtime = await connectAs(pgdb.runtimeUrl);
const holder = await openSession(pgdb.ownerUrl);
const observer = await openSession(pgdb.ownerUrl);
after(async () => { for (const c of [runtime, holder.client, observer.client]) await c.end().catch(() => undefined); await pgdb.drop(); });
await addRemoteFixtures(owner);
const policy = await activate(owner, RW, [RA]);
const consent = { admissionId: policy.admissionId, policyVersion: policy.policyVersion };
await owner.query(`CREATE SEQUENCE public.rb_floor_probe_seq`);
await owner.query(`CREATE FUNCTION public.rb_floor_probe() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  BEGIN PERFORM nextval('public.rb_floor_probe_seq'); RETURN NULL; END $$`);
await owner.query(`REVOKE ALL ON FUNCTION public.rb_floor_probe() FROM PUBLIC`);
await owner.query(`CREATE TRIGGER rb_floor_probe AFTER INSERT ON "RemoteAskAttempt" FOR EACH ROW EXECUTE FUNCTION public.rb_floor_probe()`);
const inserts = async () => Number((await owner.query(`SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS n FROM public.rb_floor_probe_seq`)).rows[0].n);
const fence = async () => Number((await owner.query(`SELECT version FROM "ActionAuthorityFence" WHERE "workspaceId" = $1`, [RW])).rows[0].version);

/** One egress-style runtime transaction: scope → fence FOR SHARE → DB-clock sample → reserve_floor(sample + aboveMs). */
async function reserveFloor(c: pg.Client, aboveMs: number, o: { workspace?: string; client?: string; before?: () => Promise<void> } = {}) {
  await c.query('BEGIN');
  try {
    await c.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true)`, [o.workspace ?? RW, o.client ?? RA]);
    // Under a foreign workspace setting the fence row is invisible (RLS): the routine must still refuse on scope (AR004).
    const epoch = ((await c.query(`SELECT version FROM public."ActionAuthorityFence" WHERE "workspaceId" = $1 FOR SHARE`, [RW])).rows[0]?.version ?? 0) as number;
    const sample = (await c.query(`SELECT clock_timestamp()::text AS now`)).rows[0].now as string;
    await o.before?.();
    const id = (await c.query(RESERVE_FLOOR_SQL, reserveFloorParams({ workspaceId: RW, clientId: RA, actorId: ACTOR, admissionId: consent.admissionId,
      policyVersion: consent.policyVersion, fenceVersion: epoch, priceRevision: PRICE, correlationId: randomUUID() }, { sample, aboveMs }))).rows[0].attemptId as string;
    await c.query('COMMIT');
    return id;
  } catch (error) { await c.query('ROLLBACK').catch(() => undefined); throw error; }
}

test('admitted above the floor: the unchanged reserve result (attempt EGRESS_COMMITTED 300000, both counters charged)', async () => {
  const id = await reserveFloor(runtime, 1500);
  const l = await ledger(owner, RW);
  assert.deepEqual(l.attempts.map(a => [a.id, a.state, a.accounted]), [[id, 'EGRESS_COMMITTED', '300000']]);
  assert.deepEqual(l.counters.map(c => c.charged), ['300000', '300000']);
  assert.equal(await inserts(), 1);
});

test('floor already passed at entry, or reached during the MONTH/DAY lock waits → AR011 before the INSERT; nothing created or charged', async () => {
  const before = await ledger(owner, RW); const probe = await inserts();
  assert.equal(await sqlstate(reserveFloor(runtime, 0, { before: () => new Promise(resolve => setTimeout(resolve, 20)) })), 'AR011');
  for (const kind of ['MONTH', 'DAY']) {
    await holder.client.query('BEGIN');
    await holder.client.query(`SELECT set_config('app.workspace_id', $1, true)`, [RW]);
    await holder.client.query(`SELECT 1 FROM "RemoteAskPeriodCounter" WHERE "workspaceId" = $1 AND kind = $2 FOR UPDATE`, [RW, kind]);
    const pending = inFlight(() => reserveFloor(runtime, 300));
    await waitUntilBlocked(observer.client, null);
    await new Promise(resolve => setTimeout(resolve, 450));
    await holder.client.query('COMMIT');
    assert.equal(await sqlstate(pending.result()), 'AR011', kind);
  }
  assert.equal(await inserts(), probe, 'the attempt INSERT never executed');
  assert.deepEqual(await ledger(owner, RW), before);
});

test('an FK key-share wait AFTER the pre-INSERT check is caught immediately before RETURN (INSERT ran, statement undone)', async () => {
  const before = await ledger(owner, RW); const probe = await inserts();
  await holder.client.query('BEGIN');
  await holder.client.query(`SELECT 1 FROM "Actor" WHERE "workspaceId" = $1 AND id = $2 FOR UPDATE`, [RW, ACTOR]);
  const pending = inFlight(() => reserveFloor(runtime, 300));
  await waitUntilBlocked(observer.client, null);
  await new Promise(resolve => setTimeout(resolve, 450));
  await holder.client.query('COMMIT');
  assert.equal(await sqlstate(pending.result()), 'AR011');
  assert.equal(await inserts(), probe + 1, 'the INSERT executed after the wait');
  assert.deepEqual(await ledger(owner, RW), before, 'and the routine undid it before returning');
});

test('scope, fence and consent refusals keep the accepted reserve codes; NULL floor and foreign scope are AR004', async () => {
  assert.equal(await sqlstate(reserveFloor(runtime, 1500, { client: 'rem-client-b' })), 'AR004');
  assert.equal(await sqlstate(reserveFloor(runtime, 1500, { workspace: 'rem-ws-other' })), 'AR004');
  await runtime.query('BEGIN');
  await runtime.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true)`, [RW, RA]);
  assert.equal(await sqlstate(runtime.query(`SELECT public.atlas_ask_remote_reserve_floor($1, $2, $3, $4::uuid, $5::bigint, $6::integer, 'ask-remote-openai-luna-v1', $7,
    $8::uuid, NULL)`, [RW, RA, ACTOR, consent.admissionId, consent.policyVersion, await fence(), PRICE, randomUUID()])), 'AR004');
  await runtime.query('ROLLBACK');
  await runtime.query('BEGIN');
  await runtime.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true)`, [RW, RA]);
  assert.equal(await sqlstate(runtime.query(RESERVE_FLOOR_SQL, reserveFloorParams({ workspaceId: RW, clientId: RA, actorId: ACTOR, admissionId: consent.admissionId,
    policyVersion: consent.policyVersion, fenceVersion: (await fence()) + 1, priceRevision: PRICE, correlationId: randomUUID() },
  { sample: new Date(Date.now() + 60_000).toISOString(), aboveMs: 0 }))), 'AR005', 'a changed fence epoch is the accepted AR005');
  await runtime.query('ROLLBACK');
  assert.throws(() => reserveFloorParams({ workspaceId: RW, clientId: RA, actorId: ACTOR, admissionId: consent.admissionId, policyVersion: consent.policyVersion,
    fenceVersion: 1, priceRevision: PRICE, correlationId: randomUUID() }, { sample: 'x', aboveMs: -1 }), /ARGUMENT_INVALID/);
});

test('confinement: remote-definer owned SECURITY DEFINER with fixed search_path, runtime-only EXECUTE; PUBLIC grant fails readiness', async () => {
  const row = (await owner.query(`SELECT p.proowner::regrole::text AS owner, p.prosecdef, p.proconfig, coalesce((SELECT array_agg(a.grantee::regrole::text)
    FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner), '{}') AS grantees, (SELECT bool_or(a.grantee = 0) FROM aclexplode(p.proacl) a) AS public
    FROM pg_proc p WHERE p.proname = 'atlas_ask_remote_reserve_floor'`)).rows[0];
  assert.deepEqual(row, { owner: pgdb.remoteRole, prosecdef: true, proconfig: ['search_path=pg_catalog, pg_temp'], grantees: [pgdb.runtimeRole], public: false });
  const ready = async () => {
    assert.deepEqual(askRemoteProblems((await runtime.query(ASK_REMOTE_READY_SQL)).rows[0] as AskRemoteFacts), []);
    assert.deepEqual(actionFenceProblems((await runtime.query(ACTION_FENCE_READY_SQL)).rows[0] as ActionFenceFacts), []);
    assertConfinedRuntimeRole((await runtime.query(RUNTIME_ROLE_CHECK_SQL)).rows[0]);
  };
  // The test-only probe trigger function above is owner-only (no PUBLIC EXECUTE), so readiness holds with it in place.
  await ready();
  const sig = 'public.atlas_ask_remote_reserve_floor(text, text, text, uuid, bigint, integer, text, text, uuid, timestamp with time zone)';
  await owner.query(`GRANT EXECUTE ON FUNCTION ${sig} TO PUBLIC`);
  const facts = (await runtime.query(ASK_REMOTE_READY_SQL)).rows[0] as AskRemoteFacts;
  assert.ok(facts.arRoutineViolations > 0 && facts.arExecuteViolations > 0);
  const shared = (await runtime.query(RUNTIME_ROLE_CHECK_SQL)).rows[0];
  assert.throws(() => assertConfinedRuntimeRole(shared), /RUNTIME_ROLE_NOT_CONFINED/, 'the shared startup readiness refuses (every Ask mode)');
  await owner.query(`REVOKE EXECUTE ON FUNCTION ${sig} FROM PUBLIC`);
  await owner.query(`REVOKE EXECUTE ON FUNCTION ${sig} FROM ${pgdb.runtimeRole}`);
  assert.ok(((await runtime.query(ASK_REMOTE_READY_SQL)).rows[0] as AskRemoteFacts).arRuntimeMissingGrants > 0, 'a missing runtime EXECUTE fails readiness');
  await owner.query(`GRANT EXECUTE ON FUNCTION ${sig} TO ${pgdb.runtimeRole}`);
  await ready();
});
