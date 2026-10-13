import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '../support/pg-harness.ts';
import { CA, KEY_A, KEY_A2, KEY_B, WS, addPowerOfficeFixtures, connect, inTx, scopeOf, sqlState, stateOf } from '../support/poweroffice-fixtures.ts';
import type { PoKey } from '../support/poweroffice-fixtures.ts';
import { SUMMARY, ageConnection, claimAttempt, closeAttempt, publishAttempt } from '../support/poweroffice-history.ts';

// S4-A A2 on PostgreSQL 17: immutable identities and history, lifecycle transitions, DB-clock start/completion/publication,
// exact deadlines, the 1000 retained-attempt cap and the DELETE/TRUNCATE guards. Direct SQL as the table OWNER (a
// superuser here: RLS bypassed, triggers still fire) cannot forge history; the confined runtime lacks the privileges.
const pgdb = await createTestDatabase();
after(async () => { await runtime.end().catch(() => undefined); await pgdb.drop(); });
await addPowerOfficeFixtures(pgdb.owner);
const runtime = await connect(pgdb.runtimeUrl);
const owner = pgdb.owner;
const KEY = `"workspaceId" = $1 AND "clientId" = $2 AND "connectionId" = $3`;
const k = (key: PoKey) => [key.workspaceId, key.clientId, key.connectionId];
/** Owner statement in a rolled-back transaction: its SQLSTATE, or undefined when it succeeded. */
async function asOwner(sql: string, params: unknown[] = []): Promise<string | undefined> {
  await owner.query('BEGIN');
  try { await owner.query(sql, params); return undefined; } catch (error) { return stateOf(error) ?? 'NO_SQLSTATE'; } finally { await owner.query('ROLLBACK'); }
}
const rt = <T>(key: PoKey, fn: Parameters<typeof inTx<T>>[2]) => inTx(runtime, scopeOf(key), fn);

const done = await rt(KEY_A, c => claimAttempt(c, KEY_A, 'syncer'));
await rt(KEY_A, c => publishAttempt(c, KEY_A, done, SUMMARY));
const failed = await rt(KEY_A, c => claimAttempt(c, KEY_A, 'syncer'));
await rt(KEY_A, c => closeAttempt(c, KEY_A, failed, 'FAILED', 'POWEROFFICE_SOURCE_FAILED'));
const active = await rt(KEY_A, c => claimAttempt(c, KEY_A, 'syncer'));

test('attempt identity and terminal history are immutable for the owner; the runtime cannot even write those columns', async () => {
  for (const [column, value] of [['claimToken', randomUUID()], ['allocatedSnapshotId', randomUUID()], ['actorId', 'reader'], ['correlationId', randomUUID()],
    ['lifecycleVersion', 2], ['sequence', 99]] as const) {
    assert.equal(await asOwner(`UPDATE public."PowerOfficeAttempt" SET "${column}" = $4 WHERE ${KEY} AND id = $5`, [...k(KEY_A), value, active.id]), 'PO001', column);
    assert.equal(await sqlState(rt(KEY_A, c => c.query(`UPDATE public."PowerOfficeAttempt" SET "${column}" = $4 WHERE ${KEY} AND id = $5`,
      [...k(KEY_A), value, active.id]))), '42501', `runtime ${column}`);
  }
  assert.equal(await asOwner(`UPDATE public."PowerOfficeAttempt" SET "startedAt" = "startedAt" - interval '1 hour', "readDeadlineAt" = "readDeadlineAt" - interval '1 hour',
    "deadlineAt" = "deadlineAt" - interval '1 hour' WHERE ${KEY} AND id = $4`, [...k(KEY_A), active.id]), 'PO001', 'no backdating of a claim');
  assert.equal(await asOwner(`UPDATE public."PowerOfficeAttempt" SET state = 'ACTIVE', "completedAt" = NULL, "safeErrorCode" = NULL WHERE ${KEY} AND id = $4`,
    [...k(KEY_A), failed.id]), 'PO002', 'no terminal revival');
  assert.equal(await asOwner(`UPDATE public."PowerOfficeAttempt" SET "safeErrorCode" = 'POWEROFFICE_DEADLINE' WHERE ${KEY} AND id = $4`, [...k(KEY_A), failed.id]),
    'PO002', 'no rewrite of a terminal code');
  assert.equal(await asOwner(`UPDATE public."PowerOfficeAttempt" SET state = 'SUCCEEDED', "completedAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '11 seconds'
    WHERE ${KEY} AND id = $4`, [...k(KEY_A), active.id]), 'PO002', 'completion at a stale time');
  assert.equal(await asOwner(`UPDATE public."PowerOfficeAttempt" SET state = 'FAILED', "completedAt" = (clock_timestamp() AT TIME ZONE 'UTC') + interval '1 second',
    "safeErrorCode" = 'POWEROFFICE_DEADLINE' WHERE ${KEY} AND id = $4`, [...k(KEY_A), active.id]), 'PO002', 'completion in the future');
  assert.equal(await asOwner(`UPDATE public."PowerOfficeSnapshot" SET summary = '{"totalCount":0,"currencies":[]}' WHERE ${KEY}`, k(KEY_A)), 'PO001');
  assert.equal(await sqlState(rt(KEY_A, c => c.query(`UPDATE public."PowerOfficeSnapshot" SET summary = '{}' WHERE ${KEY}`, k(KEY_A)))), '42501');
});

test('State: no rewind, skip, claim replacement, history rewrite, scope move or non-empty initialization', async () => {
  const set = (assignments: string, params: unknown[] = []) => asOwner(`UPDATE public."PowerOfficeState" SET ${assignments} WHERE ${KEY}`, [...k(KEY_A), ...params]);
  assert.equal(await set(`"nextSequence" = 1, "activeAttemptId" = NULL, "lastAttemptId" = NULL, "lastAttemptState" = NULL, "lastCompletedAttemptId" = NULL,
    "lastCompletedState" = NULL, "lastCompletedErrorCode" = NULL, "snapshotId" = NULL, "snapshotVersion" = NULL, "lastSuccessAt" = NULL`), 'PO002', 'rewind');
  assert.equal(await set(`"nextSequence" = "nextSequence" + 2`), 'PO002', 'skip');
  assert.equal(await set(`"activeAttemptId" = $4, "lastAttemptId" = $4`, [failed.id]), 'PO002', 'claim replacement');
  assert.equal(await set(`"lastCompletedErrorCode" = 'POWEROFFICE_DEADLINE'`), 'PO001', 'completed outcome rewrite while ACTIVE');
  assert.equal(await set(`"lastSuccessAt" = "lastSuccessAt" - interval '1 second'`), 'PO001', 'lastSuccessAt rewrite');
  assert.equal(await set(`"connectionId" = 'po-a2'`), 'PO001', 'scope move');
  assert.equal(await asOwner(`INSERT INTO public."PowerOfficeState" ("workspaceId", "clientId", "connectionId", "nextSequence") VALUES ($1, $2, 'po-unbound', 2)`,
    [WS, CA]), 'PO002', 'initialization starts empty');
  assert.equal(await sqlState(rt(KEY_A, c => c.query(`UPDATE public."PowerOfficeState" SET "workspaceId" = 'x' WHERE ${KEY}`, k(KEY_A)))), '42501');
});

test('claims: ACTIVE at the next sequence of an idle State with a current DB start time; only the ACTIVE claim publishes, before its deadline', async () => {
  const insertClaim = (key: PoKey, sequence: number, start: string, state = 'ACTIVE') => sqlState(rt(key, c => c.query(
    `INSERT INTO public."PowerOfficeAttempt" ("workspaceId", "clientId", "connectionId", id, sequence, "claimToken", "allocatedSnapshotId", "lifecycleVersion",
       "actorId", "correlationId", "startedAt", "readDeadlineAt", "deadlineAt", state, "completedAt", "safeErrorCode")
     SELECT $1, $2, $3, $4, $5, $6, $7, 1, 'syncer', $8, t, t + interval '60 seconds', t + interval '80 seconds', $9,
            CASE WHEN $9 = 'ACTIVE' THEN NULL ELSE t END, CASE WHEN $9 = 'FAILED' THEN 'POWEROFFICE_SOURCE_FAILED' END
       FROM (SELECT date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC') + $10::interval AS t) n`,
    [...k(key), randomUUID(), sequence, randomUUID(), randomUUID(), randomUUID(), state, start])));
  assert.equal(await insertClaim(KEY_A, 4, '0 seconds'), 'PO002', 'a second ACTIVE claim of a busy State');
  await rt(KEY_B, c => c.query(`INSERT INTO public."PowerOfficeState" ("workspaceId", "clientId", "connectionId") VALUES ($1, $2, $3)`, k(KEY_B)));
  assert.equal(await insertClaim(KEY_B, 2, '0 seconds'), 'PO002', 'not the next sequence');
  assert.equal(await insertClaim(KEY_B, 1, '-11 seconds'), 'PO002', 'backdated start');
  assert.equal(await insertClaim(KEY_B, 1, '1 second'), 'PO002', 'future start');
  assert.equal(await insertClaim(KEY_B, 1, '0 seconds', 'FAILED'), 'PO002', 'born terminal');
  // An ACTIVE claim past its deadline cannot publish, cannot FAIL; it can only be ABANDONED (recovery semantics).
  const late = await rt(KEY_A2, c => claimAttempt(c, KEY_A2, 'syncer'));
  await ageConnection(owner, KEY_A2, '81 seconds');
  assert.equal(await sqlState(rt(KEY_A2, c => publishAttempt(c, KEY_A2, late, SUMMARY))), 'PO007', 'publication after the deadline (actual DB clock)');
  assert.equal(await sqlState(rt(KEY_A2, c => closeAttempt(c, KEY_A2, late, 'FAILED', 'POWEROFFICE_SOURCE_FAILED'))), 'PO007', 'private failure after the deadline (actual DB clock)');
  await rt(KEY_A2, c => closeAttempt(c, KEY_A2, late, 'ABANDONED', 'POWEROFFICE_DEADLINE'));
  const early = await rt(KEY_A2, c => claimAttempt(c, KEY_A2, 'syncer'));
  assert.equal(await sqlState(rt(KEY_A2, c => closeAttempt(c, KEY_A2, early, 'ABANDONED', 'POWEROFFICE_DEADLINE'))), 'PO007', 'recovery before the deadline (actual DB clock)');
  await rt(KEY_A2, c => closeAttempt(c, KEY_A2, early, 'FAILED', 'POWEROFFICE_BINDING_CHANGED'));
});

test('DELETE guards for every role: expired unreferenced snapshots and old unreferenced terminal attempts only; State and TRUNCATE never', async () => {
  const del = (table: string, where = '', params: unknown[] = []) => asOwner(`DELETE FROM public."${table}" WHERE ${KEY} ${where}`, [...k(KEY_A), ...params]);
  assert.equal(await del('PowerOfficeSnapshot'), 'PO003', 'unexpired snapshot');
  assert.equal(await del('PowerOfficeAttempt', 'AND id = $4', [active.id]), 'PO003', 'ACTIVE attempt');
  assert.equal(await del('PowerOfficeAttempt', 'AND id = $4', [failed.id]), 'PO003', 'young terminal attempt');
  assert.equal(await del('PowerOfficeState'), 'PO003', 'State is never deleted');
  for (const t of ['PowerOfficeState', 'PowerOfficeAttempt', 'PowerOfficeSnapshot']) assert.equal(await asOwner(`TRUNCATE public."${t}" CASCADE`), 'PO003', `TRUNCATE ${t}`);
  for (const t of ['PowerOfficeState', 'PowerOfficeAttempt', 'PowerOfficeSnapshot']) {
    assert.equal(await sqlState(rt(KEY_A, c => c.query(`DELETE FROM public."${t}" WHERE ${KEY}`, k(KEY_A)))), '42501', `runtime DELETE ${t}`);
  }
  await rt(KEY_A, c => closeAttempt(c, KEY_A, active, 'FAILED', 'POWEROFFICE_EXPORT_INCOMPLETE'));
  await ageConnection(owner, KEY_A, '31 days');
  assert.equal(await del('PowerOfficeSnapshot'), 'PO003', 'expired but still the State pointer');
  assert.equal(await del('PowerOfficeAttempt', 'AND id = $4', [done.id]), 'PO003', 'old attempt that owns a snapshot');
  assert.equal(await del('PowerOfficeAttempt', 'AND id = $4', [active.id]), 'PO003', 'old attempt that is lastAttempt/lastCompleted');
  assert.equal(await del('PowerOfficeAttempt', 'AND id = $4', [failed.id]), undefined, 'old, terminal and unreferenced: deletable');
});

test('a connection with 1000 retained attempts refuses a new claim inside the claim transaction (PO006)', async () => {
  // Superuser fixture: 999 FAILED + 1 last FAILED attempt with coherent State, written with the guards off.
  await owner.query('BEGIN');
  try {
    await owner.query('SET LOCAL session_replication_role = replica');
    await owner.query(`INSERT INTO public."PowerOfficeAttempt" ("workspaceId", "clientId", "connectionId", id, sequence, "claimToken", "allocatedSnapshotId",
        "lifecycleVersion", "actorId", "correlationId", "startedAt", "readDeadlineAt", "deadlineAt", state, "completedAt", "safeErrorCode")
      SELECT $1, $2, 'po-unbound', gen_random_uuid(), s, gen_random_uuid(), gen_random_uuid(), 1, 'syncer', gen_random_uuid(), t, t + interval '60 seconds',
             t + interval '80 seconds', 'FAILED', t + interval '1 second', 'POWEROFFICE_SOURCE_FAILED'
        FROM generate_series(1, 1000) s, (SELECT date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC') - interval '1 day' AS t) n`, [WS, CA]);
    await owner.query(`INSERT INTO public."PowerOfficeState" ("workspaceId", "clientId", "connectionId", "nextSequence", "lastAttemptId", "lastAttemptState",
        "lastAttemptErrorCode", "lastCompletedAttemptId", "lastCompletedState", "lastCompletedErrorCode")
      SELECT $1, $2, 'po-unbound', 1001, a.id, 'FAILED', a."safeErrorCode", a.id, 'FAILED', a."safeErrorCode"
        FROM public."PowerOfficeAttempt" a WHERE a."connectionId" = 'po-unbound' AND a.sequence = 1000`, [WS, CA]);
    await owner.query('COMMIT');
  } catch (error) { await owner.query('ROLLBACK'); throw error; }
  const key = { workspaceId: WS, clientId: CA, connectionId: 'po-unbound' };
  assert.equal(await sqlState(rt(key, c => claimAttempt(c, key, 'syncer'))), 'PO006');
});
