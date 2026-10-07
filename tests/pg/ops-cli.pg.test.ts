import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { generateToken } from '../../packages/auth/token.ts';
import { authenticateToken } from '../../packages/auth/prisma-auth.ts';
import { resolveConnection } from '../../packages/connections/connections.ts';
import { activateConnection } from '../../packages/sync/activation.ts';
import { syncConnection } from '../../packages/sync/snapshots.ts';
import { EnvSecretResolver } from '../../connectors/secrets.ts';
import { createTestDatabase, projectRoot, runSeed } from '../support/pg-harness.ts';
import { gasta } from '../support/graph-fixtures.ts';
import { gastaVendor, testSecrets } from '../support/vendor-routes.ts';

// Task 1.10: the ops CLI as a process (scripts/ops.ts) — what the in-process E2E cannot show: the runtime-role check, token
// authentication, argument errors, the JSON output and the exit codes. No command here can reach a vendor or Decisions:
// the child gets no credential variable and no OpenAI key, and its worker runs with ATLAS_DECISIONS_MODE=rules.
const pgdb = await createTestDatabase();
const db = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
after(async () => { await db.$disconnect(); await pgdb.drop(); });
const operatorToken = generateToken();
runSeed(pgdb.ownerUrl, { ATLAS_OPERATOR_TOKEN: operatorToken });
const inherited = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && !/^(ATLAS_|OPENAI_|HUNTRESS_|ATERA_)/.test(e[0])));

async function ops(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; output: Record<string, unknown> }> {
  const child = spawn(process.execPath, ['--experimental-strip-types', 'scripts/ops.ts', ...args], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...inherited, ATLAS_RUNTIME_DATABASE_URL: pgdb.runtimeUrl, ATLAS_OPERATOR_TOKEN: operatorToken, ...env } });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', data => { stdout += String(data); });
  child.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-4000); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
  const code = await new Promise<number | null>(resolve => child.once('exit', resolve));
  clearTimeout(timer);
  try { return { code, output: JSON.parse(stdout) as Record<string, unknown> }; }
  catch { throw new Error(`ops ${args[0]} printed no JSON (exit ${code}): ${stderr}`); }
}

test('refusals before any work, exit 2: the owner connection, a wrong token, bad arguments, no database URL, Decisions without a key', async () => {
  assert.deepEqual(await ops(['mapping', '--client', 'demo-gasta'], { ATLAS_RUNTIME_DATABASE_URL: pgdb.ownerUrl }),
    { code: 2, output: { command: 'mapping', safeErrorCode: 'RUNTIME_ROLE_BYPASSES_RLS' } });
  assert.deepEqual(await ops(['mapping', '--client', 'demo-gasta'], { ATLAS_OPERATOR_TOKEN: generateToken() }),
    { code: 2, output: { command: 'mapping', error: 'OPERATOR_TOKEN_INVALID' } });
  const usage = await ops(['mapping']);
  assert.deepEqual([usage.code, usage.output.error, (usage.output.commands as string[]).length], [2, 'INVALID_ARGUMENTS', 11]);
  assert.deepEqual(await ops(['worker-once'], { ATLAS_RUNTIME_DATABASE_URL: '' }), { code: 2, output: { command: 'worker-once', error: 'ATLAS_RUNTIME_DATABASE_URL is required' } });
  assert.deepEqual(await ops(['decisions-smoke']), { code: 2, output: { command: 'decisions-smoke', safeErrorCode: 'OPENAI_KEY_REQUIRED' } });
});

test('bind, then a live-read whose credential variable is absent: DISABLED with the safe code and exit 1 — nothing was sent', async () => {
  assert.deepEqual(await ops(['bind', '--client', 'demo-gasta', '--connection', 'gasta-huntress', '--system', 'huntress', '--tenant', '7001', '--secret-ref', 'env://HUNTRESS_GASTA']),
    { code: 0, output: { command: 'bind', connectionId: 'gasta-huntress', status: 'DISABLED' } });
  assert.deepEqual(await ops(['live-read', '--client', 'demo-gasta', '--connection', 'gasta-huntress']), { code: 1, output: { command: 'live-read', connectionId: 'gasta-huntress',
    system: null, activation: { status: 'DISABLED', safeErrorCode: 'SECRET_NOT_FOUND' }, health: null, identities: null, resources: [] } });
  assert.deepEqual((await pgdb.owner.query(`SELECT "actorId", "eventType", metadata->>'safeErrorCode' AS code FROM "AuditEvent" WHERE "eventType" LIKE 'connection.%' ORDER BY "recordedAt"`)).rows,
    [{ actorId: 'demo-operator', eventType: 'connection.bound', code: null }, { actorId: 'demo-operator', eventType: 'connection.activation_failed', code: 'SECRET_NOT_FOUND' }]);
});

test('worker-once (rules override) processes what a sync stored; a dead letter is visible in the inbox and an explicit requeue completes it', async () => {
  // The sync itself runs here with the mock vendor: a child process has no mock transport
  const operator = (await authenticateToken(db, operatorToken))!;
  const io = { transport: gastaVendor().transport, secrets: new EnvSecretResolver(testSecrets) };
  assert.deepEqual(await activateConnection(db, operator, gasta, 'gasta-huntress', io), { status: 'ACTIVE' });
  const connection = await resolveConnection(db, operator, gasta, 'gasta-huntress', 'sync');
  const sync = await syncConnection(db, operator, connection, io);
  assert.deepEqual([sync.identities.candidates, sync.resources.map(r => r.eventsStored)], [1, [2]]);
  // A defect stand-in: one stored event the worker cannot read (PERMANENT, dead-lettered at once)
  const original = (await pgdb.owner.query(`SELECT "eventKey", normalized FROM "RawEvent" WHERE "externalEventId" = '9002'`)).rows[0];
  await pgdb.owner.query(`UPDATE "RawEvent" SET normalized = '{"kind":"UNKNOWN"}' WHERE "externalEventId" = '9002'`);
  const pass = await ops(['worker-once'], { ATLAS_DECISIONS_MODE: 'rules' });
  assert.equal(pass.code, 0);
  assert.match(String(pass.output.workerId), /^worker-[A-Za-z0-9.-]*-\d+$/);
  assert.deepEqual([pass.output.configVersion, pass.output.mode, pass.output.clients], ['decisions-2026-10-07.1-env', 'rules',
    [{ clientId: 'demo-gasta', events: { PROCESSED: 1, DEAD_LETTER: 1 }, shadow: {} }]], 'an override marks the recorded version; rules mode needs no key and runs no shadow');
  const inbox = await ops(['inbox', '--client', 'demo-gasta']);
  assert.deepEqual([inbox.code, (inbox.output.items as { eventKey: string; status: string; lastErrorCode: string }[]).map(i => `${i.eventKey}:${i.status}:${i.lastErrorCode}`)],
    [0, [`${original.eventKey}:DEAD_LETTER:INVALID_EVENT`]]);
  assert.deepEqual(await ops(['requeue', '--client', 'demo-gasta', '--event', 'no-such-event']), { code: 2, output: { command: 'requeue', safeErrorCode: 'EVENT_NOT_FOUND' } });
  await pgdb.owner.query(`UPDATE "RawEvent" SET normalized = $1 WHERE "eventKey" = $2`, [original.normalized, original.eventKey]); // the defect is fixed
  assert.deepEqual(await ops(['requeue', '--client', 'demo-gasta', '--event', original.eventKey]),
    { code: 0, output: { command: 'requeue', eventKey: original.eventKey, inboxStatus: 'RECEIVED' } });
  assert.deepEqual((await ops(['worker-once'], { ATLAS_DECISIONS_MODE: 'rules' })).output.clients, [{ clientId: 'demo-gasta', events: { PROCESSED: 1 }, shadow: {} }]);
  assert.deepEqual((await ops(['inbox', '--client', 'demo-gasta'])).output.items, []);
  assert.deepEqual((await pgdb.owner.query(`SELECT "actorId", "eventType" FROM "AuditEvent" WHERE "eventType" LIKE 'event.%' ORDER BY "recordedAt"`)).rows,
    [{ actorId: 'demo-operator', eventType: 'event.dead_lettered' }, { actorId: 'demo-operator', eventType: 'event.requeued' }]);
  assert.deepEqual((await pgdb.owner.query(`SELECT DISTINCT "configVersion", provider, applied FROM "DecisionRun"`)).rows,
    [{ configVersion: 'decisions-2026-10-07.1-env', provider: 'rules', applied: true }]);
});

test('mapping review and confirmation through the CLI; another client is refused (exit 2) and recorded in the workspace security audit', async () => {
  const queue = await ops(['mapping', '--client', 'demo-gasta']);
  const items = queue.output.items as { linkId: string; status: string; externalId: string; entityId: string }[];
  assert.deepEqual([queue.code, items.map(i => `${i.status}:${i.externalId}->${i.entityId}`)], [0, ['CANDIDATE:207001->demo-device-07']]);
  assert.deepEqual(await ops(['confirm-link', '--client', 'demo-gasta', '--link', items[0]!.linkId]),
    { code: 0, output: { command: 'confirm-link', linkId: items[0]!.linkId, status: 'CONFIRMED', conflictsWithLinkId: null } });
  assert.deepEqual(await ops(['mapping', '--client', 'demo-other']), { code: 2, output: { command: 'mapping', safeErrorCode: 'SCOPE_DENIED' } });
  assert.deepEqual((await pgdb.owner.query(`SELECT "requestedClientId", "reasonCode" FROM "SecurityAuditEvent" WHERE "eventType" = 'ops.scope_denied'`)).rows,
    [{ requestedClientId: 'demo-other', reasonCode: 'SCOPE_DENIED' }]);
});
