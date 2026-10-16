import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { generateToken } from '../../packages/auth/token.ts';
import { actionCredential } from '../../packages/actions/authority.ts';
import { getAction, previewAction } from '../../packages/actions/requests.ts';
import { approveAction, cancelAction, rejectAction, revokeApproval } from '../../packages/actions/approvals.ts';
import { reserveAction } from '../../packages/actions/reservation.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { CA, CB, MOCK, WA, WB, addActionFixtures, privateDir, runtimeClient } from '../support/action-fixtures.ts';
import { actionFlow, addApprovalActors, as, assertPublic, expireTokenIn, fails, observe } from '../support/action-approval.ts';

// Stage 3 S3-B, B1/B2/B5 on PostgreSQL 17: fresh bearer authority on ONE membership for every command (one workspace denial
// row each, no merging, no admin shortcut), an independent approver with approve/read/context and no request grant approves
// the exact STORED preview, every content/hash/file substitution refuses, the same signer's APPROVED replay changes nothing,
// lifetime = DB clock + 15 min capped by both signer snapshots, and explicit revoke/cancel/reject with no terminal revival.
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
const MIN = 60_000;

test('B2: an approver without any request grant exports the exact stored preview and approves; lifetime 15 min; replay changes nothing', async () => {
  const r = await flow.request();
  await assert.rejects(previewAction(db, MOCK, as('approver'), CA, await files.input({ connectionId: 'atera-a', title: 't', description: 'd',
    idempotencyKey: randomUUID() }), flow.next()), fails('PERMISSION_DENIED'), 'the approver holds no request grant');
  const file = await flow.exported('approver', CA, r.requestId);
  const approved = await approveAction(db, MOCK, as('approver'), CA, r.requestId, r.inputHash, file);
  assert.deepEqual(Object.keys(approved).sort(), ['approvalId', 'authorityEpoch', 'decidedAt', 'decision', 'expiresAt', 'idempotent', 'inputHash',
    'requestId', 'state', 'synthetic']);
  assert.deepEqual([approved.state, approved.decision, approved.idempotent, approved.synthetic], ['APPROVED', 'APPROVED', false, true]);
  assert.equal(Date.parse(approved.expiresAt!) - Date.parse(approved.decidedAt!), 15 * MIN, 'no cap: exactly 15 minutes from the DB clock');
  assertPublic(approved, 'approval result');
  const request = (await see.request(r.requestId))!;
  const approval = (await see.approval(r.requestId))!;
  assert.equal(request.state, 'APPROVED');
  assert.deepEqual([approval.signerActorId, approval.signerTokenId, approval.approverTokenExpiresAt, approval.requestHash, approval.authorityEpoch],
    ['approver', 'tok-approver', null, r.inputHash, request.authorityEpoch], 'signed by the verified current token row, bound to hash + epoch');
  assert.equal(approval.decidedAt.getTime(), approval.approvedAt.getTime());
  const audit = await see.audit(r.requestId);
  assert.deepEqual(audit.map(a => [a.eventType, a.metadata]).slice(1), [['action.approved',
    { actionRequestId: r.requestId, actionApprovalId: approved.approvalId, requestState: 'APPROVED', approvalDecision: 'APPROVED' }]]);
  // Replay by the same signer: the stored decision, no mutation, audit or renewal
  const replay = await approveAction(db, MOCK, as('approver'), CA, r.requestId, r.inputHash, await flow.exported('approver', CA, r.requestId));
  assert.deepEqual({ ...replay, idempotent: false }, approved);
  assert.equal(replay.idempotent, true);
  assert.deepEqual(await see.approval(r.requestId), approval);
  assert.deepEqual(await see.request(r.requestId), request);
  assert.equal((await see.audit(r.requestId)).length, audit.length);
  await assert.rejects(approveAction(db, MOCK, as('approver2'), CA, r.requestId, r.inputHash, await flow.exported('approver2', CA, r.requestId)),
    fails('APPROVAL_NOT_VALID'), 'another signer never replaces or co-signs the decision');
  assert.deepEqual(await see.approval(r.requestId), approval);
});

test('B2: tampered, partial, extra-field, input-preview, other-request and other-client files and a wrong hash refuse; nothing changes', async () => {
  const r = await flow.request();
  const other = await flow.request();
  const otherClient = await flow.request('requester', CB);
  const stored = JSON.parse(await readFile(await flow.exported('approver', CA, r.requestId), 'utf8'));
  const variants: Record<string, unknown> = {
    'changed title': { ...stored, title: `${stored.title} ` }, 'changed description': { ...stored, description: 'other' },
    'changed connection': { ...stored, connectionId: 'atera-b' }, 'changed hash field': { ...stored, inputHash: other.inputHash },
    'extra field': { ...stored, customerKey: 'x' }, 'missing field': { ...stored, marker: undefined }, 'not an object': [stored],
    'input preview of the same intent': JSON.parse(await readFile(r.inputPreview, 'utf8')),
    'stored preview of another request': JSON.parse(await readFile(await flow.exported('approver', CA, other.requestId), 'utf8')),
    'stored preview of another client': JSON.parse(await readFile(await flow.exported('requester', CB, otherClient.requestId), 'utf8')),
  };
  for (const [label, doc] of Object.entries(variants)) {
    await assert.rejects(approveAction(db, MOCK, as('approver'), CA, r.requestId, r.inputHash, await files.input(doc)), fails('APPROVAL_PREVIEW_MISMATCH'), label);
  }
  const exact = await files.input(stored);
  await assert.rejects(approveAction(db, MOCK, as('approver'), CA, r.requestId, other.inputHash, exact), fails('APPROVAL_HASH_MISMATCH'));
  await assert.rejects(approveAction(db, MOCK, as('approver'), CA, r.requestId, 'nothex', exact), fails('ACTION_INPUT_INVALID'));
  const open = files.out('open.json');
  await writeFile(open, JSON.stringify(stored), { mode: 0o600 });
  await chmod(open, 0o644);
  await assert.rejects(approveAction(db, MOCK, as('approver'), CA, r.requestId, r.inputHash, open), fails('ACTION_INPUT_INVALID'), 'not exactly 0600');
  const link = files.out('link.json');
  await symlink(exact, link);
  await assert.rejects(approveAction(db, MOCK, as('approver'), CA, r.requestId, r.inputHash, link), fails('ACTION_INPUT_INVALID'), 'no symlink');
  await assert.rejects(approveAction(db, MOCK, as('approver'), CA, otherClient.requestId, otherClient.inputHash, exact), fails('ACTION_NOT_FOUND'),
    'a request of another client is invisible here');
  assert.equal((await see.request(r.requestId))!.state, 'AWAITING_APPROVAL');
  assert.equal(await see.approval(r.requestId), null);
  assert.deepEqual((await see.audit(r.requestId)).slice(1).map(a => a.metadata.safeErrorCode),
    [...Object.keys(variants).map(() => 'APPROVAL_PREVIEW_MISMATCH'), 'APPROVAL_HASH_MISMATCH']);
  assert.equal((await approveAction(db, MOCK, as('approver'), CA, r.requestId, r.inputHash, exact)).state, 'APPROVED', 'the exact file approves');
});

test('B1: every S3-B command — scope/permission denial is exactly one workspace audit row; no merging; unknown token invents no actor', async () => {
  const r = await flow.approved();
  const commands: Record<string, (actor: string, client?: string) => Promise<unknown>> = {
    approve: async (actor, client = CA) => approveAction(db, MOCK, as(actor), client, r.requestId, r.inputHash, await files.input({})),
    reject: (actor, client = CA) => rejectAction(db, MOCK, as(actor), client, r.requestId, r.inputHash),
    revoke: (actor, client = CA) => revokeApproval(db, MOCK, as(actor), client, r.requestId, r.inputHash),
    cancel: (actor, client = CA) => cancelAction(db, MOCK, as(actor), client, r.requestId),
    execute: (actor, client = CA) => reserveAction(db, MOCK, as(actor), client, r.requestId, r.inputHash),
  };
  const denied: Record<string, [actor: string, client: string, code: string][]> = {
    approve: [['requester', CA, 'PERMISSION_DENIED'], ['reader', CA, 'PERMISSION_DENIED'], ['splitApprover', CA, 'PERMISSION_DENIED'],
      ['splitApprover', CB, 'PERMISSION_DENIED'], ['approverB', CA, 'SCOPE_DENIED'], ['executor', CA, 'PERMISSION_DENIED']],
    reject: [['requester', CA, 'PERMISSION_DENIED'], ['contextOnly', CA, 'PERMISSION_DENIED']],
    revoke: [['requester', CA, 'PERMISSION_DENIED'], ['splitApprover', CA, 'PERMISSION_DENIED']],
    cancel: [['approver', CA, 'PERMISSION_DENIED'], ['reader', CA, 'PERMISSION_DENIED'], ['split', CA, 'PERMISSION_DENIED']],
    execute: [['approver', CA, 'PERMISSION_DENIED'], ['requester', CA, 'PERMISSION_DENIED'], ['executeNoRead', CA, 'PERMISSION_DENIED'],
      ['dual', CA, 'PERMISSION_DENIED']],
  };
  for (const [command, cases] of Object.entries(denied)) {
    for (const [actor, client, code] of cases) {
      const before = (await see.security()).length;
      await assert.rejects(commands[command]!(actor, client), fails(code), `${command} by ${actor} on ${client}`);
      const rows = (await see.security()).slice(before);
      assert.deepEqual(rows, [{ eventType: `action.${command}_denied`, reasonCode: code, requestedClientId: client, actorId: actor }], `${command} ${actor}`);
    }
  }
  const foreign = (await see.security(WB)).length;
  for (const command of Object.keys(commands)) await assert.rejects(commands[command]!('outsider'), fails('SCOPE_DENIED'), command);
  assert.equal((await see.security(WB)).length - foreign, 5, 'outsider denials are audited in its own workspace only');
  const total = (await see.security()).length;
  for (const run of [() => cancelAction(db, MOCK, actionCredential(generateToken()), CA, r.requestId),
    () => reserveAction(db, MOCK, actionCredential(generateToken()), CA, r.requestId, r.inputHash)]) {
    await assert.rejects(run(), fails('ACTION_AUTHENTICATION_FAILED'));
  }
  assert.equal((await see.security()).length, total, 'no denial row for an unknown token');
  assert.equal((await see.request(r.requestId))!.state, 'APPROVED', 'no denial changed the request');
  assert.equal((await see.audit(r.requestId)).length, 2, 'no client audit row for any denial');
});

test('B2: self approval/rejection refuse even with both grants; a dual-role requester\'s request is approvable by another signer', async () => {
  const own = await flow.request('dual');
  await assert.rejects(flow.approve(own, 'dual'), fails('APPROVAL_SELF_REFUSED'));
  await assert.rejects(rejectAction(db, MOCK, as('dual'), CA, own.requestId, own.inputHash), fails('APPROVAL_SELF_REFUSED'));
  assert.equal(await see.approval(own.requestId), null);
  assert.equal((await flow.approve(own, 'approver')).state, 'APPROVED');
  const theirs = await flow.request('requester');
  assert.equal((await flow.approve(theirs, 'dual')).decision, 'APPROVED', 'dual may approve another requester\'s request');
});

test('B2: the lifetime is DB clock + 15 min capped by BOTH immutable signer snapshots; a null snapshot sets no cap', async () => {
  await expireTokenIn(owner, 'tok-requester2', '10 minutes');
  await expireTokenIn(owner, 'tok-approver2', '5 minutes');
  try {
    const requesterCapped = await flow.request('requester2');
    const a = await flow.approve(requesterCapped, 'approver');
    const snapshot = (await see.request(requesterCapped.requestId))!.requesterTokenExpiresAt as Date;
    assert.equal(Date.parse(a.expiresAt!), snapshot.getTime(), 'the requester cap');
    assert.ok(Date.parse(a.expiresAt!) - Date.parse(a.decidedAt!) < 15 * MIN);
    const approverCapped = await flow.request('requester');
    const b = await flow.approve(approverCapped, 'approver2');
    const approval = (await see.approval(approverCapped.requestId))!;
    assert.equal(Date.parse(b.expiresAt!), (approval.approverTokenExpiresAt as Date).getTime(), 'the approver cap (its own snapshot)');
    const both = await flow.request('requester2');
    const c = await flow.approve(both, 'approver2');
    assert.equal(Date.parse(c.expiresAt!), Math.min(snapshot.getTime(), (approval.approverTokenExpiresAt as Date).getTime()), 'the earlier of both caps');
  } finally {
    await owner.query(`UPDATE "ApiToken" SET "expiresAt" = NULL WHERE id IN ('tok-requester2', 'tok-approver2')`);
  }
});

test('B5: original signer revokes, a repeat returns the stored result; another approver and the requester cannot; no revival', async () => {
  const r = await flow.approved();
  await assert.rejects(revokeApproval(db, MOCK, as('approver2'), CA, r.requestId, r.inputHash), fails('APPROVAL_NOT_VALID'), 'another signer');
  await assert.rejects(revokeApproval(db, MOCK, as('approver'), CA, r.requestId, 'a'.repeat(64)), fails('APPROVAL_HASH_MISMATCH'));
  const revoked = await revokeApproval(db, MOCK, as('approver'), CA, r.requestId, r.inputHash);
  assert.deepEqual([revoked.state, revoked.decision, revoked.idempotent], ['REVOKED', 'REVOKED', false]);
  const [request, approval] = [(await see.request(r.requestId))!, (await see.approval(r.requestId))!];
  assert.equal(request.terminalAt.getTime(), approval.revokedAt.getTime());
  assert.equal(approval.consumedAt, null);
  const audits = (await see.audit(r.requestId)).length;
  const again = await revokeApproval(db, MOCK, as('approver'), CA, r.requestId, r.inputHash);
  assert.deepEqual({ ...again, idempotent: false }, revoked);
  assert.equal(again.idempotent, true);
  assert.deepEqual([await see.request(r.requestId), await see.approval(r.requestId)], [request, approval], 'no mutation');
  assert.equal((await see.audit(r.requestId)).length, audits, 'no audit for the stored result');
  await assert.rejects(flow.approve(r, 'approver'), fails('APPROVAL_NOT_VALID'), 'no re-approval of a terminal request');
  await assert.rejects(flow.reserve(r), fails('APPROVAL_NOT_VALID'));
  await assert.rejects(cancelAction(db, MOCK, as('requester'), CA, r.requestId), fails('ACTION_STATE_CONFLICT'));
  assert.equal((await getAction(db, MOCK, as('reader'), CA, r.requestId)).validity, 'NOT_PENDING');
});

test('B5: only the original requester cancels before reservation (pending, or approved with its decision REVOKED); pending rejection', async () => {
  const pending = await flow.request();
  await assert.rejects(cancelAction(db, MOCK, as('requester2'), CA, pending.requestId), fails('ACTION_STATE_CONFLICT'), 'another requester');
  const cancelled = await cancelAction(db, MOCK, as('requester'), CA, pending.requestId);
  assert.deepEqual([cancelled.state, cancelled.approvalId, cancelled.idempotent], ['CANCELLED', null, false]);
  assert.equal((await cancelAction(db, MOCK, as('requester'), CA, pending.requestId)).idempotent, true);
  await assert.rejects(flow.approve(pending), fails('APPROVAL_NOT_VALID'));
  const approved = await flow.approved();
  const withDecision = await cancelAction(db, MOCK, as('requester'), CA, approved.requestId);
  assert.deepEqual([withDecision.state, withDecision.decision], ['CANCELLED', 'REVOKED']);
  const approval = (await see.approval(approved.requestId))!;
  assert.deepEqual([approval.decision, approval.revokedAt.getTime()], ['REVOKED', (await see.request(approved.requestId))!.terminalAt.getTime()]);
  assert.deepEqual((await see.audit(approved.requestId)).at(-1)!.metadata, { actionRequestId: approved.requestId, actionApprovalId: approval.id,
    requestState: 'CANCELLED', approvalDecision: 'REVOKED' });
  await assert.rejects(revokeApproval(db, MOCK, as('approver'), CA, approved.requestId, approved.inputHash), fails('APPROVAL_NOT_VALID'));
  await assert.rejects(flow.reserve(approved), fails('APPROVAL_NOT_VALID'));
  const toReject = await flow.request();
  const rejected = await rejectAction(db, MOCK, as('approver2'), CA, toReject.requestId, toReject.inputHash);
  assert.deepEqual([rejected.state, rejected.decision, rejected.expiresAt], ['REJECTED', 'REJECTED', null]);
  const decision = (await see.approval(toReject.requestId))!;
  assert.deepEqual([decision.signerActorId, decision.approvedAt, decision.expiresAt], ['approver2', null, null]);
  for (const run of [() => rejectAction(db, MOCK, as('approver2'), CA, toReject.requestId, toReject.inputHash), () => flow.approve(toReject)]) {
    await assert.rejects(run(), fails('APPROVAL_NOT_VALID'));
  }
  await assert.rejects(cancelAction(db, MOCK, as('requester'), CA, toReject.requestId), fails('ACTION_STATE_CONFLICT'));
  const approvedAgain = await flow.approved();
  await assert.rejects(rejectAction(db, MOCK, as('approver2'), CA, approvedAgain.requestId, approvedAgain.inputHash), fails('APPROVAL_NOT_VALID'),
    'an approved request is revoked by its signer or cancelled, never rejected');
  assertPublic([cancelled, withDecision, rejected, await see.audit(approved.requestId), await see.audit(toReject.requestId)], 'results and audit');
});
