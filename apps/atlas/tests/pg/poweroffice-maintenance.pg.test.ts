import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { admitPowerOfficeCleanup, openPowerOfficeRuntime, runPowerOfficeCleanup } from '../../packages/poweroffice/maintenance.ts';
import type { CleanupAdmission, PowerOfficeRuntime } from '../../packages/poweroffice/maintenance.ts';
import { POWEROFFICE_AUDIT_KEYS } from '../../packages/poweroffice/audit.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { CA, WS, addPowerOfficeFixtures, connect } from '../support/poweroffice-fixtures.ts';
import { addSyncConnection, addToken, codeOf, denials, observe, revokeToken, seedRetainedAttempts } from '../support/poweroffice-sync.ts';
import { ageConnection } from '../support/poweroffice-history.ts';
import { MOCK, as, counts, goodSync, openClaim } from '../support/poweroffice-read.ts';
import { powerOfficeCredential } from '../../packages/poweroffice/authority.ts';

// S4-C C3 on PostgreSQL 17, part 1: fresh maintain admission under the runtime fence, the private single-use capability,
// the paired runner (same target, runner credentials, actual confinement + same-database facts, URLs never output), and the
// routine's bounded effects through the wrapper — BUSY, missing State, disabled-source purge, 1000-row bound with
// morePending, retained sequence/last rows, exact six-key audit. Timing, rollback and Connection interleavings: part 2.
const pgdb = await createTestDatabase();
const prisma = new PrismaClient({ datasources: { db: { url: pgdb.runtimeUrl } } });
const runtimeSql = await connect(pgdb.runtimeUrl);
const paired = openPowerOfficeRuntime(pgdb.runtimeUrl);
after(async () => { await runtimeSql.end().catch(() => undefined); await prisma.$disconnect(); await paired.db.$disconnect(); await pgdb.drop(); });
const owner = pgdb.owner;
await addPowerOfficeFixtures(owner);
const key = (connectionId: string) => ({ workspaceId: WS, clientId: CA, connectionId });
const ENV = { ATLAS_POWEROFFICE_CLEANUP_RUNNER_SECRET_REF: 'env://ATLAS_TEST_PO_RUNNER', ATLAS_TEST_PO_RUNNER: pgdb.poRunnerUrl };
const admit = (id: string, actor = 'maintainer', runtime: PowerOfficeRuntime = paired) => admitPowerOfficeCleanup(runtime, MOCK, as(actor), CA, id);
const cleanup = async (id: string, env: Record<string, string> = ENV) => runPowerOfficeCleanup(await admit(id), env);
const cleanupAudits = async (id: string) => (await owner.query(`SELECT "actorId", "correlationId", metadata FROM "AuditEvent"
  WHERE "eventType" = 'poweroffice.cleanup' AND metadata->>'connectionId' = $1 ORDER BY "recordedAt"`, [id])).rows;
/** A published connection whose snapshot is expired (stored times moved back 25 h). */
async function expiredConnection(id: string, options = {}) {
  const c = await addSyncConnection(owner, key(id), 4, options);
  await goodSync(prisma, CA, id);
  await ageConnection(owner, c, '25 hours');
  return c;
}

test('admission: all-of maintain on one membership (one workspace denial otherwise); invisible/non-PowerOffice/unbound refuse; no runner call', async () => {
  await expiredConnection('mt-admit');
  for (const [actor, code] of [['reader', 'PERMISSION_DENIED'], ['syncer', 'PERMISSION_DENIED'], ['poOnly', 'PERMISSION_DENIED'], ['admin', 'SCOPE_DENIED']]) {
    const d = (await denials(owner)).length;
    assert.equal(await codeOf(admit('mt-admit', actor)), code, actor);
    const rows = await denials(owner);
    assert.equal(rows.length, d + 1); assert.deepEqual([rows.at(-1).eventType, rows.at(-1).reasonCode], ['poweroffice.maintain.denied', code]);
  }
  for (const [id, code] of [['atera-a', 'POWEROFFICE_NOT_FOUND'], ['po-b', 'POWEROFFICE_NOT_FOUND'], ['mt-none', 'POWEROFFICE_NOT_FOUND'], ['po-unbound', 'POWEROFFICE_CONNECTION_UNAVAILABLE']]) {
    assert.equal(await codeOf(admit(id)), code, id);
  }
  assert.equal(await codeOf(admitPowerOfficeCleanup(paired, undefined, as('maintainer'), CA, 'mt-admit')), 'POWEROFFICE_MODE_UNSUPPORTED');
  const unpaired = Object.freeze({ db: prisma }) as PowerOfficeRuntime;
  assert.equal(await codeOf(admit('mt-admit', 'maintainer', unpaired)), 'POWEROFFICE_RUNTIME_NOT_READY', 'a runtime without its private URL pairing');
  assert.deepEqual(await cleanupAudits('mt-admit'), [], 'no routine ran');
  assert.equal((await observe(runtimeSql, key('mt-admit'))).snapshots.length, 1);
});

test('capability: unforgeable and single-use; an admitted cleanup completes after a later revocation (accepted Stage 2 contract)', async () => {
  await expiredConnection('mt-cap');
  assert.equal(await codeOf(runPowerOfficeCleanup({ kind: 'PowerOfficeCleanupAdmission' } as CleanupAdmission, ENV)), 'POWEROFFICE_CLEANUP_FAILED');
  const bearer = await addToken(owner, WS, 'maintainer');
  const admission = await admitPowerOfficeCleanup(paired, MOCK, powerOfficeCredential(bearer), CA, 'mt-cap');
  await revokeToken(owner, bearer);
  const receipt = await runPowerOfficeCleanup(admission, ENV);
  assert.deepEqual([receipt.outcome, receipt.clearedPointer, receipt.deletedSnapshots, receipt.synthetic], ['COMPLETED', true, 1, true]);
  assert.equal(await codeOf(runPowerOfficeCleanup(admission, ENV)), 'POWEROFFICE_CLEANUP_FAILED', 'single use');
  const [audit] = await cleanupAudits('mt-cap');
  assert.equal(audit.actorId, 'maintainer');
  assert.ok(Object.keys(audit.metadata).every(k => (POWEROFFICE_AUDIT_KEYS as readonly string[]).includes(k)));
  assert.deepEqual(Object.keys(audit.metadata).sort(), ['connectionId', 'outcome', 'snapshotId']);
});

test('paired runner misconfiguration fails closed (RUNTIME_NOT_READY) with zero effects and no URL in any output', async () => {
  await expiredConnection('mt-config');
  const before = await observe(runtimeSql, key('mt-config'));
  const other = new URL(pgdb.poRunnerUrl);
  const variant = (f: (u: URL) => void) => { const u = new URL(other); f(u); return u.toString(); };
  const cases: Record<string, Record<string, string>> = {
    'no reference': {}, 'reference not env://': { ATLAS_POWEROFFICE_CLEANUP_RUNNER_SECRET_REF: pgdb.poRunnerUrl },
    'missing variable': { ATLAS_POWEROFFICE_CLEANUP_RUNNER_SECRET_REF: 'env://ATLAS_TEST_ABSENT' },
    'other database': { ...ENV, ATLAS_TEST_PO_RUNNER: variant(u => { u.pathname = '/postgres'; }) },
    'other port': { ...ENV, ATLAS_TEST_PO_RUNNER: variant(u => { u.port = String(Number(u.port || '5432') + 1); }) },
    'extra query option': { ...ENV, ATLAS_TEST_PO_RUNNER: variant(u => { u.searchParams.set('sslmode', 'disable'); }) },
    'runtime credentials': { ...ENV, ATLAS_TEST_PO_RUNNER: pgdb.runtimeUrl },
    'wrong runner password': { ...ENV, ATLAS_TEST_PO_RUNNER: variant(u => { u.password = 'not-the-password'; }) },
    'the Stage 2 runner (not the PowerOffice grantee)': { ...ENV, ATLAS_TEST_PO_RUNNER: pgdb.runnerUrl },
    'the owner as runner': { ...ENV, ATLAS_TEST_PO_RUNNER: pgdb.ownerUrl },
  };
  for (const [label, env] of Object.entries(cases)) {
    let message = '';
    const code = await runPowerOfficeCleanup(await admit('mt-config'), env).then(() => 'ok', (e: Error & { code?: string; details?: unknown }) => {
      message = `${e.message} ${JSON.stringify(e.details ?? {})}`; return e.code;
    });
    assert.equal(code, 'POWEROFFICE_RUNTIME_NOT_READY', label);
    assert.ok(!message.includes('postgres') && !message.includes('@') && !message.includes(other.password), `${label}: no URL/credential in the error`);
  }
  assert.deepEqual(await observe(runtimeSql, key('mt-config')), before);
  assert.deepEqual(await cleanupAudits('mt-config'), []);
});

test('ACTIVE (even long expired) is SYNC_BUSY with zero effects; missing State is a no-op that never creates one', async () => {
  const c = await expiredConnection('mt-busy');
  await openClaim(prisma, CA, 'mt-busy');
  await ageConnection(owner, c, '40 days');
  const before = await observe(runtimeSql, c);
  assert.equal(await codeOf(cleanup('mt-busy')), 'POWEROFFICE_SYNC_BUSY');
  assert.deepEqual(await observe(runtimeSql, c), before); assert.deepEqual(await cleanupAudits('mt-busy'), []);
  await addSyncConnection(owner, key('mt-nostate'), 1);
  const states = (await counts(owner)).states;
  assert.deepEqual(await cleanup('mt-nostate'), { connectionId: 'mt-nostate', outcome: 'NO_STATE', clearedPointer: false, deletedSnapshots: 0,
    deletedAttempts: 0, morePending: false, synthetic: true });
  assert.equal((await counts(owner)).states, states);
});

test('disabled-source purge in the same synthetic binding (no reactivation); a same-client sibling connection is untouched', async () => {
  const c = await expiredConnection('mt-disabled');
  const sibling = await expiredConnection('mt-sibling');
  await owner.query(`UPDATE "Connection" SET status = 'DISABLED', "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = 'mt-disabled'`);
  const siblingBefore = await observe(runtimeSql, sibling);
  const receipt = await cleanup('mt-disabled');
  assert.deepEqual([receipt.outcome, receipt.clearedPointer, receipt.deletedSnapshots], ['COMPLETED', true, 1]);
  const o = await observe(runtimeSql, c);
  assert.deepEqual([o.state.pointer, o.state.lastSuccessAt !== null, o.state.lastCompletedState, o.snapshots.length], [null, true, 'SUCCEEDED', 0]);
  assert.equal((await owner.query(`SELECT status FROM "Connection" WHERE id = 'mt-disabled'`)).rows[0].status, 'DISABLED', 'never reactivated');
  assert.deepEqual(await observe(runtimeSql, sibling), siblingBefore, 'connection-scoped: the sibling keeps its expired snapshot');
});

test('bounded: at most 1000 rows per call with morePending recomputed; sequence never reset; last/last-completed attempts retained', async () => {
  const c = await addSyncConnection(owner, key('mt-bound'), 1);
  await seedRetainedAttempts(owner, c, 1003);
  await ageConnection(owner, c, '31 days');
  const before = await observe(runtimeSql, c);
  const first = await cleanup('mt-bound');
  assert.deepEqual([first.deletedSnapshots + first.deletedAttempts, first.morePending], [1000, true]);
  const second = await cleanup('mt-bound');
  assert.deepEqual([second.deletedAttempts, second.morePending], [2, false], 'last attempt (also last completed) stays');
  const o = await observe(runtimeSql, c);
  assert.deepEqual([o.attempts.length, o.attempts[0].sequence, o.state.next], [1, 1003, before.state.next]);
  const audits = await cleanupAudits('mt-bound');
  assert.equal(audits.length, 2);
  for (const a of audits) assert.deepEqual(a.metadata, { connectionId: 'mt-bound', outcome: 'COMPLETED' }, 'no counts, dates or amounts in audit');
});
