import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readCorrelation } from '../../packages/correlation/read.ts';
import { setupM365Database } from '../support/m365-pg.ts';
import { gasta } from '../support/graph-fixtures.ts';
import { M365_CONNECTION, M365_FIXTURE_CONNECTION } from '../support/m365-fixtures.ts';
import { hourStart, iso } from '../support/m365-signin-mock.ts';
import { addOperator, cli } from '../support/m365-cli.ts';
import { KARI, OTHER_DEVICE, REGISTRATION, addHuntressObservation, addReader, confirmM365Links, publishScenarioDirectory, publishSignIns, readDeps, reader,
  signIn } from '../support/correlation-fixtures.ts';

// Actual CLI read/maintenance commands (tests/pg/m365-cli-read.pg.test.ts): the frozen flag contract is enforced at parse
// time (exit 2, nothing called or written), the cursor flag alone may be up to 512 ASCII characters, m365-directory and
// correlation page through the same services as API/tools, m365-status reads DISABLED/refuses FIXTURE, and m365-cleanup
// runs on the configured EXECUTE-only runner (refused without its configuration). The boundary denial is one workspace row.
const { pgdb, db } = await setupM365Database();
const token = await addOperator(pgdb.owner, 'demo-cli-reader', ['context:read', 'm365:read', 'events:ingest', 'connections:manage']);
const contextOnly = await addOperator(pgdb.owner, 'demo-cli-context', ['context:read']);
const ops = cli(pgdb, token); const opsContext = cli(pgdb, contextOnly);
after(async () => { ops.close(); opsContext.close(); await db.$disconnect(); await pgdb.drop(); });
await addReader(pgdb.owner);
await confirmM365Links(pgdb.owner);
await publishScenarioDirectory(pgdb.owner);
await addHuntressObservation(pgdb.owner, 'obs-cli');
const R = hourStart(3); const end = new Date(R.getTime() + 3_600_000);
await publishSignIns(db, () => [signIn('c-1', iso(R, 60_000), KARI, OTHER_DEVICE), signIn('c-2', iso(R, 120_000), KARI, REGISTRATION),
  signIn('c-3', iso(R, 180_000), KARI, REGISTRATION)], R, end);
const base = ['--client', 'demo-gasta', '--connection', M365_CONNECTION];
const corr = ['correlation', ...base, '--observation', 'obs-cli', '--from', R.toISOString(), '--to', end.toISOString()];
const audits = async () => (await pgdb.owner.query(`SELECT count(*)::int AS n FROM "AuditEvent"`)).rows[0].n;

test('flag contract: undeclared, duplicate, malformed or incompatible flags are INVALID_ARGUMENTS before any permission check, service or I/O', async () => {
  ops.scenario({ tenant: 'unused' });
  const before = await audits();
  const cursor513 = `${'A'.repeat(469)}.${'B'.repeat(43)}`;
  for (const argv of [['m365-sync', ...base, '--resource', 'users', '--from', R.toISOString()], ['m365-sync', ...base, '--resource', 'signins', '--from', R.toISOString()],
    ['m365-sync', ...base, '--resource', 'signins', '--request', 'r-1', '--from', R.toISOString(), '--to', end.toISOString()], ['m365-sync', ...base, '--resource', 'mail'],
    ['m365-sync', ...base, '--resource', 'signins', '--from', '2026-10-01T00:00:00.0000001Z', '--to', '2026-10-01T01:00:00Z'],
    ['m365-directory', ...base, '--resource', 'groups'], ['m365-directory', ...base, '--resource', 'users', '--limit', '101'],
    ['m365-directory', ...base, '--resource', 'users', '--cursor', cursor513], ['m365-directory', ...base, '--resource', 'users', '--cursor', `${'é'.repeat(10)}.${'B'.repeat(43)}`],
    [...corr.slice(0, -2), '--to', 'yesterday'], ['correlation', ...base, '--observation', 'bad id', '--from', R.toISOString(), '--to', end.toISOString()],
    ['m365-cleanup', '--client', 'demo-gasta', '--connection', M365_CONNECTION], ['m365-status', ...base, '--request', 'bad id'],
    ['m365-requeue', ...base, '--request', 'r-1'], ['m365-probe', ...base, '--tenant', 'x'], ['correlation', ...corr.slice(1), '--limit', '5', '--limit', '6']]) {
    const r = await ops.run(argv);
    assert.deepEqual([r.code, r.output.error], [2, 'INVALID_ARGUMENTS'], argv.join(' '));
  }
  assert.equal(await audits(), before, 'nothing written');
  assert.deepEqual(ops.calls(), [], 'nothing called');
});

test('correlation and m365-directory page through the shared services; the same maximal input as API/tools reaches the MAC check', async () => {
  const first = await ops.run([...corr, '--limit', '2']);
  const service = await readCorrelation(db, reader, gasta, { connectionId: M365_CONNECTION, observationId: 'obs-cli', from: R.toISOString(), to: end.toISOString() }, readDeps());
  assert.deepEqual([first.code, first.output.contractVersion, first.output.total], [0, 'atlas.correlation.v1', service.total]);
  const second = await ops.run([...corr, '--limit', '2', '--cursor', first.output.nextCursor as string]);
  const ids = (r: Record<string, unknown>) => (r.items as { evidenceRef: { sourceId: string } }[]).map(i => i.evidenceRef.sourceId);
  assert.deepEqual([...ids(first.output), ...ids(second.output)], service.items!.map(i => i.evidenceRef.sourceId));
  const long = (c: string) => `${c}${'x'.repeat(127)}`;
  const max = await ops.run(['correlation', '--client', 'demo-gasta', '--connection', long('c'), '--observation', long('o'), '--from', '2026-10-01T00:00:00.0000001Z',
    '--to', '2026-10-01T23:59:59.9999999Z', '--limit', '100', '--cursor', `${'A'.repeat(468)}.${'B'.repeat(43)}`]);
  assert.deepEqual(max, { code: 2, output: { command: 'correlation', safeErrorCode: 'CORRELATION_CURSOR_INVALID' } });
  const users = await ops.run(['m365-directory', ...base, '--resource', 'users', '--limit', '1']);
  assert.deepEqual([users.code, users.output.contractVersion, users.output.total, (users.output.items as { id: string }[]).map(i => i.id), users.output.nextCursor],
    [0, 'atlas.m365-directory.v1', 1, [KARI], null]);
});

test('m365-status reads a DISABLED connection with local metadata only and refuses FIXTURE; a boundary denial is one workspace row', async () => {
  await pgdb.owner.query(`UPDATE "Connection" SET status = 'DISABLED', "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = $1`, [M365_CONNECTION]);
  const status = await ops.run(['m365-status', ...base]);
  assert.deepEqual([status.code, status.output.connectionStatus, (status.output.signIns as { windows: { total: number } }).windows.total], [0, 'DISABLED', 1]);
  assert.deepEqual(await ops.run([...corr]), { code: 2, output: { command: 'correlation', safeErrorCode: 'CONNECTION_NOT_LIVE' } });
  await pgdb.owner.query(`UPDATE "Connection" SET status = 'ACTIVE', "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = $1`, [M365_CONNECTION]);
  assert.deepEqual(await ops.run(['m365-status', '--client', 'demo-gasta', '--connection', M365_FIXTURE_CONNECTION]),
    { code: 2, output: { command: 'm365-status', safeErrorCode: 'FIXTURE_CONNECTION_NOT_SUPPORTED' } });
  assert.deepEqual(await opsContext.run([...corr]), { code: 2, output: { command: 'correlation', safeErrorCode: 'PERMISSION_DENIED' } });
  assert.deepEqual((await pgdb.owner.query(`SELECT "eventType", metadata FROM "SecurityAuditEvent" WHERE "actorId" = 'demo-cli-context'`)).rows,
    [{ eventType: 'ops.scope_denied', metadata: { command: 'correlation' } }]);
});

test('m365-cleanup runs one scoped pass on the configured runner; without the runner configuration it is refused before any work', async () => {
  assert.deepEqual(await ops.run(['m365-cleanup', '--client', 'demo-gasta']), { code: 2, output: { command: 'm365-cleanup', safeErrorCode: 'M365_CLEANUP_CONFIG_INVALID' } });
  const r = await ops.run(['m365-cleanup', '--client', 'demo-gasta'], { ATLAS_M365_CLEANUP_RUNNER_SECRET_REF: 'env://ATLAS_TEST_RUNNER_URL', ATLAS_TEST_RUNNER_URL: pgdb.runnerUrl });
  assert.deepEqual([r.code, r.output.status, (r.output.connections as unknown[]).length], [0, 'COMPLETED', 2]);
  assert.equal((await pgdb.owner.query(`SELECT count(*)::int AS n FROM "AuditEvent" WHERE "eventType" = 'retention.completed'`)).rows[0].n, 2);
  assert.ok(!JSON.stringify(r.output).includes('postgres'), 'no URL or credential in the output');
});
