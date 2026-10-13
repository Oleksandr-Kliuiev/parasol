import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createTestDatabase, urlFor } from '../support/pg-harness.ts';
import { readRolesSql, renderRolesSql } from '../support/roles-sql.ts';

// prisma/roles.sql must never echo a credential. psql prints every result row of the script (and any notice), so the
// rows and notices the server returns for the rendered script are exactly what an operator's terminal or CI log would
// show. Synthetic canary passwords only; this never runs against a real deployment.
const pgdb = await createTestDatabase({ provision: false });
after(async () => { await pgdb.drop(); });
const roles = { runtime: pgdb.runtimeRole, definer: pgdb.definerRole, runner: pgdb.runnerRole, fence: pgdb.fenceRole, poDefiner: pgdb.poDefinerRole, poRunner: pgdb.poRunnerRole };
const canary = (label: string) => `Canary${label}${randomBytes(12).toString('hex')}`;

async function provisionCapturingOutput(secrets: { runtimePassword: string; runnerPassword: string; poRunnerPassword: string }) {
  const notices: string[] = [];
  const onNotice = (n: { message?: string }) => { notices.push(String(n.message)); };
  pgdb.owner.on('notice', onNotice);
  try {
    const results = await pgdb.owner.query(renderRolesSql(await readRolesSql(), roles, secrets)) as unknown as pg.QueryResult[];
    return { notices, results: results.map(r => ({ command: r.command, fields: r.fields.map(f => f.name), rows: r.rows })) };
  } finally { pgdb.owner.off('notice', onNotice); }
}
const loginAs = async (role: string, password: string) => {
  const c = new pg.Client({ connectionString: urlFor(pgdb.ownerUrl, role, password) });
  try { await c.connect(); return (await c.query('SELECT current_user AS u')).rows[0].u as string; } finally { await c.end().catch(() => undefined); }
};

test('provisioning output carries no password: fresh roles, then existing roles; the canary values are nonetheless the credentials', async () => {
  const fresh = { runtimePassword: canary('Runtime'), runnerPassword: canary('Runner'), poRunnerPassword: canary('PoRunner') };
  const first = await provisionCapturingOutput(fresh);
  const printed = JSON.stringify(first);
  for (const secret of Object.values(fresh)) assert.ok(!printed.includes(secret), 'no password in any result row, field or notice');
  const status = first.results.find(r => r.command === 'SELECT');
  assert.deepEqual(status?.rows, [{ runtime_role_set: true, definer_role_set: true, runner_role_set: true, fence_role_set: true,
    po_definer_role_set: true, po_runner_role_set: true, runtime_password_given: true, runner_password_given: true, po_runner_password_given: true }]);
  assert.equal(await loginAs(roles.runtime, fresh.runtimePassword), roles.runtime, 'the canary was applied to the new runtime role');
  assert.equal(await loginAs(roles.runner, fresh.runnerPassword), roles.runner, 'and to the new runner role');
  assert.equal(await loginAs(roles.poRunner, fresh.poRunnerPassword), roles.poRunner, 'and to the new PowerOffice runner role');
  // Existing roles: other canaries are offered, neither printed nor applied
  const offered = { runtimePassword: canary('Offered'), runnerPassword: canary('OfferedRunner'), poRunnerPassword: canary('OfferedPoRunner') };
  const second = JSON.stringify(await provisionCapturingOutput(offered));
  for (const secret of [...Object.values(fresh), ...Object.values(offered)]) assert.ok(!second.includes(secret));
  assert.equal(await loginAs(roles.runtime, fresh.runtimePassword), roles.runtime, 'the existing credential is kept');
  await assert.rejects(loginAs(roles.runtime, offered.runtimePassword), /password authentication failed|28P01/);
  assert.equal(await loginAs(roles.poRunner, fresh.poRunnerPassword), roles.poRunner, 'the existing PowerOffice runner credential is kept');
  await assert.rejects(loginAs(roles.poRunner, offered.poRunnerPassword), /password authentication failed|28P01/);
});
