import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from '../support/pg-harness.ts';
import { KEY_A, addPowerOfficeFixtures, connect, inTx, scopeOf, stateOf } from '../support/poweroffice-fixtures.ts';
import { claimAttempt, insertSnapshot } from '../support/poweroffice-history.ts';
import { AGGREGATE_CASES } from '../support/poweroffice-aggregates.ts';

// S4-A A1/A2: the SQL snapshot guard (invoker trigger, no callable validator) accepts exactly the aggregates of the shared
// corpus that packages/poweroffice/aggregate.ts accepts — same shape, order, bounds and coherence — when the confined runtime
// inserts a snapshot for its ACTIVE claim. Every probe is rolled back.
const pgdb = await createTestDatabase();
after(async () => { await runtime.end().catch(() => undefined); await pgdb.drop(); });
await addPowerOfficeFixtures(pgdb.owner);
const runtime = await connect(pgdb.runtimeUrl);
const claim = await inTx(runtime, scopeOf(KEY_A), c => claimAttempt(c, KEY_A, 'syncer'));

async function sqlVerdict(summary: unknown): Promise<string | undefined> {
  await runtime.query('BEGIN');
  try {
    await runtime.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true)`, [KEY_A.workspaceId, KEY_A.clientId]);
    const t = (await runtime.query(`SELECT (date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC'))::text AS t`)).rows[0].t as string;
    await insertSnapshot(runtime, KEY_A, claim, summary, t);
    return undefined;
  } catch (error) { return stateOf(error) ?? 'NO_SQLSTATE'; } finally { await runtime.query('ROLLBACK'); }
}

test('SQL aggregate guard verdicts equal the shared corpus verdicts (PO005 for every invalid aggregate)', async () => {
  for (const c of AGGREGATE_CASES) assert.equal(await sqlVerdict(c.value), c.valid ? undefined : 'PO005', c.label);
});

test('no callable validator exists: every PowerOffice routine except the confined cleanup is a PUBLIC-revoked trigger function', async () => {
  const rows = (await pgdb.owner.query(`SELECT p.proname, p.prorettype = 'pg_catalog.trigger'::regtype AS trigger, p.prosecdef,
      has_function_privilege($1, p.oid, 'EXECUTE') AS runtime, EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0) AS public
    FROM pg_proc p WHERE p.proname LIKE 'atlas\\_poweroffice\\_%' ORDER BY 1`, [pgdb.runtimeRole])).rows;
  assert.deepEqual(rows, [
    { proname: 'atlas_poweroffice_attempt_guard', trigger: true, prosecdef: false, runtime: false, public: false },
    { proname: 'atlas_poweroffice_cleanup', trigger: false, prosecdef: true, runtime: false, public: false },
    { proname: 'atlas_poweroffice_commit_check', trigger: true, prosecdef: false, runtime: false, public: false },
    { proname: 'atlas_poweroffice_snapshot_guard', trigger: true, prosecdef: false, runtime: false, public: false },
    { proname: 'atlas_poweroffice_state_guard', trigger: true, prosecdef: false, runtime: false, public: false }]);
  assert.equal(await inTx(runtime, scopeOf(KEY_A), c => c.query(`SELECT public.atlas_poweroffice_snapshot_guard()`)).then(() => 'called', e => stateOf(e)), '42501');
});
