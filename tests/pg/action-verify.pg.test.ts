import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { symlink } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import { executeAction } from '../../packages/actions/execution.ts';
import { claimVerification, completeVerification } from '../../packages/actions/verification.ts';
import type { TicketRecord } from '../../packages/actions/mock-port.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { CA, CB, MOCK, WA, WB, addActionFixtures, privateDir, runtimeClient, scoped } from '../support/action-fixtures.ts';
import { actionFlow, addApprovalActors, as, fails, observe, settle, waitForWaiters } from '../support/action-approval.ts';
import { openSession } from '../support/pg-race.ts';
import {
  addExecutionActors, assertNoTicketIds, auditFault, candidateFile, exec, gate, observeExec, recover, scriptedPorts, verify, writePrivate,
} from '../support/action-exec.ts';

// Stage 3 S3-C, C4/C5 on PostgreSQL 17: exact-match verification (wrong customer/title/body/marker/ID never VERIFIED; an
// ORIGINAL mismatch is non-terminal for the remaining ordinals; a CANDIDATE mismatch keeps UNKNOWN), the protected
// reconciliation file, fresh caller authority/binding/version for every new read or recovery, the three-ordinal budget
// counting initial and failed reads, one ACTIVE claim by DB constraint, the shared lock order of publication versus
// verify/recover, bounded same-fact publication retries with zero port retries, and direct runtime SQL immutability.
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
/** The first read returns `first(record)`; later reads are the real store's. */
const firstRead = (first: (r: TicketRecord) => unknown) => {
  let n = 0;
  return { read: async ({ base }: { base(): Promise<TicketRecord | null> }) => { const rec = await base(); return (n++ === 0 ? first(rec!) : rec) as TicketRecord | null; } };
};

test('C4: wrong customer/title/body/marker/ID or a missing ticket is an ORIGINAL mismatch (non-terminal); malformed replies fail; never VERIFIED', async () => {
  const mismatches: Record<string, (r: TicketRecord) => unknown> = {
    customer: r => ({ ...r, customerKey: 'cust-other' }), title: r => ({ ...r, markedTitle: r.markedTitle.replace('CANARY-title', 'CANARY-titlX') }),
    body: r => ({ ...r, description: `${r.description} ` }), 'marker removed': r => ({ ...r, markedTitle: r.markedTitle.replace(/ \[Atlas:[^\]]+\]$/, '') }),
    'other marker': r => ({ ...r, markedTitle: r.markedTitle.replace(/\[Atlas:[^\]]+\]$/, `[Atlas:${randomUUID()}]`) }),
    'other ID': r => ({ ...r, ticketId: randomUUID() }), missing: () => null,
  };
  const failures: Record<string, (r: TicketRecord) => unknown> = { 'extra field': r => ({ ...r, status: 'open' }), 'not synthetic': r => ({ ...r, synthetic: false }),
    'read exception': () => { throw new Error('CANARY read failed'); } };
  for (const [label, tamper] of Object.entries({ ...mismatches, ...failures })) {
    const r = await flow.approved();
    const { ports, calls } = scriptedPorts(db, firstRead(tamper));
    const result = await exec(db, ports, r);
    const failed = label in failures;
    assert.deepEqual([result.state, result.attemptState, result.verificationCount, result.verificationState, result.verificationCode],
      failed ? ['CREATED_UNVERIFIED', 'CREATED', 1, 'FAILED', 'ACTION_VERIFICATION_FAILED'] : ['VERIFICATION_MISMATCH', 'MISMATCH', 1, 'MISMATCH', null], label);
    assert.equal((await see.request(r.requestId))!.resultTicketId, null, label);
    const next = await verify(db, ports, r);
    assert.deepEqual([next.state, next.ordinal, next.targetKind, next.verificationResult, calls.read, calls.create], ['VERIFIED', 2, 'ORIGINAL', 'VERIFIED', 2, 1], label);
    assert.deepEqual((await see.verifications(r.requestId)).map(v => [v.ordinal, v.state, v.safeErrorCode]),
      [[1, failed ? 'FAILED' : 'MISMATCH', failed ? 'ACTION_VERIFICATION_FAILED' : null], [2, 'VERIFIED', null]], label);
  }
});

test('C4: a wrong or other-client CANDIDATE records its ordinal while UNKNOWN stays UNKNOWN; the matching candidate verifies; a known original wins', async () => {
  // Client B's own synthetic ticket (a different binding): invisible through client A's port
  const rb = await flow.request('requester', CB);
  await flow.approve(rb, 'approverB', CB);
  const b = scriptedPorts(db);
  assert.equal((await executeAction(db, MOCK, b.ports, as('executorB'), CB, rb.requestId, rb.inputHash)).state, 'VERIFIED');
  const [bTicket] = await observeExec(runtime, CB).tickets(rb.requestId);

  const r = await flow.approved();
  const { ports, calls } = scriptedPorts(db, { create: async ({ base }) => { await base(); throw new Error('CANARY lost response'); } });
  assert.equal((await exec(db, ports, r)).state, 'OUTCOME_UNKNOWN');
  const [ticket] = await see.tickets(r.requestId);
  for (const [ordinal, candidate] of [[1, randomUUID()], [2, bTicket!]] as const) {
    const v = await verify(db, ports, r, 'executor', await candidateFile(files, r.requestId, candidate));
    assert.deepEqual([v.state, v.attemptState, v.ordinal, v.targetKind, v.verificationResult, v.verificationState], ['OUTCOME_UNKNOWN', 'UNKNOWN', ordinal, 'CANDIDATE', 'MISMATCH', 'MISMATCH']);
  }
  const ok = await verify(db, ports, r, 'executor', await candidateFile(files, r.requestId, ticket!));
  assert.deepEqual([ok.state, ok.ordinal, ok.verificationCount], ['VERIFIED', 3, 3]);
  assert.equal((await see.request(r.requestId))!.resultTicketId, ticket, 'the private result ID is set once, by the verification only');
  assertNoTicketIds([ok, await see.audit(r.requestId)], [ticket!, bTicket!], 'candidate IDs stay out of results and audit');
  assert.deepEqual(calls, { create: 1, read: 3 });

  // A known original ID can never be replaced by a candidate: refused, nothing consumed, no read
  const known = await flow.approved();
  const k = scriptedPorts(db, { read: async () => { throw new Error('CANARY'); } });
  assert.equal((await exec(db, k.ports, known)).state, 'CREATED_UNVERIFIED');
  await assert.rejects(verify(db, k.ports, known, 'executor', await candidateFile(files, known.requestId, randomUUID())), fails('ACTION_STATE_CONFLICT'));
  assert.deepEqual([(await see.attempt(known.requestId))!.verificationCount, k.calls.read], [1, 1]);
});

test('C7: the reconciliation file is protected, exact and never echoed; any defect is ACTION_INPUT_INVALID before admission', async () => {
  const r = await flow.approved();
  const { ports, calls } = scriptedPorts(db, { create: async ({ base }) => { await base(); throw new Error('lost'); } });
  await exec(db, ports, r);
  const candidate = randomUUID();
  const bad: Record<string, () => Promise<string>> = {
    'other request': () => candidateFile(files, randomUUID(), candidate), 'extra field': () => candidateFile(files, r.requestId, candidate, { note: 'x' }),
    'wrong kind': () => files.input({ kind: 'STORED_ACTION_PREVIEW', dto: 'action-candidate/1', requestId: r.requestId, candidateTicketId: candidate }),
    'wrong dto': () => files.input({ kind: 'ACTION_RECONCILIATION_CANDIDATE', dto: 'action-candidate/2', requestId: r.requestId, candidateTicketId: candidate }),
    'malformed candidate': () => candidateFile(files, r.requestId, 'bad id with spaces'), 'not JSON': async () => { const p = files.out('cand-raw.json'); await writePrivate(p, '{'); return p; },
    'mode 0644': async () => { const p = files.out('cand-0644.json'); await writePrivate(p, JSON.stringify({ kind: 'ACTION_RECONCILIATION_CANDIDATE', dto: 'action-candidate/1',
      requestId: r.requestId, candidateTicketId: candidate }), 0o644); return p; },
    symlink: async () => { const target = await candidateFile(files, r.requestId, candidate); const p = files.out('cand-link.json'); await symlink(target, p); return p; },
    'relative path': async () => 'candidate.json', oversized: () => candidateFile(files, r.requestId, candidate, { pad: 'x'.repeat(2000) }),
  };
  for (const [label, make] of Object.entries(bad)) {
    const outcome = await settle(verify(db, ports, r, 'executor', await make()));
    assert.equal(outcome, 'ACTION_INPUT_INVALID', label);
  }
  assert.deepEqual([(await see.attempt(r.requestId))!.verificationCount, calls.read], [0, 0], 'no claim, no read');
});

test('C4/B1: every new read or recovery needs fresh context:read + actions:read + actions:execute on one membership; denials audited once', async () => {
  const r = await flow.approved();
  const { ports, calls } = scriptedPorts(db, { read: async () => { throw new Error('CANARY'); } });
  await exec(db, ports, r);
  const before = (await observe(runtime).security()).length;
  for (const [actor, code] of [['executeOnly', 'PERMISSION_DENIED'], ['executeNoRead', 'PERMISSION_DENIED'], ['reader', 'PERMISSION_DENIED'],
    ['approver', 'PERMISSION_DENIED'], ['executorB', 'SCOPE_DENIED']] as const) {
    await assert.rejects(verify(db, ports, r, actor), fails(code), actor);
    await assert.rejects(recover(db, r, actor), fails(code), actor);
  }
  const security = (await observe(runtime).security()).slice(before);
  assert.equal(security.length, 10, 'exactly one workspace denial per refused command');
  assert.ok(security.every(s => s.requestedClientId === CA && ['action.verify_denied', 'action.recover_denied'].includes(s.eventType)));
  await assert.rejects(verify(db, ports, r, 'outsider'), fails('SCOPE_DENIED'));
  assert.equal((await observe(runtime).security(WB)).at(-1)!.eventType, 'action.verify_denied', 'the other workspace audits its own denial');
  assert.deepEqual([(await see.attempt(r.requestId))!.verificationCount, calls.read], [1, 1], 'no denied command claimed or read');
});

test('C4: deployed version drift after reservation refuses new reads and recovery, preserving the stored outcome', async () => {
  const source = await flow.request();
  const id = (await owner.query(`SELECT gen_random_uuid()::text AS id`)).rows[0].id as string;
  // Owner (superuser) copy of a stored request with a drifted immutable policy version, carried to CREATED_UNVERIFIED
  await owner.query(`INSERT INTO "ActionRequest" ("workspaceId","clientId",id,"connectionId","requesterActorId","requesterTokenId","requesterTokenExpiresAt",
      "idempotencyKey","intentHash","dtoVersion","actionType","actionVersion","policyVersion","portVersion",mode,"connectionSystem","customerKey",
      "connectionLifecycleVersion","secretRefDigest","authorityEpoch","markedTitle",description,marker,"canonicalInput","inputHash","createdAt","updatedAt")
    SELECT "workspaceId","clientId",$2::text::uuid,"connectionId","requesterActorId","requesterTokenId","requesterTokenExpiresAt",gen_random_uuid(),"intentHash",
      "dtoVersion","actionType","actionVersion",'atlas-action-policy/0',"portVersion",mode,"connectionSystem","customerKey","connectionLifecycleVersion",
      "secretRefDigest","authorityEpoch",replace("markedTitle", id::text, $2::text),description,'[Atlas:' || $2::text || ']',
      "canonicalInput" || jsonb_build_object('requestId', $2::text, 'title', replace("markedTitle", id::text, $2::text), 'policyVersion', 'atlas-action-policy/0'),
      "inputHash","createdAt","updatedAt" FROM "ActionRequest" WHERE id = $1::uuid`, [source.requestId, id]);
  const now = `date_trunc('milliseconds', now() AT TIME ZONE 'UTC')`;
  await owner.query(`INSERT INTO "ActionApproval" ("workspaceId","clientId",id,"requestId","requesterActorId","requestHash","authorityEpoch","actionVersion",
      "policyVersion","portVersion",mode,"signerActorId","signerTokenId",decision,"decidedAt","approvedAt","expiresAt")
    SELECT "workspaceId","clientId",gen_random_uuid(),id,"requesterActorId","inputHash","authorityEpoch","actionVersion","policyVersion","portVersion",mode,
      'approver','tok-approver','APPROVED',${now},${now},${now} + interval '10 minutes' FROM "ActionRequest" WHERE id = $1::uuid`, [id]);
  await owner.query(`UPDATE "ActionRequest" SET state = 'APPROVED' WHERE id = $1::uuid`, [id]);
  await owner.query(`UPDATE "ActionApproval" SET decision = 'CONSUMED', "consumedAt" = ${now} WHERE "requestId" = $1::uuid`, [id]);
  await owner.query(`INSERT INTO "ActionAttempt" ("workspaceId","clientId",id,"requestId","approvalId","attemptToken","createNonce","reservedAt","startDeadlineAt")
    SELECT "workspaceId","clientId",gen_random_uuid(),"requestId",id,gen_random_uuid(),gen_random_uuid(),${now},${now} + interval '4 seconds'
      FROM "ActionApproval" WHERE "requestId" = $1::uuid`, [id]);
  await owner.query(`UPDATE "ActionRequest" SET state = 'DISPATCH_RESERVED' WHERE id = $1::uuid`, [id]);
  await owner.query(`UPDATE "ActionAttempt" SET state = 'CREATED', "originalTicketId" = 'T-drift', "outcomeAt" = ${now} WHERE "requestId" = $1::uuid`, [id]);
  await owner.query(`UPDATE "ActionRequest" SET state = 'CREATED_UNVERIFIED' WHERE id = $1::uuid`, [id]);
  const drifted = { requestId: id, inputHash: source.inputHash, inputPreview: '' };
  const { ports, calls } = scriptedPorts(db);
  await assert.rejects(verify(db, ports, drifted), fails('ACTION_CONTRACT_VERSION_CHANGED'));
  await assert.rejects(recover(db, drifted), fails('ACTION_CONTRACT_VERSION_CHANGED'));
  const attempt = (await see.attempt(id))!;
  assert.deepEqual([(await see.request(id))!.state, attempt.state, attempt.verificationCount, calls.read], ['CREATED_UNVERIFIED', 'CREATED', 0, 0]);
});

test('C5: the budget of three counts the initial and failed reads; a fourth is ACTION_VERIFICATION_BUDGET; the outcome is preserved', async () => {
  const r = await flow.approved();
  const { ports, calls } = scriptedPorts(db, { read: async () => { throw new Error('CANARY read down'); } });
  const result = await exec(db, ports, r);
  assert.deepEqual([result.state, result.verificationCount, result.verificationCode], ['CREATED_UNVERIFIED', 1, 'ACTION_VERIFICATION_FAILED']);
  for (const ordinal of [2, 3]) {
    const v = await verify(db, ports, r);
    assert.deepEqual([v.ordinal, v.verificationResult, v.state, v.verificationCount], [ordinal, 'FAILED', 'CREATED_UNVERIFIED', ordinal]);
  }
  await assert.rejects(verify(db, ports, r), fails('ACTION_VERIFICATION_BUDGET'));
  assert.deepEqual([calls.create, calls.read], [1, 3]);
  const attempt = (await see.attempt(r.requestId))!;
  assert.deepEqual([attempt.verificationCount, attempt.verificationSeq, attempt.verificationState, attempt.state], [3, 3, 'FAILED', 'CREATED']);
  assert.equal((await recover(db, r)).recovered, 'NONE', 'recovery never resets the budget');
  assert.deepEqual((await see.audit(r.requestId)).filter(a => a.metadata.safeErrorCode === 'ACTION_VERIFICATION_BUDGET').length, 1);
});

test('C5: one ACTIVE claim — concurrent verifies get BUSY, the DB refuses a second ACTIVE row; direct runtime SQL stays scoped and immutable', async () => {
  const r = await flow.approved();
  const held = gate<void>();
  let reads = 0;
  const { ports } = scriptedPorts(db, { read: async ({ base }) => { if (++reads === 1) throw new Error('first read fails'); held.arrive(); await held.promise; return base(); } });
  await exec(db, ports, r);
  const pending = [verify(db, ports, r), verify(db, ports, r)].map(settle);
  await held.reached;
  // The verify that did not claim settles while the claimant's read is still held: it must be BUSY (never a second claim)
  assert.equal(await Promise.race(pending), 'ACTION_VERIFICATION_BUSY', 'the fence serializes the claims: one claims, the other is BUSY');
  const direct = async (sql: string, pattern: RegExp | null, client = CA) => {
    await runtime.query('BEGIN');
    try {
      await runtime.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true)`, [WA, client]);
      const params = sql.includes('$1') ? [r.requestId] : [];
      if (pattern) await assert.rejects(runtime.query(sql, params), pattern, sql);
      else return (await runtime.query(sql, params)).rowCount;
    } finally { await runtime.query('ROLLBACK'); }
    return null;
  };
  const attemptOf = `(SELECT id FROM "ActionAttempt" WHERE "requestId" = $1::uuid)`;
  await direct(`INSERT INTO "ActionVerification" ("workspaceId","clientId","attemptId",ordinal,"targetKind",nonce,"targetTicketId","requestHash","createNonce","startedAt","deadlineAt")
    SELECT "workspaceId","clientId",id,3,'ORIGINAL',gen_random_uuid(),'T-x',(SELECT "inputHash" FROM "ActionRequest" WHERE id = $1::uuid),"createNonce",
      date_trunc('milliseconds', now()),date_trunc('milliseconds', now()) + interval '35 seconds' FROM "ActionAttempt" WHERE "requestId" = $1::uuid`, /ActionVerification_one_active/);
  await direct(`UPDATE "ActionAttempt" SET state = 'RESERVED' WHERE "requestId" = $1::uuid`, /ACTION_LIFECYCLE_INVALID/);
  await direct(`UPDATE "ActionAttempt" SET "verificationCount" = 1, "verificationSeq" = 1 WHERE "requestId" = $1::uuid`, /ACTION_LIFECYCLE_INVALID/); // no refund
  await direct(`UPDATE "ActionAttempt" SET "originalTicketId" = 'T-other' WHERE "requestId" = $1::uuid`, /ACTION_HISTORY_IMMUTABLE/);
  await direct(`UPDATE "ActionVerification" SET state = 'ACTIVE', "completedAt" = NULL WHERE ordinal = 1 AND "attemptId" = ${attemptOf}`, /ACTION_LIFECYCLE_INVALID|ACTION_HISTORY_IMMUTABLE/);
  await direct(`UPDATE "ActionVerification" SET nonce = gen_random_uuid() WHERE "attemptId" = ${attemptOf}`, /permission denied/);
  await direct(`INSERT INTO "ActionMockTicket" ("workspaceId","clientId","connectionId",id,synthetic,"customerKey","markedTitle",description)
    VALUES ('${WA}','${CA}','atera-a',gen_random_uuid(),'LIVE','c','t','d')`, /ActionMockTicket_content_check/);
  await direct(`INSERT INTO "ActionMockTicket" ("workspaceId","clientId","connectionId",id,"customerKey","markedTitle",description)
    VALUES ('${WA}','${CB}','atera-b',gen_random_uuid(),'c','t','d')`, /row-level security/);
  assert.equal(await direct(`UPDATE "ActionAttempt" SET "updatedAt" = "updatedAt" WHERE "requestId" = $1::uuid`, null, CB), 0, 'another client sees no row');
  held.release();
  const outcomes = await Promise.all(pending);
  const busy = outcomes.filter(o => o === 'ACTION_VERIFICATION_BUSY');
  const done = outcomes.filter(o => typeof o === 'object') as { state: string; ordinal: number }[];
  assert.deepEqual([busy.length, done.length, done[0]!.state, done[0]!.ordinal], [1, 1, 'VERIFIED', 2], 'the fence serializes the claims: one claims, the other is BUSY');
});

test('C5: a publication and verify/recover share the lock order (request → attempt → ordinal; no fence for publications): queued, no deadlock', async () => {
  const r = await flow.approved();
  let reads = 0;
  const { ports } = scriptedPorts(db, { read: async ({ base }) => (++reads === 1 ? null : base()) });
  assert.equal((await exec(db, ports, r)).state, 'VERIFICATION_MISMATCH');
  const claimed = await claimVerification(db, MOCK, as('executor'), CA, r.requestId, null);
  assert.ok('claim' in claimed);
  const holder = await openSession(pgdb.runtimeUrl);
  await holder.client.query('BEGIN');
  await holder.client.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true)`, [WA, CA]);
  await holder.client.query(`SELECT 1 FROM "ActionRequest" WHERE id = $1 FOR UPDATE`, [r.requestId]);
  const publication = settle(completeVerification(db, ports, claimed.claim));
  await waitForWaiters(owner, 1);
  const recovery = settle(recover(db, r));
  const second = settle(verify(db, ports, r, 'executor2'));
  await waitForWaiters(owner, 3);
  await holder.client.query('ROLLBACK'); await holder.client.end();
  const [p, rec, v] = await Promise.all([publication, recovery, second]) as [{ verificationResult: string; state: string }, { recovered: string }, { idempotent: boolean; state: string }];
  assert.deepEqual([p.verificationResult, p.state, rec.recovered, v.state, v.idempotent], ['VERIFIED', 'VERIFIED', 'NONE', 'VERIFIED', true]);
});

test('C5: a known rollback (40001/40P01) re-runs the SAME publication at most three times, never the port; exhaustion keeps the prior state', async () => {
  const cases: [event: string, times: number, errcode: string, expect: string][] = [
    ['action.created', 2, '40001', 'VERIFIED'], ['action.created', 3, '40001', 'ACTION_PUBLICATION_CONFLICT'],
    ['action.verified', 2, '40P01', 'VERIFIED'], ['action.verified', 3, '40001', 'CREATED_UNVERIFIED'],
  ];
  for (const [event, times, errcode, expect] of cases) {
    const r = await flow.approved();
    const { ports, calls } = scriptedPorts(db);
    const fault = await auditFault(owner, event, times, errcode);
    let outcome;
    try { outcome = await settle(exec(db, ports, r)); } finally { await fault.remove(); }
    const label = `${event} ×${times} ${errcode}`;
    assert.deepEqual([calls.create, calls.read], [1, event === 'action.created' && times === 3 ? 0 : 1], `${label}: zero port retries`);
    const events = (await see.audit(r.requestId)).map(a => a.eventType);
    if (expect === 'ACTION_PUBLICATION_CONFLICT') {
      assert.equal(outcome, expect, label);
      assert.deepEqual([(await see.attempt(r.requestId))!.state, events.includes('action.created')], ['RESERVED', false], `${label}: recovery-safe prior state`);
    } else {
      const result = outcome as { state: string; verificationCode: string | null };
      assert.equal(result.state, expect, label);
      assert.equal(events.filter(e => e === event).length, expect === 'VERIFIED' ? 1 : 0, `${label}: one audit row per committed fact`);
      if (expect === 'CREATED_UNVERIFIED') {
        assert.deepEqual([result.verificationCode, (result as unknown as { verificationState: string }).verificationState], ['ACTION_PUBLICATION_CONFLICT', 'ACTIVE']);
        assert.deepEqual((await see.verifications(r.requestId)).map(v => v.state), ['ACTIVE'], `${label}: the claim stays for explicit recovery`);
      }
    }
  }
});
