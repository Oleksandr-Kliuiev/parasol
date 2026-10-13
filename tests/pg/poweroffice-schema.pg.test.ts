import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '../support/pg-harness.ts';
import { CA, CB, KEY_A, KEY_A2, KEY_B, WS, addPowerOfficeFixtures, connect, inTx, scopeOf, stateOf } from '../support/poweroffice-fixtures.ts';
import { SUMMARY, claimAttempt, publishAttempt } from '../support/poweroffice-history.ts';

// S4-A A2 on PostgreSQL 17: strict CHECK truth semantics (NULL never passes as UNKNOWN) and scoped compound foreign keys.
// CHECKs are isolated from the guards with session_replication_role = replica (superuser fixture; CHECKs still apply, row
// triggers do not); the scoped FKs with only the guard/commit triggers disabled. Every probe runs in a rolled-back transaction.
const pgdb = await createTestDatabase();
after(async () => { await runtime.end().catch(() => undefined); await pgdb.drop(); });
await addPowerOfficeFixtures(pgdb.owner);
const runtime = await connect(pgdb.runtimeUrl);
const owner = pgdb.owner;
const claimA = await inTx(runtime, scopeOf(KEY_A), c => claimAttempt(c, KEY_A, 'syncer'));
await inTx(runtime, scopeOf(KEY_A), c => publishAttempt(c, KEY_A, claimA, SUMMARY));
const claimA2 = await inTx(runtime, scopeOf(KEY_A2), c => claimAttempt(c, KEY_A2, 'syncer'));

/** SQLSTATE of `sql` in a transaction that is always rolled back; `setup` prepares the session (replica mode, disabled triggers). */
async function probe(setup: string, sql: string, params: unknown[] = []): Promise<string | undefined> {
  await owner.query('BEGIN');
  try { if (setup) await owner.query(setup); await owner.query(sql, params); return undefined; }
  catch (error) { return stateOf(error) ?? 'NO_SQLSTATE'; }
  finally { await owner.query('ROLLBACK'); }
}
const REPLICA = 'SET LOCAL session_replication_role = replica';
const cols = (row: Record<string, unknown>) => Object.keys(row).map(c => `"${c}"`).join(', ');
const vals = (row: Record<string, unknown>) => Object.keys(row).map((_, i) => `$${i + 1}`).join(', ');
const insert = (table: string, row: Record<string, unknown>, setup = REPLICA) =>
  probe(setup, `INSERT INTO public."${table}" (${cols(row)}) VALUES (${vals(row)})`, Object.values(row));

const T0 = '2026-10-24 22:30:00.000';
const plus = (s: number) => new Date(Date.parse(`${T0.replace(' ', 'T')}Z`) + s * 1000).toISOString().replace('T', ' ').replace('Z', '');
const scope = { workspaceId: WS, clientId: CA, connectionId: 'po-unbound' };
const a1 = randomUUID(); const a2 = randomUUID();
const STATE = { ...scope, nextSequence: 2, activeAttemptId: null, snapshotId: null, snapshotVersion: null, lastAttemptId: a1, lastAttemptState: 'FAILED',
  lastAttemptErrorCode: 'POWEROFFICE_DEADLINE', lastCompletedAttemptId: a1, lastCompletedState: 'FAILED', lastCompletedErrorCode: 'POWEROFFICE_DEADLINE',
  lastSuccessAt: null, updatedAt: T0 };
const ATTEMPT = { ...scope, id: a2, sequence: 1, claimToken: randomUUID(), allocatedSnapshotId: randomUUID(), lifecycleVersion: 1, actorId: 'syncer',
  correlationId: randomUUID(), startedAt: T0, readDeadlineAt: plus(60), deadlineAt: plus(80), state: 'SUCCEEDED', completedAt: plus(5), safeErrorCode: null };
const SNAPSHOT = { ...scope, id: randomUUID(), attemptId: a2, lifecycleVersion: 1, asOf: T0, businessDate: '2026-10-25', publishedAt: plus(5),
  expiresAt: plus(5 + 86_400), summary: JSON.stringify(SUMMARY), synthetic: true };

test('State CHECK: partial-null pairs/tuples, outcome codes, ACTIVE pointer and success coherence; NULL never passes', async () => {
  assert.equal(await insert('PowerOfficeState', STATE), undefined, 'the baseline row is valid');
  const cases: [string, Record<string, unknown>, string][] = [
    ['pointer without version', { snapshotId: randomUUID(), lastSuccessAt: T0 }, '23514'], ['version without pointer', { snapshotVersion: 1 }, '23514'],
    ['version 0', { snapshotId: randomUUID(), snapshotVersion: 0, lastSuccessAt: T0 }, '23514'],
    ['lastAttempt without state', { lastAttemptState: null, lastAttemptErrorCode: null }, '23514'],
    ['claim history at sequence 1', { nextSequence: 1 }, '23514'], ['sequence 0', { nextSequence: 0 }, '23514'], ['sequence NULL', { nextSequence: null }, '23502'],
    ['FAILED without code', { lastAttemptErrorCode: null, lastCompletedErrorCode: null }, '23514'],
    ['unknown code', { lastAttemptErrorCode: 'NOT_A_CODE', lastCompletedErrorCode: 'NOT_A_CODE' }, '23514'],
    ['non-attempt code', { lastAttemptErrorCode: 'POWEROFFICE_SYNC_BUSY', lastCompletedErrorCode: 'POWEROFFICE_SYNC_BUSY' }, '23514'],
    ['SUCCEEDED with code', { lastAttemptState: 'SUCCEEDED', lastCompletedState: 'SUCCEEDED' }, '23514'],
    ['ACTIVE without pointer', { lastAttemptState: 'ACTIVE', lastAttemptErrorCode: null }, '23514'],
    ['pointer to a terminal last attempt', { activeAttemptId: a1 }, '23514'],
    ['ACTIVE pointer to another than lastAttempt', { activeAttemptId: a2, lastAttemptState: 'ACTIVE', lastAttemptErrorCode: null }, '23514'],
    ['terminal lastAttempt differs from lastCompleted', { lastCompletedAttemptId: a2 }, '23514'],
    ['lastCompleted state NULL with ID', { lastCompletedState: null, lastCompletedErrorCode: null }, '23514'],
    ['lastCompleted ACTIVE', { lastAttemptState: 'ACTIVE', activeAttemptId: a1, lastAttemptErrorCode: null, lastCompletedState: 'ACTIVE', lastCompletedErrorCode: null }, '23514'],
    ['pointer without lastSuccessAt', { snapshotId: randomUUID(), snapshotVersion: 1 }, '23514'],
    ['success without completed claim', { nextSequence: 1, lastAttemptId: null, lastAttemptState: null, lastAttemptErrorCode: null, lastCompletedAttemptId: null,
      lastCompletedState: null, lastCompletedErrorCode: null, lastSuccessAt: T0 }, '23514'],
  ];
  for (const [label, change, expected] of cases) assert.equal(await insert('PowerOfficeState', { ...STATE, ...change }), expected, label);
});

test('Attempt CHECK: exact 60/80 s deadlines, lifecycle columns, fixed codes, deadline side of FAILED/ABANDONED, bounded identities', async () => {
  assert.equal(await insert('PowerOfficeAttempt', ATTEMPT), undefined, 'the baseline row is valid');
  const cases: [string, Record<string, unknown>, string][] = [
    ['read deadline 61 s', { readDeadlineAt: plus(61) }, '23514'], ['deadline 79 s', { deadlineAt: plus(79) }, '23514'],
    ['ACTIVE with completedAt', { state: 'ACTIVE' }, '23514'], ['ACTIVE with code', { state: 'ACTIVE', completedAt: null, safeErrorCode: 'POWEROFFICE_DEADLINE' }, '23514'],
    ['SUCCEEDED with code', { safeErrorCode: 'POWEROFFICE_DEADLINE' }, '23514'], ['SUCCEEDED at the deadline', { completedAt: plus(80) }, '23514'],
    ['SUCCEEDED before start', { completedAt: plus(-1) }, '23514'], ['terminal without completedAt', { completedAt: null }, '23514'],
    ['FAILED without code', { state: 'FAILED' }, '23514'], ['FAILED at the deadline', { state: 'FAILED', completedAt: plus(80), safeErrorCode: 'POWEROFFICE_SOURCE_FAILED' }, '23514'],
    ['ABANDONED before the deadline', { state: 'ABANDONED', completedAt: plus(79), safeErrorCode: 'POWEROFFICE_DEADLINE' }, '23514'],
    ['unknown state', { state: 'DONE' }, '23514'], ['unknown code', { state: 'FAILED', safeErrorCode: 'BOOM' }, '23514'],
    ['sequence 0', { sequence: 0 }, '23514'], ['lifecycle 0', { lifecycleVersion: 0 }, '23514'], ['actor id shape', { actorId: 'bad actor' }, '23514'],
    ['claim token NULL', { claimToken: null }, '23502'], ['deadline NULL', { deadlineAt: null }, '23502'],
  ];
  for (const [label, change, expected] of cases) assert.equal(await insert('PowerOfficeAttempt', { ...ATTEMPT, ...change }), expected, label);
  assert.equal(await insert('PowerOfficeAttempt', { ...ATTEMPT, state: 'ABANDONED', completedAt: plus(80), safeErrorCode: 'POWEROFFICE_DEADLINE' }), undefined,
    'ABANDONED at the deadline is valid');
});

test('Snapshot CHECK: synthetic marker, 24 h expiry, publication inside the 80 s claim, Europe/Oslo business date across DST, object summary', async () => {
  assert.equal(await insert('PowerOfficeSnapshot', SNAPSHOT), undefined, '22:30 UTC on 24 Oct 2026 is 00:30 on the 25th in Oslo (CEST)');
  const cases: [string, Record<string, unknown>, string][] = [
    ['UTC date instead of Oslo', { businessDate: '2026-10-24' }, '23514'], ['synthetic false', { synthetic: false }, '23514'],
    ['synthetic NULL', { synthetic: null }, '23502'], ['expiry 23 h', { expiresAt: plus(5 + 82_800) }, '23514'],
    ['published before asOf', { publishedAt: plus(-1), expiresAt: plus(86_399) }, '23514'],
    ['published at asOf + 80 s', { publishedAt: plus(80), expiresAt: plus(80 + 86_400) }, '23514'],
    ['array summary', { summary: '[]' }, '23514'], ['summary NULL', { summary: null }, '23502'], ['lifecycle 0', { lifecycleVersion: 0 }, '23514'],
  ];
  for (const [label, change, expected] of cases) assert.equal(await insert('PowerOfficeSnapshot', { ...SNAPSHOT, ...change }), expected, label);
  // Winter time: 23:30 UTC on 25 Oct 2026 is 00:30 on the 26th (CET), 22:59:59.999 UTC is still the 25th.
  const winter = (asOf: string, date: string) => insert('PowerOfficeSnapshot', { ...SNAPSHOT, asOf, businessDate: date, publishedAt: asOf,
    expiresAt: new Date(Date.parse(`${asOf.replace(' ', 'T')}Z`) + 86_400_000).toISOString().replace('T', ' ').replace('Z', '') });
  assert.equal(await winter('2026-10-25 23:30:00.000', '2026-10-26'), undefined);
  assert.equal(await winter('2026-10-25 22:59:59.999', '2026-10-25'), undefined);
  assert.equal(await winter('2026-10-25 22:59:59.999', '2026-10-26'), '23514');
});

test('scoped compound FKs: no reference across connection/client, snapshot bound to its attempt\'s allocated ID, version and asOf; actor workspace-scoped', async () => {
  const off = (table: string) => `ALTER TABLE public."${table}" DISABLE TRIGGER "${table}_guard"; ALTER TABLE public."${table}" DISABLE TRIGGER "${table}_commit"`;
  const update = (table: string, set: string, where: string, params: unknown[]) => probe(off(table), `UPDATE public."${table}" SET ${set} WHERE ${where}`, params);
  const keyA = `"workspaceId" = '${WS}' AND "clientId" = '${CA}' AND "connectionId" = 'po-a'`;
  assert.equal(await update('PowerOfficeState', `"activeAttemptId" = $1, "lastAttemptId" = $1, "lastAttemptState" = 'ACTIVE', "lastAttemptErrorCode" = NULL`, keyA, [claimA2.id]), '23503', 'ACTIVE pointer to another connection\'s attempt');
  assert.equal(await update('PowerOfficeState', `"snapshotVersion" = 2`, keyA, []), '23503', 'pointer with another lifecycle version');
  // Snapshot rows with the business date CHECK satisfied by computing it in SQL; only the composite FK may refuse.
  const snapshotProbe = (change: Record<string, unknown>) => probe(off('PowerOfficeSnapshot'),
    `INSERT INTO public."PowerOfficeSnapshot" ("workspaceId", "clientId", "connectionId", id, "attemptId", "lifecycleVersion", "asOf", "businessDate", "publishedAt", "expiresAt", summary)
     SELECT $1, $2, $3, $4, $5, $6, a."startedAt" + $7::interval, (((a."startedAt" + $7::interval) AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Oslo')::date,
            a."startedAt" + $7::interval, a."startedAt" + $7::interval + interval '24 hours', $8::jsonb
       FROM public."PowerOfficeAttempt" a WHERE a.id = $9`,
    [change.workspaceId ?? WS, change.clientId ?? CA, change.connectionId ?? 'po-a2', change.id ?? claimA2.allocatedSnapshotId, change.attemptId ?? claimA2.id,
      change.lifecycleVersion ?? 1, change.shift ?? '0 seconds', JSON.stringify(SUMMARY), claimA2.id]);
  assert.equal(await snapshotProbe({}), undefined, 'the matching composite key is accepted');
  assert.equal(await snapshotProbe({ id: randomUUID() }), '23503', 'snapshot ID other than the allocated one');
  assert.equal(await snapshotProbe({ lifecycleVersion: 2 }), '23503', 'another lifecycle version');
  assert.equal(await snapshotProbe({ shift: '1 millisecond' }), '23503', 'asOf other than the claim startedAt');
  assert.equal(await snapshotProbe({ connectionId: 'po-a' }), '23503', 'the same attempt under another connection');
  assert.equal(await snapshotProbe({ clientId: CB, connectionId: 'po-b' }), '23503', 'another client');
  const attempt = { ...ATTEMPT, workspaceId: WS, clientId: CA, connectionId: 'po-a2', id: randomUUID(), sequence: 99, allocatedSnapshotId: randomUUID() };
  assert.equal(await insert('PowerOfficeAttempt', { ...attempt }, `${off('PowerOfficeAttempt')}`), undefined);
  assert.equal(await insert('PowerOfficeAttempt', { ...attempt, actorId: 'outsider' }, off('PowerOfficeAttempt')), '23503',
    'an actor of another workspace');
  assert.equal(await insert('PowerOfficeAttempt', { ...attempt, connectionId: 'atera-a' }, off('PowerOfficeAttempt')), '23503',
    'no State row for that connection');
});

test('Actor deletion is RESTRICTed by retained attempt metadata; a Connection with PowerOffice history cannot be deleted', async () => {
  await owner.query(`INSERT INTO "Actor" ("workspaceId", id, "displayName") VALUES ($1, 'po-temp', 'Synthetic'), ($1, 'po-temp2', 'Synthetic')`, [WS]);
  assert.equal(await probe('', `DELETE FROM public."Actor" WHERE "workspaceId" = $1 AND id = 'po-temp2'`, [WS]), undefined, 'control: no reference');
  await inTx(runtime, scopeOf(KEY_B), c => claimAttempt(c, KEY_B, 'po-temp'));
  assert.equal(await probe('', `DELETE FROM public."Actor" WHERE "workspaceId" = $1 AND id = 'po-temp'`, [WS]), '23503');
  assert.equal(await probe('', `DELETE FROM public."Connection" WHERE "workspaceId" = $1 AND id = 'po-a'`, [WS]), '23503');
});
