import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { AtlasError } from '../../packages/core/contracts.ts';
import { generateToken } from '../../packages/auth/token.ts';
import { disableM365Connection } from '../../packages/connections/m365-disable.ts';
import { bindConnection } from '../../packages/connections/connections.ts';
import { createTestDatabase, projectRoot, runSeed } from '../support/pg-harness.ts';
import { addMappingFixtures, gasta, other, WS } from '../support/graph-fixtures.ts';
import { M365_CONNECTION, M365_FIXTURE_CONNECTION, M365_TENANT, addM365Actors, addM365Fixtures, m365Actors } from '../support/m365-fixtures.ts';

// Stage 2 task 2.3, A5 on PostgreSQL 17: the local disable of an M365 connection — service and operator CLI process.
// Connections:manage on the client, current authority rechecked under the Connection lock, microsoft365 only, FIXTURE
// refused, DISABLED + a new lifecycleVersion + allowlisted audit in one transaction, even when already DISABLED.
const pgdb = await createTestDatabase();
const db = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
after(async () => { await db.$disconnect(); await pgdb.drop(); });
const operatorToken = generateToken(); const technicianToken = generateToken();
runSeed(pgdb.ownerUrl, { ATLAS_OPERATOR_TOKEN: operatorToken, ATLAS_DEMO_TOKEN: technicianToken });
await addMappingFixtures(pgdb.owner);
await addM365Fixtures(pgdb.owner);
await addM365Actors(pgdb.owner);
const fails = (code: string) => (e: unknown) => e instanceof AtlasError && e.code === code;
const connection = async (id: string) => (await pgdb.owner.query(`SELECT status, "lifecycleVersion" AS v FROM "Connection" WHERE id = $1`, [id])).rows[0] as { status: string; v: number };
const audit = async (eventType: string) => (await pgdb.owner.query(`SELECT "actorId", metadata FROM "AuditEvent" WHERE "eventType" = $1 ORDER BY "recordedAt", id`, [eventType])).rows;

test('disable: ACTIVE → DISABLED with a new version and one allowlisted audit row; an already DISABLED connection gets a new version again', async () => {
  const admin = m365Actors.admin;
  const first = await disableM365Connection(db, admin, gasta, M365_CONNECTION);
  assert.deepEqual(first, { connectionId: M365_CONNECTION, status: 'DISABLED', lifecycleVersion: 2 });
  const again = await disableM365Connection(db, admin, gasta, M365_CONNECTION);
  assert.deepEqual(again, { connectionId: M365_CONNECTION, status: 'DISABLED', lifecycleVersion: 3 }, 'pending capabilities of version 2 are invalidated too');
  assert.deepEqual(await connection(M365_CONNECTION), { status: 'DISABLED', v: 3 });
  const rows = await audit('connection.disabled');
  assert.deepEqual(rows.map(r => [r.actorId, r.metadata]), [
    ['demo-admin', { connectionId: M365_CONNECTION, system: 'microsoft365', previousStatus: 'ACTIVE', connectionStatus: 'DISABLED', lifecycleVersion: '2' }],
    ['demo-admin', { connectionId: M365_CONNECTION, system: 'microsoft365', previousStatus: 'DISABLED', connectionStatus: 'DISABLED', lifecycleVersion: '3' }]]);
  assert.ok(!JSON.stringify(rows).includes(M365_TENANT) && !JSON.stringify(rows).includes('env://'), 'no tenant ID or secret reference');
});

test('disable is confined: permission, client scope, system and FIXTURE are refused before any change, rejections audited safely', async () => {
  const before = await connection(M365_CONNECTION);
  await assert.rejects(disableM365Connection(db, m365Actors.m365Reviewer, gasta, M365_CONNECTION), fails('PERMISSION_DENIED'), 'm365:read is not connections:manage');
  await assert.rejects(disableM365Connection(db, m365Actors.admin, other, M365_CONNECTION), fails('SCOPE_DENIED'), 'demo-admin is not a member of demo-other');
  await assert.rejects(disableM365Connection(db, m365Actors.admin, gasta, 'demo-atera-connection'), fails('CONNECTION_NOT_M365'));
  await assert.rejects(disableM365Connection(db, m365Actors.admin, gasta, M365_FIXTURE_CONNECTION), fails('FIXTURE_CONNECTION_NOT_SUPPORTED'));
  await assert.rejects(disableM365Connection(db, m365Actors.admin, gasta, 'no-such-connection'), fails('CONNECTION_NOT_FOUND'));
  await assert.rejects(disableM365Connection(db, m365Actors.admin, gasta, 'bad id'), fails('CONNECTION_NOT_FOUND'));
  assert.deepEqual(await connection(M365_CONNECTION), before);
  assert.deepEqual(await connection('demo-atera-connection'), { status: 'FIXTURE', v: 0 });
  assert.deepEqual(await connection(M365_FIXTURE_CONNECTION), { status: 'FIXTURE', v: 0 });
  assert.deepEqual((await audit('connection.disable_rejected')).map(r => r.metadata.safeErrorCode),
    ['CONNECTION_NOT_M365', 'FIXTURE_CONNECTION_NOT_SUPPORTED', 'CONNECTION_NOT_FOUND']);
});

test('disable locks the Connection row and rechecks CURRENT authority under that lock: a membership revoked meanwhile changes nothing', async () => {
  await pgdb.owner.query(`UPDATE "Connection" SET status = 'ACTIVE', "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = $1`, [M365_CONNECTION]);
  const before = await connection(M365_CONNECTION);
  // Another transaction holds the publication fence; disable waits for it instead of interleaving
  const holder = new pg.Client({ connectionString: pgdb.ownerUrl }); await holder.connect();
  try {
    await holder.query('BEGIN');
    await holder.query(`SELECT id FROM "Connection" WHERE id = $1 FOR NO KEY UPDATE`, [M365_CONNECTION]);
    // ... and, while the disable waits, the admin loses connections:manage
    await holder.query(`UPDATE "ClientMembership" SET permissions = ARRAY['context:read'] WHERE "actorId" = 'demo-admin' AND "clientId" = 'demo-gasta'`);
    let settled = false;
    const pending = disableM365Connection(db, m365Actors.admin, gasta, M365_CONNECTION).finally(() => { settled = true; });
    pending.catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(settled, false, 'disable waits for the Connection lock');
    await holder.query('COMMIT');
    await assert.rejects(pending, fails('PERMISSION_DENIED'), 'authority is the one current when the lock is held');
  } finally { await holder.end(); }
  assert.deepEqual(await connection(M365_CONNECTION), before, 'no status or version change');
  const denial = (await pgdb.owner.query(`SELECT "eventType", "requestedClientId", "reasonCode", metadata FROM "SecurityAuditEvent" WHERE "eventType" = 'connection.disable_denied'`)).rows;
  assert.deepEqual(denial, [{ eventType: 'connection.disable_denied', requestedClientId: 'demo-gasta', reasonCode: 'PERMISSION_DENIED', metadata: {} }]);
  await pgdb.owner.query(`UPDATE "ClientMembership" SET permissions = ARRAY['connections:manage'] WHERE "actorId" = 'demo-admin' AND "clientId" = 'demo-gasta'`);
});

test('the Stage 1 bind and activation paths share the version: a new binding starts at version 1, its output unchanged', async () => {
  assert.deepEqual(await bindConnection(db, m365Actors.admin, gasta, { connectionId: 'gasta-atera-v2', system: 'atera', externalTenantId: '7001', secretRef: 'env://ATERA_V2' }),
    { connectionId: 'gasta-atera-v2', status: 'DISABLED' });
  assert.deepEqual(await connection('gasta-atera-v2'), { status: 'DISABLED', v: 1 });
  await assert.rejects(pgdb.owner.query(`UPDATE "Connection" SET status = 'ACTIVE' WHERE id = 'gasta-atera-v2'`), /increment lifecycleVersion/, 'no status change without a new version, even for the owner');
});

// The operator CLI as a process: the same service behind the command boundary (permission refusal → workspace security audit).
const inherited = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && !/^(ATLAS_|OPENAI_|HUNTRESS_|ATERA_|M365_)/.test(e[0])));
async function ops(args: string[], token: string): Promise<{ code: number | null; stdout: string; output: Record<string, unknown> }> {
  const child = spawn(process.execPath, ['--experimental-strip-types', 'scripts/ops.ts', ...args], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...inherited, ATLAS_RUNTIME_DATABASE_URL: pgdb.runtimeUrl, ATLAS_OPERATOR_TOKEN: token } });
  let stdout = '';
  child.stdout.on('data', data => { stdout += String(data); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
  const code = await new Promise<number | null>(resolve => child.once('exit', resolve));
  clearTimeout(timer);
  return { code, stdout, output: JSON.parse(stdout) as Record<string, unknown> };
}

test('CLI m365-disable: the operator (connections:manage) disables with local output only; the technician is refused at the boundary', async () => {
  const before = await connection(M365_CONNECTION);
  const done = await ops(['m365-disable', '--client', 'demo-gasta', '--connection', M365_CONNECTION], operatorToken);
  assert.deepEqual([done.code, done.output], [0, { command: 'm365-disable', connectionId: M365_CONNECTION, status: 'DISABLED', lifecycleVersion: before.v + 1 }]);
  assert.ok(!done.stdout.includes(M365_TENANT) && !done.stdout.includes('env://'));
  const refused = await ops(['m365-disable', '--client', 'demo-gasta', '--connection', M365_CONNECTION], technicianToken);
  assert.deepEqual([refused.code, refused.output], [2, { command: 'm365-disable', safeErrorCode: 'PERMISSION_DENIED' }]);
  assert.deepEqual(await connection(M365_CONNECTION), { status: 'DISABLED', v: before.v + 1 });
  const denied = (await pgdb.owner.query(`SELECT "actorId", "reasonCode", metadata FROM "SecurityAuditEvent" WHERE "eventType" = 'ops.scope_denied' AND "workspaceId" = $1`, [WS])).rows;
  assert.deepEqual(denied, [{ actorId: 'demo-technician', reasonCode: 'PERMISSION_DENIED', metadata: { command: 'm365-disable' } }]);
  const bad = await ops(['m365-disable', '--client', 'demo-gasta', '--connection', M365_CONNECTION, '--tenant', M365_TENANT], operatorToken);
  assert.equal(bad.code, 2, 'a caller cannot pass a tenant');
});
