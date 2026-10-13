import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { powerOfficeCredential } from '../../packages/poweroffice/authority.ts';
import { POWEROFFICE_MODE_VARIABLE, powerOfficeComposition } from '../../packages/poweroffice/composition.ts';
import { validateSummary } from '../../packages/poweroffice/aggregate.ts';
import type { InvoiceSummary } from '../../packages/poweroffice/contracts.ts';
import { admitSync } from '../../packages/poweroffice/admission.ts';
import { endClaim } from '../../packages/poweroffice/capabilities.ts';
import { runExportPass } from '../../packages/poweroffice/pass.ts';
import { publishFact } from '../../packages/poweroffice/publication.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { CA, WS, addPowerOfficeFixtures, connect, tokens } from '../support/poweroffice-fixtures.ts';
import { addSyncConnection, audits, clone, codeOf, observe } from '../support/poweroffice-sync.ts';

// S4-B RC1 R1 regression on PostgreSQL 17 with the PRODUCTION MOCK composition (actual built-in source, no fault seam):
// publication is bound to the exact detached completed fact of its own claim. A different structurally valid aggregate —
// invented, another genuine claim's completed fact, or offered after a rolled-back first publication — refuses with
// POWEROFFICE_PUBLICATION_CONFLICT BEFORE any publication effect; the authentic fact then publishes exactly once with the
// claim's original IDs and content.
const pgdb = await createTestDatabase();
const prisma = new PrismaClient({ datasources: { db: { url: pgdb.runtimeUrl } } });
const runtime = await connect(pgdb.runtimeUrl);
after(async () => { await runtime.end().catch(() => undefined); await prisma.$disconnect(); await pgdb.drop(); });
const owner = pgdb.owner;
await addPowerOfficeFixtures(owner);
const MOCK = powerOfficeComposition({ [POWEROFFICE_MODE_VARIABLE]: 'MOCK' });
const syncer = powerOfficeCredential(tokens.syncer!);
const key = (connectionId: string) => ({ workspaceId: WS, clientId: CA, connectionId });

/** A genuine admission and an actual built-in complete pass. */
async function completed(connectionId: string, items: number) {
  await addSyncConnection(owner, key(connectionId), items);
  const admitted = await admitSync(prisma, MOCK, syncer, CA, connectionId);
  const pass = await runExportPass(prisma, admitted.claim);
  if (!pass.complete) throw new Error(`pass failed: ${pass.code}`);
  assert.equal(pass.summary.totalCount, items); assert.ok(Object.isFrozen(pass.summary));
  return { admitted, fact: pass.summary };
}
/** Nothing published for this claim: ACTIVE, no snapshot, no pointer, only the STARTED audit. */
async function unpublished(connectionId: string, attemptId: string, label: string): Promise<void> {
  const o = await observe(runtime, key(connectionId));
  assert.deepEqual([o.snapshots.length, o.state.pointer, o.state.active, o.state.lastSuccessAt, o.state.lastCompleted, o.attempts.map((a: { state: string }) => a.state)],
    [0, null, attemptId, null, null, ['ACTIVE']], `${label}: no snapshot/pointer/terminal change`);
  assert.deepEqual((await audits(owner, connectionId)).map(r => r.metadata.outcome), ['STARTED'], `${label}: no success audit`);
}
/** The authentic fact publishes exactly once with the claim's allocated IDs and its exact content. */
async function publishedAuthentic(connectionId: string, c: Awaited<ReturnType<typeof completed>>): Promise<void> {
  const receipt = await publishFact(prisma, c.admitted.claim, clone(c.fact)); // a structurally identical detached copy
  assert.deepEqual([receipt.idempotent, receipt.attemptId, receipt.sequence], [false, c.admitted.attemptId, c.admitted.sequence]);
  const o = await observe(runtime, key(connectionId));
  assert.equal(o.snapshots.length, 1);
  assert.deepEqual([o.snapshots[0].id, o.attempts[0].allocated, o.state.pointer], [receipt.snapshotId, receipt.snapshotId, receipt.snapshotId]);
  assert.deepEqual(validateSummary(o.snapshots[0].summary), c.fact, 'the exact original content');
  assert.deepEqual((await audits(owner, connectionId)).map(r => r.metadata.outcome), ['STARTED', 'SUCCEEDED']);
  assert.equal((await publishFact(prisma, c.admitted.claim, c.fact)).idempotent, true, 'identical replay stays a no-op receipt');
}

test('a genuine complete claim refuses a different valid first fact before any effect; the authentic fact then publishes exactly', async () => {
  const c = await completed('pv-substitute', 3);
  const group = c.fact.currencies[0]!;
  const sameShapeOtherAmount: InvoiceSummary = { totalCount: c.fact.totalCount, currencies: c.fact.currencies.map(g => g === group
    ? { ...g, outstandingInvoiceAmount: g.outstandingInvoiceAmount === '0.00' ? g.outstandingInvoiceAmount : '1.00',
      outstandingCreditAmount: g.creditNoteCount > 0 ? '0.01' : '0.00', overdueInvoiceCount: 0 } : g) };
  for (const [label, substitute] of [['known empty', { totalCount: 0, currencies: [] }], ['same count, other amounts', sameShapeOtherAmount]] as const) {
    assert.notDeepEqual(validateSummary(substitute), c.fact, `${label} is a different valid fact`);
    assert.equal(await codeOf(publishFact(prisma, c.admitted.claim, substitute)), 'POWEROFFICE_PUBLICATION_CONFLICT', label);
    await unpublished('pv-substitute', c.admitted.attemptId, label);
  }
  await publishedAuthentic('pv-substitute', c);
  endClaim(c.admitted.claim);
  assert.equal(await codeOf(publishFact(prisma, c.admitted.claim, c.fact)), 'POWEROFFICE_CLAIM_STALE', 'an ended claim no longer holds a fact');
});

test("another genuine claim's completed fact is refused for this claim (both directions); each claim publishes only its own", async () => {
  const a = await completed('pv-own-a', 3);
  const b = await completed('pv-own-b', 5);
  assert.equal(await codeOf(publishFact(prisma, a.admitted.claim, b.fact)), 'POWEROFFICE_PUBLICATION_CONFLICT');
  assert.equal(await codeOf(publishFact(prisma, b.admitted.claim, a.fact)), 'POWEROFFICE_PUBLICATION_CONFLICT');
  await unpublished('pv-own-a', a.admitted.attemptId, 'a');
  await unpublished('pv-own-b', b.admitted.attemptId, 'b');
  await publishedAuthentic('pv-own-a', a);
  await publishedAuthentic('pv-own-b', b);
});

test('after a rolled-back first publication a changed fact is still refused before any effect; the authentic fact then commits once', async () => {
  const c = await completed('pv-after-rollback', 3);
  await owner.query(`CREATE FUNCTION public.s4b_test_provenance_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW."eventType" = 'poweroffice.sync.succeeded' THEN RAISE EXCEPTION 'audit sink down' USING ERRCODE = '58000'; END IF; RETURN NEW; END $$;
    REVOKE ALL ON FUNCTION public.s4b_test_provenance_audit_fault() FROM PUBLIC;
    CREATE TRIGGER s4b_test_provenance_audit_fault BEFORE INSERT ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION public.s4b_test_provenance_audit_fault();`);
  try { assert.equal(await codeOf(publishFact(prisma, c.admitted.claim, c.fact)), 'POWEROFFICE_AUDIT_FAILED', 'the first publication rolled back'); }
  finally { await owner.query(`DROP TRIGGER s4b_test_provenance_audit_fault ON "AuditEvent"; DROP FUNCTION public.s4b_test_provenance_audit_fault();`); }
  await unpublished('pv-after-rollback', c.admitted.attemptId, 'rolled back');
  // Nothing would stop a write now (no fault, claim ACTIVE, before the deadline): only the fact binding refuses.
  assert.equal(await codeOf(publishFact(prisma, c.admitted.claim, { totalCount: 0, currencies: [] })), 'POWEROFFICE_PUBLICATION_CONFLICT');
  await unpublished('pv-after-rollback', c.admitted.attemptId, 'changed fact after rollback');
  await publishedAuthentic('pv-after-rollback', c);
});
