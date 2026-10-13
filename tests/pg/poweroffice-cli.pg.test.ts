import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { POWEROFFICE_AUDIT_KEYS } from '../../packages/poweroffice/audit.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { CA, WS, addPowerOfficeFixtures, tokens } from '../support/poweroffice-fixtures.ts';
import { addSyncConnection, audits, denials, expectedSummary, syntheticInvoiceIds } from '../support/poweroffice-sync.ts';
import { ageConnection } from '../support/poweroffice-history.ts';
import { openClaim } from '../support/poweroffice-read.ts';
import { runOps, trapControl, trapDir } from '../support/poweroffice-process.ts';
import type { CliRun } from '../support/poweroffice-process.ts';

// S4-C C4: the ACTUAL operator CLI journey (scripts/ops.ts child processes under the outbound network trap) on PostgreSQL
// 17 — synthetic seed (trusted test fixture only) → sync → summary → failure STALE (a crashed claim) → recovery → expiry →
// purge — plus strict-flag/credential/mode refusals, and privacy capture over every stdout/stderr, audit row, workspace
// denial and the Stage 1 telemetry/Decisions/observation tables: no token, URL, password, binding, invoice ID or amount
// outside the summary read itself; zero outbound network attempts with a positive trap control.
const pgdb = await createTestDatabase();
const prisma = new PrismaClient({ datasources: { db: { url: pgdb.runtimeUrl } } });
const owner = pgdb.owner;
await addPowerOfficeFixtures(owner);
const trap = trapDir();
after(async () => { await prisma.$disconnect(); await pgdb.drop(); trap.close(); });
const conn = await addSyncConnection(owner, { workspaceId: WS, clientId: CA, connectionId: 'cli-po' }, 140); // the synthetic seed
const ENV = { ATLAS_RUNTIME_DATABASE_URL: pgdb.runtimeUrl, ATLAS_POWEROFFICE_MODE: 'MOCK', ATLAS_POWEROFFICE_CLEANUP_RUNNER_SECRET_REF: 'env://ATLAS_TEST_PO_RUNNER',
  ATLAS_TEST_PO_RUNNER: pgdb.poRunnerUrl };
const runs: CliRun[] = [];
async function ops(command: string, actor: string, extra: Record<string, string> = {}, args = ['--client', CA, '--connection', 'cli-po']): Promise<CliRun> {
  const run = await runOps(trap, [command, ...args], { ...ENV, ATLAS_OPERATOR_TOKEN: tokens[actor]!, ...extra });
  runs.push(run);
  assert.equal(run.output.synthetic, true, `${command}: synthetic marker`);
  return run;
}
const STAGE1 = ['DecisionRun', 'ShadowJob', 'Observation', 'RawEvent', 'ResourceSnapshot', 'ExternalEntity', 'EntityLink', 'SyncState', 'ToolExecution'];
const stage1Counts = async () => Object.fromEntries(await Promise.all(STAGE1.map(async t => [t, Number((await owner.query(`SELECT count(*) FROM "${t}"`)).rows[0].count)])));
const baseline = await stage1Counts();

test('journey: status → sync → summary → crashed claim (BUSY, STALE) → recover → sync → expiry → purge, with exit codes', async () => {
  const first = await ops('poweroffice-status', 'reader');
  assert.deepEqual([first.code, first.output.status, first.output.lastAttemptState], [0, 'MISSING', 'NEVER_SYNCED']);
  const sync = await ops('poweroffice-sync', 'syncer');
  assert.deepEqual([sync.code, sync.output.state, sync.output.sequence, sync.output.idempotent], [0, 'SUCCEEDED', 1, false]);
  const summary = await ops('poweroffice-summary', 'reader');
  assert.deepEqual([summary.code, summary.output.status, summary.output.safeErrorCode], [0, 'FRESH', null]);
  assert.deepEqual(summary.output.summary, await expectedSummary('cli-po', conn.companyKey, summary.output.asOf as string, sync.output.attemptId as string));
  // A crashed sync process after its claim committed (the actual admission, no pass): the next sync is BUSY.
  const crashed = await openClaim(prisma, CA, 'cli-po');
  const busy = await ops('poweroffice-sync', 'syncer');
  assert.deepEqual([busy.code, busy.output.safeErrorCode], [1, 'POWEROFFICE_SYNC_BUSY']);
  const notDue = await ops('poweroffice-recover', 'syncer');
  assert.deepEqual([notDue.code, notDue.output.safeErrorCode], [1, 'POWEROFFICE_RECOVERY_NOT_DUE']);
  const busyCleanup = await ops('poweroffice-cleanup', 'maintainer');
  assert.deepEqual([busyCleanup.code, busyCleanup.output.safeErrorCode], [1, 'POWEROFFICE_SYNC_BUSY']);
  await ageConnection(owner, conn, '2 minutes');
  const recovered = await ops('poweroffice-recover', 'syncer');
  assert.deepEqual([recovered.code, recovered.output.state, recovered.output.attemptId, recovered.output.safeErrorCode], [0, 'ABANDONED', crashed.attemptId, 'POWEROFFICE_DEADLINE']);
  const stale = await ops('poweroffice-summary', 'reader');
  assert.deepEqual([stale.code, stale.output.status, stale.output.safeErrorCode, stale.output.summary], [0, 'STALE', 'POWEROFFICE_DEADLINE', summary.output.summary],
    'failure keeps the previous snapshot with a visible warning');
  const none = await ops('poweroffice-recover', 'syncer');
  assert.deepEqual([none.code, none.output.safeErrorCode], [1, 'POWEROFFICE_NO_ACTIVE_ATTEMPT']);
  const again = await ops('poweroffice-sync', 'syncer');
  assert.deepEqual([again.code, again.output.sequence], [0, 3]);
  assert.equal((await ops('poweroffice-summary', 'reader')).output.status, 'FRESH', 'publication clears the warning');
  await ageConnection(owner, conn, '25 hours');
  const expired = await ops('poweroffice-summary', 'reader');
  assert.deepEqual([expired.code, expired.output.status, expired.output.summary], [0, 'EXPIRED', null], 'hidden at read time before any purge');
  const purge = await ops('poweroffice-cleanup', 'maintainer');
  assert.deepEqual([purge.code, purge.output.outcome, purge.output.clearedPointer, purge.output.deletedSnapshots, purge.output.morePending],
    [0, 'COMPLETED', true, 2, false]);
  const after1 = await ops('poweroffice-status', 'reader');
  assert.deepEqual([after1.output.status, after1.output.lastCompletedState, after1.output.lastSuccessAt !== null], ['EXPIRED', 'SUCCEEDED', true]);
});

test('refusals: strict flags (no token/url/file/clock), credential only from the environment, mode, rights and runner config', async () => {
  for (const args of [['--client', CA], ['--client', CA, '--connection', 'cli-po', '--token', tokens.reader!], ['--client', CA, '--connection', 'cli-po', '--url', 'http://x'],
    ['--client', CA, '--connection', 'cli-po', '--file', '/tmp/x'], ['--client', CA, '--connection', 'cli-po', '--clock', '2026-01-01']]) {
    const r = await ops('poweroffice-summary', 'reader', {}, args);
    assert.deepEqual([r.code, r.output.safeErrorCode], [2, 'INVALID_ARGUMENTS']);
  }
  const noToken = await runOps(trap, ['poweroffice-summary', '--client', CA, '--connection', 'cli-po'], { ...ENV }); runs.push(noToken);
  assert.deepEqual([noToken.code, noToken.output.safeErrorCode], [2, 'POWEROFFICE_AUTHENTICATION_FAILED']);
  const off = await ops('poweroffice-summary', 'reader', { ATLAS_POWEROFFICE_MODE: '' });
  assert.deepEqual([off.code, off.output.safeErrorCode], [2, 'POWEROFFICE_DISABLED']);
  const live = await ops('poweroffice-sync', 'syncer', { ATLAS_POWEROFFICE_MODE: 'LIVE' });
  assert.deepEqual([live.code, live.output.safeErrorCode], [2, 'POWEROFFICE_MODE_UNSUPPORTED']);
  const owner1 = await ops('poweroffice-status', 'reader', { ATLAS_RUNTIME_DATABASE_URL: pgdb.ownerUrl });
  assert.deepEqual([owner1.code, owner1.output.safeErrorCode], [2, 'POWEROFFICE_RUNTIME_NOT_READY'], 'the owner is never the runtime');
  const denied = await ops('poweroffice-summary', 'contextOnly');
  assert.deepEqual([denied.code, denied.output.safeErrorCode], [1, 'PERMISSION_DENIED']);
  const noMaintain = await ops('poweroffice-cleanup', 'syncer');
  assert.deepEqual([noMaintain.code, noMaintain.output.safeErrorCode], [1, 'PERMISSION_DENIED']);
  const noRunner = await ops('poweroffice-cleanup', 'maintainer', { ATLAS_POWEROFFICE_CLEANUP_RUNNER_SECRET_REF: '' });
  assert.deepEqual([noRunner.code, noRunner.output.safeErrorCode], [2, 'POWEROFFICE_RUNTIME_NOT_READY']);
  const foreign = await ops('poweroffice-status', 'reader', {}, ['--client', CA, '--connection', 'atera-a']);
  assert.deepEqual([foreign.code, foreign.output.safeErrorCode], [1, 'POWEROFFICE_NOT_FOUND']);
  const unavailable = await ops('poweroffice-summary', 'reader', {}, ['--client', CA, '--connection', 'po-disabled']);
  assert.deepEqual([unavailable.code, unavailable.output.status, unavailable.output.summary], [1, 'UNAVAILABLE', null]);
});

test('privacy capture: outputs, audits, denials and Stage 1 tables; zero outbound network attempts with a positive control', async () => {
  const invoiceIds = await syntheticInvoiceIds('cli-po', conn.companyKey, '2026-10-10T08:00:00.000Z', '00000000-0000-4000-8000-000000000000');
  const secrets = [...Object.values(tokens), conn.companyKey, conn.companyKey.slice('synthetic-po-'.length), 'fixture://', pgdb.runtimeUrl, pgdb.poRunnerUrl,
    new URL(pgdb.poRunnerUrl).password, new URL(pgdb.runtimeUrl).password, 'postgresql://', ...invoiceIds.slice(0, 20)];
  for (const run of runs) {
    const text = run.stdout + run.stderr;
    for (const s of secrets) assert.ok(!text.includes(s), `${run.output.command}: no secret/binding/URL/invoice ID`);
    assert.equal(run.stderr, '', `${run.output.command}: nothing on stderr`);
    if (run.output.command !== 'poweroffice-summary') assert.ok(!/"[0-9]+\.[0-9]{2}"/.test(run.stdout), `${run.output.command}: no amount`);
  }
  const rows = await audits(owner);
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.ok(Object.keys(row.metadata).every((k: string) => (POWEROFFICE_AUDIT_KEYS as readonly string[]).includes(k)), `${row.eventType}: six keys only`);
    const text = JSON.stringify(row);
    for (const s of secrets) assert.ok(!text.includes(s));
    assert.ok(!/\.[0-9]{2}"/.test(JSON.stringify(row.metadata)), 'no amount in audit');
  }
  for (const d of await denials(owner)) assert.deepEqual(d.metadata, {});
  assert.deepEqual(await stage1Counts(), baseline, 'no PowerOffice data reaches telemetry, Decisions, observations, raw events, snapshots, entities or the ledger');
  assert.equal(trap.trapped(), '', 'no outbound network attempt in any CLI process');
  const ctl = trapDir();
  const db = new URL(pgdb.runtimeUrl);
  try {
    // With the paired DB endpoint allowed (as in every CLI run above), any other target is still recorded.
    const control = await trapControl(ctl, { ATLAS_TEST_NETWORK_TRAP_DB: `${db.hostname}:${db.port || '5432'}` });
    assert.ok(control.includes('fetch') && control.includes('net.connect') && control.includes('net.Socket.connect'));
  } finally { ctl.close(); }
});
