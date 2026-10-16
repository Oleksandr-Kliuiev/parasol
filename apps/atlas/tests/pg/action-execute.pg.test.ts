import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { START_DEADLINE_MS } from '../../packages/actions/contracts.ts';
import { actionComposition } from '../../packages/actions/policy.ts';
import type { ActionComposition } from '../../packages/actions/policy.ts';
import { dispatchReserved, executeAction } from '../../packages/actions/execution.ts';
import type { ActionPorts } from '../../packages/actions/mock-port.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { CA, CB, WA, addActionFixtures, privateDir, runtimeClient, scoped } from '../support/action-fixtures.ts';
import { actionFlow, addApprovalActors, as, fails, observe } from '../support/action-approval.ts';
import {
  addExecutionActors, assertNoTicketIds, auditFault, candidateFile, exec, observeExec, recover, scriptedPorts, statusError, verify, withNetworkTrap,
} from '../support/action-exec.ts';
import type { Script } from '../support/action-exec.ts';

// Stage 3 S3-C, C1/C2/C3/C8 on PostgreSQL 17 (immediate cases; the 35 s recovery waits live in action-recovery). The real
// services end to end with the built-in synthetic port behind a TEST-ONLY counting/fault wrapper: one lifetime create, the
// separately authorized initial read, visible uncertainty for every possible-effect failure, zero calls for a known
// pre-call refusal, authorization linearized at the reservation commit, and no native network access.
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
const audits = async (requestId: string) => (await see.audit(requestId)).map(a => a.eventType);

test('C1: request → stored-preview independent approval → reserved create → separately authorized read (ordinal 1) → VERIFIED; synthetic, private, no network', async () => {
  const r = await flow.request();
  assert.equal((await flow.approve(r)).state, 'APPROVED', 'approver holds read + approve, no request grant, and exports the STORED preview');
  const { ports, calls } = scriptedPorts(db);
  const { result, attempts } = await withNetworkTrap(() => exec(db, ports, r));
  assert.deepEqual(attempts, [], 'the trusted MOCK composition makes no native network call');
  const control = await withNetworkTrap(async () => { for (const call of [() => fetch('http://127.0.0.1:9/'), () => import('node:net').then(n => n.default.connect(9, '127.0.0.1'))] as (() => Promise<unknown>)[]) {
    await Promise.resolve().then(call).catch(() => undefined);
  } });
  assert.deepEqual(control.attempts, ['fetch', 'net.connect'], 'the trap itself observes native calls');
  assert.deepEqual([result.state, result.attemptState, result.verificationCount, result.verificationState, result.verificationCode, result.recoveryRequired,
    result.synthetic], ['VERIFIED', 'VERIFIED', 1, 'VERIFIED', null, false, true]);
  assert.deepEqual(calls, { create: 1, read: 1 });
  const tickets = await see.tickets(r.requestId);
  assert.equal(tickets.length, 1, 'exactly one synthetic ticket');
  const request = (await see.request(r.requestId))!;
  assert.deepEqual([request.state, request.resultTicketId, request.terminalAt instanceof Date], ['VERIFIED', tickets[0], true]);
  const attempt = (await see.attempt(r.requestId))!;
  assert.deepEqual([attempt.state, attempt.originalTicketId, attempt.verifiedTicketId, attempt.activeVerificationToken, attempt.verificationSeq],
    ['VERIFIED', tickets[0], tickets[0], null, 1]);
  assert.deepEqual((await see.verifications(r.requestId)).map(v => [v.ordinal, v.targetKind, v.state, v.targetTicketId, v.createNonce === attempt.createNonce]),
    [[1, 'ORIGINAL', 'VERIFIED', tickets[0], true]]);
  assert.deepEqual(await audits(r.requestId), ['action.requested', 'action.approved', 'action.reserved', 'action.created', 'action.verification_claimed', 'action.verified']);
  assertNoTicketIds(result, tickets, 'execute result');
  assertNoTicketIds(await see.audit(r.requestId), tickets, 'audit');
  const replay = await verify(db, ports, r);
  assert.deepEqual([replay.state, replay.idempotent, replay.ordinal, calls.read], ['VERIFIED', true, null, 1], 'VERIFIED replays a safe summary with zero reads');
  await assert.rejects(exec(db, ports, r), fails('ACTION_ALREADY_RESERVED'));
  assert.equal(calls.create, 1, 'one lifetime create');
  assert.equal((await scoped(runtime, WA, CB, `SELECT count(*)::int AS n FROM "ActionMockTicket" WHERE id = $1`, [tickets[0]]))[0]!.n, 0, 'other client: invisible');
  assert.equal((await scoped(runtime, WA, '', `SELECT count(*)::int AS n FROM "ActionMockTicket"`))[0]!.n, 0, 'empty scope: invisible');
});

test('C2: exception, 429, 5xx, malformed/oversized ID and a lost response after commit are visible OUTCOME_UNKNOWN; one create, no read, no retry', async () => {
  const cases: Record<string, Script['create']> = {
    exception: async () => { throw new Error('CANARY synthetic exception'); },
    'status 429': async () => { throw statusError(429); },
    'status 503': async () => { throw statusError(503); },
    'malformed ID': async () => 'not a valid id!',
    'oversized ID': async () => 'x'.repeat(129),
    'committed, then the response was lost': async ({ base }) => { await base(); throw new Error('CANARY connection reset'); },
  };
  for (const [label, create] of Object.entries(cases)) {
    const r = await flow.approved();
    const { ports, calls } = scriptedPorts(db, { create });
    const result = await exec(db, ports, r);
    assert.deepEqual([result.state, result.attemptState, result.safeErrorCode, result.verificationCount, result.synthetic],
      ['OUTCOME_UNKNOWN', 'UNKNOWN', 'ACTION_OUTCOME_UNKNOWN', 0, true], label);
    assert.deepEqual(calls, { create: 1, read: 0 }, label);
    await assert.rejects(exec(db, ports, r), fails('ACTION_ALREADY_RESERVED'), label);
    await assert.rejects(verify(db, ports, r), fails('ACTION_OUTCOME_UNKNOWN'), `${label}: no evidence, nothing to read`);
    assert.deepEqual([calls.create, calls.read], [1, 0], `${label}: never re-POSTed, never read without a target`);
    assert.equal((await see.request(r.requestId))!.state, 'OUTCOME_UNKNOWN', label);
    const tickets = await see.tickets(r.requestId);
    if (label.startsWith('committed')) {
      assert.equal(tickets.length, 1, 'the effect happened although the response was lost');
      const v = await verify(db, ports, r, 'executor', await candidateFile(files, r.requestId, tickets[0]!));
      assert.deepEqual([v.state, v.ordinal, v.targetKind, v.verificationResult], ['VERIFIED', 1, 'CANDIDATE', 'VERIFIED'], 'matching evidence resolves UNKNOWN');
      assertNoTicketIds(v, tickets, 'candidate verify');
    } else {
      assert.equal(tickets.length, 0, label);
    }
    assertNoTicketIds(result, tickets, label);
  }
});

test('C2: a failed create-fact audit rolls the publication back (never success); a failed verified audit leaves no partial verified result', async () => {
  const created = await auditFault(owner, 'action.created', 1);
  const r = await flow.approved();
  const { ports, calls } = scriptedPorts(db);
  try {
    await assert.rejects(exec(db, ports, r), fails('ACTION_AUDIT_FAILED'));
  } finally { await created.remove(); }
  const attempt = (await see.attempt(r.requestId))!;
  assert.deepEqual([attempt.state, attempt.originalTicketId, (await see.request(r.requestId))!.state, calls.create, calls.read],
    ['RESERVED', null, 'DISPATCH_RESERVED', 1, 0], 'nothing recorded; explicit recovery after the grace makes it UNKNOWN (action-recovery)');
  assert.equal((await see.tickets(r.requestId)).length, 1);
  await assert.rejects(recover(db, r), fails('ACTION_RECOVERY_NOT_DUE'));

  const verified = await auditFault(owner, 'action.verified', 1);
  const r2 = await flow.approved();
  const second = scriptedPorts(db);
  let result;
  try { result = await exec(db, second.ports, r2); } finally { await verified.remove(); }
  // The result carries the established create outcome, the consumed and still ACTIVE ordinal, and the read's fixed code
  assert.deepEqual([result.state, result.verificationCode, result.verificationCount, result.verificationState, result.activeVerificationOrdinal,
    second.calls.create, second.calls.read], ['CREATED_UNVERIFIED', 'ACTION_AUDIT_FAILED', 1, 'ACTIVE', 1, 1, 1]);
  const request = (await see.request(r2.requestId))!;
  assert.deepEqual([request.state, request.resultTicketId], ['CREATED_UNVERIFIED', null], 'no partial VERIFIED request');
  const rows = await see.verifications(r2.requestId);
  assert.deepEqual(rows.map(v => [v.ordinal, v.state]), [[1, 'ACTIVE']], 'the claim is still ACTIVE: recovery after its deadline (action-recovery)');
  assert.equal((await see.attempt(r2.requestId))!.verificationState, 'ACTIVE');
  await assert.rejects(verify(db, second.ports, r2), (e: unknown) => fails('ACTION_VERIFICATION_BUSY')(e)
    && (e as { details: Record<string, string> }).details.recoveryRequired === 'false');
  assert.equal(second.calls.read, 1, 'BUSY reads nothing');
});

test('C3: a positively known pre-call refusal is NOT_DISPATCHED with zero calls; the attempt stays consumed and is never downgraded', async () => {
  const r = await flow.approved();
  const unavailable: ActionPorts = { ticketPort() { throw new Error('CANARY port unavailable'); } };
  const result = await exec(db, unavailable, r);
  assert.deepEqual([result.state, result.attemptState, result.safeErrorCode, result.verificationCount], ['NOT_DISPATCHED', 'NOT_DISPATCHED', 'ACTION_NOT_DISPATCHED', 0]);
  assert.ok((await see.request(r.requestId))!.terminalAt instanceof Date);
  const { ports, calls } = scriptedPorts(db);
  await assert.rejects(exec(db, ports, r), fails('ACTION_ALREADY_RESERVED'));
  await assert.rejects(verify(db, ports, r), fails('ACTION_NOT_DISPATCHED'));
  assert.equal((await recover(db, r)).recovered, 'NONE', 'recovery never touches a published NOT_DISPATCHED');
  assert.deepEqual(calls, { create: 0, read: 0 });

  // The permit's start window passed before its first use: a deliberate wait of the fixed 5 s window (no clock control exists).
  const r2 = await flow.approved();
  const { permit, expected } = await flow.reserve(r2);
  await new Promise(resolve => setTimeout(resolve, START_DEADLINE_MS + 100));
  const late = await dispatchReserved(db, ports, permit, expected);
  assert.deepEqual([late.summary.state, late.code, late.created, calls.create], ['NOT_DISPATCHED', 'ACTION_NOT_DISPATCHED', false, 0]);
  await assert.rejects(dispatchReserved(db, ports, permit, expected), fails('APPROVAL_NOT_VALID'), 'a spent permit dispatches nothing');
  assert.deepEqual(await audits(r2.requestId), ['action.requested', 'action.approved', 'action.reserved', 'action.not_dispatched']);
});

test('C3: authorization linearizes at reservation commit — later revocation cannot stop the approved create; the initial read needs fresh authority', async () => {
  const restore = [`UPDATE "Actor" SET status = 'ACTIVE' WHERE "workspaceId" = '${WA}' AND id = 'approver'`,
    `UPDATE "ApiToken" SET "revokedAt" = NULL WHERE id = 'tok-requester'`,
    `UPDATE "ClientMembership" SET permissions = ARRAY['context:read','actions:read','actions:execute'] WHERE "actorId" = 'executor' AND "clientId" = '${CA}'`];
  try {
    const r = await flow.approved();
    const { permit, expected } = await flow.reserve(r);
    await owner.query(`UPDATE "Actor" SET status = 'DISABLED' WHERE "workspaceId" = '${WA}' AND id = 'approver'`);
    await owner.query(`UPDATE "ApiToken" SET "revokedAt" = now() WHERE id = 'tok-requester'`);
    await owner.query(`UPDATE "ClientMembership" SET permissions = ARRAY['context:read','actions:read'] WHERE "actorId" = 'executor' AND "clientId" = '${CA}'`);
    const { ports, calls } = scriptedPorts(db);
    const dispatched = await dispatchReserved(db, ports, permit, expected);
    assert.deepEqual([dispatched.summary.state, dispatched.created, calls.create], ['CREATED_UNVERIFIED', true, 1], 'the reserved create still happens');
    await assert.rejects(verify(db, ports, r, 'executor'), fails('PERMISSION_DENIED'));
    assert.deepEqual([calls.read, (await see.attempt(r.requestId))!.verificationCount], [0, 0], 'a refused admission consumes no ordinal and reads nothing');
    const v = await verify(db, ports, r, 'executor2');
    assert.deepEqual([v.state, v.ordinal, v.targetKind], ['VERIFIED', 1, 'ORIGINAL'], 'signer revocation and epoch drift alone do not bar a fresh read');
  } finally { for (const sql of restore) await owner.query(sql); }

  // Inside action-execute: the executor loses execute while the create runs → created stays, zero reads, fixed code
  const r2 = await flow.approved();
  const losing = scriptedPorts(db, { create: async ({ base }) => {
    await owner.query(`UPDATE "ClientMembership" SET permissions = ARRAY['context:read','actions:read'] WHERE "actorId" = 'executor' AND "clientId" = '${CA}'`);
    return base();
  } });
  try {
    const result = await exec(db, losing.ports, r2);
    assert.deepEqual([result.state, result.verificationCode, result.verificationCount, losing.calls.read], ['CREATED_UNVERIFIED', 'PERMISSION_DENIED', 0, 0]);
  } finally { await owner.query(restore[2]!); }
  // Binding drift while the create runs: the new read is refused (ACTION_AUTHORITY_CHANGED), the create outcome stays
  const r3 = await flow.approved();
  const drifting = scriptedPorts(db, { create: async ({ base }) => {
    await owner.query(`UPDATE "Connection" SET "lifecycleVersion" = "lifecycleVersion" + 1 WHERE "workspaceId" = '${WA}' AND id = 'atera-a'`);
    return base();
  } });
  const drifted = await exec(db, drifting.ports, r3);
  assert.deepEqual([drifted.state, drifted.verificationCode, drifting.calls.read], ['CREATED_UNVERIFIED', 'ACTION_AUTHORITY_CHANGED', 0]);
  await assert.rejects(recover(db, r3), fails('ACTION_AUTHORITY_CHANGED'), 'recovery rechecks the exact stored binding too');
  assert.deepEqual((await observe(runtime).audit(r3.requestId)).map(a => a.metadata.safeErrorCode).filter(Boolean),
    ['ACTION_AUTHORITY_CHANGED', 'ACTION_AUTHORITY_CHANGED'], 'both refusals are audited safely');
});

test('C8: DISABLED by default; LIVE, origins, custom ports and callbacks refuse before any reservation or call', async () => {
  for (const env of [{}, { ATLAS_ACTIONS_MODE: '' }, { ATLAS_ACTIONS_MODE: 'DISABLED' }]) {
    assert.throws(() => actionComposition(env), fails('ACTION_MODE_DISABLED'));
  }
  for (const env of [{ ATLAS_ACTIONS_MODE: 'LIVE' }, { ATLAS_ACTIONS_MODE: 'mock' }, { ATLAS_ACTIONS_MODE: 'MOCK', ATLAS_ACTIONS_ORIGIN: 'https://example.invalid' },
    { ATLAS_ACTIONS_MODE: 'MOCK', ATLAS_ACTIONS_PORT: 'custom' }, { ATLAS_ACTIONS_MODE: 'MOCK', ATLAS_ACTIONS_CALLBACK: 'x' },
    { ATLAS_ACTIONS_MODE: 'MOCK', ATLAS_ACTIONS_SCRIPT: 'x' }, { ATLAS_ACTIONS_MODE: 'MOCK', ATLAS_ACTIONS_LIVE: '1' }]) {
    assert.throws(() => actionComposition(env), fails('ACTION_MODE_REFUSED'), JSON.stringify(Object.keys(env)));
  }
  const r = await flow.approved();
  const { ports, calls } = scriptedPorts(db);
  const live = Object.freeze({ mode: 'LIVE', policyVersion: 'atlas-action-policy/1', portVersion: 'atlas-synthetic-ticket-port/1' }) as unknown as ActionComposition;
  await assert.rejects(executeAction(db, live, ports, as('executor'), CA, r.requestId, r.inputHash), fails('ACTION_MODE_REFUSED'));
  assert.deepEqual([(await see.attempt(r.requestId)), calls.create], [null, 0], 'no reservation, no call');
});
