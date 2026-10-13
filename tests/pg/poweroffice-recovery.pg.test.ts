import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { powerOfficeCredential } from '../../packages/poweroffice/authority.ts';
import { POWEROFFICE_MODE_VARIABLE, powerOfficeComposition } from '../../packages/poweroffice/composition.ts';
import type { InvoiceSummary } from '../../packages/poweroffice/contracts.ts';
import { admitSync } from '../../packages/poweroffice/admission.ts';
import type { Admitted } from '../../packages/poweroffice/admission.ts';
import { runExportPass } from '../../packages/poweroffice/pass.ts';
import { publishFact } from '../../packages/poweroffice/publication.ts';
import { closeFailed } from '../../packages/poweroffice/failure.ts';
import { recoverPowerOffice } from '../../packages/poweroffice/recovery.ts';
import { syncPowerOffice } from '../../packages/poweroffice/sync.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { CA, WS, addPowerOfficeFixtures, connect, tokens } from '../support/poweroffice-fixtures.ts';
import { addSyncConnection, addToken, audits, codeOf, denials, observe, revokeToken, seam, sleep } from '../support/poweroffice-sync.ts';
import type { SyncConnection } from '../support/poweroffice-sync.ts';

// S4-B B5 (and the B2/B4 time bounds) on PostgreSQL 17 with REAL waits against stored DB-clock deadlines — no caller clock
// and no stored-time rewriting. All long cases share one timeline (batched): claims are admitted at t≈0; at t≈52 s a page
// deadline is capped by the ORIGINAL 60 s read window; once the DB clock passes a claim's readDeadlineAt its next page is
// refused and the private failure still closes it before 80 s; after every deadlineAt (≈82 s) expired claims stay BUSY,
// private failure can no longer mutate, explicit recovery abandons (also after disable/lifecycle drift), late results are
// inert and an identical SUCCEEDED receipt is still a no-op after fresh authority. Recovery never calls the port.
const pgdb = await createTestDatabase();
const prisma = new PrismaClient({ datasources: { db: { url: pgdb.runtimeUrl } } });
const runtime = await connect(pgdb.runtimeUrl);
after(async () => { await runtime.end().catch(() => undefined); await prisma.$disconnect(); await pgdb.drop(); });
const owner = pgdb.owner;
await addPowerOfficeFixtures(owner);
const MOCK = powerOfficeComposition({ [POWEROFFICE_MODE_VARIABLE]: 'MOCK' });
const syncer = powerOfficeCredential(tokens.syncer!);
const key = (connectionId: string) => ({ workspaceId: WS, clientId: CA, connectionId });
const noPort = seam(async () => { throw new Error('recovery must never call the port'); });
const recover = (id: string, credential = syncer) => recoverPowerOffice(prisma, noPort.composition, credential, CA, id);
const auditCount = async (id: string) => (await audits(owner, id)).length;
/** DB clock against the stored deadlines of the named connections' ACTIVE attempts. */
async function untilDb(column: 'readDeadlineAt' | 'deadlineAt', ids: string[]): Promise<void> {
  for (;;) {
    const r = await owner.query(`SELECT bool_and((clock_timestamp() AT TIME ZONE 'UTC') >= "${column}") AS due FROM "PowerOfficeAttempt"
      WHERE "workspaceId" = $1 AND "connectionId" = ANY($2) AND state = 'ACTIVE'`, [WS, ids]);
    if (r.rows[0].due !== false) return;
    await sleep(100);
  }
}
const dbBefore = async (column: 'readDeadlineAt' | 'deadlineAt', attemptId: string) => (await owner.query(`SELECT (clock_timestamp() AT TIME ZONE 'UTC') < "${column}" AS before
  FROM "PowerOfficeAttempt" WHERE id = $1::uuid`, [attemptId])).rows[0].before as boolean;

interface Claimed { conn: SyncConnection; admitted: Admitted; prior?: { pointer: string; lastSuccessAt: string } }
const c: Record<string, Claimed> = {};
let capWindow = { before: 0, after: 0 };
let lateFact: InvoiceSummary | null = null;
let replayFact: InvoiceSummary | null = null;
let replayBearer = '';
let persistFact: InvoiceSummary | null = null;
const capSeam = seam();
const windowSeam = seam();
async function claim(id: string, items = 3, withPrior = false, credential = syncer, composition: unknown = MOCK): Promise<Claimed> {
  const conn = await addSyncConnection(owner, key(id), items);
  let prior;
  if (withPrior) {
    await syncPowerOffice(prisma, seam().composition, syncer, CA, id);
    const o = await observe(runtime, conn);
    prior = { pointer: o.state.pointer, lastSuccessAt: o.state.lastSuccessAt };
  }
  return (c[id] = { conn, admitted: await admitSync(prisma, composition, credential, CA, id), prior });
}

test('t≈0: claims admitted; recovery is not due; BUSY; no-ACTIVE recovery is a zero-effect no-op; private failure after revocation closes only its own claim', async () => {
  capWindow.before = performance.now();
  await claim('r-cap', 3, false, syncer, capSeam.composition);
  capWindow.after = performance.now();
  await claim('r-window', 250, false, syncer, windowSeam.composition);
  const persist = await claim('r-persist');
  const pp = await runExportPass(prisma, persist.admitted.claim);
  persistFact = pp.complete ? pp.summary : null;
  await claim('r-crash');
  await claim('r-busy');
  await claim('r-private-late');
  await claim('r-drift', 3, true);
  await owner.query(`UPDATE "Connection" SET status = 'DISABLED', "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = 'r-drift'`);
  const late = await claim('r-late', 3, true);
  const pass = await runExportPass(prisma, late.admitted.claim);
  assert.equal(pass.complete, true); lateFact = pass.complete ? pass.summary : null;
  replayBearer = await addToken(owner, WS, 'syncer');
  const replay = await claim('r-replay', 3, false, powerOfficeCredential(replayBearer));
  const rp = await runExportPass(prisma, replay.admitted.claim);
  replayFact = rp.complete ? rp.summary : null;
  await publishFact(prisma, replay.admitted.claim, replayFact);
  // Audit failure of the private failure leaves the claim ACTIVE (recovered after the deadline below).
  await claim('r-audit');
  await owner.query(`CREATE FUNCTION public.s4b_test_failure_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW."eventType" = 'poweroffice.sync.failed' THEN RAISE EXCEPTION 'audit sink down' USING ERRCODE = '58000'; END IF; RETURN NEW; END $$;
    REVOKE ALL ON FUNCTION public.s4b_test_failure_audit_fault() FROM PUBLIC;
    CREATE TRIGGER s4b_test_failure_audit_fault BEFORE INSERT ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION public.s4b_test_failure_audit_fault();`);
  try { assert.equal(await codeOf(closeFailed(prisma, c['r-audit']!.admitted.failure, 'POWEROFFICE_SOURCE_FAILED')), 'POWEROFFICE_AUDIT_FAILED'); }
  finally { await owner.query(`DROP TRIGGER s4b_test_failure_audit_fault ON "AuditEvent"; DROP FUNCTION public.s4b_test_failure_audit_fault();`); }
  assert.equal((await observe(runtime, key('r-audit'))).attempts[0].state, 'ACTIVE', 'audit failure: claim stays ACTIVE');

  // Recovery before the deadline, without sync rights, or with nothing ACTIVE: refused/no-op with zero effects and no audit.
  const crash = await observe(runtime, key('r-crash')); const crashAudits = await auditCount('r-crash');
  assert.equal(await codeOf(recover('r-crash')), 'POWEROFFICE_RECOVERY_NOT_DUE');
  const seen = (await denials(owner)).length;
  assert.equal(await codeOf(recover('r-crash', powerOfficeCredential(tokens.reader!))), 'PERMISSION_DENIED');
  assert.equal(await codeOf(recover('r-crash', powerOfficeCredential(tokens.maintainer!))), 'PERMISSION_DENIED');
  assert.equal((await denials(owner)).length, seen + 2);
  assert.deepEqual(await observe(runtime, key('r-crash')), crash); assert.equal(await auditCount('r-crash'), crashAudits);
  const s = seam();
  assert.equal(await codeOf(syncPowerOffice(prisma, s.composition, syncer, CA, 'r-crash')), 'POWEROFFICE_SYNC_BUSY');
  await addSyncConnection(owner, key('r-none'), 3);
  assert.equal(await codeOf(recover('r-none')), 'POWEROFFICE_NO_ACTIVE_ATTEMPT');
  assert.equal((await observe(runtime, key('r-none'))).state, null, 'recovery never initializes State');
  await addSyncConnection(owner, key('r-lostack'), 3);
  await syncPowerOffice(prisma, s.composition, syncer, CA, 'r-lostack');
  const lostAck = await auditCount('r-lostack');
  assert.equal(await codeOf(recover('r-lostack')), 'POWEROFFICE_NO_ACTIVE_ATTEMPT', 'after a committed publication (lost acknowledgement)');
  assert.equal(await auditCount('r-lostack'), lostAck);

  // Private failure after the caller's revocation: closes its own ACTIVE claim, no summary, no read; replay is a no-op.
  const bearer = await addToken(owner, WS, 'syncer');
  const own = await claim('r-revoked', 3, true, powerOfficeCredential(bearer));
  await revokeToken(owner, bearer);
  assert.equal(await closeFailed(prisma, own.admitted.failure, 'POWEROFFICE_AUTHENTICATION_FAILED'), 'FAILED');
  const after1 = await observe(runtime, own.conn); const audited = await auditCount('r-revoked');
  assert.deepEqual([after1.attempts[1].state, after1.attempts[1].safeErrorCode, after1.state.lastCompletedState, after1.state.pointer, after1.state.lastSuccessAt],
    ['FAILED', 'POWEROFFICE_AUTHENTICATION_FAILED', 'FAILED', own.prior!.pointer, own.prior!.lastSuccessAt]);
  assert.equal(await closeFailed(prisma, own.admitted.failure, 'POWEROFFICE_SOURCE_FAILED'), 'NO_OP', 'terminal replay');
  const next = await admitSync(prisma, MOCK, syncer, CA, 'r-revoked');
  assert.equal(await closeFailed(prisma, own.admitted.failure, 'POWEROFFICE_SOURCE_FAILED'), 'NO_OP', 'the old continuation cannot close the new claim');
  const after2 = await observe(runtime, own.conn);
  assert.deepEqual([after2.state.active, after2.attempts[2].state], [next.attemptId, 'ACTIVE']);
  assert.equal(await auditCount('r-revoked'), audited + 1, 'only the new STARTED audit');
  assert.deepEqual(await runExportPass(prisma, own.admitted.claim), { complete: false, code: 'POWEROFFICE_AUTHENTICATION_FAILED' }, 'the revoked claim reads nothing');
  assert.equal(s.calls.length, 1, 'only the r-lostack sync read a page'); assert.equal(noPort.calls.length, 0);
});

test('t≈52 s: a page admitted late gets the ORIGINAL read deadline, not now + 10 s; the pass and publication still complete', async () => {
  await sleep(Math.max(0, capWindow.after + 52_000 - performance.now()));
  const cap = c['r-cap']!;
  const started = performance.now();
  const pass = await runExportPass(prisma, cap.admitted.claim);
  assert.equal(pass.complete, true);
  assert.equal((await publishFact(prisma, cap.admitted.claim, pass.complete ? pass.summary : null)).idempotent, false);
  assert.ok(performance.now() - started < 8_000);
  const [call] = capSeam.calls;
  assert.equal(capSeam.calls.length, 1);
  // The local read deadline was anchored inside admitSync, before its DB clock read: anchor + 60 s − 1 ms.
  assert.ok(call!.monotonicDeadline >= capWindow.before + 60_000 - 1 && call!.monotonicDeadline <= capWindow.after + 60_000,
    `the original read window (${Math.round(call!.monotonicDeadline - capWindow.before)} ms after admission start)`);
  assert.ok(call!.monotonicDeadline < call!.startedAt + 10_000 - 1_000, 'capped below now + 10 s: no window restarted after the waits');
});

test('read window: past readDeadlineAt the next page admission refuses with no port call; private failure and a completed fact\'s publication still commit before 80 s', async () => {
  const w = c['r-window']!;
  await untilDb('readDeadlineAt', ['r-window', 'r-persist']);
  const persist = c['r-persist']!;
  assert.equal(await dbBefore('readDeadlineAt', persist.admitted.attemptId), false, 'the read window is over');
  assert.equal((await publishFact(prisma, persist.admitted.claim, persistFact)).idempotent, false, 'the 20 s persistence window remains');
  assert.equal((await observe(runtime, persist.conn)).snapshots.length, 1);
  assert.equal(await dbBefore('deadlineAt', w.admitted.attemptId), true, 'still before the claim deadline');
  assert.deepEqual(await runExportPass(prisma, w.admitted.claim), { complete: false, code: 'POWEROFFICE_DEADLINE' });
  assert.equal(windowSeam.calls.length, 0, 'no port call after the read window');
  assert.equal(await closeFailed(prisma, w.admitted.failure, 'POWEROFFICE_DEADLINE'), 'FAILED');
  const o = await observe(runtime, w.conn);
  assert.deepEqual([o.attempts[0].state, o.attempts[0].safeErrorCode, o.snapshots.length], ['FAILED', 'POWEROFFICE_DEADLINE', 0]);
});

test('after deadlineAt: expired claims stay BUSY; private failure cannot mutate; recovery abandons (also after drift); late results are inert; receipts stay no-ops', async () => {
  await untilDb('deadlineAt', Object.keys(c));
  const s = seam();
  // Existing ACTIVE is BUSY even when expired.
  const busy = await auditCount('r-busy');
  assert.equal(await codeOf(syncPowerOffice(prisma, s.composition, syncer, CA, 'r-busy')), 'POWEROFFICE_SYNC_BUSY');
  assert.equal(await auditCount('r-busy'), busy);
  // Private failure at/after the deadline: no mutation; recovery closes it.
  assert.equal(await closeFailed(prisma, c['r-private-late']!.admitted.failure, 'POWEROFFICE_SOURCE_FAILED'), 'EXPIRED');
  assert.equal((await observe(runtime, key('r-private-late'))).attempts[0].state, 'ACTIVE');
  // Crash after claim: recovery abandons atomically with one audit; a second recovery is a no-op; the next sync is a NEW attempt.
  const receipt = await recover('r-crash');
  assert.deepEqual(receipt, { connectionId: 'r-crash', attemptId: c['r-crash']!.admitted.attemptId, sequence: 1, state: 'ABANDONED',
    safeErrorCode: 'POWEROFFICE_DEADLINE', synthetic: true });
  const crash = await observe(runtime, key('r-crash'));
  assert.deepEqual([crash.state.active, crash.state.lastAttemptState, crash.state.lastCompletedState, crash.state.lastCompletedErrorCode, crash.attempts[0].state],
    [null, 'ABANDONED', 'ABANDONED', 'POWEROFFICE_DEADLINE', 'ABANDONED']);
  const abandoned = (await audits(owner, 'r-crash')).at(-1);
  assert.deepEqual([abandoned.eventType, abandoned.metadata], ['poweroffice.sync.abandoned', { connectionId: 'r-crash', attemptId: receipt.attemptId, sequence: '1',
    outcome: 'ABANDONED', safeErrorCode: 'POWEROFFICE_DEADLINE' }]);
  const crashAudits = await auditCount('r-crash');
  assert.equal(await codeOf(recover('r-crash')), 'POWEROFFICE_NO_ACTIVE_ATTEMPT'); assert.equal(await auditCount('r-crash'), crashAudits);
  assert.equal((await syncPowerOffice(prisma, s.composition, syncer, CA, 'r-crash')).sequence, 2, 'a fresh attempt, not a continuation');
  // Disabled connection with an advanced lifecycle: recovery still closes the old claim; no reactivation, no data.
  assert.equal((await recover('r-drift')).state, 'ABANDONED');
  const drift = await observe(runtime, key('r-drift'));
  assert.deepEqual([drift.state.pointer, drift.state.lastSuccessAt, drift.snapshots.length], [c['r-drift']!.prior!.pointer, c['r-drift']!.prior!.lastSuccessAt, 1]);
  assert.equal(await codeOf(syncPowerOffice(prisma, s.composition, syncer, CA, 'r-drift')), 'POWEROFFICE_CONNECTION_UNAVAILABLE');
  assert.equal((await owner.query(`SELECT status FROM "Connection" WHERE id = 'r-drift'`)).rows[0].status, 'DISABLED');
  // A late complete result of a recovered claim can never publish.
  assert.equal((await recover('r-late')).state, 'ABANDONED');
  assert.equal(await codeOf(publishFact(prisma, c['r-late']!.admitted.claim, lateFact)), 'POWEROFFICE_CLAIM_STALE');
  const late = await observe(runtime, key('r-late'));
  assert.deepEqual([late.snapshots.length, late.state.pointer], [1, c['r-late']!.prior!.pointer]);
  // The audit-failure claim stayed recoverable; the late private-failure claim too.
  assert.equal((await recover('r-audit')).state, 'ABANDONED');
  assert.equal((await recover('r-private-late')).state, 'ABANDONED');
  // Identical SUCCEEDED receipt after the deadline: still a no-op after fresh authority; changed fact conflicts; revoked refuses.
  const replay = c['r-replay']!;
  const replayAudits = await auditCount('r-replay');
  assert.equal((await publishFact(prisma, replay.admitted.claim, replayFact)).idempotent, true);
  assert.equal(await codeOf(publishFact(prisma, replay.admitted.claim, { totalCount: 0, currencies: [] })), 'POWEROFFICE_PUBLICATION_CONFLICT');
  await revokeToken(owner, replayBearer);
  assert.equal(await codeOf(publishFact(prisma, replay.admitted.claim, replayFact)), 'POWEROFFICE_AUTHENTICATION_FAILED');
  assert.equal(await codeOf(recover('r-replay')), 'POWEROFFICE_NO_ACTIVE_ATTEMPT');
  assert.equal(await auditCount('r-replay'), replayAudits, 'no duplicate audit');
  assert.equal(noPort.calls.length, 0, 'recovery never called the port'); assert.equal(s.calls.length, 1, 'only the fresh r-crash sync read');
});
