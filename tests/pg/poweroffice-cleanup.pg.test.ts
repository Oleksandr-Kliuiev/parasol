import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createTestDatabase } from '../support/pg-harness.ts';
import { CA, CB, KEY_A, KEY_A2, KEY_B, KEY_DISABLED, WS, addPowerOfficeFixtures, connect, inTx, scopeOf, sqlState, stateOf } from '../support/poweroffice-fixtures.ts';
import type { PoKey } from '../support/poweroffice-fixtures.ts';
import { SUMMARY, ageConnection, claimAttempt, closeAttempt, publishAttempt } from '../support/poweroffice-history.ts';

// S4-A A3/item 5 on PostgreSQL 17: the SQL cleanup routine called DIRECTLY by the confined PowerOffice runner in explicit
// disposable transactions (the S4-C admission, runner pairing and 10 s wrapper are NOT part of this checkpoint). Scope GUCs
// must equal the arguments; fence → Connection → State; ACTIVE is BUSY; expired snapshots first (pointer cleared, lastSuccessAt
// kept), then old unreferenced attempts; combined 1000 rows with morePending; one safe audit; audit failure rolls back.
const pgdb = await createTestDatabase();
const clients: pg.Client[] = [];
after(async () => { for (const c of clients) await c.end().catch(() => undefined); await pgdb.drop(); });
await addPowerOfficeFixtures(pgdb.owner);
const runtime = await connect(pgdb.runtimeUrl); clients.push(runtime);
const runner = await connect(pgdb.poRunnerUrl); clients.push(runner);
const rt = <T>(key: PoKey, fn: Parameters<typeof inTx<T>>[2]) => inTx(runtime, scopeOf(key), fn);
interface Settings { workspace?: string; clients?: string; connection?: string; actor?: string }
/** One runner transaction: transaction-local settings, then the routine; COMMIT on success, ROLLBACK on failure. */
async function cleanup(key: PoKey, settings: Settings = {}, args: Partial<{ workspace: unknown; client: unknown; connection: unknown; correlation: unknown }> = {}) {
  await runner.query('BEGIN');
  try {
    await runner.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true), set_config('app.poweroffice_connection_id', $3, true),
      set_config('app.actor_id', $4, true)`, [settings.workspace ?? key.workspaceId, settings.clients ?? key.clientId, settings.connection ?? key.connectionId, settings.actor ?? 'maintainer']);
    const arg = (name: keyof typeof args, fallback: unknown) => (name in args ? args[name] : fallback);
    const result = (await runner.query(`SELECT public.atlas_poweroffice_cleanup($1, $2, $3, $4::uuid) AS r`, [arg('workspace', key.workspaceId),
      arg('client', key.clientId), arg('connection', key.connectionId), arg('correlation', randomUUID())])).rows[0].r;
    await runner.query('COMMIT');
    return result as { outcome: string; clearedPointer: boolean; deletedSnapshots: number; deletedAttempts: number; morePending: boolean };
  } catch (error) { await runner.query('ROLLBACK'); throw error; }
}
const failure = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => stateOf(e));
const snapshot = (key: PoKey) => rt(key, async c => (await c.query(`SELECT "snapshotId"::text AS pointer, "lastSuccessAt" IS NOT NULL AS success, "lastCompletedState" AS completed,
  (SELECT count(*)::int FROM public."PowerOfficeSnapshot" WHERE "connectionId" = $1) AS snapshots, (SELECT count(*)::int FROM public."PowerOfficeAttempt" WHERE "connectionId" = $1) AS attempts,
  (SELECT count(*)::int FROM public."AuditEvent" WHERE "eventType" = 'poweroffice.cleanup' AND metadata->>'connectionId' = $1) AS audits
  FROM public."PowerOfficeState" WHERE "connectionId" = $1`, [key.connectionId])).rows[0]);

test('scope GUCs must equal the arguments before any lock; foreign, non-PowerOffice or unbound connections refuse with zero effects', async () => {
  const c1 = await rt(KEY_A, c => claimAttempt(c, KEY_A, 'syncer'));
  await rt(KEY_A, c => publishAttempt(c, KEY_A, c1, SUMMARY));
  const before = await snapshot(KEY_A);
  for (const [label, settings, args] of [
    ['workspace setting differs', { workspace: 'po-ws-other' }, {}], ['client list is not the exact singleton', { clients: `${CA},${CB}` }, {}],
    ['blank client list', { clients: '' }, {}], ['connection setting blank', { connection: '' }, {}], ['connection setting differs', { connection: 'po-a2' }, {}],
    ['actor setting blank', { actor: '' }, {}], ['malformed actor', { actor: 'bad actor' }, {}], ['NULL correlation', {}, { correlation: null }],
    ['malformed connection argument', { connection: 'po a' }, { connection: 'po a' }], ['NULL workspace', {}, { workspace: null }],
    ['non-PowerOffice connection', { connection: 'atera-a' }, { connection: 'atera-a' }], ['connection without binding provenance', { connection: 'po-unbound' }, { connection: 'po-unbound' }],
    ['connection of another client', { clients: CA, connection: 'po-b' }, { client: CA, connection: 'po-b' }],
    ['client of another workspace named under this workspace', { clients: 'po-client-x', connection: 'po-x' }, { client: 'po-client-x', connection: 'po-x' }],
  ] as [string, Settings, Record<string, unknown>][]) {
    assert.equal(await failure(cleanup(KEY_A, settings, args)), 'PO010', label);
  }
  assert.deepEqual(await snapshot(KEY_A), before, 'no effect and no audit');
});

test('missing State is a no-op (never initialized); any ACTIVE attempt, even long expired, is BUSY with zero effects', async () => {
  assert.deepEqual(await cleanup(KEY_DISABLED), { outcome: 'NO_STATE', clearedPointer: false, deletedSnapshots: 0, deletedAttempts: 0, morePending: false });
  assert.equal(await rt(KEY_DISABLED, async c => (await c.query(`SELECT count(*)::int AS n FROM public."PowerOfficeState" WHERE "connectionId" = 'po-disabled'`)).rows[0].n), 0);
  const old = await rt(KEY_A2, c => claimAttempt(c, KEY_A2, 'syncer'));
  await rt(KEY_A2, c => publishAttempt(c, KEY_A2, old, SUMMARY));
  await rt(KEY_A2, c => claimAttempt(c, KEY_A2, 'syncer'));
  await ageConnection(pgdb.owner, KEY_A2, '40 days');
  const before = await snapshot(KEY_A2);
  assert.equal((await cleanup(KEY_A2)).outcome, 'BUSY');
  assert.deepEqual(await snapshot(KEY_A2), before, 'expired snapshot, old attempts and pointer all untouched while a claim is ACTIVE');
});

test('expired snapshots first with the pointer cleared atomically and audited; then old unreferenced attempts; lastAttempt/lastCompleted retained', async () => {
  const c2 = await rt(KEY_A, c => claimAttempt(c, KEY_A, 'syncer'));
  await rt(KEY_A, c => closeAttempt(c, KEY_A, c2, 'FAILED', 'POWEROFFICE_SOURCE_FAILED'));
  const c3 = await rt(KEY_A, c => claimAttempt(c, KEY_A, 'syncer'));
  await rt(KEY_A, c => publishAttempt(c, KEY_A, c3, SUMMARY));
  await ageConnection(pgdb.owner, KEY_A, '25 hours');
  // Expired but young: snapshots go, attempts (completed < 30 days) stay.
  assert.deepEqual(await cleanup(KEY_A), { outcome: 'COMPLETED', clearedPointer: true, deletedSnapshots: 2, deletedAttempts: 0, morePending: false });
  assert.deepEqual(await snapshot(KEY_A), { pointer: null, success: true, completed: 'SUCCEEDED', snapshots: 0, attempts: 3, audits: 1 },
    'purged: lastSuccessAt and the SUCCEEDED outcome survive');
  await ageConnection(pgdb.owner, KEY_A, '30 days');
  assert.deepEqual(await cleanup(KEY_A), { outcome: 'COMPLETED', clearedPointer: false, deletedSnapshots: 0, deletedAttempts: 2, morePending: false });
  assert.deepEqual(await snapshot(KEY_A), { pointer: null, success: true, completed: 'SUCCEEDED', snapshots: 0, attempts: 1, audits: 2 },
    'the latest (lastAttempt = lastCompleted) attempt is retained beyond 30 days');
  const audits = await rt(KEY_A, async c => (await c.query(`SELECT metadata, "actorId" FROM public."AuditEvent" WHERE "eventType" = 'poweroffice.cleanup' ORDER BY "recordedAt"`)).rows);
  assert.deepEqual(audits.map(a => Object.keys(a.metadata).sort()), [['connectionId', 'outcome', 'snapshotId'], ['connectionId', 'outcome']], 'six-key domain, no counts');
  assert.equal(audits[0].metadata.snapshotId, c3.allocatedSnapshotId); assert.equal(audits[0].actorId, 'maintainer');
});

test('a DISABLED connection with its immutable synthetic binding can still be purged (no source, no reactivation)', async () => {
  const claim = await rt(KEY_DISABLED, c => claimAttempt(c, KEY_DISABLED, 'syncer', 2));
  await rt(KEY_DISABLED, c => publishAttempt(c, KEY_DISABLED, claim, SUMMARY));
  await ageConnection(pgdb.owner, KEY_DISABLED, '2 days');
  assert.equal((await cleanup(KEY_DISABLED)).deletedSnapshots, 1);
  assert.equal((await pgdb.owner.query(`SELECT status FROM "Connection" WHERE id = 'po-disabled'`)).rows[0].status, 'DISABLED');
});

test('combined bound of 1000 rows per call (snapshots first) with morePending recomputed on eligible rows', async () => {
  const owner = pgdb.owner;
  await owner.query('BEGIN');
  try {
    await owner.query('SET LOCAL session_replication_role = replica');
    await owner.query(`INSERT INTO public."PowerOfficeAttempt" ("workspaceId", "clientId", "connectionId", id, sequence, "claimToken", "allocatedSnapshotId",
        "lifecycleVersion", "actorId", "correlationId", "startedAt", "readDeadlineAt", "deadlineAt", state, "completedAt", "safeErrorCode")
      SELECT $1, $2, 'po-b', gen_random_uuid(), s, gen_random_uuid(), gen_random_uuid(), 1, 'syncer', gen_random_uuid(), t, t + interval '60 seconds', t + interval '80 seconds',
             CASE WHEN s <= 5 THEN 'SUCCEEDED' ELSE 'FAILED' END, t + interval '1 second', CASE WHEN s > 5 THEN 'POWEROFFICE_SOURCE_FAILED' END
        FROM generate_series(1, 1100) s, (SELECT date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC') - interval '40 days' AS t) n`, [WS, CB]);
    await owner.query(`INSERT INTO public."PowerOfficeSnapshot" ("workspaceId", "clientId", "connectionId", id, "attemptId", "lifecycleVersion", "asOf", "businessDate",
        "publishedAt", "expiresAt", summary)
      SELECT a."workspaceId", a."clientId", a."connectionId", a."allocatedSnapshotId", a.id, 1, a."startedAt", ((a."startedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Oslo')::date,
             a."completedAt", a."completedAt" + interval '24 hours', $1::jsonb FROM public."PowerOfficeAttempt" a WHERE a."connectionId" = 'po-b' AND a.sequence <= 5`,
      [JSON.stringify(SUMMARY)]);
    await owner.query(`INSERT INTO public."PowerOfficeState" ("workspaceId", "clientId", "connectionId", "nextSequence", "lastAttemptId", "lastAttemptState",
        "lastAttemptErrorCode", "lastCompletedAttemptId", "lastCompletedState", "lastCompletedErrorCode", "lastSuccessAt")
      SELECT $1, $2, 'po-b', 1101, a.id, 'FAILED', a."safeErrorCode", a.id, 'FAILED', a."safeErrorCode",
             (SELECT max("publishedAt") FROM public."PowerOfficeSnapshot" WHERE "connectionId" = 'po-b')
        FROM public."PowerOfficeAttempt" a WHERE a."connectionId" = 'po-b' AND a.sequence = 1100`, [WS, CB]);
    await owner.query('COMMIT');
  } catch (error) { await owner.query('ROLLBACK'); throw error; }
  assert.deepEqual(await cleanup(KEY_B), { outcome: 'COMPLETED', clearedPointer: false, deletedSnapshots: 5, deletedAttempts: 995, morePending: true });
  assert.deepEqual(await cleanup(KEY_B), { outcome: 'COMPLETED', clearedPointer: false, deletedSnapshots: 0, deletedAttempts: 104, morePending: false });
  assert.deepEqual((await snapshot(KEY_B)).attempts, 1, 'only the last attempt remains; the sequence is never reset');
  assert.equal(await rt(KEY_B, async c => (await c.query(`SELECT "nextSequence" AS n FROM public."PowerOfficeState" WHERE "connectionId" = 'po-b'`)).rows[0].n), 1101);
});

test('audit failure rolls the pointer and deletions back; the definer cannot directly delete unexpired/referenced or ACTIVE/young rows', async () => {
  const c = await rt(KEY_A, x => claimAttempt(x, KEY_A, 'syncer'));
  await rt(KEY_A, x => publishAttempt(x, KEY_A, c, SUMMARY));
  await ageConnection(pgdb.owner, KEY_A, '25 hours');
  const before = await snapshot(KEY_A);
  // TEST-ONLY audit fault (owner-created, PUBLIC revoked, dropped afterwards).
  await pgdb.owner.query(`CREATE FUNCTION public.s4a_test_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW."eventType" = 'poweroffice.cleanup' THEN RAISE EXCEPTION 'audit sink down' USING ERRCODE = '58000'; END IF; RETURN NEW; END $$;
    REVOKE ALL ON FUNCTION public.s4a_test_audit_fault() FROM PUBLIC;
    CREATE TRIGGER s4a_test_audit_fault BEFORE INSERT ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION public.s4a_test_audit_fault();`);
  try { assert.equal(await failure(cleanup(KEY_A)), '58000'); }
  finally { await pgdb.owner.query(`DROP TRIGGER s4a_test_audit_fault ON "AuditEvent"; DROP FUNCTION public.s4a_test_audit_fault();`); }
  assert.deepEqual(await snapshot(KEY_A), before, 'pointer and expired snapshot unchanged');
  // Direct DELETE as the definer under its own admitted scope still meets the guards.
  const owner = pgdb.owner;
  const asDefiner = async (sql: string, params: unknown[]) => {
    await owner.query('BEGIN');
    try {
      await owner.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true), set_config('app.poweroffice_connection_id', $3, true)`,
        [WS, CA, 'po-a']);
      await owner.query(`SET LOCAL ROLE "${pgdb.poDefinerRole}"`);
      await owner.query(sql, params); return undefined;
    } catch (error) { return stateOf(error); } finally { await owner.query('ROLLBACK'); }
  };
  assert.equal(await asDefiner(`DELETE FROM public."PowerOfficeSnapshot" WHERE id = $1`, [c.allocatedSnapshotId]), 'PO003', 'expired but still the pointer');
  const young = await rt(KEY_A, x => claimAttempt(x, KEY_A, 'syncer'));
  assert.equal(await asDefiner(`DELETE FROM public."PowerOfficeAttempt" WHERE id = $1`, [young.id]), 'PO003', 'ACTIVE');
  await rt(KEY_A, x => closeAttempt(x, KEY_A, young, 'FAILED', 'POWEROFFICE_DTO_INVALID'));
  assert.equal(await asDefiner(`DELETE FROM public."PowerOfficeAttempt" WHERE id = $1`, [young.id]), 'PO003', 'young terminal and referenced');
  assert.equal(await asDefiner(`DELETE FROM public."PowerOfficeAttempt" WHERE id = $1`, [c.id]), 'PO003', 'owns an existing snapshot');
  assert.equal(await sqlState(rt(KEY_A, x => x.query(`DELETE FROM public."PowerOfficeSnapshot"`))), '42501', 'the runtime has no DELETE');
});

test('cleanup holds the workspace fence FOR UPDATE: reads and binding mutations wait; a concurrent Connection update commits afterwards', async () => {
  const other = await connect(pgdb.runtimeUrl); clients.push(other);
  const admin = await connect(pgdb.ownerUrl); clients.push(admin);
  await runner.query('BEGIN');
  await runner.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true), set_config('app.poweroffice_connection_id', 'po-a', true),
    set_config('app.actor_id', 'maintainer', true)`, [WS, CA]);
  assert.equal((await runner.query(`SELECT public.atlas_poweroffice_cleanup($1, $2, 'po-a', gen_random_uuid()) AS r`, [WS, CA])).rows[0].r.outcome, 'COMPLETED');
  const waits = async (c: pg.Client, sql: string) => {
    await c.query('BEGIN'); await c.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true)`, [WS, CA]);
    await c.query(`SET LOCAL lock_timeout = '300ms'`);
    try { await c.query(sql); return 'proceeded'; } catch (e) { return stateOf(e); } finally { await c.query('ROLLBACK'); }
  };
  assert.equal(await waits(other, `SELECT 1 FROM public."ActionAuthorityFence" WHERE "workspaceId" = '${WS}' FOR SHARE`), '55P03', 'a read admission waits');
  assert.equal(await waits(admin, `UPDATE public."Connection" SET "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = 'po-a'`), '55P03', 'a binding mutation waits');
  const pending = admin.query(`UPDATE public."Connection" SET "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = 'po-a' RETURNING "lifecycleVersion" AS v`);
  await new Promise(resolve => setTimeout(resolve, 200));
  await runner.query('COMMIT');
  assert.equal((await pending).rows[0].v, 2, 'the mutation commits after the cleanup, never interleaved');
  assert.equal(await failure(cleanup(KEY_A)), 'ok', 'the next cleanup sees the new lifecycle and still closes out the same synthetic binding');
});
