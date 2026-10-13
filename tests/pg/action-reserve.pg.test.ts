import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { assertRuntimeRole } from '../../packages/graph/scoped-db.ts';
import { AtlasError } from '../../packages/core/contracts.ts';
import type { Actor } from '../../packages/core/contracts.ts';
import { disableM365Connection } from '../../packages/connections/m365-disable.ts';
import { cancelAction, rejectAction, revokeApproval } from '../../packages/actions/approvals.ts';
import { consumeReservationPermit } from '../../packages/actions/reservation.ts';
import type { ReservationPermit } from '../../packages/actions/reservation.ts';
import { getAction } from '../../packages/actions/requests.ts';
import { createTestDatabase, provisionRoles } from '../support/pg-harness.ts';
import { CA, MOCK, WA, addActionFixtures, fenceVersion, privateDir, runtimeClient, scoped } from '../support/action-fixtures.ts';
import { inFlight, openSession } from '../support/pg-race.ts';
import { actionFlow, addApprovalActors, as, assertPublic, expireTokenIn, fails, holdFence, observe, settle, untilPassed, waitForWaiters } from '../support/action-approval.ts';
import type { Stored } from '../support/action-approval.ts';

// Stage 3 S3-B, B4 (+ B3 orderings, A4/R2 grants) on PostgreSQL 17: reservation consumes the approval, inserts the unique
// lifetime attempt, sets DISPATCH_RESERVED and audits in one transaction; only a committed reservation yields a private,
// bound, single-use permit with a non-renewed start deadline; concurrent reserve/revoke/cancel/owner/m365-disable orderings
// are deterministic through the fence's FIFO lock queue; a deadlock or cancelled statement is a fixed error with zero effect
// and no retry; runtime grants are exactly the S3-B write surface and readiness refuses any other.
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
const expect = (r: Stored) => ({ workspaceId: WA, clientId: CA, requestId: r.requestId, inputHash: r.inputHash, mode: 'MOCK' });
const refusedConsume = (permit: ReservationPermit, r: Stored, label: string) =>
  assert.throws(() => consumeReservationPermit(permit, expect(r)), fails('APPROVAL_NOT_VALID'), label);

test('B4: one transaction consumes the approval, inserts the attempt, reserves and audits; the permit is private, bound and single-use', async () => {
  const r = await flow.approved();
  const approval = (await see.approval(r.requestId))!;
  const { reservation, permit } = await flow.reserve(r);
  assert.deepEqual(Object.keys(reservation).sort(), ['approvalId', 'attemptId', 'authorityEpoch', 'inputHash', 'requestId', 'reservedAt', 'startDeadlineAt',
    'state', 'synthetic']);
  assert.equal(Date.parse(reservation.startDeadlineAt) - Date.parse(reservation.reservedAt), 5000, 'start window: 5 s (approval lasts longer)');
  assertPublic(reservation, 'reservation result');
  const [request, consumed, attempt] = [(await see.request(r.requestId))!, (await see.approval(r.requestId))!, (await see.attempt(r.requestId))!];
  assert.deepEqual([request.state, request.terminalAt, consumed.decision, consumed.consumedAt.getTime()],
    ['DISPATCH_RESERVED', null, 'CONSUMED', Date.parse(reservation.reservedAt)]);
  assert.deepEqual([consumed.expiresAt, consumed.decidedAt], [approval.expiresAt, approval.decidedAt], 'consumption never renews the approval');
  assert.deepEqual([attempt.id, attempt.approvalId, attempt.state, attempt.verificationCount, attempt.originalTicketId],
    [reservation.attemptId, approval.id, 'RESERVED', 0, null]);
  assert.deepEqual((await see.audit(r.requestId)).at(-1), { eventType: 'action.reserved', metadata: { actionRequestId: r.requestId,
    actionApprovalId: approval.id, actionAttemptId: attempt.id, requestState: 'DISPATCH_RESERVED' } });
  // The handle carries nothing: serialized, cloned or fabricated copies are unknown to the capability map
  assert.equal(JSON.stringify(permit), '{"kind":"ActionReservationPermit"}');
  assert.ok(Object.isFrozen(permit));
  refusedConsume(structuredClone(permit), r, 'a structured clone');
  refusedConsume(JSON.parse(JSON.stringify(permit)), r, 'a deserialized copy');
  refusedConsume(Object.freeze({ kind: 'ActionReservationPermit' as const }), r, 'a fabricated handle');
  const dispatch = consumeReservationPermit(permit, expect(r));
  assert.deepEqual([dispatch.attemptId, dispatch.createNonce, dispatch.attemptToken, dispatch.inputHash, dispatch.mode, dispatch.connectionId, dispatch.markedTitle],
    [attempt.id, attempt.createNonce, attempt.attemptToken, r.inputHash, 'MOCK', 'atera-a', request.markedTitle], 'bound to the committed attempt and stored intent');
  assert.equal(dispatch.startDeadlineAt.getTime(), attempt.startDeadlineAt.getTime());
  assert.ok(Object.isFrozen(dispatch));
  refusedConsume(permit, r, 'consumed exactly once');
  assert.deepEqual(await see.attempt(r.requestId), attempt, 'consumption is local: the durable attempt is unchanged');
  // After reservation: no second permit, and cancel/revoke/reject never claim to prevent anything
  await assert.rejects(flow.reserve(r), fails('ACTION_ALREADY_RESERVED'));
  await assert.rejects(cancelAction(db, MOCK, as('requester'), CA, r.requestId), fails('ACTION_ALREADY_RESERVED'));
  await assert.rejects(revokeApproval(db, MOCK, as('approver'), CA, r.requestId, r.inputHash), fails('ACTION_ALREADY_RESERVED'));
  await assert.rejects(rejectAction(db, MOCK, as('approver'), CA, r.requestId, r.inputHash), fails('ACTION_ALREADY_RESERVED'));
  await assert.rejects(flow.approve(r), fails('APPROVAL_NOT_VALID'));
  assert.equal(await see.attempts(r.requestId), 1);
  assert.equal((await getAction(db, MOCK, as('reader'), CA, r.requestId)).state, 'DISPATCH_RESERVED');
});

test('B4: a mismatched or late consumption spends the permit and never resets the durable attempt latch', async () => {
  const r = await flow.approved();
  const { permit } = await flow.reserve(r);
  for (const change of [{ requestId: (await flow.request()).requestId }, { inputHash: 'f'.repeat(64) }, { mode: 'LIVE' }, { clientId: 'act-client-b' }]) {
    const other = await flow.approved();
    const reserved = await flow.reserve(other);
    assert.throws(() => consumeReservationPermit(reserved.permit, { ...expect(other), ...change }), fails('APPROVAL_NOT_VALID'), JSON.stringify(change));
    refusedConsume(reserved.permit, other, 'spent by the refused attempt');
    assert.equal((await see.attempt(other.requestId))!.state, 'RESERVED');
    await assert.rejects(flow.reserve(other), fails('ACTION_ALREADY_RESERVED'), 'no new reservation after a refused consumption');
  }
  assert.equal(consumeReservationPermit(permit, expect(r)).requestId, r.requestId);
});

test('B4: the start deadline is min(reservedAt + 5 s, approval expiry) on the monotonic clock; it is never renewed', async () => {
  await expireTokenIn(owner, 'tok-approver2', '3 seconds');
  try {
    const short = await flow.approved('requester', 'approver2');
    const approval = (await see.approval(short.requestId))!;
    const { reservation, permit } = await flow.reserve(short);
    assert.equal(Date.parse(reservation.startDeadlineAt), approval.expiresAt.getTime(), 'the approval expiry caps the window');
    assert.ok(Date.parse(reservation.startDeadlineAt) - Date.parse(reservation.reservedAt) < 5000);
    await untilPassed(owner, approval.expiresAt);
    refusedConsume(permit, short, 'late: after the approval expiry');
    assert.equal((await see.attempt(short.requestId))!.state, 'RESERVED');
  } finally { await owner.query(`UPDATE "ApiToken" SET "expiresAt" = NULL WHERE id = 'tok-approver2'`); }
  const normal = await flow.approved();
  const full = await flow.reserve(normal);
  await assert.rejects(flow.reserve(normal), fails('ACTION_ALREADY_RESERVED'), 'a replayed reservation mints no new permit or deadline');
  await new Promise(resolve => setTimeout(resolve, 5050));
  refusedConsume(full.permit, normal, 'late: after reservedAt + 5 s');
});

test('B4: concurrent reservations of one approval give exactly one attempt and one permit; the rest ACTION_ALREADY_RESERVED', async () => {
  const r = await flow.approved();
  const results = await Promise.all(Array.from({ length: 6 }, () => settle(flow.reserve(r))));
  const won = results.filter(x => typeof x !== 'string');
  assert.equal(won.length, 1);
  assert.deepEqual(results.filter(x => typeof x === 'string'), Array(5).fill('ACTION_ALREADY_RESERVED'));
  assert.equal(await see.attempts(r.requestId), 1);
  const events = (await see.audit(r.requestId)).map(a => a.eventType);
  assert.deepEqual([events.filter(e => e === 'action.reserved').length, events.filter(e => e === 'action.execute_refused').length], [1, 5]);
});

/** `first` and then `second` queue behind a held fence row; releasing it lets them run in that order (FIFO lock queue). */
async function ordered<A, B>(first: () => Promise<A>, second: () => Promise<B>): Promise<[A | string, B | string]> {
  const hold = await holdFence(pgdb.runtimeUrl);
  try {
    const a = inFlight(first);
    await waitForWaiters(runtime, 1);
    const b = inFlight(second);
    await waitForWaiters(runtime, 2);
    await hold.release();
    return [await settle(a.result()), await settle(b.result())];
  } catch (error) { await hold.release().catch(() => undefined); throw error; }
}
const ownerUpdate = async (sql: string) => { const s = await openSession(pgdb.ownerUrl); try { return (await s.client.query(sql)).rowCount; } finally { await s.client.end(); } };

test('B3/B4: revoke or cancel winning the fence first prevents the reservation; a committed reservation makes them ACTION_ALREADY_RESERVED', async () => {
  const revoke = (r: Stored) => () => revokeApproval(db, MOCK, as('approver'), CA, r.requestId, r.inputHash);
  const cancel = (r: Stored) => () => cancelAction(db, MOCK, as('requester'), CA, r.requestId);
  for (const [label, decide, state] of [['revoke', revoke, 'REVOKED'], ['cancel', cancel, 'CANCELLED']] as const) {
    const a = await flow.approved();
    const [decided, reserved] = await ordered(decide(a), () => flow.reserve(a));
    assert.deepEqual([(decided as { state: string }).state, reserved], [state, 'APPROVAL_NOT_VALID'], `${label} first`);
    assert.equal(await see.attempts(a.requestId), 0);
    const b = await flow.approved();
    const [won, late] = await ordered(() => flow.reserve(b), decide(b));
    assert.deepEqual([typeof won === 'object' && won.reservation.state, late], ['DISPATCH_RESERVED', 'ACTION_ALREADY_RESERVED'], `reserve before ${label}`);
    assert.equal(consumeReservationPermit((won as { permit: ReservationPermit }).permit, expect(b)).requestId, b.requestId);
  }
});

test('B3: an owner Connection update or m365-disable winning the fence invalidates; reserving first wins without lock inversion', async () => {
  await owner.query(`INSERT INTO "Connection" ("workspaceId","clientId",id,system,"externalTenantId","secretRef",status,"boundBy","boundAt")
    VALUES ($1, $2, 'm365-a', 'microsoft365', '11111111-2222-4333-8444-555555555555', 'env://M365_A', 'ACTIVE', 'operator', now())`, [WA, CA]);
  await owner.query(`INSERT INTO "Actor" ("workspaceId", id, "displayName") VALUES ($1, 'operator', 'Synthetic actor')`, [WA]);
  await owner.query(`INSERT INTO "ClientMembership" ("workspaceId","clientId","actorId",permissions) VALUES ($1, $2, 'operator', ARRAY['connections:manage'])`, [WA, CA]);
  const operator: Actor = { id: 'operator', workspaceId: WA, workspacePermissions: [], memberships: [{ clientId: CA, permissions: ['connections:manage'] }] };
  const disable = () => disableM365Connection(db, operator, { workspaceId: WA, clientId: CA }, 'm365-a');
  const touch = async () => ({ updated: await ownerUpdate(`UPDATE "Connection" SET "secretRef" = "secretRef" WHERE id = 'atera-a'`) });
  const mutations: [string, () => Promise<object>][] = [['owner Connection update', touch], ['m365-disable', disable]];
  for (const [label, mutate] of mutations) {
    const a = await flow.approved();
    const [, reserved] = await ordered(mutate, () => flow.reserve(a));
    assert.equal(reserved, 'ACTION_AUTHORITY_CHANGED', `${label} first: no permit`);
    assert.equal((await see.request(a.requestId))!.state, 'INVALIDATED');
    assert.equal(await see.attempts(a.requestId), 0);
    if (label === 'm365-disable') await owner.query(`UPDATE "Connection" SET status = 'ACTIVE', "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = 'm365-a'`);
    const b = await flow.approved();
    const epoch = await fenceVersion(runtime, WA);
    const [won, after] = await ordered(() => flow.reserve(b), mutate);
    assert.equal(typeof won === 'object' && won.reservation.state, 'DISPATCH_RESERVED', `reserve before ${label}`);
    assert.notEqual(typeof after, 'string', `${label} completes after the reservation (no deadlock)`);
    assert.equal(await fenceVersion(runtime, WA), epoch! + 1);
    assert.equal(consumeReservationPermit((won as { permit: ReservationPermit }).permit, expect(b)).requestId, b.requestId,
      'a later revocation cannot retroactively cancel the committed reservation');
    if (label === 'm365-disable') await owner.query(`UPDATE "Connection" SET status = 'ACTIVE', "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = 'm365-a'`);
  }
});

test('B4: a deadlock before reservation is ACTION_DB_CONFLICT with zero effect and no retry; a cancelled statement is a fixed error too', async () => {
  const r = await flow.approved();
  const audits = (await see.audit(r.requestId)).length;
  const holder = await openSession(pgdb.ownerUrl);
  try {
    await holder.client.query('BEGIN');
    await holder.client.query(`SET LOCAL deadlock_timeout = '60s'`); // the reservation (1 s default) detects the cycle
    await holder.client.query(`SELECT 1 FROM "ActionRequest" WHERE id = $1 FOR UPDATE`, [r.requestId]);
    const reserving = inFlight(() => flow.reserve(r));
    await waitForWaiters(runtime, 1); // holds the fence, waits for the request row
    const cycle = inFlight(() => holder.client.query(`SELECT 1 FROM "ActionAuthorityFence" WHERE "workspaceId" = $1 FOR UPDATE`, [WA]));
    assert.equal(await settle(reserving.result()), 'ACTION_DB_CONFLICT');
    await cycle.result();
  } finally { await holder.client.query('ROLLBACK').catch(() => undefined); await holder.client.end(); }
  assert.deepEqual([(await see.request(r.requestId))!.state, (await see.approval(r.requestId))!.decision, await see.attempts(r.requestId)], ['APPROVED', 'APPROVED', 0]);
  assert.equal((await see.audit(r.requestId)).length, audits, 'the whole transaction rolled back (no refusal row either)');
  // A statement cancelled while waiting behind the fence: fixed error, nothing written
  const hold = await holdFence(pgdb.runtimeUrl);
  try {
    const reserving = inFlight(() => flow.reserve(r));
    await waitForWaiters(runtime, 1);
    await owner.query(`SELECT pg_cancel_backend(l.pid) FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE NOT l.granted AND a.datname = current_database() AND l.pid <> $1`, [hold.session.pid]);
    assert.equal(await settle(reserving.result()), 'UNEXPECTED_ERROR');
  } finally { await hold.release(); }
  assert.deepEqual([(await see.request(r.requestId))!.state, await see.attempts(r.requestId)], ['APPROVED', 0]);
  assert.equal((await flow.reserve(r)).reservation.state, 'DISPATCH_RESERVED', 'an explicit new call reserves');
});

/**
 * A real deadlock AT an audit INSERT: the owner holds the audit table ACCESS EXCLUSIVE, `step` reaches (and is proved to wait
 * on) that table while holding the workspace fence, then the owner asks for the same fence row. The step's session (1 s
 * deadlock_timeout; the owner's is 60 s) is the deadlock victim.
 */
async function deadlockAtAudit<T>(table: 'AuditEvent' | 'SecurityAuditEvent', step: () => Promise<T>): Promise<T | string> {
  const holder = await openSession(pgdb.ownerUrl);
  try {
    await holder.client.query('BEGIN');
    await holder.client.query(`SET LOCAL deadlock_timeout = '60s'`);
    await holder.client.query(`LOCK TABLE "${table}" IN ACCESS EXCLUSIVE MODE`);
    const running = inFlight(step);
    await waitForWaiters(runtime, 1);
    const waiting = (await owner.query(`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND locktype = 'relation' AND relation = $1::regclass`,
      [`"${table}"`])).rows[0].n;
    assert.equal(waiting, 1, `the step waits on the ${table} INSERT itself, not on an earlier lock`);
    const cycle = inFlight(() => holder.client.query(`SELECT 1 FROM "ActionAuthorityFence" WHERE "workspaceId" = $1 FOR UPDATE`, [WA]));
    const outcome = await settle(running.result());
    await cycle.result();
    return outcome;
  } finally { await holder.client.query('ROLLBACK').catch(() => undefined); await holder.client.end(); }
}

test('RC1-F2: a deadlock at the reservation audit INSERT is ACTION_DB_CONFLICT with zero effect and no permit; at a denial audit too', async () => {
  const r = await flow.approved();
  const [audits, security] = [(await see.audit(r.requestId)).length, (await see.security()).length];
  assert.equal(await deadlockAtAudit('AuditEvent', () => flow.reserve(r)), 'ACTION_DB_CONFLICT', 'not masked as ACTION_AUDIT_FAILED');
  assert.deepEqual([(await see.request(r.requestId))!.state, (await see.approval(r.requestId))!.decision, (await see.approval(r.requestId))!.consumedAt,
    await see.attempts(r.requestId), (await see.audit(r.requestId)).length], ['APPROVED', 'APPROVED', null, 0, audits], 'consume/attempt/state/audit all rolled back');
  // The scope-denial audit of the same admission: one workspace row or a fixed conflict, never a masked audit failure
  assert.equal(await deadlockAtAudit('SecurityAuditEvent', () => flow.reserve(r, 'approver')), 'ACTION_DB_CONFLICT');
  assert.equal((await see.security()).length, security, 'no denial row survives the rolled-back admission');
  const { reservation, permit } = await flow.reserve(r);
  assert.equal(consumeReservationPermit(permit, expect(r)).attemptId, reservation.attemptId, 'only an explicit new call reserves (no retry happened)');
});

test('RC1-F2: genuine audit-storage failures stay ACTION_AUDIT_FAILED — the denial audit as well as the reservation audit', async () => {
  const r = await flow.approved();
  await owner.query(`CREATE FUNCTION test_refuse_denial() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW."eventType" = 'action.execute_denied' THEN RAISE EXCEPTION 'CANARY audit store down'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER test_refuse_denial BEFORE INSERT ON "SecurityAuditEvent" FOR EACH ROW EXECUTE FUNCTION test_refuse_denial();
    REVOKE ALL ON FUNCTION test_refuse_denial() FROM PUBLIC;`);
  const security = (await see.security()).length;
  try {
    await assert.rejects(flow.reserve(r, 'approver'), fails('ACTION_AUDIT_FAILED'));
    assert.equal((await see.security()).length, security);
  } finally { await owner.query(`DROP TRIGGER test_refuse_denial ON "SecurityAuditEvent"; DROP FUNCTION test_refuse_denial();`); }
  await assert.rejects(flow.reserve(r, 'approver'), fails('PERMISSION_DENIED'));
  assert.equal((await see.security()).length, security + 1);
});

test('B4: a failing reservation audit rolls everything back and mints no permit', async () => {
  const r = await flow.approved();
  await owner.query(`CREATE FUNCTION test_refuse_reserved() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW."eventType" = 'action.reserved' THEN RAISE EXCEPTION 'CANARY audit store down'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER test_refuse_reserved BEFORE INSERT ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION test_refuse_reserved();
    REVOKE ALL ON FUNCTION test_refuse_reserved() FROM PUBLIC;`);
  try {
    await assert.rejects(flow.reserve(r), fails('ACTION_AUDIT_FAILED'));
    assert.deepEqual([(await see.request(r.requestId))!.state, (await see.approval(r.requestId))!.decision, await see.attempts(r.requestId)], ['APPROVED', 'APPROVED', 0]);
  } finally { await owner.query(`DROP TRIGGER test_refuse_reserved ON "AuditEvent"; DROP FUNCTION test_refuse_reserved();`); }
  assert.equal((await flow.reserve(r)).reservation.state, 'DISPATCH_RESERVED');
});

test('A4/R2: runtime grants are exactly the S3-C write surface; immutable fields stay closed; readiness refuses extra or missing grants', async () => {
  const privileges = (await owner.query(`SELECT c.relname AS t, a.attname AS col, has_column_privilege($1, c.oid, a.attnum, 'UPDATE') AS u
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE c.relname LIKE 'Action%' AND has_column_privilege($1, c.oid, a.attnum, 'UPDATE')`, [pgdb.runtimeRole])).rows.map(p => `${p.t}.${p.col}`).sort();
  // S3-B lifecycle columns plus the S3-C result/outcome/claim columns — exactly the history triggers' mutable sets
  assert.deepEqual(privileges, ['ActionApproval.consumedAt', 'ActionApproval.decision', 'ActionApproval.revokedAt', 'ActionApproval.safeErrorCode',
    ...['activeCandidateId', 'activeDeadlineAt', 'activeStartedAt', 'activeVerificationOrdinal', 'activeVerificationToken', 'originalTicketId', 'outcomeAt',
      'safeErrorCode', 'state', 'updatedAt', 'verificationCount', 'verificationSeq', 'verificationState', 'verifiedTicketId'].map(c => `ActionAttempt.${c}`),
    'ActionAuthorityFence.workspaceId', 'ActionRequest.resultTicketId', 'ActionRequest.safeErrorCode', 'ActionRequest.state', 'ActionRequest.terminalAt',
    'ActionRequest.updatedAt', 'ActionVerification.completedAt', 'ActionVerification.safeErrorCode', 'ActionVerification.state'].sort());
  const tables = (await owner.query(`SELECT relname AS t, has_table_privilege($1, oid, 'INSERT') AS i, has_table_privilege($1, oid, 'DELETE') AS d,
      has_table_privilege($1, oid, 'TRUNCATE') AS x FROM pg_class WHERE relname LIKE 'Action%' AND relkind = 'r'`, [pgdb.runtimeRole])).rows
    .sort((a, b) => (a.t < b.t ? -1 : 1));
  assert.deepEqual(tables.map(t => [t.t, t.i, t.d, t.x]), [['ActionApproval', true, false, false], ['ActionAttempt', true, false, false],
    ['ActionAuthorityFence', false, false, false], ['ActionMockTicket', true, false, false], ['ActionRequest', true, false, false],
    ['ActionVerification', true, false, false]]);
  const r = await flow.approved();
  await revokeApproval(db, MOCK, as('approver'), CA, r.requestId, r.inputHash);
  const direct = async (sql: string, pattern: RegExp) => {
    await runtime.query('BEGIN');
    try {
      await runtime.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true)`, [WA, CA]);
      await assert.rejects(runtime.query(sql, [r.requestId]), pattern, sql);
    } finally { await runtime.query('ROLLBACK'); }
  };
  for (const sql of [`UPDATE "ActionApproval" SET "requestHash" = repeat('0', 64) WHERE "requestId" = $1`, `UPDATE "ActionApproval" SET "expiresAt" = now() WHERE "requestId" = $1`,
    `UPDATE "ActionApproval" SET "signerActorId" = 'approver2' WHERE "requestId" = $1`, `UPDATE "ActionRequest" SET "authorityEpoch" = 0 WHERE id = $1`,
    `UPDATE "ActionAttempt" SET "createNonce" = gen_random_uuid() WHERE "requestId" = $1`, `UPDATE "ActionAttempt" SET "attemptToken" = gen_random_uuid() WHERE "requestId" = $1`,
    `UPDATE "ActionVerification" SET "targetTicketId" = 'T-2' WHERE "attemptId" = $1`, `UPDATE "ActionMockTicket" SET description = 'x' WHERE id = $1`,
    `DELETE FROM "ActionApproval" WHERE "requestId" = $1`, `DELETE FROM "ActionVerification" WHERE "attemptId" = $1`, `DELETE FROM "ActionMockTicket" WHERE id = $1`]) {
    await direct(sql, /permission denied/);
  }
  // S3-C granted the set-once result ID, but a non-VERIFIED request cannot carry one (state CHECK), and it is set once only
  await direct(`UPDATE "ActionRequest" SET "resultTicketId" = 'T-1' WHERE id = $1`, /ActionRequest_state_check/);
  await direct(`UPDATE "ActionApproval" SET "revokedAt" = now() WHERE "requestId" = $1`, /ACTION_HISTORY_IMMUTABLE/);
  await direct(`UPDATE "ActionRequest" SET "terminalAt" = now() WHERE id = $1`, /ACTION_HISTORY_IMMUTABLE/);
  await direct(`UPDATE "ActionRequest" SET state = 'APPROVED' WHERE id = $1`, /ACTION_LIFECYCLE_INVALID/);
  await direct(`UPDATE "ActionApproval" SET decision = 'APPROVED' WHERE "requestId" = $1`, /ACTION_LIFECYCLE_INVALID/);
  // Readiness: any action grant outside the S3-C allowlist, or a missing one, refuses startup and every fenced admission
  const roles = { runtime: pgdb.runtimeRole, definer: pgdb.definerRole, runner: pgdb.runnerRole, fence: pgdb.fenceRole, poDefiner: pgdb.poDefinerRole, poRunner: pgdb.poRunnerRole };
  const reprovision = () => provisionRoles(owner, roles, { runtimePassword: randomBytes(18).toString('hex'), runnerPassword: randomBytes(18).toString('hex') });
  for (const drift of [`GRANT UPDATE ("expiresAt") ON "ActionApproval" TO "${roles.runtime}"`, `GRANT UPDATE ("attemptToken") ON "ActionAttempt" TO "${roles.runtime}"`,
    `GRANT UPDATE ("targetTicketId") ON "ActionVerification" TO "${roles.runtime}"`, `GRANT UPDATE (description) ON "ActionMockTicket" TO "${roles.runtime}"`,
    `REVOKE INSERT ON "ActionAttempt" FROM "${roles.runtime}"`, `REVOKE INSERT ON "ActionMockTicket" FROM "${roles.runtime}"`,
    `REVOKE UPDATE ("activeCandidateId") ON "ActionAttempt" FROM "${roles.runtime}"`, `REVOKE UPDATE ("resultTicketId") ON "ActionRequest" FROM "${roles.runtime}"`,
    `REVOKE UPDATE ("terminalAt") ON "ActionRequest" FROM "${roles.runtime}"`, `REVOKE UPDATE ("consumedAt") ON "ActionApproval" FROM "${roles.runtime}"`]) {
    await owner.query(drift);
    try {
      await assert.rejects(assertRuntimeRole(db), /RUNTIME_ROLE_NOT_CONFINED/, drift);
      await assert.rejects(getAction(db, MOCK, as('reader'), CA, r.requestId), (e: unknown) => e instanceof AtlasError && e.code === 'ACTION_FENCE_NOT_READY', drift);
    } finally { await reprovision(); }
  }
  await assertRuntimeRole(db);
  assert.equal((await scoped<{ n: number }>(runtime, WA, CA, `SELECT count(*)::int AS n FROM "ActionAttempt" WHERE "requestId" = $1`, [r.requestId]))[0]!.n, 0);
});
