import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { recoverPowerOffice } from '../../packages/poweroffice/recovery.ts';
import { SUMMARY_DTO_KEYS, STATUS_DTO_KEYS } from '../../packages/poweroffice/read-contracts.ts';
import { admitPowerOfficeCleanup, openPowerOfficeRuntime, runPowerOfficeCleanup } from '../../packages/poweroffice/maintenance.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { CA, WS, addPowerOfficeFixtures, connect } from '../support/poweroffice-fixtures.ts';
import { addSyncConnection, codeOf, expectedSummary, observe } from '../support/poweroffice-sync.ts';
import { ageConnection } from '../support/poweroffice-history.ts';
import { MOCK, as, completeClaim, counts, failingSync, goodSync, openClaim, readAudits, statusOf, summaryOf } from '../support/poweroffice-read.ts';

// S4-C C2 on PostgreSQL 17: one case per 04 "Read view" precedence row through the real service and MOCK composition,
// with stored DB times only (trusted ageConnection fixture moves history into the past; no clock override). Previous
// snapshot survives failure; ACTIVE never repairs a warning; publication clears it; purged/expired prior success stays
// EXPIRED even after a later failure/ACTIVE; known empty stays {0, []}; reads change no domain row and audit atomically.
const pgdb = await createTestDatabase();
const prisma = new PrismaClient({ datasources: { db: { url: pgdb.runtimeUrl } } });
const runtimeSql = await connect(pgdb.runtimeUrl);
const paired = openPowerOfficeRuntime(pgdb.runtimeUrl);
after(async () => { await runtimeSql.end().catch(() => undefined); await prisma.$disconnect(); await paired.db.$disconnect(); await pgdb.drop(); });
const owner = pgdb.owner;
await addPowerOfficeFixtures(owner);
const key = (connectionId: string) => ({ workspaceId: WS, clientId: CA, connectionId });
const conn = (id: string, items: number, options = {}) => addSyncConnection(owner, key(id), items, options);
const RUNNER_ENV = { ATLAS_POWEROFFICE_CLEANUP_RUNNER_SECRET_REF: 'env://ATLAS_TEST_PO_RUNNER', ATLAS_TEST_PO_RUNNER: pgdb.poRunnerUrl };
const purge = async (id: string) => runPowerOfficeCleanup(await admitPowerOfficeCleanup(paired, MOCK, as('maintainer'), CA, id), RUNNER_ENV);
const view = async (id: string) => {
  const [s, t] = [await summaryOf(prisma, id, CA), await statusOf(prisma, id, CA)];
  assert.deepEqual(Object.keys(s), [...SUMMARY_DTO_KEYS]); assert.deepEqual(Object.keys(t), [...STATUS_DTO_KEYS]);
  assert.equal(s.synthetic, true); assert.equal(t.synthetic, true); assert.equal(Object.isFrozen(s), true);
  assert.equal('summary' in t, false, 'status never carries a summary');
  for (const f of ['status', 'asOf', 'expiresAt', 'businessDate', 'lastAttemptState', 'lastCompletedState', 'lastCompletedErrorCode', 'safeErrorCode'] as const) {
    assert.deepEqual(t[f], s[f], `status/summary agree on ${f}`);
  }
  return { s, t, row: [s.status, s.safeErrorCode, s.summary === null ? null : 'summary', s.lastAttemptState, s.lastCompletedState, s.lastCompletedErrorCode] };
};

test('MISSING: never synced (no State is created by reading) and first ACTIVE claim; reads write only their audit rows', async () => {
  const c = await conn('rd-missing', 3);
  const before = await counts(owner);
  const { s, t, row } = await view(c.connectionId);
  assert.deepEqual(row, ['MISSING', null, null, 'NEVER_SYNCED', null, null]);
  assert.deepEqual([t.lastAttemptId, t.lastAttemptSequence, t.lastSuccessAt, s.asOf, s.expiresAt, s.businessDate], [null, null, null, null, null, null]);
  const after1 = await counts(owner);
  assert.deepEqual([after1.states, after1.audits - before.audits, after1.denials, after1.executions], [before.states, 2, before.denials, before.executions]);
  assert.equal((await observe(runtimeSql, c)).state, null, 'reads never initialize State');
  const audits = await readAudits(owner, c.connectionId);
  assert.deepEqual(audits.map(a => [a.eventType, a.actorId, a.clientId, a.metadata]), [
    ['poweroffice.summary.read', 'reader', CA, { connectionId: c.connectionId, outcome: 'READ' }],
    ['poweroffice.status.read', 'reader', CA, { connectionId: c.connectionId, outcome: 'READ' }]]);
  const claim = await openClaim(prisma, CA, c.connectionId);
  const active = await view(c.connectionId);
  assert.deepEqual(active.row, ['MISSING', null, null, 'ACTIVE', null, null]);
  assert.deepEqual([active.t.lastAttemptId, active.t.lastAttemptSequence], [claim.attemptId, 1]);
  await completeClaim(prisma, claim);
});

test('FRESH with the exact aggregate; a known-empty export stays {totalCount:0, currencies:[]}; reads change no domain row', async () => {
  const c = await conn('rd-fresh', 150);
  const receipt = await goodSync(prisma, CA, c.connectionId);
  const domain = await observe(runtimeSql, c);
  const { s, t, row } = await view(c.connectionId);
  assert.deepEqual(row, ['FRESH', null, 'summary', 'SUCCEEDED', 'SUCCEEDED', null]);
  assert.deepEqual(s.summary, await expectedSummary(c.connectionId, c.companyKey, s.asOf!, receipt.attemptId));
  assert.deepEqual(domain.snapshots[0].summary, s.summary);
  assert.equal(s.asOf, domain.snapshots[0].asOf); assert.equal(s.businessDate, domain.snapshots[0].businessDate);
  assert.equal(Date.parse(s.expiresAt!) - Date.parse(t.lastSuccessAt!), 24 * 3600_000, 'expiry is publication + 24 h');
  assert.deepEqual([t.lastAttemptId, t.lastAttemptSequence], [receipt.attemptId, 1]);
  assert.deepEqual(await observe(runtimeSql, c), domain, 'domain rows unchanged by reads');
  const audits = await readAudits(owner, c.connectionId);
  assert.deepEqual(audits.map(a => a.metadata), [{ connectionId: c.connectionId, outcome: 'READ', snapshotId: receipt.snapshotId },
    { connectionId: c.connectionId, outcome: 'READ', snapshotId: receipt.snapshotId }]);
  const e = await conn('rd-empty', 0);
  await goodSync(prisma, CA, e.connectionId);
  const empty = await view(e.connectionId);
  assert.deepEqual(empty.row, ['FRESH', null, 'summary', 'SUCCEEDED', 'SUCCEEDED', null]);
  assert.deepEqual(empty.s.summary, { totalCount: 0, currencies: [] }, 'known zero, never null');
});

test('STALE by age (> 15 min, stored DB times): SNAPSHOT_STALE with the summary; 15 min and less stays FRESH', async () => {
  const c = await conn('rd-age', 7);
  await goodSync(prisma, CA, c.connectionId);
  await ageConnection(owner, c, '14 minutes 30 seconds');
  assert.equal((await view(c.connectionId)).row[0], 'FRESH');
  await ageConnection(owner, c, '40 seconds');
  assert.deepEqual((await view(c.connectionId)).row, ['STALE', 'POWEROFFICE_SNAPSHOT_STALE', 'summary', 'SUCCEEDED', 'SUCCEEDED', null]);
});

test('success → failure → ACTIVE keeps STALE with the retained code; publication clears it; ABANDONED → ACTIVE likewise', async () => {
  const c = await conn('rd-warn', 5);
  await goodSync(prisma, CA, c.connectionId);
  const fresh = (await view(c.connectionId)).s;
  assert.equal(await failingSync(prisma, CA, c.connectionId), 'POWEROFFICE_SOURCE_FAILED');
  const failed = await view(c.connectionId);
  assert.deepEqual(failed.row, ['STALE', 'POWEROFFICE_SOURCE_FAILED', 'summary', 'FAILED', 'FAILED', 'POWEROFFICE_SOURCE_FAILED']);
  assert.deepEqual([failed.s.summary, failed.s.asOf], [fresh.summary, fresh.asOf], 'previous snapshot kept on failure');
  const claim = await openClaim(prisma, CA, c.connectionId);
  assert.deepEqual((await view(c.connectionId)).row, ['STALE', 'POWEROFFICE_SOURCE_FAILED', 'summary', 'ACTIVE', 'FAILED', 'POWEROFFICE_SOURCE_FAILED'],
    'ACTIVE changes progress only, never repairs the warning');
  const receipt = await completeClaim(prisma, claim);
  const cleared = await view(c.connectionId);
  assert.deepEqual(cleared.row, ['FRESH', null, 'summary', 'SUCCEEDED', 'SUCCEEDED', null]);
  assert.equal(cleared.t.lastAttemptId, receipt.attemptId);
  // ABANDONED (explicit recovery at/after the stored deadline) → ACTIVE → still STALE/DEADLINE until the next publication.
  const stuck = await openClaim(prisma, CA, c.connectionId);
  await ageConnection(owner, c, '2 minutes');
  await recoverPowerOffice(prisma, MOCK, as('syncer'), CA, c.connectionId);
  assert.deepEqual((await view(c.connectionId)).row, ['STALE', 'POWEROFFICE_DEADLINE', 'summary', 'ABANDONED', 'ABANDONED', 'POWEROFFICE_DEADLINE']);
  const next = await openClaim(prisma, CA, c.connectionId);
  assert.deepEqual((await view(c.connectionId)).row, ['STALE', 'POWEROFFICE_DEADLINE', 'summary', 'ACTIVE', 'ABANDONED', 'POWEROFFICE_DEADLINE']);
  await completeClaim(prisma, next);
  assert.deepEqual((await view(c.connectionId)).row, ['FRESH', null, 'summary', 'SUCCEEDED', 'SUCCEEDED', null]);
  assert.ok(stuck.attemptId !== next.attemptId);
});

test('ERROR: never succeeded and last completed FAILED/ABANDONED — null summary, even with a new ACTIVE claim', async () => {
  const c = await conn('rd-error', 4);
  assert.equal(await failingSync(prisma, CA, c.connectionId), 'POWEROFFICE_SOURCE_FAILED');
  assert.deepEqual((await view(c.connectionId)).row, ['ERROR', 'POWEROFFICE_SOURCE_FAILED', null, 'FAILED', 'FAILED', 'POWEROFFICE_SOURCE_FAILED']);
  const claim = await openClaim(prisma, CA, c.connectionId);
  assert.deepEqual((await view(c.connectionId)).row, ['ERROR', 'POWEROFFICE_SOURCE_FAILED', null, 'ACTIVE', 'FAILED', 'POWEROFFICE_SOURCE_FAILED']);
  await ageConnection(owner, c, '2 minutes');
  await recoverPowerOffice(prisma, MOCK, as('syncer'), CA, c.connectionId);
  assert.deepEqual((await view(c.connectionId)).row, ['ERROR', 'POWEROFFICE_DEADLINE', null, 'ABANDONED', 'ABANDONED', 'POWEROFFICE_DEADLINE']);
  assert.ok(claim.attemptId);
});

test('EXPIRED at read time (DB clock ≥ expiresAt) before any cleanup; after purge it stays EXPIRED through later failure and ACTIVE', async () => {
  const c = await conn('rd-expired', 6);
  await goodSync(prisma, CA, c.connectionId);
  await ageConnection(owner, c, '24 hours');
  const expired = await view(c.connectionId);
  assert.deepEqual(expired.row, ['EXPIRED', 'POWEROFFICE_SNAPSHOT_EXPIRED', null, 'SUCCEEDED', 'SUCCEEDED', null]);
  assert.deepEqual([expired.s.asOf, expired.s.expiresAt, expired.s.businessDate], [null, null, null]);
  assert.equal((await observe(runtimeSql, c)).snapshots.length, 1, 'hidden by the read, not deleted by it');
  const receipt = await purge(c.connectionId);
  assert.deepEqual([receipt.outcome, receipt.clearedPointer, receipt.deletedSnapshots], ['COMPLETED', true, 1]);
  const purged = await observe(runtimeSql, c);
  assert.deepEqual([purged.state.pointer, purged.state.lastSuccessAt !== null, purged.state.lastCompletedState], [null, true, 'SUCCEEDED'],
    'publish → purge: pointer cleared, lastSuccessAt and the SUCCEEDED completion retained');
  assert.deepEqual((await view(c.connectionId)).row, ['EXPIRED', 'POWEROFFICE_SNAPSHOT_EXPIRED', null, 'SUCCEEDED', 'SUCCEEDED', null]);
  assert.equal(await failingSync(prisma, CA, c.connectionId), 'POWEROFFICE_SOURCE_FAILED');
  assert.deepEqual((await view(c.connectionId)).row, ['EXPIRED', 'POWEROFFICE_SNAPSHOT_EXPIRED', null, 'FAILED', 'FAILED', 'POWEROFFICE_SOURCE_FAILED']);
  const claim = await openClaim(prisma, CA, c.connectionId);
  assert.deepEqual((await view(c.connectionId)).row, ['EXPIRED', 'POWEROFFICE_SNAPSHOT_EXPIRED', null, 'ACTIVE', 'FAILED', 'POWEROFFICE_SOURCE_FAILED']);
  await completeClaim(prisma, claim);
  assert.deepEqual((await view(c.connectionId)).row, ['FRESH', null, 'summary', 'SUCCEEDED', 'SUCCEEDED', null]);
});

test('UNAVAILABLE outranks everything: DISABLED / unbound binding and a current snapshot of another lifecycle; no financial read', async () => {
  const d = await conn('rd-disabled', 3, { status: 'DISABLED', version: 2 });
  assert.deepEqual((await view(d.connectionId)).row, ['UNAVAILABLE', 'POWEROFFICE_CONNECTION_UNAVAILABLE', null, 'NEVER_SYNCED', null, null]);
  const u = await conn('rd-unbound', 3, { bound: false });
  assert.deepEqual((await view(u.connectionId)).row, ['UNAVAILABLE', 'POWEROFFICE_CONNECTION_UNAVAILABLE', null, 'NEVER_SYNCED', null, null]);
  const c = await conn('rd-lifecycle', 3);
  await goodSync(prisma, CA, c.connectionId);
  await owner.query(`UPDATE "Connection" SET "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = $1`, [c.connectionId]);
  const changed = await view(c.connectionId);
  assert.deepEqual(changed.row, ['UNAVAILABLE', 'POWEROFFICE_BINDING_CHANGED', null, 'SUCCEEDED', 'SUCCEEDED', null]);
  assert.deepEqual([changed.s.asOf, changed.s.businessDate], [null, null]);
  await ageConnection(owner, c, '25 hours');
  assert.equal((await view(c.connectionId)).row[1], 'POWEROFFICE_BINDING_CHANGED', 'UNAVAILABLE outranks EXPIRED');
  await owner.query(`UPDATE "Connection" SET status = 'DISABLED', "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = $1`, [c.connectionId]);
  assert.equal((await view(c.connectionId)).row[1], 'POWEROFFICE_CONNECTION_UNAVAILABLE');
  const audits = await readAudits(owner, c.connectionId);
  assert.ok(audits.every(a => a.metadata.snapshotId === undefined && a.metadata.outcome === 'READ'), 'no snapshot shown, none audited');
});

test('unknown, foreign-client and non-PowerOffice connections are one indistinguishable POWEROFFICE_NOT_FOUND without audit', async () => {
  const before = await counts(owner);
  for (const id of ['po-nope', 'po-b', 'atera-a', 'po-x', 'bad id', '']) {
    assert.equal(await codeOf(summaryOf(prisma, id, CA)), 'POWEROFFICE_NOT_FOUND', id);
    assert.equal(await codeOf(statusOf(prisma, id, CA)), 'POWEROFFICE_NOT_FOUND', id);
  }
  assert.deepEqual(await counts(owner), before, 'no audit, denial, State or ledger write');
});

test('mode first: DISABLED / fabricated compositions refuse before any database work', async () => {
  const before = await counts(owner);
  const { readPowerOfficeSummary } = await import('../../packages/poweroffice/read.ts');
  for (const composition of [undefined, { mode: 'MOCK', synthetic: true }]) {
    assert.equal(await codeOf(readPowerOfficeSummary(prisma, composition, as('reader'), CA, 'po-a')), 'POWEROFFICE_MODE_UNSUPPORTED');
  }
  assert.deepEqual(await counts(owner), before);
});
