import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
import { AtlasError } from '../../packages/core/contracts.ts';
import { deriveRequestId } from '../../packages/actions/canonical.ts';
import { actionCredential } from '../../packages/actions/authority.ts';
import { getAction, previewAction, requestAction } from '../../packages/actions/requests.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { CA, CB, MOCK, WA, WB, addActionFixtures, fenceVersion, privateDir, runtimeClient, scoped, tokens } from '../support/action-fixtures.ts';

// Stage 3 S3-A, A1 and A4 on PostgreSQL 17: the immutable signer snapshot (token ROW ID + exact expiry) with the epoch proof
// (any auth/binding mutation moves the epoch for good; natural expiry needs no mutation), scoped FKs and two-workspace RLS,
// direct-SQL immutability of every action row (later-stage tables included), referenced tokens never deleted, accepted
// ApiToken policy/grants unchanged, and a derived-ID collision refused rather than adopted.
const pgdb = await createTestDatabase();
const db = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
const runtime = await runtimeClient(pgdb.runtimeUrl);
const files = await privateDir();
after(async () => { await runtime.end(); await db.$disconnect(); await files.remove(); await pgdb.drop(); });
await addActionFixtures(pgdb.owner);
const owner = pgdb.owner;
const fails = (code: string) => (e: unknown) => e instanceof AtlasError && e.code === code;
const as = (actor: string) => actionCredential(tokens[actor]!);
const key = (n: number) => `${String(n).padStart(8, '0')}-aaaa-4bbb-8ccc-dddddddddddd`;
let out = 0;
async function create(n: number, actor = 'requester', client = CA, connectionId = client === CA ? 'atera-a' : 'atera-b') {
  const input = await files.input({ connectionId, title: `Signed ${n}`, description: 'Body', idempotencyKey: key(n) });
  const p = await previewAction(db, MOCK, as(actor), client, input, files.out(`p-${++out}.json`));
  return requestAction(db, MOCK, as(actor), client, input, p.inputHash);
}
/** Owner (superuser) copy of a stored request under a new ID, consistent with every CHECK, with selected bindings replaced. */
const clone = (source: string, o: { id?: string; key?: string; workspaceId?: string; clientId?: string; connectionId?: string; tokenId?: string } = {}) => {
  const id = o.id ? `'${o.id}'::text` : 'n.id';
  const v = (value: string | undefined, column: string) => value === undefined ? `r."${column}"` : `'${value}'`;
  const title = `replace(r."markedTitle", r.id::text, ${id})`;
  return owner.query(`WITH n AS (SELECT gen_random_uuid()::text AS id)
    INSERT INTO "ActionRequest" SELECT ${v(o.workspaceId, 'workspaceId')}, ${v(o.clientId, 'clientId')}, (${id})::uuid, ${v(o.connectionId, 'connectionId')},
      r."requesterActorId", ${v(o.tokenId, 'requesterTokenId')}, r."requesterTokenExpiresAt", ${o.key ? `'${o.key}'::uuid` : 'gen_random_uuid()'}, r."intentHash",
      r."dtoVersion", r."actionType", r."actionVersion", r."policyVersion", r."portVersion", r.mode, r."connectionSystem", r."customerKey",
      r."connectionLifecycleVersion", r."secretRefDigest", r."authorityEpoch", ${title}, r.description, '[Atlas:' || ${id} || ']',
      r."canonicalInput" || jsonb_build_object('requestId', ${id}, 'title', ${title}, 'workspaceId', ${v(o.workspaceId, 'workspaceId')}, 'clientId',
        ${v(o.clientId, 'clientId')}, 'connectionId', ${v(o.connectionId, 'connectionId')}, 'requesterTokenId', ${v(o.tokenId, 'requesterTokenId')}),
      r."inputHash", 'AWAITING_APPROVAL', NULL, NULL, r."createdAt", r."updatedAt", NULL
    FROM "ActionRequest" r, n WHERE r.id = '${source}'`);
};
const row = async (id: string, client = CA) => (await scoped<Record<string, any>>(runtime, WA, client, `SELECT * FROM "ActionRequest" WHERE id = $1`, [id]))[0]!;
const validity = async (id: string) => (await getAction(db, MOCK, as('reader'), CA, id)).validity;
const refused = async (sql: string, pattern: RegExp, params: unknown[] = []) => {
  await owner.query('BEGIN');
  try { await assert.rejects(owner.query(sql, params), pattern, sql); } finally { await owner.query('ROLLBACK'); }
};

test('signer snapshot: the token ROW ID and exact expiry are captured; natural expiry is visible without any mutation; every later mutation moves the epoch for good', async () => {
  await owner.query(`UPDATE "ApiToken" SET "expiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') + interval '3 seconds' WHERE id = 'tok-requester'`);
  const r = await create(1);
  const stored = await row(r.requestId);
  const token = (await owner.query(`SELECT "expiresAt" FROM "ApiToken" WHERE id = 'tok-requester'`)).rows[0];
  assert.deepEqual([stored.requesterTokenId, stored.requesterTokenExpiresAt?.getTime()], ['tok-requester', token.expiresAt.getTime()]);
  assert.equal(await validity(r.requestId), 'CURRENT');
  const epoch = await fenceVersion(runtime, WA);
  const remaining = (await owner.query(`SELECT greatest(0, extract(epoch FROM "expiresAt" - (clock_timestamp() AT TIME ZONE 'UTC')) * 1000)::int AS ms
    FROM "ApiToken" WHERE id = 'tok-requester'`)).rows[0].ms as number;
  assert.ok(remaining > 0, 'the request was signed before the token expired');
  await sleep(remaining + 300);
  assert.equal(await validity(r.requestId), 'SIGNER_EXPIRED', 'DB clock passed the snapshot; nothing was mutated');
  assert.equal(await fenceVersion(runtime, WA), epoch);
  await assert.rejects(create(2), fails('ACTION_AUTHENTICATION_FAILED'), 'the expired token itself no longer authenticates');
  await owner.query(`UPDATE "ApiToken" SET "expiresAt" = NULL WHERE id = 'tok-requester'`); // extension: a mutation
  assert.equal(await validity(r.requestId), 'AUTHORITY_CHANGED', 'an expiry extension cannot renew the old intent');
  assert.equal((await row(r.requestId)).requesterTokenExpiresAt?.getTime(), token.expiresAt.getTime(), 'the snapshot never changes');
  const mutations = [
    `UPDATE "ClientMembership" SET permissions = permissions WHERE "actorId" = 'split' AND "clientId" = '${CA}'`,
    `DELETE FROM "ClientMembership" WHERE "actorId" = 'split' AND "clientId" = '${CB}'`,
    `INSERT INTO "ClientMembership" ("workspaceId","clientId","actorId",permissions) VALUES ('${WA}','${CB}','split',ARRAY['actions:request'])`,
    `UPDATE "Actor" SET status = 'DISABLED' WHERE "workspaceId" = '${WA}' AND id = 'contextOnly'`,
    `UPDATE "Actor" SET status = 'ACTIVE' WHERE "workspaceId" = '${WA}' AND id = 'contextOnly'`,
    `UPDATE "Connection" SET "secretRef" = "secretRef" WHERE id = 'atera-a'`,
  ];
  for (const sql of mutations) {
    const fresh = await create(10 + mutations.indexOf(sql));
    assert.equal(await validity(fresh.requestId), 'CURRENT');
    const before = await fenceVersion(runtime, WA) as number;
    await owner.query(sql);
    assert.ok((await fenceVersion(runtime, WA) as number) > before, sql);
    assert.equal(await validity(fresh.requestId), 'AUTHORITY_CHANGED', `${sql}: the unreserved request is stale`);
  }
  assert.equal(await validity(r.requestId), 'AUTHORITY_CHANGED', 'restoring every earlier value never revives an old epoch');
  const other = await fenceVersion(runtime, WB);
  await owner.query(`UPDATE "Actor" SET "displayName" = "displayName" WHERE "workspaceId" = '${WB}'`);
  const latest = await create(20);
  assert.ok((await fenceVersion(runtime, WB) as number) > (other as number));
  assert.equal(await validity(latest.requestId), 'CURRENT', 'another workspace\'s mutation does not touch this epoch');
});

test('A1: action rows follow workspace and client scope for the runtime; every link is a scoped composite FK', async () => {
  const a = await create(30); const b = await create(31, 'requester', CB);
  assert.deepEqual((await scoped(runtime, WA, CA, `SELECT id FROM "ActionRequest" WHERE id IN ($1, $2)`, [a.requestId, b.requestId])).map(r => r.id), [a.requestId]);
  assert.deepEqual((await scoped(runtime, WA, CB, `SELECT id FROM "ActionRequest" WHERE id IN ($1, $2)`, [a.requestId, b.requestId])).map(r => r.id), [b.requestId]);
  assert.deepEqual(await scoped(runtime, WB, CA, `SELECT id FROM "ActionRequest"`), [], 'a client ID of another workspace');
  assert.deepEqual(await scoped(runtime, '', '', `SELECT id FROM "ActionRequest"`), [], 'blank scope');
  const attempt = async (o: Parameters<typeof clone>[1], pattern: RegExp) => {
    await owner.query('BEGIN');
    try { await assert.rejects(clone(a.requestId, o), pattern, JSON.stringify(o)); } finally { await owner.query('ROLLBACK'); }
  };
  await owner.query('BEGIN'); await clone(a.requestId); await owner.query('ROLLBACK'); // the consistent copy itself is accepted
  await attempt({ connectionId: 'atera-b' }, /ActionRequest_connection_fkey/);                       // a connection of another client
  await attempt({ tokenId: 'tok-reader' }, /ActionRequest_requesterToken_fkey/);                   // another actor's token row
  await attempt({ workspaceId: WB, clientId: 'act-client-x', connectionId: 'atera-x' }, /ActionRequest_requesterToken_fkey/); // actor of another workspace
  await runtime.query('BEGIN');
  await runtime.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true)`, [WA, CB]);
  assert.equal((await runtime.query(`SELECT count(*)::int AS n FROM "ActionRequest" WHERE id = $1`, [a.requestId])).rows[0].n, 0, 'client A row invisible from B');
  await runtime.query('SAVEPOINT s');
  await assert.rejects(runtime.query(`INSERT INTO "ActionRequest" ("workspaceId","clientId",id,"connectionId","requesterActorId","requesterTokenId","idempotencyKey",
      "intentHash","dtoVersion","actionType","actionVersion","policyVersion","portVersion",mode,"connectionSystem","customerKey","connectionLifecycleVersion",
      "secretRefDigest","authorityEpoch","markedTitle",description,marker,"canonicalInput","inputHash")
    VALUES ('${WA}','${CA}',gen_random_uuid(),'atera-a','requester','tok-requester',gen_random_uuid(),'x','x','x','x','x','x','MOCK','atera','c',0,'x',0,'t','d','m','{}','x')`),
    /row-level security/, 'a write into another client of the scope');
  await runtime.query('ROLLBACK TO SAVEPOINT s');
  await assert.rejects(runtime.query(`INSERT INTO "ActionAuthorityFence" ("workspaceId", version) VALUES ('${WA}', 0)`), /permission denied/);
  await runtime.query('ROLLBACK');
});

test('A4: direct SQL cannot change immutable request/approval/attempt/verification/mock fields; lifecycle and self-approval are refused; runtime writes only lifecycle columns', async () => {
  const r = await create(40);
  const s = await row(r.requestId);
  const q = (sql: string) => sql.replaceAll(':id', `'${r.requestId}'`);
  for (const sql of [`UPDATE "ActionRequest" SET "markedTitle" = 'x [Atlas:' || id || ']' WHERE id = :id`, `UPDATE "ActionRequest" SET "authorityEpoch" = 0 WHERE id = :id`,
    `UPDATE "ActionRequest" SET "canonicalInput" = "canonicalInput" || '{"x":1}' WHERE id = :id`, `UPDATE "ActionRequest" SET "requesterTokenId" = 'tok-requester2' WHERE id = :id`,
    `UPDATE "ActionRequest" SET "requesterTokenExpiresAt" = now() WHERE id = :id`, `UPDATE "ActionRequest" SET "inputHash" = repeat('0', 64) WHERE id = :id`,
    `DELETE FROM "ActionRequest" WHERE id = :id`, `TRUNCATE "ActionRequest" CASCADE`]) {
    await refused(q(sql), /ACTION_HISTORY_IMMUTABLE|check constraint/);
  }
  await refused(q(`UPDATE "ActionRequest" SET state = 'DISPATCH_RESERVED' WHERE id = :id`), /ACTION_LIFECYCLE_INVALID/);
  const approval = (signer: string, extra: Partial<Record<'hash' | 'expires' | 'cap', string>> = {}) => `INSERT INTO "ActionApproval" ("workspaceId","clientId",id,"requestId",
    "requesterActorId","requestHash","authorityEpoch","actionVersion","policyVersion","portVersion",mode,"signerActorId","signerTokenId","approverTokenExpiresAt",
    decision,"decidedAt","approvedAt","expiresAt") VALUES ('${WA}','${CA}',gen_random_uuid(),'${r.requestId}','requester','${extra.hash ?? s.inputHash}',${s.authorityEpoch},
    '${s.actionVersion}','${s.policyVersion}','${s.portVersion}','MOCK','${signer}','tok-${signer}',${extra.cap ?? 'NULL'},'APPROVED',now(),now(),now() + interval '${extra.expires ?? '10 minutes'}')
    RETURNING id`;
  await refused(approval('requester'), /ActionApproval_contract_check/, []);
  await refused(approval('approver', { hash: '0'.repeat(64) }), /foreign key/);
  await refused(approval('approver', { expires: '16 minutes' }), /ActionApproval_lifetime_check/);
  await refused(approval('approver', { cap: `now() + interval '5 minutes'` }), /ActionApproval_lifetime_check/);
  await refused(approval('approver').replace(`now() + interval '10 minutes')`, `NULL)`), /ActionApproval_lifetime_check/); // approved without expiry
  const approvalId = (await owner.query(approval('approver'))).rows[0].id;
  await refused(`UPDATE "ActionApproval" SET "requestHash" = repeat('1', 64) WHERE id = $1`, /ACTION_HISTORY_IMMUTABLE|foreign key/, [approvalId]);
  await refused(`UPDATE "ActionApproval" SET "expiresAt" = "expiresAt" + interval '1 minute' WHERE id = $1`, /ACTION_HISTORY_IMMUTABLE/, [approvalId]);
  await refused(`UPDATE "ActionApproval" SET decision = 'REJECTED', "approvedAt" = NULL, "expiresAt" = NULL WHERE id = $1`, /ACTION_HISTORY_IMMUTABLE|ACTION_LIFECYCLE_INVALID/, [approvalId]);
  const attempt = (extra = `now() + interval '4 seconds'`) => `INSERT INTO "ActionAttempt" ("workspaceId","clientId",id,"requestId","approvalId","attemptToken","createNonce",
    "reservedAt","startDeadlineAt") VALUES ('${WA}','${CA}',gen_random_uuid(),'${r.requestId}','${approvalId}',gen_random_uuid(),gen_random_uuid(),now(),${extra}) RETURNING id, "createNonce"`;
  await refused(attempt(`now() + interval '6 seconds'`), /ActionAttempt_contract_check/);
  const att = (await owner.query(attempt())).rows[0];
  await refused(attempt(), /ActionAttempt_request_key|duplicate key/);
  await refused(`UPDATE "ActionAttempt" SET "createNonce" = gen_random_uuid() WHERE id = $1`, /ACTION_HISTORY_IMMUTABLE|foreign key/, [att.id]);
  await refused(`UPDATE "ActionAttempt" SET "verificationCount" = 2, "verificationSeq" = 2 WHERE id = $1`, /ACTION_LIFECYCLE_INVALID/, [att.id]);
  await owner.query(`UPDATE "ActionAttempt" SET state = 'UNKNOWN' WHERE id = $1`, [att.id]);
  await refused(`UPDATE "ActionAttempt" SET state = 'RESERVED' WHERE id = $1`, /ACTION_LIFECYCLE_INVALID/, [att.id]);
  // F3: an ACTIVE claim needs EVERY mandatory field (token, ordinal, startedAt, deadline); each absent field alone is refused,
  // and stray claim fields outside ACTIVE too. CHECKs must never pass by evaluating to SQL NULL.
  const full: Record<string, string> = { "verificationCount": '1', "verificationSeq": '1', "verificationState": `'ACTIVE'`,
    "activeVerificationToken": 'gen_random_uuid()', "activeVerificationOrdinal": '1', "activeStartedAt": `date_trunc('milliseconds', now())`,
    "activeDeadlineAt": `date_trunc('milliseconds', now()) + interval '35 seconds'` };
  const claim = (changes: Record<string, string>) => `UPDATE "ActionAttempt" SET ${Object.entries({ ...full, ...changes })
    .map(([c, v]) => `"${c}" = ${v}`).join(', ')} WHERE id = '${att.id}'`;
  for (const missing of ['activeVerificationToken', 'activeVerificationOrdinal', 'activeStartedAt', 'activeDeadlineAt']) {
    await refused(claim({ [missing]: 'NULL' }), /ActionAttempt_claim_check/, []);
  }
  for (const changes of Object.values({
    'ordinal 0': { activeVerificationOrdinal: '0' }, 'ordinal above the consumed count': { activeVerificationOrdinal: '2' },
    'deadline other than startedAt + 35 s': { activeDeadlineAt: `date_trunc('milliseconds', now()) + interval '36 seconds'` },
    'malformed candidate': { activeCandidateId: `'bad id'` },
    'stray ordinal while not ACTIVE': { verificationState: `'FAILED'`, activeVerificationToken: 'NULL', activeStartedAt: 'NULL', activeDeadlineAt: 'NULL' },
    'stray deadline while not ACTIVE': { verificationState: `'FAILED'`, activeVerificationToken: 'NULL', activeVerificationOrdinal: 'NULL', activeStartedAt: 'NULL' },
  } as Record<string, Record<string, string>>)) {
    await refused(claim(changes), /ActionAttempt_claim_check/, []);
  }
  await owner.query(claim({ activeCandidateId: `'T-1'` })); // the fully populated claim is accepted
  const active = await scoped<Record<string, unknown>>(runtime, WA, CA, `SELECT "verificationState", "activeVerificationOrdinal" AS ord
    FROM "ActionAttempt" WHERE id = $1`, [att.id]);
  assert.deepEqual([active[0]!.verificationState, active[0]!.ord], ['ACTIVE', 1]);
  await owner.query(`UPDATE "ActionAttempt" SET "verificationState" = 'FAILED', "activeVerificationToken" = NULL, "activeVerificationOrdinal" = NULL,
    "activeStartedAt" = NULL, "activeDeadlineAt" = NULL, "activeCandidateId" = NULL WHERE id = $1`, [att.id]);
  const verification = (ordinal: number, nonce = att.createNonce) => `INSERT INTO "ActionVerification" ("workspaceId","clientId","attemptId",ordinal,"targetKind",nonce,
    "targetTicketId","requestHash","createNonce","startedAt","deadlineAt") VALUES ('${WA}','${CA}','${att.id}',${ordinal},'CANDIDATE',gen_random_uuid(),'T-1',
    '${s.inputHash}','${nonce}',date_trunc('milliseconds', now()),date_trunc('milliseconds', now()) + interval '35 seconds')`;
  await refused(verification(1, '00000000-0000-4000-8000-000000000000'), /foreign key/);
  await refused(verification(4), /ActionVerification_contract_check/);
  await owner.query(verification(1));
  await refused(verification(2), /ActionVerification_one_active|duplicate key/);
  await owner.query(`UPDATE "ActionVerification" SET state = 'FAILED', "completedAt" = now() WHERE "attemptId" = $1 AND ordinal = 1`, [att.id]);
  await refused(`UPDATE "ActionVerification" SET state = 'ACTIVE', "completedAt" = NULL WHERE "attemptId" = $1`, /ACTION_LIFECYCLE_INVALID|ACTION_HISTORY_IMMUTABLE/, [att.id]);
  await refused(`UPDATE "ActionVerification" SET "targetTicketId" = 'T-2' WHERE "attemptId" = $1`, /ACTION_HISTORY_IMMUTABLE/, [att.id]);
  await refused(`DELETE FROM "ActionVerification" WHERE "attemptId" = $1`, /ACTION_HISTORY_IMMUTABLE/, [att.id]);
  const ticket = (await owner.query(`INSERT INTO "ActionMockTicket" ("workspaceId","clientId","connectionId",id,"customerKey","markedTitle",description)
    VALUES ('${WA}','${CA}','atera-a',gen_random_uuid(),'cust','t','d') RETURNING id`)).rows[0].id;
  await refused(`UPDATE "ActionMockTicket" SET description = 'changed' WHERE id = $1`, /ACTION_HISTORY_IMMUTABLE/, [ticket]);
  await refused(`DELETE FROM "ActionMockTicket" WHERE id = $1`, /ACTION_HISTORY_IMMUTABLE/, [ticket]);
  await refused(`UPDATE "ActionMockTicket" SET synthetic = 'LIVE' WHERE id = $1`, /ACTION_HISTORY_IMMUTABLE|check constraint/, [ticket]);
  // The runtime sees the later-stage rows of its scope; since S3-C it may write only the lifecycle/outcome/claim columns the
  // history triggers let change (tests/pg/action-reserve.pg.test.ts and action-verify.pg.test.ts cover those grants):
  // identity, intent, nonce and synthetic ticket content stay closed, and nothing is deletable
  assert.equal((await scoped(runtime, WA, CA, `SELECT count(*)::int AS n FROM "ActionApproval"`))[0]!.n, 1);
  for (const sql of [q(`UPDATE "ActionRequest" SET "inputHash" = repeat('0', 64) WHERE id = :id`), `UPDATE "ActionApproval" SET "expiresAt" = now()`,
    `UPDATE "ActionAttempt" SET "attemptToken" = gen_random_uuid()`, `UPDATE "ActionMockTicket" SET description = 'changed'`,
    `UPDATE "ActionVerification" SET "targetTicketId" = 'T-9'`, `DELETE FROM "ActionMockTicket"`, `DELETE FROM "ActionRequest"`]) {
    await runtime.query('BEGIN');
    await runtime.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.client_ids', $2, true)`, [WA, CA]);
    await assert.rejects(runtime.query(sql), /permission denied/, sql);
    await runtime.query('ROLLBACK');
  }
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM "Approval"`)).rows[0].n, 0, 'the legacy Approval contract stays inert');
});

test('accepted ApiToken surface unchanged; a referenced token row cannot be deleted; signed identities hold no digest', async () => {
  const r = await create(50);
  const before = await fenceVersion(runtime, WA);
  await refused(`DELETE FROM "ApiToken" WHERE id = 'tok-requester'`, /foreign key/);
  assert.equal(await fenceVersion(runtime, WA), before, 'the refused delete rolled its epoch increment back');
  assert.deepEqual((await owner.query(`SELECT polname, polcmd, pg_get_expr(polqual, polrelid) AS q FROM pg_policy WHERE polrelid = '"ApiToken"'::regclass`)).rows,
    [{ polname: 'ApiToken_lookup', polcmd: 'r', q: '("tokenHash" = atlas_app_token_hash())' }]);
  assert.deepEqual((await owner.query(`SELECT has_table_privilege($1, '"ApiToken"', 'SELECT') AS s, has_any_column_privilege($1, '"ApiToken"', 'INSERT') AS i,
    has_any_column_privilege($1, '"ApiToken"', 'UPDATE') AS u, has_table_privilege($1, '"ApiToken"', 'DELETE') AS d`, [pgdb.runtimeRole])).rows[0], { s: true, i: false, u: false, d: false });
  await runtime.query('BEGIN');
  await runtime.query(`SELECT set_config('app.workspace_id', $1, true), set_config('app.actor_id', 'requester', true)`, [WA]);
  assert.equal((await runtime.query(`SELECT count(*)::int AS n FROM "ApiToken"`)).rows[0].n, 0, 'an actor name exposes no token row');
  await runtime.query('ROLLBACK');
  const columns = (await owner.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'
    AND table_name LIKE 'Action%' AND (column_name ILIKE '%token%' OR column_name ILIKE '%digest%' OR column_name ILIKE '%secret%') ORDER BY 1, 2`)).rows
    .map(c => `${c.table_name}.${c.column_name}`);
  assert.deepEqual(columns, ['ActionApproval.approverTokenExpiresAt', 'ActionApproval.signerTokenId', 'ActionAttempt.attemptToken',
    'ActionAttempt.activeVerificationToken', 'ActionRequest.requesterTokenExpiresAt', 'ActionRequest.requesterTokenId', 'ActionRequest.secretRefDigest'].sort(),
    'token ROW IDs, expiry snapshots, private claim tokens and the secretRef digest only — no bearer digest column');
  assert.ok(r.requestId);
});

test('a derived-ID collision with another request is refused, never adopted', async () => {
  const base = await create(60);
  const colliding = key(61);
  const id = deriveRequestId(WA, CA, 'requester', colliding);
  await clone(base.requestId, { id });
  const input = await files.input({ connectionId: 'atera-a', title: 'Collision', description: 'Body', idempotencyKey: colliding });
  const p = await previewAction(db, MOCK, as('requester'), CA, input, files.out('collision.json'));
  assert.equal(p.requestId, id);
  await assert.rejects(requestAction(db, MOCK, as('requester'), CA, input, p.inputHash), fails('ACTION_STATE_CONFLICT'));
  const stored = await row(id);
  assert.notEqual(stored.idempotencyKey, colliding, 'the other request keeps its own key; nothing was adopted or overwritten');
});
