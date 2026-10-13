import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PrismaClient } from '@prisma/client';
import { powerOfficeCredential } from '../../packages/poweroffice/authority.ts';
import type { PowerOfficeCredential } from '../../packages/poweroffice/authority.ts';
import type { InvoiceSummary } from '../../packages/poweroffice/contracts.ts';
import { admitSync } from '../../packages/poweroffice/admission.ts';
import { runExportPass } from '../../packages/poweroffice/pass.ts';
import { publishFact } from '../../packages/poweroffice/publication.ts';
import { syncPowerOffice } from '../../packages/poweroffice/sync.ts';
import { closeFailed } from '../../packages/poweroffice/failure.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { CA, WS, addPowerOfficeFixtures, connect, tokens } from '../support/poweroffice-fixtures.ts';
import { addSyncConnection, addToken, audits, codeOf, observe, revokeToken, seam, untilWaiting } from '../support/poweroffice-sync.ts';
import type { Seam } from '../support/poweroffice-sync.ts';

// S4-B B4 on PostgreSQL 17: atomic publication of the SAME complete fact with the allocated identities; identical replay is
// a no-op receipt (no second snapshot/audit) that still needs fresh authority and the unchanged binding; a changed fact
// under the same identity is PUBLICATION_CONFLICT; an audit failure rolls everything back and leaves the claim ACTIVE;
// ACTUAL deadlock victims (40P01) are re-run with the same fact and zero port calls, at most three transactions in total (the
// private failure continuation follows the same bounded rule);
// generic failures (other SQLSTATEs, a Prisma transaction timeout) are never re-run.
const pgdb = await createTestDatabase();
const prisma = new PrismaClient({ datasources: { db: { url: pgdb.runtimeUrl } } });
const runtime = await connect(pgdb.runtimeUrl);
const extra: pg.Client[] = [];
after(async () => { for (const c of [runtime, ...extra]) await c.end().catch(() => undefined); await prisma.$disconnect(); await pgdb.drop(); });
const owner = pgdb.owner;
await addPowerOfficeFixtures(owner);
const key = (connectionId: string) => ({ workspaceId: WS, clientId: CA, connectionId });
const syncer = powerOfficeCredential(tokens.syncer!);

/** Admission + a complete pass through the seam; returns the claim and its fact, ready to publish. */
async function completed(connectionId: string, credential: PowerOfficeCredential = syncer, s: Seam = seam()) {
  const conn = await addSyncConnection(owner, key(connectionId), 3);
  const admitted = await admitSync(prisma, s.composition, credential, CA, connectionId);
  const pass = await runExportPass(prisma, admitted.claim);
  if (!pass.complete) throw new Error(`pass failed: ${pass.code}`);
  return { conn, claim: admitted.claim, failure: admitted.failure, fact: pass.summary, seam: s, attemptId: admitted.attemptId };
}
const succeeded = async (connectionId: string) => (await audits(owner, connectionId)).filter(r => r.eventType === 'poweroffice.sync.succeeded');

test('identical replay is a no-op receipt (one snapshot, one audit); the same identity with a changed fact is PUBLICATION_CONFLICT', async () => {
  const c = await completed('po-replay');
  const first = await publishFact(prisma, c.claim, c.fact);
  const replay = await publishFact(prisma, c.claim, JSON.parse(JSON.stringify(c.fact)));
  assert.deepEqual({ ...replay, idempotent: false }, first); assert.equal(replay.idempotent, true);
  const changed: InvoiceSummary = { totalCount: 1, currencies: [{ currency: 'NOK', count: 1, openInvoiceCount: 1, overdueInvoiceCount: 0, creditNoteCount: 0,
    outstandingInvoiceAmount: '1.00', outstandingCreditAmount: '0.00' }] };
  const before = await observe(runtime, c.conn);
  assert.equal(await codeOf(publishFact(prisma, c.claim, changed)), 'POWEROFFICE_PUBLICATION_CONFLICT');
  assert.equal(await codeOf(publishFact(prisma, c.claim, { totalCount: 1 })), 'POWEROFFICE_DTO_INVALID', 'a malformed fact never reaches SQL');
  assert.deepEqual(await observe(runtime, c.conn), before);
  assert.equal(before.snapshots.length, 1); assert.equal((await succeeded('po-replay')).length, 1, 'no duplicate audit');
  assert.equal(c.seam.calls.length, 1, 'publication and replays call no port');
});

test('a receipt needs fresh authority and the unchanged binding: revoked caller or changed lifecycle refuse with no effect', async () => {
  const bearer = await addToken(owner, WS, 'syncer');
  const c = await completed('po-receipt', powerOfficeCredential(bearer));
  await publishFact(prisma, c.claim, c.fact);
  const before = await observe(runtime, c.conn);
  await revokeToken(owner, bearer);
  assert.equal(await codeOf(publishFact(prisma, c.claim, c.fact)), 'POWEROFFICE_AUTHENTICATION_FAILED');
  const d = await completed('po-receipt-bump');
  await publishFact(prisma, d.claim, d.fact);
  await owner.query(`UPDATE "Connection" SET "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = 'po-receipt-bump'`);
  assert.equal(await codeOf(publishFact(prisma, d.claim, d.fact)), 'POWEROFFICE_BINDING_CHANGED');
  assert.deepEqual(await observe(runtime, c.conn), before);
});

test('audit failure rolls the whole publication back (AUDIT_FAILED): no snapshot, claim ACTIVE, never a false failure; a later explicit publication commits once', async () => {
  await owner.query(`CREATE FUNCTION public.s4b_test_publication_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW."eventType" = 'poweroffice.sync.succeeded' THEN RAISE EXCEPTION 'audit sink down' USING ERRCODE = '58000'; END IF; RETURN NEW; END $$;
    REVOKE ALL ON FUNCTION public.s4b_test_publication_audit_fault() FROM PUBLIC;
    CREATE TRIGGER s4b_test_publication_audit_fault BEFORE INSERT ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION public.s4b_test_publication_audit_fault();`);
  let c: Awaited<ReturnType<typeof completed>>;
  try {
    c = await completed('po-audit');
    assert.equal(await codeOf(publishFact(prisma, c.claim, c.fact)), 'POWEROFFICE_AUDIT_FAILED');
    const o = await observe(runtime, c.conn);
    assert.deepEqual([o.snapshots.length, o.state.active, o.state.pointer, o.attempts[0].state], [0, c.attemptId, null, 'ACTIVE']);
    await addSyncConnection(owner, key('po-audit-sync'), 3);
    const s = seam();
    assert.equal(await codeOf(syncPowerOffice(prisma, s.composition, syncer, CA, 'po-audit-sync')), 'POWEROFFICE_AUDIT_FAILED');
    const o2 = await observe(runtime, key('po-audit-sync'));
    assert.deepEqual([o2.attempts[0].state, o2.snapshots.length, o2.state.lastCompleted], ['ACTIVE', 0, null], 'left ACTIVE for explicit recovery, not FAILED');
    assert.equal(await codeOf(syncPowerOffice(prisma, s.composition, syncer, CA, 'po-audit-sync')), 'POWEROFFICE_SYNC_BUSY');
  } finally {
    await owner.query(`DROP TRIGGER s4b_test_publication_audit_fault ON "AuditEvent"; DROP FUNCTION public.s4b_test_publication_audit_fault();`);
  }
  const receipt = await publishFact(prisma, c!.claim, c!.fact);
  assert.equal(receipt.idempotent, false); assert.equal((await succeeded('po-audit')).length, 1);
});

/**
 * A direct (owner) session holding the connection's State row lock (FOR UPDATE) in an open transaction. Its own
 * session-level deadlock_timeout is 5 s, so in every cycle the Stage 4 transaction (default 1 s) runs PostgreSQL's deadlock
 * check first and is the 40P01 victim deterministically (a session SET only; no catalog or privilege change).
 */
async function stateHolder(connectionId: string, wait = false): Promise<{ client: pg.Client; locked: Promise<unknown> }> {
  const client = await connect(pgdb.ownerUrl); extra.push(client);
  await client.query(`SET deadlock_timeout = '5s'`);
  await client.query('BEGIN');
  const locked = client.query(`SELECT 1 /* s4b-holder */ FROM public."PowerOfficeState" WHERE "connectionId" = $1 FOR UPDATE`, [connectionId]);
  if (!wait) await locked;
  return { client, locked };
}
/**
 * `victims` ACTUAL deadlocks against one publication: each holder takes the State row first; once the publication (fence
 * held) waits for that row, the holder asks for the fence — the publication waited first, so it is the 40P01 victim and the
 * holder proceeds. The next holder is already queued on the State row, so the re-run meets the same cycle.
 */
async function deadlockChain(connectionId: string, victims: number, publish: () => Promise<unknown>): Promise<string> {
  let holder = await stateHolder(connectionId);
  const pending = codeOf(publish());
  for (let i = 0; i < victims; i++) {
    await untilWaiting(owner, '"nextSequence", "activeAttemptId"'); // the publication's State lock (locks.ts) is waiting
    const next = i + 1 < victims ? await stateHolder(connectionId, true) : null;
    if (next) await untilWaiting(owner, 's4b-holder');
    const fence = await holder.client.query(`SELECT 1 FROM public."ActionAuthorityFence" WHERE "workspaceId" = $1 FOR UPDATE`, [WS]).then(() => 'locked', e => e.code);
    assert.equal(fence, 'locked', `round ${i + 1}: the holder is not the victim`);
    await holder.client.query('ROLLBACK');
    if (next) { await next.locked; holder = next; }
  }
  return pending;
}

test('a real deadlock victim at publication is re-run with fresh authority and the same fact: one snapshot, one audit, zero port calls', async () => {
  const c = await completed('po-deadlock');
  const deadlocks = async () => Number((await owner.query(`SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`)).rows[0].deadlocks);
  const before = await deadlocks();
  let receipt: unknown;
  assert.equal(await deadlockChain('po-deadlock', 1, async () => { receipt = await publishFact(prisma, c.claim, c.fact); }), 'ok');
  assert.equal((receipt as { idempotent: boolean }).idempotent, false);
  const o = await observe(runtime, c.conn);
  assert.deepEqual([o.snapshots.length, o.snapshots[0].id, o.attempts[0].state], [1, (receipt as { snapshotId: string }).snapshotId, 'SUCCEEDED']);
  assert.equal((await succeeded('po-deadlock')).length, 1); assert.equal(c.seam.calls.length, 1);
  for (let i = 0; i < 40 && await deadlocks() === before; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(await deadlocks() > before, 'PostgreSQL recorded the deadlock');
});

test('three consecutive real deadlock victims exhaust the bound: PUBLICATION_CONFLICT, claim still ACTIVE and publishable, zero port calls', async () => {
  const c = await completed('po-exhaust');
  assert.equal(await deadlockChain('po-exhaust', 3, () => publishFact(prisma, c.claim, c.fact)), 'POWEROFFICE_PUBLICATION_CONFLICT');
  const o = await observe(runtime, c.conn);
  assert.deepEqual([o.snapshots.length, o.attempts[0].state, o.state.active], [0, 'ACTIVE', c.attemptId], 'nothing committed; recoverable');
  assert.equal((await succeeded('po-exhaust')).length, 0); assert.equal(c.seam.calls.length, 1, 'no new export, no port call');
  assert.equal((await publishFact(prisma, c.claim, c.fact)).idempotent, false, 'the next explicit publication of the same fact commits');
});

test('only 40P01/40001 is re-run: injected 40001 runs exactly three transactions; 57014 and a Prisma transaction timeout run once', async () => {
  await owner.query(`CREATE SEQUENCE public.s4b_test_publication_runs; REVOKE ALL ON SEQUENCE public.s4b_test_publication_runs FROM PUBLIC;
    GRANT USAGE ON SEQUENCE public.s4b_test_publication_runs TO "${pgdb.runtimeRole}";
    CREATE FUNCTION public.s4b_test_snapshot_fault() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE n bigint := nextval('public.s4b_test_publication_runs'); BEGIN
      IF NEW."connectionId" = 'po-inject-40001' THEN RAISE EXCEPTION 'injected' USING ERRCODE = '40001'; END IF;
      IF NEW."connectionId" = 'po-inject-57014' THEN RAISE EXCEPTION 'injected' USING ERRCODE = '57014'; END IF;
      IF NEW."connectionId" = 'po-inject-timeout' THEN PERFORM pg_sleep(21); END IF;
      RETURN NEW; END $$;
    REVOKE ALL ON FUNCTION public.s4b_test_snapshot_fault() FROM PUBLIC;
    CREATE TRIGGER s4b_test_snapshot_fault BEFORE INSERT ON "PowerOfficeSnapshot" FOR EACH ROW EXECUTE FUNCTION public.s4b_test_snapshot_fault();`);
  const runs = async () => Number((await owner.query(`SELECT last_value, is_called FROM public.s4b_test_publication_runs`)).rows.map(r => r.is_called ? r.last_value : 0)[0]);
  try {
    for (const [id, expected, transactions] of [['po-inject-40001', 'POWEROFFICE_PUBLICATION_CONFLICT', 3], ['po-inject-57014', 'UNEXPECTED_ERROR', 1],
      ['po-inject-timeout', 'POWEROFFICE_DB_CONFLICT', 1]] as const) {
      const c = await completed(id);
      const before = await runs();
      assert.equal(await codeOf(publishFact(prisma, c.claim, c.fact)), expected, id);
      assert.equal(await runs() - before, transactions, `${id}: publication transactions`);
      const o = await observe(runtime, c.conn);
      assert.deepEqual([o.snapshots.length, o.attempts[0].state], [0, 'ACTIVE'], `${id}: nothing committed, claim left for recovery`);
      assert.equal(c.seam.calls.length, 1, `${id}: zero extra port calls`);
    }
  } finally {
    await owner.query(`DROP TRIGGER s4b_test_snapshot_fault ON "PowerOfficeSnapshot"; DROP FUNCTION public.s4b_test_snapshot_fault();
      DROP SEQUENCE public.s4b_test_publication_runs;`);
  }
});

test('the private failure continuation follows the same rule: a real deadlock victim is re-run (FAILED once); three victims leave the claim ACTIVE', async () => {
  const one = await completed('pf-deadlock');
  let outcome: unknown;
  assert.equal(await deadlockChain('pf-deadlock', 1, async () => { outcome = await closeFailed(prisma, one.failure, 'POWEROFFICE_SOURCE_FAILED'); }), 'ok');
  assert.equal(outcome, 'FAILED');
  const failed = (await audits(owner, 'pf-deadlock')).filter(r => r.eventType === 'poweroffice.sync.failed');
  assert.deepEqual(failed.map(r => r.metadata.safeErrorCode), ['POWEROFFICE_SOURCE_FAILED'], 'one FAILED audit');
  assert.deepEqual((await observe(runtime, one.conn)).attempts.map((a: { state: string }) => a.state), ['FAILED']);
  const three = await completed('pf-exhaust');
  assert.equal(await deadlockChain('pf-exhaust', 3, () => closeFailed(prisma, three.failure, 'POWEROFFICE_SOURCE_FAILED')), 'POWEROFFICE_DB_CONFLICT');
  assert.deepEqual([(await observe(runtime, three.conn)).attempts[0].state, (await audits(owner, 'pf-exhaust')).length], ['ACTIVE', 1], 'nothing committed beyond STARTED');
  assert.equal(await closeFailed(prisma, three.failure, 'POWEROFFICE_SOURCE_FAILED'), 'FAILED', 'a later explicit closure still records it');
});
