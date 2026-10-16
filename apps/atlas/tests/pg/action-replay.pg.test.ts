import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { takeReservationPermit } from '../../packages/actions/reservation.ts';
import type { ReservedDispatch } from '../../packages/actions/reservation.ts';
import { publishCreateFact, publishVerification } from '../../packages/actions/publication.ts';
import type { ClaimIdentity, PublisherContext } from '../../packages/actions/publication.ts';
import { claimVerification } from '../../packages/actions/verification.ts';
import { mockActionPorts } from '../../packages/actions/mock-port.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { CA, MOCK, WA, addActionFixtures, privateDir, runtimeClient, scoped } from '../support/action-fixtures.ts';
import { actionFlow, addApprovalActors, as, fails, settle } from '../support/action-approval.ts';
import type { Stored } from '../support/action-approval.ts';
import { addExecutionActors, assertNoTicketIds, auditFault, freshCall, observeExec } from '../support/action-exec.ts';

// Stage 3 S3-C RC2 repair R2 on PostgreSQL 17: every committed fact has a stable identity. An identical conflict or stale
// publication — like an identical success — is a no-op with no second audit; its first observation keeps one safe audit;
// distinct facts are still each audited once. The identity is the committed audit row itself (keyed digest ID, no private
// value in metadata or ID), so it survives a new process/client, and a rolled-back attempt (audit failure, 40001/40P01)
// leaves none, so a retry records the fact exactly once within the three-attempt bound.
const pgdb = await createTestDatabase();
const db = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
const runtime = await runtimeClient(pgdb.runtimeUrl);
const files = await privateDir();
const closers: (() => Promise<unknown>)[] = [];
after(async () => { for (const c of closers) await c().catch(() => undefined); await runtime.end(); await db.$disconnect(); await files.remove(); await pgdb.drop(); });
const owner = pgdb.owner;
await addActionFixtures(owner);
await addApprovalActors(owner);
await addExecutionActors(owner);
const flow = actionFlow(db, files);
const see = observeExec(runtime);
const count = async (r: Stored, event: string) => (await see.audit(r.requestId)).filter(a => a.eventType === event).length;

async function dispatched(): Promise<{ r: Stored; d: ReservedDispatch; ticket: string }> {
  const r = await flow.approved();
  const { permit, expected } = await flow.reserve(r);
  const use = takeReservationPermit(permit, expected);
  assert.ok('dispatch' in use);
  const d = use.dispatch;
  const ticket = await mockActionPorts(db).ticketPort({ workspaceId: d.workspaceId, clientId: d.clientId, connectionId: d.connectionId })
    .createOne({ customerKey: d.customerKey, markedTitle: d.markedTitle, description: d.description, nonce: d.createNonce }, freshCall());
  return { r, d, ticket };
}
/** Claims the next ordinal and captures that claim's own exact private identity from the stored rows (runtime scope). */
async function claimIdentity(r: Stored, candidate: string | null): Promise<{ identity: ClaimIdentity; ctx: PublisherContext }> {
  const claimed = await claimVerification(db, MOCK, as('executor'), CA, r.requestId, candidate);
  assert.ok('claim' in claimed);
  const a = (await see.attempt(r.requestId))!;
  const v = (await scoped<Record<string, any>>(runtime, WA, CA, `SELECT * FROM "ActionVerification" WHERE "attemptId" = $1 AND ordinal = $2`, [a.id, a.activeVerificationOrdinal]))[0]!;
  return { identity: { requestId: r.requestId, attemptId: a.id, ordinal: v.ordinal, token: a.activeVerificationToken, nonce: v.nonce, targetKind: v.targetKind,
    targetTicketId: v.targetTicketId, candidate: a.activeCandidateId, requestHash: v.requestHash, createNonce: v.createNonce },
  ctx: { workspaceId: WA, clientId: CA, actorId: 'executor', correlationId: randomUUID() } };
}
/** Audit rows hold no ticket/candidate ID, nonce, token or hash — neither in metadata nor as (an unkeyed digest in) the row ID. */
async function assertPrivateAudit(r: Stored, secrets: string[]): Promise<void> {
  const rows = await scoped<Record<string, any>>(runtime, WA, CA, `SELECT id, "eventType", metadata FROM "AuditEvent" WHERE metadata->>'actionRequestId' = $1`, [r.requestId]);
  // The first 12 hex digits precede the UUID version nibble: an ID derived from an unkeyed digest would start with them
  const digests = secrets.map(s => createHash('sha256').update(s).digest('hex').slice(0, 12));
  assertNoTicketIds(rows, secrets, 'audit rows');
  for (const row of rows) for (const h of digests) assert.ok(!row.id.replace(/-/g, '').startsWith(h), 'no unkeyed digest as a row ID');
}

test('R2: an identical conflicting create fact is a no-op (one audit), distinct conflicts are each audited once, and the identity survives a new client', async () => {
  const { r, d, ticket } = await dispatched();
  assert.equal((await publishCreateFact(db, d, { kind: 'CREATED', ticketId: ticket })).effect, 'PUBLISHED');
  assert.equal((await publishCreateFact(db, d, { kind: 'CREATED', ticketId: ticket })).effect, 'IDENTICAL', 'identical success: no-op');
  const other = randomUUID();
  const first = await publishCreateFact(db, d, { kind: 'CREATED', ticketId: other });
  const again = await publishCreateFact(db, d, { kind: 'CREATED', ticketId: other });
  assert.deepEqual([first.effect, again.effect, await count(r, 'action.create_result_conflict')], ['CONFLICT', 'IDENTICAL', 1], 'reproduction 1: no duplicate audit');
  const third = randomUUID();
  assert.equal((await publishCreateFact(db, d, { kind: 'CREATED', ticketId: third })).effect, 'CONFLICT', 'a distinct fact is still handled');
  assert.equal(await count(r, 'action.create_result_conflict'), 2);
  // A new process/client (restart): the committed receipt is durable
  const restarted = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl }); closers.push(() => restarted.$disconnect());
  assert.deepEqual([(await publishCreateFact(restarted, d, { kind: 'CREATED', ticketId: other })).effect,
    (await publishCreateFact(restarted, d, { kind: 'CREATED', ticketId: third })).effect], ['IDENTICAL', 'IDENTICAL']);
  assert.deepEqual([await count(r, 'action.create_result_conflict'), await count(r, 'action.created')], [2, 1]);
  const attempt = (await see.attempt(r.requestId))!;
  assert.deepEqual([attempt.state, attempt.originalTicketId], ['CREATED', ticket], 'the stored outcome is preserved');
  await assertPrivateAudit(r, [ticket, other, third, d.attemptToken, d.createNonce, d.inputHash]);
});

test('R2: an identical stale result of an abandoned claim is a no-op (one audit); a distinct stale outcome is audited once; nothing else changes', async () => {
  const { r, d, ticket } = await dispatched();
  await publishCreateFact(db, d, { kind: 'UNKNOWN' });
  const candidate = randomUUID();
  const { identity, ctx } = await claimIdentity(r, candidate);
  assert.equal((await publishCreateFact(db, d, { kind: 'CREATED', ticketId: ticket })).abandonedOrdinal, 1, 'a differing late original abandons the claim');
  const results = [await publishVerification(db, ctx, identity, 'MISMATCH'), await publishVerification(db, ctx, identity, 'MISMATCH')];
  assert.deepEqual([results.map(x => x.result), await count(r, 'action.verification_stale')], [['STALE', 'STALE'], 1], 'reproduction 2: no duplicate stale audit');
  assert.deepEqual([(await publishVerification(db, ctx, identity, 'FAILED')).result, await count(r, 'action.verification_stale')], ['STALE', 2], 'distinct fact');
  const restarted = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl }); closers.push(() => restarted.$disconnect());
  assert.equal((await publishVerification(restarted, ctx, identity, 'FAILED')).result, 'STALE');
  assert.equal(await count(r, 'action.verification_stale'), 2);
  const [row] = await see.verifications(r.requestId);
  assert.deepEqual([row!.state, (await see.request(r.requestId))!.state, (await see.attempt(r.requestId))!.verificationCount], ['ABANDONED', 'CREATED_UNVERIFIED', 1]);
  await assertPrivateAudit(r, [ticket, candidate, identity.token, identity.nonce, identity.requestHash, identity.createNonce]);
});

test('R2: duplicate successful read facts stay no-ops; audit rollback and known-rollback retries record each fact exactly once', async () => {
  // Successful VERIFIED: first publication fails at its audit (rolled back, nothing recorded), the retry records it, a repeat is a no-op
  const { r, d, ticket } = await dispatched();
  await publishCreateFact(db, d, { kind: 'CREATED', ticketId: ticket });
  const live = await claimIdentity(r, null);
  let fault = await auditFault(owner, 'action.verified', 1);
  try { assert.equal(await settle(publishVerification(db, live.ctx, live.identity, 'VERIFIED')), 'ACTION_AUDIT_FAILED'); } finally { await fault.remove(); }
  assert.deepEqual([(await see.request(r.requestId))!.state, await count(r, 'action.verified')], ['CREATED_UNVERIFIED', 0], 'no partial success');
  assert.equal((await publishVerification(db, live.ctx, live.identity, 'VERIFIED')).result, 'VERIFIED');
  assert.equal((await publishVerification(db, live.ctx, live.identity, 'VERIFIED')).result, 'VERIFIED');
  assert.deepEqual([(await see.request(r.requestId))!.state, await count(r, 'action.verified')], ['VERIFIED', 1]);

  // Conflict facts: audit failure → nothing; 2 × 40001 → recorded once on the third attempt; 3 × 40001 → bounded conflict, then once
  const c = await dispatched();
  await publishCreateFact(db, c.d, { kind: 'CREATED', ticketId: c.ticket });
  const [x1, x2, x3] = [randomUUID(), randomUUID(), randomUUID()];
  const conflictCount = () => count(c.r, 'action.create_result_conflict');
  fault = await auditFault(owner, 'action.create_result_conflict', 1);
  try { assert.equal(await settle(publishCreateFact(db, c.d, { kind: 'CREATED', ticketId: x1 })), 'ACTION_AUDIT_FAILED'); } finally { await fault.remove(); }
  assert.equal(await conflictCount(), 0);
  assert.deepEqual([(await publishCreateFact(db, c.d, { kind: 'CREATED', ticketId: x1 })).effect, (await publishCreateFact(db, c.d, { kind: 'CREATED', ticketId: x1 })).effect],
    ['CONFLICT', 'IDENTICAL']);
  fault = await auditFault(owner, 'action.create_result_conflict', 2, '40001');
  try { assert.equal((await publishCreateFact(db, c.d, { kind: 'CREATED', ticketId: x2 })).effect, 'CONFLICT'); } finally { await fault.remove(); }
  fault = await auditFault(owner, 'action.create_result_conflict', 3, '40P01');
  try { assert.equal(await settle(publishCreateFact(db, c.d, { kind: 'CREATED', ticketId: x3 })), 'ACTION_PUBLICATION_CONFLICT'); } finally { await fault.remove(); }
  assert.equal(await conflictCount(), 2, 'x1 and x2 once each; the exhausted x3 left no receipt');
  assert.deepEqual([(await publishCreateFact(db, c.d, { kind: 'CREATED', ticketId: x3 })).effect, (await publishCreateFact(db, c.d, { kind: 'CREATED', ticketId: x2 })).effect],
    ['CONFLICT', 'IDENTICAL']);
  assert.equal(await conflictCount(), 3);

  // Stale facts: the same rules
  const s = await dispatched();
  await publishCreateFact(db, s.d, { kind: 'UNKNOWN' });
  const stale = await claimIdentity(s.r, randomUUID());
  await publishCreateFact(db, s.d, { kind: 'CREATED', ticketId: s.ticket });
  const staleCount = () => count(s.r, 'action.verification_stale');
  fault = await auditFault(owner, 'action.verification_stale', 1);
  try { assert.equal(await settle(publishVerification(db, stale.ctx, stale.identity, 'MISMATCH')), 'ACTION_AUDIT_FAILED'); } finally { await fault.remove(); }
  assert.equal(await staleCount(), 0);
  fault = await auditFault(owner, 'action.verification_stale', 3, '40001');
  try { assert.equal(await settle(publishVerification(db, stale.ctx, stale.identity, 'MISMATCH')), 'ACTION_PUBLICATION_CONFLICT'); } finally { await fault.remove(); }
  assert.equal(await staleCount(), 0);
  fault = await auditFault(owner, 'action.verification_stale', 2, '40001');
  try { assert.equal((await publishVerification(db, stale.ctx, stale.identity, 'MISMATCH')).result, 'STALE'); } finally { await fault.remove(); }
  assert.equal((await publishVerification(db, stale.ctx, stale.identity, 'MISMATCH')).result, 'STALE');
  assert.equal(await staleCount(), 1);
  await assert.rejects(publishVerification(db, stale.ctx, { ...stale.identity, nonce: randomUUID() }, 'MISMATCH'), fails('ACTION_STATE_CONFLICT'),
    'a forged identity publishes nothing');
  assert.equal(await staleCount(), 1);
});
