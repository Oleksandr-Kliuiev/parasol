import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { assertConfinedRuntimeRole } from '../../packages/graph/runtime-role.ts';
import { POWEROFFICE_RUNTIME_UPDATE_COLUMNS, powerOfficeProblems } from '../../packages/graph/poweroffice-role.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { addPowerOfficeFixtures, connect } from '../support/poweroffice-fixtures.ts';
import { factsInEnvelope, inRollbackEnvelope, provisionInEnvelope, provisioningBody, runtimeFactsInEnvelope } from '../support/poweroffice-envelope.ts';

// S4-A RC4 R1 on PostgreSQL 17: the runtime holds NO grant option (delegation authority) on the three PowerOffice tables —
// not on its approved table SELECT/INSERT, not on any column SELECT/INSERT, not on its approved mutable-column UPDATE. Each
// drift is applied inside one owner transaction that always rolls back; the FULL startup facts are evaluated as the runtime
// (SET LOCAL SESSION AUTHORIZATION: session_user = current_user = runtime) and must refuse; the production provisioning body
// (savepoint) removes every option and restores exactly the approved grants. Nothing is committed.
const pgdb = await createTestDatabase();
const clients: pg.Client[] = [];
after(async () => { for (const c of clients) await c.end().catch(() => undefined); await pgdb.drop(); });
await addPowerOfficeFixtures(pgdb.owner);
const { owner, roles } = pgdb;
const observer = await connect(pgdb.ownerUrl); clients.push(observer);
const body = await provisioningBody(roles);
const PO = ['PowerOfficeState', 'PowerOfficeAttempt', 'PowerOfficeSnapshot'];
const columns = (await owner.query(`SELECT c.relname AS t, a.attname AS c FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
  WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1) AND a.attnum > 0 AND NOT a.attisdropped ORDER BY 1, a.attnum`, [PO])).rows as { t: string; c: string }[];
const q = (t: string) => `public."${t}"`;
/** The runtime's effective privileges on the three tables, as one comparable snapshot (incl. grant options). */
const runtimeAcl = async (c: pg.Client) => (await c.query(`SELECT c.relname AS t, c.relacl::text AS acl,
    (SELECT json_agg(a.attacl::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attacl IS NOT NULL) AS cols
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1) ORDER BY 1`, [PO])).rows;
const baseline = await runtimeAcl(owner);

/** One uncommitted drift: the full runtime startup assertion and per-admission facts must refuse (or accept, `healthy`). */
async function check(label: string, grant: string, refused: boolean, restore = false): Promise<void> {
  await inRollbackEnvelope(owner, async () => {
    await owner.query(grant);
    assert.deepEqual(await runtimeAcl(observer), baseline, `${label}: invisible to another session`);
    const full = await runtimeFactsInEnvelope(owner, roles.runtime);
    assert.equal(full.sessionRoleMismatch, false);
    const po = await factsInEnvelope(owner, roles.runtime);
    if (refused) {
      assert.ok(full.poRuntimeGrantViolations > 0 && po.poRuntimeGrantViolations > 0, `${label}: runtime grant violation (startup and admission)`);
      assert.throws(() => assertConfinedRuntimeRole(full), /RUNTIME_ROLE_NOT_CONFINED/, `${label}: full startup assertion refuses`);
    } else {
      assertConfinedRuntimeRole(full);
      assert.deepEqual(powerOfficeProblems(po), [], `${label}: healthy`);
    }
    if (restore) {
      assert.equal(await provisionInEnvelope(owner, body), undefined, `${label}: production provisioning succeeds`);
      assertConfinedRuntimeRole(await runtimeFactsInEnvelope(owner, roles.runtime));
      assert.deepEqual(await runtimeAcl(owner), baseline, `${label}: exactly the approved grants again`);
    }
  });
  assert.deepEqual(await runtimeAcl(owner), baseline, `${label}: rolled back`);
}

test('the observed matrix is complete: 3 tables, 43 columns, 15 approved mutable UPDATE columns', () => {
  assert.equal(columns.length, 43);
  assert.deepEqual(Object.fromEntries(PO.map(t => [t, (POWEROFFICE_RUNTIME_UPDATE_COLUMNS[t] ?? []).length])),
    { PowerOfficeState: 12, PowerOfficeAttempt: 3, PowerOfficeSnapshot: 0 });
});

test('approved grants re-stated without options stay healthy; adjacent forbidden privileges stay refused', async () => {
  await check('re-grant approved table SELECT/INSERT', PO.map(t => `GRANT SELECT, INSERT ON ${q(t)} TO "${roles.runtime}"`).join('; '), false);
  await check('re-grant approved UPDATE columns', `GRANT UPDATE ("nextSequence", "updatedAt") ON ${q('PowerOfficeState')} TO "${roles.runtime}";
    GRANT UPDATE (state, "completedAt", "safeErrorCode") ON ${q('PowerOfficeAttempt')} TO "${roles.runtime}"`, false);
  await check('column REFERENCES control', `GRANT REFERENCES ("connectionId") ON ${q('PowerOfficeSnapshot')} TO "${roles.runtime}"`, true);
  await check('immutable UPDATE control', `GRANT UPDATE (summary) ON ${q('PowerOfficeSnapshot')} TO "${roles.runtime}"`, true);
  await check('MAINTAIN control', `GRANT MAINTAIN ON ${q('PowerOfficeAttempt')} TO "${roles.runtime}"`, true);
});

test('table SELECT and INSERT WITH GRANT OPTION on each table: refused; provisioning removes the option, keeps the approved privilege', async () => {
  for (const t of PO) for (const priv of ['SELECT', 'INSERT']) {
    await check(`${priv} WITH GRANT OPTION on ${t}`, `GRANT ${priv} ON ${q(t)} TO "${roles.runtime}" WITH GRANT OPTION`, true, true);
  }
});

test('column SELECT and INSERT WITH GRANT OPTION on every one of the 43 columns: refused; provisioning restores each table', async () => {
  for (const { t, c } of columns) for (const priv of ['SELECT', 'INSERT']) {
    await check(`${priv} (${c}) WITH GRANT OPTION on ${t}`, `GRANT ${priv} ("${c}") ON ${q(t)} TO "${roles.runtime}" WITH GRANT OPTION`, true);
  }
  for (const t of PO) {
    const all = columns.filter(x => x.t === t).map(x => `"${x.c}"`).join(', ');
    await check(`all column options on ${t}`, `GRANT SELECT (${all}), INSERT (${all}) ON ${q(t)} TO "${roles.runtime}" WITH GRANT OPTION`, true, true);
  }
});

test('UPDATE WITH GRANT OPTION on each approved mutable column (State 12, Attempt 3): refused; provisioning restores the exact UPDATE grants', async () => {
  for (const t of ['PowerOfficeState', 'PowerOfficeAttempt']) {
    for (const c of POWEROFFICE_RUNTIME_UPDATE_COLUMNS[t]!) {
      await check(`UPDATE (${c}) WITH GRANT OPTION on ${t}`, `GRANT UPDATE ("${c}") ON ${q(t)} TO "${roles.runtime}" WITH GRANT OPTION`, true);
    }
    const all = POWEROFFICE_RUNTIME_UPDATE_COLUMNS[t]!.map(c => `"${c}"`).join(', ');
    await check(`all approved UPDATE options on ${t}`, `GRANT UPDATE (${all}) ON ${q(t)} TO "${roles.runtime}" WITH GRANT OPTION`, true, true);
  }
});
