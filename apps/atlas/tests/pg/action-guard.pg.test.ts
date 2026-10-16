import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { generateToken, hashToken } from '../../packages/auth/token.ts';
import { actionCredential } from '../../packages/actions/authority.ts';
import { approveAction, cancelAction, revokeApproval } from '../../packages/actions/approvals.ts';
import { getAction } from '../../packages/actions/requests.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { CA, CB, MOCK, WA, addActionFixtures, fenceVersion, privateDir, runtimeClient, tokens } from '../support/action-fixtures.ts';
import { inFlight, openSession } from '../support/pg-race.ts';
import { actionFlow, addApprovalActors, as, expireTokenIn, fails, observe, settle, untilPassed, waitForWaiters } from '../support/action-approval.ts';
import type { Stored } from '../support/action-approval.ts';

// Stage 3 S3-B, B3/B5 on PostgreSQL 17: the shared stored guard. Any protected owner mutation (no-op, unrelated, remove then
// restore, token revoke/replace/shorten/extend, a new grant) permanently invalidates every unreserved intent of the workspace
// at approve/reserve/revoke/cancel: INVALIDATED + unconsumed approval REVOKED + audit, committed, then refused. Natural
// expiry of either snapshot, of the approval or of the caller's own token is evaluated on the DB clock AFTER the row locks.
// A rejected owner update rolls its epoch back; a failing terminal audit rolls the whole outcome back; version drift refuses.
const pgdb = await createTestDatabase();
const db = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
const runtime = await runtimeClient(pgdb.runtimeUrl);
const files = await privateDir();
after(async () => { await runtime.end(); await db.$disconnect(); await files.remove(); await pgdb.drop(); });
await addActionFixtures(pgdb.owner);
await addApprovalActors(pgdb.owner);
const owner = pgdb.owner;
const flow = actionFlow(db, files);
const see = observe(runtime);

async function assertInvalidated(r: Stored, code: string, approvalRevoked: boolean): Promise<void> {
  const request = (await see.request(r.requestId))!;
  assert.deepEqual([request.state, request.safeErrorCode], ['INVALIDATED', code]);
  assert.ok(request.terminalAt instanceof Date);
  const approval = await see.approval(r.requestId);
  if (approvalRevoked) assert.deepEqual([approval!.decision, approval!.safeErrorCode, approval!.revokedAt.getTime()], ['REVOKED', code, request.terminalAt.getTime()]);
  else assert.equal(approval, null);
  assert.equal(await see.attempts(r.requestId), 0);
  assert.deepEqual((await see.audit(r.requestId)).at(-1), { eventType: 'action.invalidated', metadata: { actionRequestId: r.requestId,
    requestState: 'INVALIDATED', safeErrorCode: code, ...(approvalRevoked ? { actionApprovalId: approval!.id } : {}) } });
}

/** Owner mutations; each restores what it changes, so only the epoch remembers it. */
const MUTATIONS: Record<string, string[]> = {
  'no-op on an unrelated actor': [`UPDATE "Actor" SET "displayName" = "displayName" WHERE "workspaceId" = '${WA}' AND id = 'reader'`],
  'requester membership removed then restored': [`DELETE FROM "ClientMembership" WHERE "actorId" = 'requester' AND "clientId" = '${CA}'`,
    `INSERT INTO "ClientMembership" ("workspaceId","clientId","actorId",permissions) VALUES ('${WA}','${CA}','requester',ARRAY['context:read','actions:read','actions:request'])`],
  'approver disabled then enabled': [`UPDATE "Actor" SET status = 'DISABLED' WHERE "workspaceId" = '${WA}' AND id = 'approver'`,
    `UPDATE "Actor" SET status = 'ACTIVE' WHERE "workspaceId" = '${WA}' AND id = 'approver'`],
  'requester token revoked then restored': [`UPDATE "ApiToken" SET "revokedAt" = now() WHERE id = 'tok-requester'`,
    `UPDATE "ApiToken" SET "revokedAt" = NULL WHERE id = 'tok-requester'`],
  'approver token expiry shortened then extended': [`UPDATE "ApiToken" SET "expiresAt" = now() + interval '1 day' WHERE id = 'tok-approver'`,
    `UPDATE "ApiToken" SET "expiresAt" = NULL WHERE id = 'tok-approver'`],
  'Connection no-op': [`UPDATE "Connection" SET "secretRef" = "secretRef" WHERE id = 'atera-a'`],
  'another client\'s Connection': [`UPDATE "Connection" SET "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = 'atera-b'`],
  'a new approver granted': [`INSERT INTO "ClientMembership" ("workspaceId","clientId","actorId",permissions) VALUES ('${WA}','${CA}','reader2',ARRAY['actions:approve'])`],
};
await owner.query(`INSERT INTO "Actor" ("workspaceId", id, "displayName") VALUES ('${WA}', 'reader2', 'Synthetic actor')`);

test('B3/B5: every owner mutation after approval invalidates at reservation for good (approval REVOKED, audit); restored rights never revive', async () => {
  for (const [label, statements] of Object.entries(MUTATIONS)) {
    const r = await flow.approved();
    for (const sql of statements) await owner.query(sql);
    if (label === 'a new approver granted') await owner.query(`DELETE FROM "ClientMembership" WHERE "actorId" = 'reader2'`);
    await assert.rejects(flow.reserve(r), fails('ACTION_AUTHORITY_CHANGED'), label);
    await assertInvalidated(r, 'ACTION_AUTHORITY_CHANGED', true);
    await assert.rejects(flow.reserve(r), fails('APPROVAL_NOT_VALID'), `${label}: no second chance`);
    await assert.rejects(flow.approve(r), fails('APPROVAL_NOT_VALID'), `${label}: no re-approval`);
    assert.equal((await see.request(r.requestId))!.state, 'INVALIDATED');
  }
});

test('B3: a mutation between request and approval invalidates at approve (no decision row); granting a new approver does too', async () => {
  for (const label of ['no-op on an unrelated actor', 'a new approver granted', 'Connection no-op']) {
    const r = await flow.request();
    for (const sql of MUTATIONS[label]!) await owner.query(sql);
    await assert.rejects(flow.approve(r), fails('ACTION_AUTHORITY_CHANGED'), label);
    await assertInvalidated(r, 'ACTION_AUTHORITY_CHANGED', false);
    await owner.query(`DELETE FROM "ClientMembership" WHERE "actorId" = 'reader2'`);
  }
  // Idempotent retrieval shows the stored terminal outcome; a new key is a new request with the new epoch
  const r = await flow.request();
  await owner.query(MUTATIONS['no-op on an unrelated actor']![0]!);
  const revokeCase = await flow.approved();
  await owner.query(MUTATIONS['Connection no-op']![0]!);
  await assert.rejects(revokeApproval(db, MOCK, as('approver'), CA, revokeCase.requestId, revokeCase.inputHash), fails('ACTION_AUTHORITY_CHANGED'));
  await assertInvalidated(revokeCase, 'ACTION_AUTHORITY_CHANGED', true);
  await assert.rejects(cancelAction(db, MOCK, as('requester'), CA, r.requestId), fails('ACTION_AUTHORITY_CHANGED'), 'cancel runs the guard too');
  await assertInvalidated(r, 'ACTION_AUTHORITY_CHANGED', false);
});

test('B3: a rejected owner Connection update rolls its epoch back; the approved request still reserves', async () => {
  const r = await flow.approved();
  const epoch = await fenceVersion(runtime, WA);
  await assert.rejects(owner.query(`UPDATE "Connection" SET "clientId" = '${CB}' WHERE id = 'atera-a'`), /immutable/i);
  assert.equal(await fenceVersion(runtime, WA), epoch);
  assert.equal((await flow.reserve(r)).reservation.state, 'DISPATCH_RESERVED');
});

/**
 * Holds the request row (or, with `row = 'approval'`, only its decision row: the LAST lock a command takes) as the owner — as a
 * post-dispatch publisher would — while `step` passes the fence and then waits; releases it after `whileWaiting`.
 */
async function behindRequestLock<T>(r: Stored, step: () => Promise<T>, whileWaiting: () => Promise<void>, row: 'request' | 'approval' = 'request'):
  Promise<T | string> {
  const holder = await openSession(pgdb.ownerUrl);
  try {
    await holder.client.query('BEGIN');
    await holder.client.query(row === 'request' ? `SELECT 1 FROM "ActionRequest" WHERE id = $1 FOR UPDATE`
      : `SELECT 1 FROM "ActionApproval" WHERE "requestId" = $1 FOR UPDATE`, [r.requestId]);
    const running = inFlight(step);
    await waitForWaiters(runtime, 1);
    await whileWaiting();
    await holder.client.query('ROLLBACK');
    return await settle(running.result());
  } finally { await holder.client.end(); }
}

test('B3/B5: natural expiry of the requester snapshot while approve waits on the request lock: DB clock after locks → EXPIRED committed', async () => {
  await expireTokenIn(owner, 'tok-requester2', '3 seconds');
  const r = await flow.request('requester2');
  const snapshot = (await see.request(r.requestId))!.requesterTokenExpiresAt as Date;
  const file = await flow.exported('approver', CA, r.requestId);
  const outcome = await behindRequestLock(r, () => approveAction(db, MOCK, as('approver'), CA, r.requestId, r.inputHash, file), () => untilPassed(owner, snapshot));
  assert.equal(outcome, 'APPROVAL_NOT_VALID');
  const request = (await see.request(r.requestId))!;
  assert.deepEqual([request.state, request.safeErrorCode, await see.approval(r.requestId)], ['EXPIRED', 'APPROVAL_NOT_VALID', null]);
  assert.deepEqual((await see.audit(r.requestId)).at(-1)!.metadata, { actionRequestId: r.requestId, requestState: 'EXPIRED', safeErrorCode: 'APPROVAL_NOT_VALID' });
  await owner.query(`UPDATE "ApiToken" SET "expiresAt" = NULL WHERE id = 'tok-requester2'`);
  await assert.rejects(flow.approve(r), fails('APPROVAL_NOT_VALID'), 'extending the token never renews the old intent');
  assert.deepEqual([(await getAction(db, MOCK, as('reader'), CA, r.requestId)).state], ['EXPIRED']);
});

test('B3/B5: the approval expiring while reservation waits → EXPIRED, approval REVOKED, no attempt; the caller\'s own expiry refuses with no decision', async () => {
  await expireTokenIn(owner, 'tok-approver2', '4 seconds');
  try {
    const r = await flow.approved('requester', 'approver2');
    const approval = (await see.approval(r.requestId))!;
    assert.equal(approval.expiresAt.getTime(), approval.approverTokenExpiresAt.getTime(), 'capped by the approver snapshot');
    const outcome = await behindRequestLock(r, () => flow.reserve(r), () => untilPassed(owner, approval.expiresAt));
    assert.equal(outcome, 'APPROVAL_NOT_VALID');
    const [request, revoked] = [(await see.request(r.requestId))!, (await see.approval(r.requestId))!];
    assert.deepEqual([request.state, revoked.decision, revoked.safeErrorCode, revoked.consumedAt], ['EXPIRED', 'REVOKED', 'APPROVAL_NOT_VALID', null]);
    assert.equal(await see.attempts(r.requestId), 0);
  } finally { await owner.query(`UPDATE "ApiToken" SET "expiresAt" = NULL WHERE id = 'tok-approver2'`); }
  // The caller (approver2) passes admission with a valid token, which expires while it waits for the request lock
  await expireTokenIn(owner, 'tok-approver2', '3 seconds');
  try {
    const r = await flow.request();
    const file = await flow.exported('approver2', CA, r.requestId);
    const expiry = (await owner.query(`SELECT "expiresAt" FROM "ApiToken" WHERE id = 'tok-approver2'`)).rows[0].expiresAt as Date;
    const outcome = await behindRequestLock(r, () => approveAction(db, MOCK, as('approver2'), CA, r.requestId, r.inputHash, file), () => untilPassed(owner, expiry));
    assert.equal(outcome, 'ACTION_AUTHENTICATION_FAILED');
    assert.deepEqual([(await see.request(r.requestId))!.state, await see.approval(r.requestId)], ['AWAITING_APPROVAL', null]);
    assert.equal((await flow.approve(r, 'approver')).state, 'APPROVED', 'the request itself was not lost');
  } finally { await owner.query(`UPDATE "ApiToken" SET "expiresAt" = NULL WHERE id = 'tok-approver2'`); }
});

/** The caller's current token expires (DB clock) while `step` waits on the given row; the result and every row/audit before and after. */
async function expiresWhileWaiting<T>(r: Stored, tokenId: string, row: 'request' | 'approval', step: () => Promise<T>) {
  const before = { request: await see.request(r.requestId), approval: await see.approval(r.requestId), audit: (await see.audit(r.requestId)).length,
    security: (await see.security()).length };
  await expireTokenIn(owner, tokenId, '2 seconds');
  try {
    const expiry = (await owner.query(`SELECT "expiresAt" FROM "ApiToken" WHERE id = $1`, [tokenId])).rows[0].expiresAt as Date;
    const outcome = await behindRequestLock(r, step, () => untilPassed(owner, expiry), row);
    assert.equal(outcome, 'ACTION_AUTHENTICATION_FAILED', `${tokenId} expired while waiting on the ${row} row`);
    assert.deepEqual([await see.request(r.requestId), await see.approval(r.requestId)], [before.request, before.approval], 'no state change');
    assert.deepEqual([(await see.audit(r.requestId)).length, (await see.security()).length, await see.attempts(r.requestId)],
      [before.audit, before.security, 0], 'no audit row of any kind, no attempt');
  } finally { await owner.query(`UPDATE "ApiToken" SET "expiresAt" = NULL WHERE id = $1`, [tokenId]); }
}

test('RC1-F1: terminal replays (own revoke, own cancel) re-check the caller\'s token on the DB clock after the LAST lock; valid replays unchanged', async () => {
  const revoke = (r: Stored, actor = 'approver') => () => revokeApproval(db, MOCK, as(actor), CA, r.requestId, r.inputHash);
  const cancel = (r: Stored, actor = 'requester') => () => cancelAction(db, MOCK, as(actor), CA, r.requestId);
  const cases: [label: string, setup: () => Promise<Stored>, replay: (r: Stored) => () => Promise<unknown>, token: string, row: 'request' | 'approval'][] = [
    ['revoke, waiting on the request row', async () => { const r = await flow.approved(); await revoke(r)(); return r; }, revoke, 'tok-approver', 'request'],
    ['revoke, waiting on the approval row', async () => { const r = await flow.approved(); await revoke(r)(); return r; }, revoke, 'tok-approver', 'approval'],
    ['cancel of a pending request (no decision row), waiting on the request row', async () => { const r = await flow.request(); await cancel(r)(); return r; },
      cancel, 'tok-requester', 'request'],
    ['cancel of an approved request, waiting on its revoked decision row', async () => { const r = await flow.approved(); await cancel(r)(); return r; },
      cancel, 'tok-requester', 'approval'],
  ];
  for (const [label, setup, replay, token, row] of cases) {
    const r = await setup();
    const valid = await replay(r)() as { idempotent: boolean; authorityEpoch: number };
    assert.equal(valid.idempotent, true, `${label}: the valid stored replay`);
    await expiresWhileWaiting(r, token, row, replay(r));
    // The token's expiry was restored (an auth mutation: the epoch moved). A terminal replay recaptures nothing and is unchanged.
    assert.deepEqual(await replay(r)(), valid, `${label}: valid replay after the refusal, same stored result and epoch`);
  }
});

test('RC1-F1: the same boundary precedes every other outcome — approval replay, reservation, other-actor refusals (no refusal audit)', async () => {
  const approved = await flow.approved();
  const replay = async () => approveAction(db, MOCK, as('approver'), CA, approved.requestId, approved.inputHash, await flow.exported('approver', CA, approved.requestId));
  assert.equal((await replay()).idempotent, true);
  const file = await flow.exported('approver', CA, approved.requestId);
  await expiresWhileWaiting(approved, 'tok-approver', 'approval',
    () => approveAction(db, MOCK, as('approver'), CA, approved.requestId, approved.inputHash, file));
  const reservable = await flow.approved();
  await expiresWhileWaiting(reservable, 'tok-executor', 'approval', () => flow.reserve(reservable));
  const revoked = await flow.approved();
  await revokeApproval(db, MOCK, as('approver'), CA, revoked.requestId, revoked.inputHash);
  await assert.rejects(revokeApproval(db, MOCK, as('approver2'), CA, revoked.requestId, revoked.inputHash), fails('APPROVAL_NOT_VALID'), 'another signer');
  await expiresWhileWaiting(revoked, 'tok-approver2', 'approval', () => revokeApproval(db, MOCK, as('approver2'), CA, revoked.requestId, revoked.inputHash));
  const cancelled = await flow.request();
  await cancelAction(db, MOCK, as('requester'), CA, cancelled.requestId);
  await assert.rejects(cancelAction(db, MOCK, as('requester2'), CA, cancelled.requestId), fails('ACTION_STATE_CONFLICT'), 'another requester');
  await expiresWhileWaiting(cancelled, 'tok-requester2', 'request', () => cancelAction(db, MOCK, as('requester2'), CA, cancelled.requestId));
});

test('B5: token replacement (new row, old revoked) invalidates even for the original signer presenting its new token', async () => {
  const r = await flow.approved();
  const rotated = generateToken();
  await owner.query(`UPDATE "ApiToken" SET "revokedAt" = now() WHERE id = 'tok-approver'`);
  await owner.query(`INSERT INTO "ApiToken" ("workspaceId", id, "actorId", "tokenHash") VALUES ($1, 'tok-approver-b', 'approver', $2)`, [WA, hashToken(rotated)]);
  await assert.rejects(revokeApproval(db, MOCK, actionCredential(rotated), CA, r.requestId, r.inputHash), fails('ACTION_AUTHORITY_CHANGED'),
    'the same signer with its new token: the epoch moved, the approval is invalidated rather than revoked');
  await assertInvalidated(r, 'ACTION_AUTHORITY_CHANGED', true);
  tokens.approver = rotated; // later tests sign with the replacement
});

test('terminal outcome audit failure rolls the invalidation back; the next attempt commits it. An approval audit failure stores no decision', async () => {
  const install = (event: string) => owner.query(`CREATE FUNCTION test_refuse_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW."eventType" = '${event}' THEN RAISE EXCEPTION 'CANARY audit store down'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER test_refuse_audit BEFORE INSERT ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION test_refuse_audit();
    REVOKE ALL ON FUNCTION test_refuse_audit() FROM PUBLIC;`);
  const remove = () => owner.query(`DROP TRIGGER test_refuse_audit ON "AuditEvent"; DROP FUNCTION test_refuse_audit();`);
  const r = await flow.approved();
  await owner.query(MUTATIONS['no-op on an unrelated actor']![0]!);
  await install('action.invalidated');
  try {
    await assert.rejects(flow.reserve(r), fails('ACTION_AUDIT_FAILED'));
    assert.deepEqual([(await see.request(r.requestId))!.state, (await see.approval(r.requestId))!.decision], ['APPROVED', 'APPROVED'], 'nothing committed');
  } finally { await remove(); }
  await assert.rejects(flow.reserve(r), fails('ACTION_AUTHORITY_CHANGED'));
  await assertInvalidated(r, 'ACTION_AUTHORITY_CHANGED', true);
  const fresh = await flow.request();
  await install('action.approved');
  try {
    await assert.rejects(flow.approve(fresh), fails('ACTION_AUDIT_FAILED'));
    assert.deepEqual([(await see.request(fresh.requestId))!.state, await see.approval(fresh.requestId)], ['AWAITING_APPROVAL', null]);
  } finally { await remove(); }
  assert.equal((await flow.approve(fresh)).state, 'APPROVED');
});

test('B2: deployed policy/port version drift invalidates with ACTION_CONTRACT_VERSION_CHANGED at approve and at reserve', async () => {
  // Owner (superuser) copies of a stored request whose immutable policyVersion differs from the deployed one
  const drifted = async (source: Stored, state: 'AWAITING_APPROVAL' | 'APPROVED'): Promise<Stored> => {
    const id = (await owner.query(`SELECT gen_random_uuid()::text AS id`)).rows[0].id as string;
    await owner.query(`INSERT INTO "ActionRequest" ("workspaceId","clientId",id,"connectionId","requesterActorId","requesterTokenId","requesterTokenExpiresAt",
        "idempotencyKey","intentHash","dtoVersion","actionType","actionVersion","policyVersion","portVersion",mode,"connectionSystem","customerKey",
        "connectionLifecycleVersion","secretRefDigest","authorityEpoch","markedTitle",description,marker,"canonicalInput","inputHash","createdAt","updatedAt")
      SELECT "workspaceId","clientId",$2::text::uuid,"connectionId","requesterActorId","requesterTokenId","requesterTokenExpiresAt",gen_random_uuid(),"intentHash",
        "dtoVersion","actionType","actionVersion",'atlas-action-policy/0',"portVersion",mode,"connectionSystem","customerKey","connectionLifecycleVersion",
        "secretRefDigest","authorityEpoch",replace("markedTitle", id::text, $2::text),description,'[Atlas:' || $2::text || ']',
        "canonicalInput" || jsonb_build_object('requestId', $2::text, 'title', replace("markedTitle", id::text, $2::text), 'policyVersion', 'atlas-action-policy/0'),
        "inputHash","createdAt","updatedAt" FROM "ActionRequest" WHERE id = $1::uuid`, [source.requestId, id]);
    if (state === 'APPROVED') {
      await owner.query(`INSERT INTO "ActionApproval" ("workspaceId","clientId",id,"requestId","requesterActorId","requestHash","authorityEpoch","actionVersion",
          "policyVersion","portVersion",mode,"signerActorId","signerTokenId",decision,"decidedAt","approvedAt","expiresAt")
        SELECT "workspaceId","clientId",gen_random_uuid(),id,"requesterActorId","inputHash","authorityEpoch","actionVersion","policyVersion","portVersion",mode,
          'approver2','tok-approver2','APPROVED',date_trunc('milliseconds', now() AT TIME ZONE 'UTC'),date_trunc('milliseconds', now() AT TIME ZONE 'UTC'),
          date_trunc('milliseconds', now() AT TIME ZONE 'UTC') + interval '10 minutes' FROM "ActionRequest" WHERE id = $1::uuid`, [id]);
      await owner.query(`UPDATE "ActionRequest" SET state = 'APPROVED' WHERE id = $1::uuid`, [id]);
    }
    return { requestId: id, inputHash: source.inputHash, inputPreview: '' };
  };
  const source = await flow.request();
  const pending = await drifted(source, 'AWAITING_APPROVAL');
  await assert.rejects(flow.approve(pending), fails('ACTION_CONTRACT_VERSION_CHANGED'));
  await assertInvalidated(pending, 'ACTION_CONTRACT_VERSION_CHANGED', false);
  const approved = await drifted(source, 'APPROVED');
  await assert.rejects(flow.reserve(approved), fails('ACTION_CONTRACT_VERSION_CHANGED'));
  await assertInvalidated(approved, 'ACTION_CONTRACT_VERSION_CHANGED', true);
  assert.equal((await flow.approve(source)).state, 'APPROVED', 'the deployed-version request itself is unaffected');
});
