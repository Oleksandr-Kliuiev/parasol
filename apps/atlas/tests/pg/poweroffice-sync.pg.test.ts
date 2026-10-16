import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { powerOfficeCredential } from '../../packages/poweroffice/authority.ts';
import { POWEROFFICE_MODE_VARIABLE, powerOfficeComposition } from '../../packages/poweroffice/composition.ts';
import { validateSummary } from '../../packages/poweroffice/aggregate.ts';
import { businessDate } from '../../packages/poweroffice/calendar.ts';
import { POWEROFFICE_AUDIT_KEYS } from '../../packages/poweroffice/audit.ts';
import { admitSync } from '../../packages/poweroffice/admission.ts';
import { runExportPass } from '../../packages/poweroffice/pass.ts';
import { publishFact } from '../../packages/poweroffice/publication.ts';
import { syncPowerOffice } from '../../packages/poweroffice/sync.ts';
import { recoverPowerOffice } from '../../packages/poweroffice/recovery.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { CA, CB, CX, WS, addPowerOfficeFixtures, connect, tokens } from '../support/poweroffice-fixtures.ts';
import { addSyncConnection, addToken, audits, codeOf, denials, expectedSummary, observe, seam, seedRetainedAttempts, sleep, untilWaiting } from '../support/poweroffice-sync.ts';

// S4-B B1/B2 on PostgreSQL 17 through the real built-in MOCK composition: mode before everything, binding/authority
// refusals with zero writes or port calls, the durable one-ACTIVE claim (BUSY even for parallel callers), the 1000-attempt
// cap, token expiry after the last lock, a complete multi-page export published atomically with the exact aggregate and
// six-key audits, the known-empty export, and unforgeable single-pass capabilities.
const pgdb = await createTestDatabase();
const prisma = new PrismaClient({ datasources: { db: { url: pgdb.runtimeUrl } } });
const runtime = await connect(pgdb.runtimeUrl);
after(async () => { await runtime.end().catch(() => undefined); await prisma.$disconnect(); await pgdb.drop(); });
const owner = pgdb.owner;
await addPowerOfficeFixtures(owner);
const MOCK = powerOfficeComposition({ [POWEROFFICE_MODE_VARIABLE]: 'MOCK' });
const as = (who: string) => powerOfficeCredential(tokens[who]!);
const key = (connectionId: string, clientId = CA) => ({ workspaceId: WS, clientId, connectionId });
const stateCount = async () => Number((await owner.query(`SELECT count(*) FROM "PowerOfficeState"`)).rows[0].count);

test('mode is decided first: DISABLED/unsupported compositions refuse with no State, audit, denial or port call', async () => {
  for (const env of [{}, { [POWEROFFICE_MODE_VARIABLE]: 'DISABLED' }, { [POWEROFFICE_MODE_VARIABLE]: 'LIVE' }, { [POWEROFFICE_MODE_VARIABLE]: 'MOCK', ATLAS_POWEROFFICE_URL: 'http://127.0.0.1:9' }]) {
    assert.throws(() => powerOfficeComposition(env), (e: { code?: string }) => e.code === 'POWEROFFICE_DISABLED' || e.code === 'POWEROFFICE_MODE_UNSUPPORTED');
  }
  for (const composition of [{ mode: 'MOCK', synthetic: true }, undefined]) {
    assert.equal(await codeOf(syncPowerOffice(prisma, composition, as('syncer'), CA, 'po-a')), 'POWEROFFICE_MODE_UNSUPPORTED');
    assert.equal(await codeOf(recoverPowerOffice(prisma, composition, as('syncer'), CA, 'po-a')), 'POWEROFFICE_MODE_UNSUPPORTED');
  }
  assert.equal(await stateCount(), 0); assert.deepEqual(await audits(owner), []); assert.deepEqual(await denials(owner), []);
});

test('binding and authority refusals: no State initialization, no write, no port call; one workspace denial for a refused member', async () => {
  const s = seam();
  const cases: [string, string, string, string][] = [['syncer', CA, 'po-unbound', 'POWEROFFICE_CONNECTION_UNAVAILABLE'],
    ['syncer', CA, 'po-disabled', 'POWEROFFICE_CONNECTION_UNAVAILABLE'], ['syncer', CA, 'atera-a', 'POWEROFFICE_NOT_FOUND'],
    ['syncer', CA, 'missing', 'POWEROFFICE_NOT_FOUND'], ['syncer', CA, 'bad id!', 'POWEROFFICE_NOT_FOUND'], ['syncer', CB, 'po-b', 'SCOPE_DENIED'],
    ['reader', CA, 'po-a', 'PERMISSION_DENIED'], ['contextOnly', CA, 'po-a', 'PERMISSION_DENIED'], ['poOnly', CA, 'po-a', 'PERMISSION_DENIED'],
    ['outsider', CA, 'po-a', 'SCOPE_DENIED'], ['syncer', CX, 'po-x', 'SCOPE_DENIED'], ['disabled', CA, 'po-a', 'POWEROFFICE_AUTHENTICATION_FAILED']];
  for (const [who, client, connection, expected] of cases) {
    const before = (await denials(owner)).length;
    assert.equal(await codeOf(syncPowerOffice(prisma, s.composition, as(who), client, connection)), expected, `${who} ${connection}`);
    const added = (await denials(owner)).length - before;
    assert.equal(added, expected === 'SCOPE_DENIED' || expected === 'PERMISSION_DENIED' ? 1 : 0, `${who} ${connection}: workspace denials`);
  }
  assert.equal(s.calls.length, 0, 'zero port calls'); assert.equal(await stateCount(), 0, 'no State initialized'); assert.deepEqual(await audits(owner), []);
});

test('complete multi-page export: exact independent aggregate, atomic snapshot/pointer/SUCCEEDED/lastSuccessAt, six-key audits, payload-free receipt', async () => {
  const conn = await addSyncConnection(owner, key('po-big'), 250);
  const s = seam();
  const receipt = await syncPowerOffice(prisma, s.composition, as('syncer'), CA, 'po-big');
  assert.deepEqual(Object.keys(receipt).sort(), ['attemptId', 'connectionId', 'idempotent', 'sequence', 'snapshotId', 'state', 'synthetic']);
  assert.equal(receipt.state, 'SUCCEEDED'); assert.equal(receipt.idempotent, false); assert.equal(receipt.synthetic, true); assert.equal(receipt.sequence, 1);
  assert.deepEqual(s.calls.map(c => [c.ordinal, c.outcome]), [[1, 'page'], [2, 'page'], [3, 'page']], 'one call per page, serial, no retry');
  for (const c of s.calls) assert.ok(c.monotonicDeadline - c.startedAt <= 10_000, 'per-page deadline ≤ 10 s');
  const o = await observe(runtime, conn);
  assert.equal(o.snapshots.length, 1);
  const snap = o.snapshots[0];
  assert.equal(snap.id, receipt.snapshotId); assert.equal(snap.attemptId, receipt.attemptId); assert.equal(snap.synthetic, true);
  assert.deepEqual(validateSummary(snap.summary), await expectedSummary('po-big', conn.companyKey, snap.asOf, receipt.attemptId));
  assert.equal(snap.businessDate, businessDate(new Date(snap.asOf)));
  assert.deepEqual(o.attempts.map((a: { state: string; allocated: string }) => [a.state, a.allocated]), [['SUCCEEDED', receipt.snapshotId]]);
  assert.equal(o.state.pointer, receipt.snapshotId); assert.equal(o.state.active, null); assert.equal(o.state.next, 2);
  assert.deepEqual([o.state.lastAttemptState, o.state.lastCompletedState, o.state.lastCompletedErrorCode], ['SUCCEEDED', 'SUCCEEDED', null]);
  assert.ok(o.state.lastSuccessAt !== null);
  const rows = await audits(owner, 'po-big');
  assert.deepEqual(rows.map(r => r.eventType), ['poweroffice.sync.started', 'poweroffice.sync.succeeded']);
  assert.deepEqual(rows[0].metadata, { connectionId: 'po-big', attemptId: receipt.attemptId, sequence: '1', outcome: 'STARTED' });
  assert.deepEqual(rows[1].metadata, { connectionId: 'po-big', attemptId: receipt.attemptId, snapshotId: receipt.snapshotId, sequence: '1', outcome: 'SUCCEEDED' });
  for (const r of rows) {
    assert.ok(Object.keys(r.metadata).every(k => (POWEROFFICE_AUDIT_KEYS as readonly string[]).includes(k)));
    assert.equal(r.actorId, 'syncer'); assert.equal(r.correlationId, rows[0].correlationId, 'one correlation per sync');
  }
  // A second sync is a new attempt: new sequence and snapshot, the pointer moves, lastCompleted replaced.
  const second = await syncPowerOffice(prisma, s.composition, as('syncer'), CA, 'po-big');
  assert.equal(second.sequence, 2); assert.notEqual(second.snapshotId, receipt.snapshotId);
  const o2 = await observe(runtime, conn);
  assert.equal(o2.state.pointer, second.snapshotId); assert.equal(o2.state.lastCompleted, second.attemptId); assert.equal(o2.snapshots.length, 2);
});

test('a successful empty export is a known zero, never null', async () => {
  const conn = await addSyncConnection(owner, key('po-empty'), 0);
  const s = seam();
  await syncPowerOffice(prisma, s.composition, as('syncer'), CA, 'po-empty');
  assert.equal(s.calls.length, 1);
  assert.deepEqual((await observe(runtime, conn)).snapshots[0].summary, { totalCount: 0, currencies: [] });
});

test('one durable ACTIVE claim: an admitted claim makes every later sync BUSY; parallel callers — exactly one admitted, port calls only for it', async () => {
  const held = await addSyncConnection(owner, key('po-held'), 3);
  const admitted = await admitSync(prisma, MOCK, as('syncer'), CA, 'po-held');
  assert.equal(admitted.sequence, 1);
  const s = seam();
  const before = (await audits(owner, 'po-held')).length;
  assert.equal(await codeOf(syncPowerOffice(prisma, s.composition, as('syncer'), CA, 'po-held')), 'POWEROFFICE_SYNC_BUSY');
  assert.equal(await codeOf(admitSync(prisma, MOCK, as('syncer'), CA, 'po-held')), 'POWEROFFICE_SYNC_BUSY');
  assert.equal(s.calls.length, 0); assert.equal((await audits(owner, 'po-held')).length, before, 'BUSY writes no audit');
  assert.deepEqual((await observe(runtime, held)).attempts.map((a: { state: string }) => a.state), ['ACTIVE']);
  const conn = await addSyncConnection(owner, key('po-race'), 3);
  const slow = seam(async call => { await sleep(300); return call.builtIn(); });
  const results = await Promise.all(Array.from({ length: 6 }, () => codeOf(syncPowerOffice(prisma, slow.composition, as('syncer'), CA, 'po-race'))));
  assert.deepEqual(results.sort(), ['POWEROFFICE_SYNC_BUSY', 'POWEROFFICE_SYNC_BUSY', 'POWEROFFICE_SYNC_BUSY', 'POWEROFFICE_SYNC_BUSY', 'POWEROFFICE_SYNC_BUSY', 'ok']);
  assert.deepEqual(slow.calls.map(c => c.ordinal), [1], 'one page call, only for the admitted claim');
  const o = await observe(runtime, conn);
  assert.deepEqual(o.attempts.map((a: { sequence: number; state: string }) => [a.sequence, a.state]), [[1, 'SUCCEEDED']]);
  assert.equal((await audits(owner, 'po-race')).length, 2);
});

test('1000 retained attempts: SYNC_LIMIT before any port call or write; below the cap a claim is still admitted', async () => {
  const conn = await addSyncConnection(owner, key('po-cap'), 1);
  await seedRetainedAttempts(owner, conn, 998);
  const s = seam();
  assert.equal((await syncPowerOffice(prisma, s.composition, as('syncer'), CA, 'po-cap')).sequence, 999);
  assert.equal((await syncPowerOffice(prisma, s.composition, as('syncer'), CA, 'po-cap')).sequence, 1000, 'the 1000th retained attempt is admitted');
  const calls = s.calls.length; const audited = (await audits(owner, 'po-cap')).length;
  assert.equal(await codeOf(syncPowerOffice(prisma, s.composition, as('syncer'), CA, 'po-cap')), 'POWEROFFICE_SYNC_LIMIT');
  assert.equal(s.calls.length, calls, 'no port call'); assert.equal((await audits(owner, 'po-cap')).length, audited, 'no audit');
  const o = await observe(runtime, conn);
  assert.equal(o.attempts.length, 1000); assert.equal(o.state.next, 1001); assert.equal(o.state.active, null);
});

test('token expiry while admission waits for the State lock: AUTHENTICATION_FAILED after the last lock, zero effects and port calls', async () => {
  const conn = await addSyncConnection(owner, key('po-expiring'), 1);
  const s = seam();
  await syncPowerOffice(prisma, s.composition, as('syncer'), CA, 'po-expiring'); // the State exists
  const bearer = await addToken(owner, WS, 'syncer', 1500);
  const holder = await connect(pgdb.runtimeUrl);
  try {
    await holder.query('BEGIN');
    await holder.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true)`, [WS, CA]);
    await holder.query(`SELECT 1 FROM public."PowerOfficeState" WHERE "connectionId" = 'po-expiring' FOR UPDATE`);
    const before = await observe(runtime, conn); const calls = s.calls.length; const audited = (await audits(owner)).length;
    const pending = codeOf(syncPowerOffice(prisma, s.composition, powerOfficeCredential(bearer), CA, 'po-expiring'));
    await untilWaiting(owner, 'PowerOfficeState');
    await sleep(2000);
    await holder.query('COMMIT');
    assert.equal(await pending, 'POWEROFFICE_AUTHENTICATION_FAILED');
    assert.deepEqual(await observe(runtime, conn), before); assert.equal(s.calls.length, calls); assert.equal((await audits(owner)).length, audited);
  } finally { await holder.end(); }
});

test('capabilities are unforgeable and single-use: one export pass per claim; no publication before a complete pass; copies are unknown', async () => {
  await addSyncConnection(owner, key('po-caps'), 3);
  const admitted = await admitSync(prisma, MOCK, as('syncer'), CA, 'po-caps');
  assert.ok(Object.isFrozen(admitted.claim) && Object.isFrozen(admitted.failure));
  assert.deepEqual(JSON.parse(JSON.stringify(admitted.claim)), { kind: 'PowerOfficeSyncClaim' }, 'serializes to nothing private');
  assert.equal(await codeOf(publishFact(prisma, admitted.claim, { totalCount: 0, currencies: [] })), 'POWEROFFICE_CLAIM_STALE', 'no complete pass yet');
  assert.equal(await codeOf(runExportPass(prisma, { ...admitted.claim })), 'POWEROFFICE_CLAIM_STALE', 'a copy is unknown');
  const pass = await runExportPass(prisma, admitted.claim);
  assert.equal(pass.complete, true);
  assert.equal(await codeOf(runExportPass(prisma, admitted.claim)), 'POWEROFFICE_CLAIM_STALE', 'no second pass');
  assert.equal((await publishFact(prisma, admitted.claim, pass.complete ? pass.summary : null)).idempotent, false);
});
