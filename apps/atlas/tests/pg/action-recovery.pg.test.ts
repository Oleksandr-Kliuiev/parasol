import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { RECOVERY_GRACE_MS } from '../../packages/actions/contracts.ts';
import { takeReservationPermit } from '../../packages/actions/reservation.ts';
import { claimVerification, completeVerification } from '../../packages/actions/verification.ts';
import type { VerificationClaim } from '../../packages/actions/verification.ts';
import { mockActionPorts } from '../../packages/actions/mock-port.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { CA, MOCK, addActionFixtures, privateDir, runtimeClient } from '../support/action-fixtures.ts';
import { actionFlow, addApprovalActors, as, fails, settle, untilPassed } from '../support/action-approval.ts';
import type { Stored } from '../support/action-approval.ts';
import { addExecutionActors, auditFault, candidateFile, exec, freshCall, observeExec, recover, scriptedPorts, verify } from '../support/action-exec.ts';

// Stage 3 S3-C, C2/C3/C5 recovery on PostgreSQL 17. A restarted process cannot prove whether a reserved create happened:
// action-recover marks RESERVED → OUTCOME_UNKNOWN only at/after reservedAt + 35 s (ACTION_RECOVERY_NOT_DUE before), never
// dispatching again; a crashed or expired ACTIVE claim stays BUSY until an explicit recover at/after startedAt + 35 s
// abandons it without refund; a late, expired or abandoned claim can never publish, even without a replacement. Every
// scenario is set up first, then ONE bounded wait on the DB clock covers all deadlines (no caller clock control exists).
const pgdb = await createTestDatabase();
const db = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
const runtime = await runtimeClient(pgdb.runtimeUrl);
const files = await privateDir();
after(async () => { await runtime.end(); await db.$disconnect(); await files.remove(); await pgdb.drop(); });
const owner = pgdb.owner;
await addActionFixtures(owner);
await addApprovalActors(owner);
await addExecutionActors(owner);
const flow = actionFlow(db, files);
const see = observeExec(runtime);
const busy = (recoveryRequired: boolean) => (e: unknown) => fails('ACTION_VERIFICATION_BUSY')(e)
  && (e as { details: Record<string, string> }).details.recoveryRequired === String(recoveryRequired);

test('C2/C3/C5: crashed reservations recover to OUTCOME_UNKNOWN only after 35 s (no re-POST); crashed or expired claims only by explicit recover (no refund)', async () => {
  const { ports, calls } = scriptedPorts(db, { read: async () => { throw new Error('CANARY read down'); } });
  const deadlines: Date[] = [];
  const reservedAt = async (r: Stored) => { const a = (await see.attempt(r.requestId))!; deadlines.push(new Date(a.reservedAt.getTime() + RECOVERY_GRACE_MS)); };
  const claimedAt = async (r: Stored) => { const a = (await see.attempt(r.requestId))!; deadlines.push(a.activeDeadlineAt); };

  // S1: the process died after the reservation commit, before any create call (the permit is lost with it)
  const s1 = await flow.approved();
  await flow.reserve(s1);
  await reservedAt(s1);
  // S2: it died after the create committed, before the response was published
  const s2 = await flow.approved();
  const r2 = await flow.reserve(s2);
  const use = takeReservationPermit(r2.permit, r2.expected);
  assert.ok('dispatch' in use);
  const d = use.dispatch;
  const ticket2 = await mockActionPorts(db).ticketPort({ workspaceId: d.workspaceId, clientId: d.clientId, connectionId: d.connectionId })
    .createOne({ customerKey: d.customerKey, markedTitle: d.markedTitle, description: d.description, nonce: d.createNonce }, freshCall());
  await reservedAt(s2);
  // S3: the create-fact publication was rolled back by an audit failure (never success; RESERVED stays)
  const s3 = await flow.approved();
  const fault = await auditFault(owner, 'action.created', 1);
  try { await assert.rejects(exec(db, ports, s3), fails('ACTION_AUDIT_FAILED')); } finally { await fault.remove(); }
  await reservedAt(s3);
  // S4: a claim committed, then the process died before its read result (ordinal 2 after a failed initial read)
  const s4 = await flow.approved();
  assert.equal((await exec(db, ports, s4)).verificationCount, 1);
  const claimed4 = await claimVerification(db, MOCK, as('executor'), CA, s4.requestId, null);
  assert.ok('claim' in claimed4);
  await claimedAt(s4);
  // S5: a claim recovered as ABANDONED first; its late result must stay stale with no replacement claim
  const s5 = await flow.approved();
  await exec(db, ports, s5);
  const claimed5 = await claimVerification(db, MOCK, as('executor'), CA, s5.requestId, null);
  assert.ok('claim' in claimed5);
  await claimedAt(s5);

  // Before the deadlines: NOT_DUE, BUSY without a recovery hint, no create, no state change
  for (const r of [s1, s2, s3, s4, s5]) await assert.rejects(recover(db, r), fails('ACTION_RECOVERY_NOT_DUE'));
  await assert.rejects(verify(db, ports, s1), fails('ACTION_STATE_CONFLICT'), 'no create outcome yet: nothing to verify');
  await assert.rejects(verify(db, ports, s4), busy(false));
  assert.deepEqual(await Promise.all([s1, s2, s3].map(async r => (await see.request(r.requestId))!.state)), ['DISPATCH_RESERVED', 'DISPATCH_RESERVED', 'DISPATCH_RESERVED']);

  await untilPassed(owner, new Date(Math.max(...deadlines.map(x => x.getTime()))));

  // S4 expired: still BUSY (expiry alone never mints a claim); its late result is stale without any replacement
  await assert.rejects(verify(db, ports, s4), busy(true));
  const readsBefore = calls.read;
  const stale4 = await completeVerification(db, ports, claimed4.claim as VerificationClaim);
  assert.deepEqual([stale4.verificationResult, stale4.state, stale4.verificationState, calls.read], ['STALE', 'CREATED_UNVERIFIED', 'ACTIVE', readsBefore],
    'the read window closed: no read, nothing published');
  // S5: recovered first, then the late result → stale; no replacement claim exists
  assert.deepEqual([(await recover(db, s5)).recovered, (await completeVerification(db, ports, claimed5.claim as VerificationClaim)).verificationResult],
    ['CLAIM_ABANDONED', 'STALE']);
  assert.deepEqual((await see.verifications(s5.requestId)).map(v => [v.ordinal, v.state, v.safeErrorCode]), [[1, 'FAILED', 'ACTION_VERIFICATION_FAILED'],
    [2, 'ABANDONED', 'ACTION_VERIFICATION_FAILED']]);
  const recovered4 = await recover(db, s4);
  assert.deepEqual([recovered4.recovered, recovered4.verificationCount, recovered4.verificationState, recovered4.state], ['CLAIM_ABANDONED', 2, 'ABANDONED', 'CREATED_UNVERIFIED'],
    'abandoned without refund; the established outcome stays');
  const good = scriptedPorts(db);
  const v4 = await verify(db, good.ports, s4);
  assert.deepEqual([v4.ordinal, v4.state], [3, 'VERIFIED'], 'only a remaining ordinal, with a new nonce');

  // S1–S3: OUTCOME_UNKNOWN by explicit recovery only, never a second create; a repeat changes nothing
  for (const r of [s1, s2, s3]) {
    const rec = await recover(db, r);
    assert.deepEqual([rec.recovered, rec.state, rec.attemptState, rec.safeErrorCode], ['OUTCOME_UNKNOWN', 'OUTCOME_UNKNOWN', 'UNKNOWN', 'ACTION_OUTCOME_UNKNOWN']);
    assert.equal((await recover(db, r)).recovered, 'NONE');
    await assert.rejects(exec(db, good.ports, r), fails('ACTION_ALREADY_RESERVED'));
    await assert.rejects(verify(db, good.ports, r), fails('ACTION_OUTCOME_UNKNOWN'), 'no evidence: UNKNOWN stays unresolved');
  }
  const none = await verify(db, good.ports, s1, 'executor', await candidateFile(files, s1.requestId, randomUUID()));
  assert.deepEqual([none.verificationResult, none.state, (await see.tickets(s1.requestId)).length], ['MISMATCH', 'OUTCOME_UNKNOWN', 0]);
  for (const r of [s2, s3]) {
    const [ticket] = await see.tickets(r.requestId);
    assert.equal(ticket !== undefined && (r !== s2 || ticket === ticket2), true);
    const v = await verify(db, good.ports, r, 'executor', await candidateFile(files, r.requestId, ticket!));
    assert.deepEqual([v.state, v.targetKind], ['VERIFIED', 'CANDIDATE'], 'the possible effect is found only through matching evidence');
  }
  assert.equal(good.calls.create, 0, 'recovery and verification never create');
  const outcome = await settle(recover(db, s1));
  assert.equal(typeof outcome === 'object' && (outcome as { recovered: string }).recovered, 'NONE');
});
