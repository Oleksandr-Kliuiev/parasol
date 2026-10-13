import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { CREATE_DEADLINE_MS } from '../../packages/actions/contracts.ts';
import { takeReservationPermit } from '../../packages/actions/reservation.ts';
import type { ReservedDispatch } from '../../packages/actions/reservation.ts';
import { publishCreateFact } from '../../packages/actions/publication.ts';
import { claimVerification, completeVerification } from '../../packages/actions/verification.ts';
import { mockActionPorts } from '../../packages/actions/mock-port.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { CA, MOCK, addActionFixtures, privateDir, runtimeClient } from '../support/action-fixtures.ts';
import { actionFlow, addApprovalActors, as, fails, settle } from '../support/action-approval.ts';
import type { Stored } from '../support/action-approval.ts';
import { addExecutionActors, assertNoTicketIds, candidateFile, exec, freshCall, gate, observeExec, scriptedPorts, verify } from '../support/action-exec.ts';

// Stage 3 S3-C, C6 on PostgreSQL 17: late create results versus candidate verification in both orders. The orderings are
// driven through the real publication service with the continuation's own capability (the test plays the trusted
// dispatcher after a create timeout), so no wait is needed; the last test runs the actual dispatcher's 15 s create and read
// deadlines (three scenarios concurrently, one bounded wait). A continuation never creates or reads; a different ID never
// replaces a stored original or VERIFIED fact; matching evidence proves identity, not uniqueness.
const pgdb = await createTestDatabase();
const db = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
const runtime = await runtimeClient(pgdb.runtimeUrl);
const files = await privateDir();
after(async () => { await runtime.end(); await db.$disconnect(); await files.remove(); await pgdb.drop(); });
await addActionFixtures(pgdb.owner);
await addApprovalActors(pgdb.owner);
await addExecutionActors(pgdb.owner);
const flow = actionFlow(db, files);
const see = observeExec(runtime);
const events = async (requestId: string) => (await see.audit(requestId)).map(a => a.eventType);

/** A committed reservation whose permit the test consumes as the trusted dispatcher. */
async function dispatched(): Promise<{ r: Stored; d: ReservedDispatch }> {
  const r = await flow.approved();
  const { permit, expected } = await flow.reserve(r);
  const use = takeReservationPermit(permit, expected);
  assert.ok('dispatch' in use);
  return { r, d: use.dispatch };
}
/** The single create invocation of that dispatch (or an upstream duplicate with identical content: no marker deduplication). */
const createVia = (d: ReservedDispatch) => mockActionPorts(db).ticketPort({ workspaceId: d.workspaceId, clientId: d.clientId, connectionId: d.connectionId })
  .createOne({ customerKey: d.customerKey, markedTitle: d.markedTitle, description: d.description, nonce: d.createNonce }, freshCall());
const claim = async (r: Stored, candidate: string | null) => {
  const claimed = await claimVerification(db, MOCK, as('executor'), CA, r.requestId, candidate);
  assert.ok('claim' in claimed);
  return claimed.claim;
};

test('C6: create facts — identical is a no-op, a second different original conflicts, UNKNOWN/NOT_DISPATCHED never downgrade, only the own capability publishes', async () => {
  const { r, d } = await dispatched();
  const ticket = await createVia(d);
  assert.deepEqual([(await publishCreateFact(db, d, { kind: 'CREATED', ticketId: ticket })).effect, (await see.request(r.requestId))!.state], ['PUBLISHED', 'CREATED_UNVERIFIED']);
  assert.equal((await publishCreateFact(db, d, { kind: 'CREATED', ticketId: ticket })).effect, 'IDENTICAL');
  assert.equal((await publishCreateFact(db, d, { kind: 'CREATED', ticketId: randomUUID() })).effect, 'CONFLICT');
  for (const kind of ['UNKNOWN', 'NOT_DISPATCHED'] as const) assert.equal((await publishCreateFact(db, d, { kind })).effect, 'PRESERVED', kind);
  await assert.rejects(publishCreateFact(db, { ...d, attemptToken: randomUUID() }, { kind: 'CREATED', ticketId: ticket }), fails('ACTION_STATE_CONFLICT'));
  await assert.rejects(publishCreateFact(db, { ...d, createNonce: randomUUID() }, { kind: 'UNKNOWN' }), fails('ACTION_STATE_CONFLICT'));
  await assert.rejects(publishCreateFact(db, d, { kind: 'CREATED', ticketId: 'bad id' }), fails('ACTION_OUTCOME_UNKNOWN'));
  const attempt = (await see.attempt(r.requestId))!;
  assert.deepEqual([attempt.state, attempt.originalTicketId], ['CREATED', ticket], 'the first original stays');
  assert.deepEqual((await events(r.requestId)).slice(3), ['action.created', 'action.create_result_conflict'], 'no duplicate audit for the identical fact');
  const { ports, calls } = scriptedPorts(db);
  assert.equal((await verify(db, ports, r)).state, 'VERIFIED');
  assert.deepEqual(calls, { create: 0, read: 1 });
  assertNoTicketIds(await see.audit(r.requestId), [ticket], 'audit');
});

test('C6: a first late original that differs from the ACTIVE candidate abandons that claim (no refund); the candidate result is then stale', async () => {
  const { r, d } = await dispatched();
  const ticket = await createVia(d);
  await publishCreateFact(db, d, { kind: 'UNKNOWN' }); // what the dispatcher published at its create deadline
  const { ports, calls } = scriptedPorts(db);
  const c = await claim(r, randomUUID());
  const late = await publishCreateFact(db, d, { kind: 'CREATED', ticketId: ticket });
  assert.deepEqual([late.effect, late.abandonedOrdinal, late.summary.state, late.summary.verificationState, late.summary.activeVerificationOrdinal, late.summary.verificationCount],
    ['PUBLISHED', 1, 'CREATED_UNVERIFIED', 'ABANDONED', null, 1]);
  const stale = await completeVerification(db, ports, c);
  assert.deepEqual([stale.verificationResult, stale.state, stale.verificationCount], ['STALE', 'CREATED_UNVERIFIED', 1], 'stale even though nothing replaced it');
  assert.deepEqual((await see.verifications(r.requestId)).map(v => [v.ordinal, v.targetKind, v.state, v.safeErrorCode]), [[1, 'CANDIDATE', 'ABANDONED', 'ACTION_STATE_CONFLICT']]);
  await assert.rejects(verify(db, ports, r, 'executor', await candidateFile(files, r.requestId, ticket)), fails('ACTION_STATE_CONFLICT'), 'the original wins');
  const v = await verify(db, ports, r);
  assert.deepEqual([v.state, v.ordinal, v.targetKind], ['VERIFIED', 2, 'ORIGINAL']);
  assert.ok((await events(r.requestId)).includes('action.verification_stale'));
  assert.equal(calls.create, 0, 'the continuation never creates');
});

test('C6: the same ID keeps the ACTIVE candidate claim, which then verifies; candidate VERIFIED first: same ID attaches provenance, a different one conflicts', async () => {
  // Late original equal to the active candidate: the claim survives and completes
  const same = await dispatched();
  const t1 = await createVia(same.d);
  await publishCreateFact(db, same.d, { kind: 'UNKNOWN' });
  const { ports } = scriptedPorts(db);
  const c = await claim(same.r, t1);
  const late = await publishCreateFact(db, same.d, { kind: 'CREATED', ticketId: t1 });
  assert.deepEqual([late.effect, late.abandonedOrdinal, late.summary.verificationState, late.summary.state], ['PUBLISHED', null, 'ACTIVE', 'CREATED_UNVERIFIED']);
  const done = await completeVerification(db, ports, c);
  assert.deepEqual([done.verificationResult, done.targetKind, done.state], ['VERIFIED', 'CANDIDATE', 'VERIFIED']);

  // Candidate VERIFIED first, then the late original with the same ID: provenance attached, VERIFIED unchanged
  const attach = await dispatched();
  const t2 = await createVia(attach.d);
  await publishCreateFact(db, attach.d, { kind: 'UNKNOWN' });
  assert.equal((await verify(db, ports, attach.r, 'executor', await candidateFile(files, attach.r.requestId, t2))).state, 'VERIFIED');
  assert.equal((await publishCreateFact(db, attach.d, { kind: 'CREATED', ticketId: t2 })).effect, 'ATTACHED');
  const attached = (await see.attempt(attach.r.requestId))!;
  assert.deepEqual([attached.state, attached.originalTicketId, attached.verifiedTicketId], ['VERIFIED', t2, t2]);

  // A matching duplicate (identical content, other ID) VERIFIED first: the late original cannot replace it — safe conflict audit
  const dup = await dispatched();
  const original = await createVia(dup.d);
  const duplicate = await createVia(dup.d);
  await publishCreateFact(db, dup.d, { kind: 'UNKNOWN' });
  assert.equal((await verify(db, ports, dup.r, 'executor', await candidateFile(files, dup.r.requestId, duplicate))).state, 'VERIFIED',
    'matching evidence proves this ticket matches, not that no other exists');
  assert.equal((await publishCreateFact(db, dup.d, { kind: 'CREATED', ticketId: original })).effect, 'CONFLICT');
  const kept = (await see.attempt(dup.r.requestId))!;
  assert.deepEqual([kept.state, kept.verifiedTicketId, kept.originalTicketId, (await see.request(dup.r.requestId))!.resultTicketId], ['VERIFIED', duplicate, null, duplicate]);
  assert.equal((await events(dup.r.requestId)).at(-1), 'action.create_result_conflict');
});

test('C6: a candidate MISMATCH first, then the late original → CREATED_UNVERIFIED; later reads target the original', async () => {
  const { r, d } = await dispatched();
  const ticket = await createVia(d);
  await publishCreateFact(db, d, { kind: 'UNKNOWN' });
  const { ports } = scriptedPorts(db);
  const miss = await verify(db, ports, r, 'executor', await candidateFile(files, r.requestId, randomUUID()));
  assert.deepEqual([miss.verificationResult, miss.state], ['MISMATCH', 'OUTCOME_UNKNOWN']);
  assert.deepEqual([(await publishCreateFact(db, d, { kind: 'CREATED', ticketId: ticket })).summary.state], ['CREATED_UNVERIFIED']);
  const v = await verify(db, ports, r);
  assert.deepEqual([v.state, v.ordinal, v.targetKind], ['VERIFIED', 2, 'ORIGINAL']);
});

test('C2/C6: the actual dispatcher — the 15 s create AbortSignal, a late original from the owned continuation, and the 15 s read deadline', async () => {
  const until = async (check: () => Promise<boolean>, ms = CREATE_DEADLINE_MS + 10_000) => {
    const deadline = Date.now() + ms;
    while (!(await check())) { if (Date.now() > deadline) throw new Error('condition not reached'); await new Promise(resolve => setTimeout(resolve, 100)); }
  };
  // 1. The create commits but its reply is held past the deadline: UNKNOWN, then the late original abandons an active candidate
  const lateCreate = async () => {
    const r = await flow.approved();
    const reply = gate<void>(); const read = gate<void>();
    let reads = 0;
    const { ports, calls } = scriptedPorts(db, {
      create: async ({ base }) => { const id = await base(); await reply.promise; return id; },
      read: async ({ base }) => { if (++reads === 1) { read.arrive(); await read.promise; } return base(); },
    });
    const execution = exec(db, ports, r, 'executor', { lateGraceMs: 30_000 });
    await until(async () => (await see.request(r.requestId))!.state === 'OUTCOME_UNKNOWN');
    const candidate = verify(db, ports, r, 'executor2', await candidateFile(files, r.requestId, randomUUID()));
    await read.reached;
    reply.release();
    const result = await execution;
    assert.deepEqual([result.state, result.attemptState, result.verificationState, result.verificationCode], ['CREATED_UNVERIFIED', 'CREATED', 'ABANDONED', null]);
    read.release();
    assert.equal((await candidate).verificationResult, 'STALE');
    assert.deepEqual([calls.create, calls.read], [1, 1], 'one create; the continuation performed no read');
    assert.equal((await verify(db, ports, r)).state, 'VERIFIED');
  };
  // 2. A port that honors the AbortSignal: rejected at the deadline → UNKNOWN; no late result
  const aborted = async () => {
    const r = await flow.approved();
    let observedAbort = false; const started = Date.now();
    const { ports, calls } = scriptedPorts(db, { create: ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => {
      observedAbort = true; reject(new Error('aborted'));
    })) });
    const result = await exec(db, ports, r, 'executor', { lateGraceMs: 2_000 });
    assert.deepEqual([result.state, observedAbort, Date.now() - started >= CREATE_DEADLINE_MS - 50, calls.create], ['OUTCOME_UNKNOWN', true, true, 1]);
    assert.equal((await see.tickets(r.requestId)).length, 0);
  };
  // 3. The initial read never answers: FAILED at its 15 s deadline, the create outcome stays, one ordinal consumed
  const slowRead = async () => {
    const r = await flow.approved();
    const never = gate<void>();
    const { ports, calls } = scriptedPorts(db, { read: async ({ base }) => { await never.promise; return base(); } });
    const result = await exec(db, ports, r);
    never.release();
    assert.deepEqual([result.state, result.verificationCount, result.verificationState, result.verificationCode, calls.read],
      ['CREATED_UNVERIFIED', 1, 'FAILED', 'ACTION_VERIFICATION_FAILED', 1]);
  };
  const outcomes = await Promise.all([lateCreate(), aborted(), slowRead()].map(p => settle(p)));
  assert.deepEqual(outcomes, [undefined, undefined, undefined]);
});
