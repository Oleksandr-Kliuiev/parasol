import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createTestDatabase } from '../support/pg-harness.ts';
import { CA, KEY_A, KEY_A2, KEY_B, KEY_DISABLED, WS, addPowerOfficeFixtures, connect, inTx, scopeOf, stateOf } from '../support/poweroffice-fixtures.ts';
import type { PoKey } from '../support/poweroffice-fixtures.ts';
import { SUMMARY, ageConnection, claimAttempt, closeAttempt, insertSnapshot, lockFence, publishAttempt } from '../support/poweroffice-history.ts';
import type { Claimed } from '../support/poweroffice-history.ts';

// S4-A F2 repair on PostgreSQL 17: the ORIGINAL claim deadline is enforced with the actual DB clock — independent of any
// recent (backdated) publishedAt/completedAt a writer supplies — at the statement and again at COMMIT. At/after the deadline
// a new publication or private FAILED closure rolls back with no snapshot, pointer or terminal change; recovery (ABANDONED)
// is the only closure. A receipt-only no-op on an already SUCCEEDED attempt is not a transition and stays possible.
const pgdb = await createTestDatabase();
const clients: pg.Client[] = [];
after(async () => { for (const c of clients) await c.end().catch(() => undefined); await pgdb.drop(); });
await addPowerOfficeFixtures(pgdb.owner);
const runtime = await connect(pgdb.runtimeUrl); clients.push(runtime);
const KEY_U: PoKey = { workspaceId: WS, clientId: CA, connectionId: 'po-unbound' };
const K = `"workspaceId" = $1 AND "clientId" = $2 AND "connectionId" = $3`;
const k = (key: PoKey) => [key.workspaceId, key.clientId, key.connectionId];
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A publication with a SUPPLIED timestamp t (text, UTC), in the caller's open transaction, after fence → State → Attempt locks. */
async function publishAt(c: pg.Client, key: PoKey, claim: Claimed, t: string): Promise<void> {
  await insertSnapshot(c, key, claim, SUMMARY, t);
  await c.query(`UPDATE public."PowerOfficeAttempt" SET state = 'SUCCEEDED', "completedAt" = $5 WHERE ${K} AND id = $4`, [...k(key), claim.id, t]);
  await c.query(`UPDATE public."PowerOfficeState" SET "activeAttemptId" = NULL, "lastAttemptState" = 'SUCCEEDED', "lastCompletedAttemptId" = $4,
    "lastCompletedState" = 'SUCCEEDED', "lastCompletedErrorCode" = NULL, "snapshotId" = $5, "snapshotVersion" = $6, "lastSuccessAt" = $7 WHERE ${K}`,
    [...k(key), claim.id, claim.allocatedSnapshotId, claim.lifecycleVersion, t]);
}
async function failAt(c: pg.Client, key: PoKey, claim: Claimed, t: string): Promise<void> {
  await c.query(`UPDATE public."PowerOfficeAttempt" SET state = 'FAILED', "completedAt" = $5, "safeErrorCode" = 'POWEROFFICE_SOURCE_FAILED' WHERE ${K} AND id = $4`,
    [...k(key), claim.id, t]);
  await c.query(`UPDATE public."PowerOfficeState" SET "activeAttemptId" = NULL, "lastAttemptState" = 'FAILED', "lastAttemptErrorCode" = 'POWEROFFICE_SOURCE_FAILED',
    "lastCompletedAttemptId" = $4, "lastCompletedState" = 'FAILED', "lastCompletedErrorCode" = 'POWEROFFICE_SOURCE_FAILED' WHERE ${K}`, [...k(key), claim.id]);
}
/** Locks in the approved order, then the claim's deadline, the DB clock and a recent backdated value (deadline - 1 ms). */
async function locked(c: pg.Client, key: PoKey, claim: Claimed) {
  await lockFence(c, key.workspaceId);
  await c.query(`SELECT 1 FROM public."PowerOfficeState" WHERE ${K} FOR UPDATE`, k(key));
  return (await c.query(`SELECT ("deadlineAt" - interval '1 millisecond')::text AS before, "deadlineAt" < (clock_timestamp() AT TIME ZONE 'UTC') AS expired,
    "deadlineAt" - (clock_timestamp() AT TIME ZONE 'UTC') > interval '0' AS pending FROM public."PowerOfficeAttempt" WHERE ${K} AND id = $4 FOR UPDATE`, [...k(key), claim.id])).rows[0];
}
/** Waits (DB clock) until the claim's deadline is reached: the first observation at/after deadlineAt. */
async function untilDeadline(c: pg.Client, key: PoKey, claim: Claimed): Promise<void> {
  for (;;) {
    const r = (await c.query(`SELECT (clock_timestamp() AT TIME ZONE 'UTC') >= "deadlineAt" AS reached FROM public."PowerOfficeAttempt" WHERE ${K} AND id = $4`,
      [...k(key), claim.id])).rows[0];
    if (r.reached) return;
    await sleep(20);
  }
}
const observe = (key: PoKey) => inTx(runtime, scopeOf(key), async c => (await c.query(`SELECT s."activeAttemptId"::text AS active, s."snapshotId"::text AS pointer,
  s."lastCompletedState" AS completed, (SELECT count(*)::int FROM public."PowerOfficeSnapshot" WHERE ${K}) AS snapshots,
  (SELECT string_agg(state, ',' ORDER BY sequence) FROM public."PowerOfficeAttempt" WHERE ${K}) AS states FROM public."PowerOfficeState" s WHERE ${K}`, k(key))).rows[0]);
/** Runs `fn` as `c` in one transaction with scope settings; returns the SQLSTATE of the statement or the COMMIT. */
async function attempt(c: pg.Client, key: PoKey, fn: (c: pg.Client) => Promise<void>): Promise<string | undefined> {
  return inTx(c, scopeOf(key), fn).then(() => undefined, e => stateOf(e));
}

test('after the actual deadline, a backdated but recent publishedAt/completedAt cannot publish or FAIL — runtime and owner; ABANDONED still closes it', async () => {
  for (const [label, c] of [['runtime', runtime], ['owner', pgdb.owner]] as const) {
    const key = label === 'runtime' ? KEY_A : KEY_A2;
    const claim = await inTx(runtime, scopeOf(key), x => claimAttempt(x, key, 'syncer'));
    await ageConnection(pgdb.owner, key, '81 seconds');
    const before = await observe(key);
    assert.equal(await attempt(c, key, async x => {
      const l = await locked(x, key, claim);
      assert.equal(l.expired, true, 'the deadline is in the past on the DB clock');
      await publishAt(x, key, claim, l.before);
    }), 'PO007', `${label}: late publication`);
    assert.equal(await attempt(c, key, async x => { const l = await locked(x, key, claim); await failAt(x, key, claim, l.before); }), 'PO007', `${label}: late FAILED`);
    assert.deepEqual(await observe(key), before, `${label}: no snapshot, pointer or terminal change`);
    await inTx(c, scopeOf(key), x => closeAttempt(x, key, claim, 'ABANDONED', 'POWEROFFICE_DEADLINE'));
    assert.deepEqual(await observe(key), { ...before, active: null, completed: 'ABANDONED', states: 'ABANDONED' }, `${label}: recovery closes it`);
  }
});

test('exact boundary: once the DB clock reaches deadlineAt the same transaction can no longer publish; one moment before it could', async () => {
  const claim = await inTx(runtime, scopeOf(KEY_B), x => claimAttempt(x, KEY_B, 'syncer'));
  await ageConnection(pgdb.owner, KEY_B, '79500 milliseconds');
  const before = await observe(KEY_B);
  assert.equal(await attempt(runtime, KEY_B, async x => {
    const l = await locked(x, KEY_B, claim);
    assert.equal(l.pending, true, 'locked before the deadline');
    await untilDeadline(x, KEY_B, claim);
    await publishAt(x, KEY_B, claim, l.before);
  }), 'PO007');
  assert.deepEqual(await observe(KEY_B), before);
  assert.equal(await attempt(runtime, KEY_B, async x => { await locked(x, KEY_B, claim); await untilDeadline(x, KEY_B, claim);
    await x.query(`UPDATE public."PowerOfficeAttempt" SET state = 'ABANDONED', "completedAt" = date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC'),
      "safeErrorCode" = 'POWEROFFICE_DEADLINE' WHERE id = $1`, [claim.id]);
    await x.query(`UPDATE public."PowerOfficeState" SET "activeAttemptId" = NULL, "lastAttemptState" = 'ABANDONED', "lastAttemptErrorCode" = 'POWEROFFICE_DEADLINE',
      "lastCompletedAttemptId" = $1, "lastCompletedState" = 'ABANDONED', "lastCompletedErrorCode" = 'POWEROFFICE_DEADLINE' WHERE "connectionId" = 'po-b'`, [claim.id]);
  }), undefined, 'at the boundary, recovery is due');
  const early = await inTx(runtime, scopeOf(KEY_B), x => claimAttempt(x, KEY_B, 'syncer'));
  assert.equal(await attempt(runtime, KEY_B, async x => { await lockFence(x, WS); await x.query(`SELECT 1 FROM public."PowerOfficeAttempt" WHERE id = $1 FOR UPDATE`, [early.id]);
    await x.query(`UPDATE public."PowerOfficeAttempt" SET state = 'ABANDONED', "completedAt" = date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC'),
      "safeErrorCode" = 'POWEROFFICE_DEADLINE' WHERE id = $1`, [early.id]); }), 'PO007', 'recovery before the deadline is refused');
  await inTx(runtime, scopeOf(KEY_B), x => publishAttempt(x, KEY_B, early, SUMMARY));
  assert.equal((await observe(KEY_B)).pointer, early.allocatedSnapshotId, 'a before-deadline publication commits');
});

test('COMMIT boundary: statements before the deadline, COMMIT at/after it — publication and FAILED both roll back with zero effects', async () => {
  for (const kind of ['publish', 'fail'] as const) {
    const key = kind === 'publish' ? KEY_DISABLED : KEY_U;
    const claim = await inTx(runtime, scopeOf(key), x => claimAttempt(x, key, 'syncer', key === KEY_DISABLED ? 2 : 1));
    await ageConnection(pgdb.owner, key, '78500 milliseconds');
    const before = await observe(key);
    assert.equal(await attempt(runtime, key, async x => {
      const l = await locked(x, key, claim);
      assert.equal(l.pending, true);
      const t = (await x.query(`SELECT (date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC'))::text AS t`)).rows[0].t as string;
      if (kind === 'publish') await publishAt(x, key, claim, t); else await failAt(x, key, claim, t);
      await untilDeadline(x, key, claim);
    }), 'PO007', `${kind}: the deferred check refuses the late COMMIT`);
    assert.deepEqual(await observe(key), before, `${kind}: nothing committed`);
  }
});

test('a receipt-only no-op on an already SUCCEEDED attempt after its deadline is not a publication; a new snapshot for it is refused', async () => {
  const claim = await inTx(runtime, scopeOf(KEY_A), x => claimAttempt(x, KEY_A, 'syncer'));
  await inTx(runtime, scopeOf(KEY_A), x => publishAttempt(x, KEY_A, claim, SUMMARY));
  await ageConnection(pgdb.owner, KEY_A, '90 seconds');
  const before = await observe(KEY_A);
  assert.equal(await attempt(runtime, KEY_A, async x => { await locked(x, KEY_A, claim);
    await x.query(`UPDATE public."PowerOfficeAttempt" SET state = state, "completedAt" = "completedAt" WHERE id = $1`, [claim.id]); }), undefined);
  assert.equal(await attempt(runtime, KEY_A, async x => { const l = await locked(x, KEY_A, claim);
    await insertSnapshot(x, KEY_A, claim, SUMMARY, l.before, '00000000-0000-4000-8000-0000000000ff'); }), 'PO002', 'no second publication of a terminal claim');
  assert.deepEqual(await observe(KEY_A), before);
});
