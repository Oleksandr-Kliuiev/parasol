import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '../support/pg-harness.ts';
import { KEY_A, KEY_A2, addPowerOfficeFixtures, commitState, connect, inTx, scopeOf, sqlState } from '../support/poweroffice-fixtures.ts';
import { EMPTY, SUMMARY, ageConnection, claimAttempt, closeAttempt, insertSnapshot, lockFence, publishAttempt } from '../support/poweroffice-history.ts';
import type { PoKey } from '../support/poweroffice-fixtures.ts';

// S4-A A2 on real PostgreSQL 17 through the confined runtime role: the DEFERRABLE INITIALLY DEFERRED constraint triggers
// check, at COMMIT, both directions of ACTIVE discoverability, latest/completed metadata and the published pointer
// (docs/stage4/IMPLEMENTATION_HANDOFF.md items 2 and 3). Each failing transaction leaves no partial effect.
const pgdb = await createTestDatabase();
after(async () => { await runtime.end().catch(() => undefined); await pgdb.drop(); });
await addPowerOfficeFixtures(pgdb.owner);
const runtime = await connect(pgdb.runtimeUrl);
const tx = <T>(key: PoKey, fn: Parameters<typeof inTx<T>>[2]) => inTx(runtime, scopeOf(key), fn);
/** Every statement succeeds; the deferred invariant refuses at COMMIT (SQLSTATE of the COMMIT itself). */
const atCommit = (key: PoKey, fn: Parameters<typeof commitState>[2]) => commitState(runtime, scopeOf(key), fn);
const KEY = `"workspaceId" = $1 AND "clientId" = $2 AND "connectionId" = $3`;
const k = (key: PoKey) => [key.workspaceId, key.clientId, key.connectionId];
const state = (key: PoKey) => tx(key, async c => (await c.query(`SELECT "nextSequence" AS n, "activeAttemptId"::text AS active, "snapshotId"::text AS snapshot,
  "lastAttemptState" AS last, "lastCompletedState" AS completed, "lastCompletedErrorCode" AS code, "lastSuccessAt" IS NOT NULL AS success
  FROM public."PowerOfficeState" WHERE ${KEY}`, k(key))).rows[0]);
const counts = (key: PoKey) => tx(key, async c => (await c.query(`SELECT (SELECT count(*)::int FROM public."PowerOfficeAttempt" WHERE ${KEY}) AS attempts,
  (SELECT count(*)::int FROM public."PowerOfficeSnapshot" WHERE ${KEY}) AS snapshots`, k(key))).rows[0]);

test('coherent history commits: claim → publish → claim → fail keeps the pointer → claim → publish moves it; known empty publishes too', async () => {
  const first = await tx(KEY_A, c => claimAttempt(c, KEY_A, 'syncer'));
  assert.deepEqual(await state(KEY_A), { n: 2, active: first.id, snapshot: null, last: 'ACTIVE', completed: null, code: null, success: false });
  await tx(KEY_A, c => publishAttempt(c, KEY_A, first, SUMMARY));
  assert.deepEqual(await state(KEY_A), { n: 2, active: null, snapshot: first.allocatedSnapshotId, last: 'SUCCEEDED', completed: 'SUCCEEDED', code: null, success: true });
  const second = await tx(KEY_A, c => claimAttempt(c, KEY_A, 'syncer'));
  assert.equal((await state(KEY_A)).completed, 'SUCCEEDED', 'an ACTIVE claim keeps the last completed outcome');
  await tx(KEY_A, c => closeAttempt(c, KEY_A, second, 'FAILED', 'POWEROFFICE_SOURCE_FAILED'));
  assert.deepEqual(await state(KEY_A), { n: 3, active: null, snapshot: first.allocatedSnapshotId, last: 'FAILED', completed: 'FAILED',
    code: 'POWEROFFICE_SOURCE_FAILED', success: true }, 'failure preserves the snapshot and last success');
  const third = await tx(KEY_A, c => claimAttempt(c, KEY_A, 'syncer'));
  await tx(KEY_A, c => publishAttempt(c, KEY_A, third, EMPTY));
  assert.deepEqual(await state(KEY_A), { n: 4, active: null, snapshot: third.allocatedSnapshotId, last: 'SUCCEEDED', completed: 'SUCCEEDED', code: null, success: true });
});

test('orphan ACTIVE attempt and ACTIVE pointer without its ACTIVE row both fail at COMMIT with zero effects', async () => {
  const before = await counts(KEY_A2);
  // ACTIVE attempt inserted, State pointer/sequence never updated
  assert.equal(await atCommit(KEY_A2, async c => {
    await lockFence(c, KEY_A2.workspaceId);
    await c.query(`INSERT INTO public."PowerOfficeState" ("workspaceId", "clientId", "connectionId") VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, k(KEY_A2));
    await c.query(`INSERT INTO public."PowerOfficeAttempt" ("workspaceId", "clientId", "connectionId", id, sequence, "claimToken", "allocatedSnapshotId",
        "lifecycleVersion", "actorId", "correlationId", "startedAt", "readDeadlineAt", "deadlineAt")
      SELECT $1, $2, $3, $4, 1, $5, $6, 1, 'syncer', $7, t, t + interval '60 seconds', t + interval '80 seconds'
        FROM (SELECT date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC') AS t) n`, [...k(KEY_A2), randomUUID(), randomUUID(), randomUUID(), randomUUID()]);
  }), 'PO004');
  assert.deepEqual(await counts(KEY_A2), before, 'the State insert rolled back with it');
  // A terminal attempt named as the ACTIVE pointer of a "new claim"
  const done = await tx(KEY_A2, c => claimAttempt(c, KEY_A2, 'syncer'));
  await tx(KEY_A2, c => closeAttempt(c, KEY_A2, done, 'FAILED', 'POWEROFFICE_DTO_INVALID'));
  assert.equal(await atCommit(KEY_A2, c => c.query(`UPDATE public."PowerOfficeState" SET "nextSequence" = "nextSequence" + 1, "activeAttemptId" = $4,
    "lastAttemptId" = $4, "lastAttemptState" = 'ACTIVE', "lastAttemptErrorCode" = NULL WHERE ${KEY}`, [...k(KEY_A2), done.id])), 'PO004');
  assert.deepEqual(await state(KEY_A2), { n: 2, active: null, snapshot: null, last: 'FAILED', completed: 'FAILED', code: 'POWEROFFICE_DTO_INVALID', success: false });
});

test('wrong or partial publication fails at COMMIT: snapshot of a still-ACTIVE claim, SUCCEEDED without pointer, pointer with a different lastSuccessAt', async () => {
  const claim = await tx(KEY_A2, c => claimAttempt(c, KEY_A2, 'syncer'));
  const now = `(date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC'))::text`;
  const at = async (c: Parameters<Parameters<typeof tx>[1]>[0]) => (await c.query(`SELECT ${now} AS t`)).rows[0].t as string;
  // 1. snapshot inserted, attempt left ACTIVE, State untouched
  assert.equal(await atCommit(KEY_A2, async c => insertSnapshot(c, KEY_A2, claim, SUMMARY, await at(c))), 'PO004');
  // 2. snapshot + SUCCEEDED attempt, State never updated (pointer and ACTIVE pointer disagree)
  assert.equal(await atCommit(KEY_A2, async c => {
    const t = await at(c);
    await insertSnapshot(c, KEY_A2, claim, SUMMARY, t);
    await c.query(`UPDATE public."PowerOfficeAttempt" SET state = 'SUCCEEDED', "completedAt" = $5 WHERE ${KEY} AND id = $4`, [...k(KEY_A2), claim.id, t]);
  }), 'PO004');
  // 3. SUCCEEDED without a snapshot: the State's success transition requires a new pointer (guard, at once)
  assert.equal(await sqlState(tx(KEY_A2, async c => {
    const t = await at(c);
    await c.query(`UPDATE public."PowerOfficeAttempt" SET state = 'SUCCEEDED', "completedAt" = $5 WHERE ${KEY} AND id = $4`, [...k(KEY_A2), claim.id, t]);
    await c.query(`UPDATE public."PowerOfficeState" SET "activeAttemptId" = NULL, "lastAttemptState" = 'SUCCEEDED', "lastCompletedAttemptId" = $4,
      "lastCompletedState" = 'SUCCEEDED', "lastCompletedErrorCode" = NULL, "lastSuccessAt" = $5 WHERE ${KEY}`, [...k(KEY_A2), claim.id, t]);
  })), 'PO002');
  // 4. full publication but lastSuccessAt differs from the pointer's publishedAt
  assert.equal(await atCommit(KEY_A2, async c => {
    const t = await at(c);
    await insertSnapshot(c, KEY_A2, claim, SUMMARY, t);
    await c.query(`UPDATE public."PowerOfficeAttempt" SET state = 'SUCCEEDED', "completedAt" = $5 WHERE ${KEY} AND id = $4`, [...k(KEY_A2), claim.id, t]);
    await c.query(`UPDATE public."PowerOfficeState" SET "activeAttemptId" = NULL, "lastAttemptState" = 'SUCCEEDED', "lastCompletedAttemptId" = $4,
      "lastCompletedState" = 'SUCCEEDED', "lastCompletedErrorCode" = NULL, "snapshotId" = $5, "snapshotVersion" = 1,
      "lastSuccessAt" = $6::timestamp(3) - interval '1 second' WHERE ${KEY}`, [...k(KEY_A2), claim.id, claim.allocatedSnapshotId, t]);
  }), 'PO004');
  assert.deepEqual(await counts(KEY_A2), { attempts: 2, snapshots: 0 }, 'no partial publication survived');
  assert.equal((await state(KEY_A2)).active, claim.id, 'the claim stays ACTIVE and recoverable');
  await tx(KEY_A2, c => publishAttempt(c, KEY_A2, claim, SUMMARY));
  assert.equal((await state(KEY_A2)).snapshot, claim.allocatedSnapshotId);
});

test('pointer moves only by publication or expired purge: no older/foreign snapshot; purge clears it and keeps lastSuccessAt and the SUCCEEDED outcome', async () => {
  const s = await state(KEY_A);
  const old = (await tx(KEY_A, async c => (await c.query(`SELECT id::text AS id FROM public."PowerOfficeSnapshot" WHERE ${KEY} AND id <> $4 ORDER BY "publishedAt" LIMIT 1`,
    [...k(KEY_A), s.snapshot])).rows[0].id)) as string;
  assert.equal(await sqlState(tx(KEY_A, c => c.query(`UPDATE public."PowerOfficeState" SET "snapshotId" = $4 WHERE ${KEY}`, [...k(KEY_A), old]))), 'PO002');
  assert.equal(await sqlState(tx(KEY_A, c => c.query(`UPDATE public."PowerOfficeState" SET "snapshotId" = NULL, "snapshotVersion" = NULL WHERE ${KEY}`, k(KEY_A)))),
    'PO002', 'an unexpired pointer is never cleared');
  const a2 = (await tx(KEY_A2, async c => (await c.query(`SELECT "snapshotId"::text AS id FROM public."PowerOfficeState" WHERE ${KEY}`, k(KEY_A2))).rows[0].id)) as string;
  assert.equal(await sqlState(tx(KEY_A, c => c.query(`UPDATE public."PowerOfficeState" SET "snapshotId" = $4 WHERE ${KEY}`, [...k(KEY_A), a2]))), 'PO002',
    'another connection\'s snapshot is refused (guard; the scoped FK is tested in poweroffice-schema)');
  await ageConnection(pgdb.owner, KEY_A, '25 hours');
  await tx(KEY_A, c => c.query(`UPDATE public."PowerOfficeState" SET "snapshotId" = NULL, "snapshotVersion" = NULL WHERE ${KEY}`, k(KEY_A)));
  assert.deepEqual(await state(KEY_A), { n: 4, active: null, snapshot: null, last: 'SUCCEEDED', completed: 'SUCCEEDED', code: null, success: true },
    'purged: pointer null, lastSuccessAt and lastCompleted retained');
  // A purged pointer can only be replaced by a new publication; an unexpired orphan snapshot cannot exist without it.
  const next = await tx(KEY_A, c => claimAttempt(c, KEY_A, 'syncer'));
  await tx(KEY_A, c => publishAttempt(c, KEY_A, next, SUMMARY));
  assert.equal((await state(KEY_A)).snapshot, next.allocatedSnapshotId);
});
