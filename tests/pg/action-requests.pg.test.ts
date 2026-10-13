import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import { AtlasError } from '../../packages/core/contracts.ts';
import { generateToken, hashToken } from '../../packages/auth/token.ts';
import { PREVIEW_FIELDS } from '../../packages/actions/contracts.ts';
import { actionCredential } from '../../packages/actions/authority.ts';
import { exportStoredPreview, getAction, previewAction, requestAction } from '../../packages/actions/requests.ts';
import type { ActionComposition } from '../../packages/actions/policy.ts';
import { createTestDatabase } from '../support/pg-harness.ts';
import { CA, CB, CUSTOMER_CANARY, MOCK, WA, WB, addActionFixtures, fenceVersion, privateDir, runtimeClient, scoped, tokens } from '../support/action-fixtures.ts';

// Stage 3 S3-A, A2/A3 and the command-authority half of B1 on PostgreSQL 17: deterministic private preview, a matching hash
// stores one immutable request, idempotent retrieval never renews or rebinds, concurrent admissions serialize on the fence,
// audit failure rolls back, denials are audited exactly once in the workspace, and no private value reaches public output.
const pgdb = await createTestDatabase();
const db = new PrismaClient({ datasourceUrl: pgdb.runtimeUrl });
const runtime = await runtimeClient(pgdb.runtimeUrl);
const files = await privateDir();
after(async () => { await runtime.end(); await db.$disconnect(); await files.remove(); await pgdb.drop(); });
await addActionFixtures(pgdb.owner);
const owner = pgdb.owner;
const fails = (code: string) => (e: unknown) => e instanceof AtlasError && e.code === code && e.message === code;
const as = (actor: string) => actionCredential(tokens[actor]!);
const key = (n: number) => `${String(n).padStart(8, '0')}-1111-4222-8333-444444444444`;
let out = 0;
const next = () => files.out(`preview-${++out}.json`);
const intent = (n: number, change: Record<string, string> = {}) =>
  files.input({ connectionId: 'atera-a', title: 'CANARY-title printer', description: 'CANARY-body\nsecond line', idempotencyKey: key(n), ...change });
const securityRows = async (w: string) => scoped<{ eventType: string; reasonCode: string; requestedClientId: string; actorId: string }>(runtime, w, '',
  `SELECT "eventType", "reasonCode", "requestedClientId", "actorId" FROM "SecurityAuditEvent" ORDER BY "recordedAt", id`);
const auditRows = async (client: string) => scoped<{ eventType: string; metadata: Record<string, string> }>(runtime, WA, client,
  `SELECT "eventType", metadata FROM "AuditEvent" ORDER BY "recordedAt", id`);
const requestRows = async (client = CA) => scoped<Record<string, unknown>>(runtime, WA, client, `SELECT * FROM "ActionRequest" ORDER BY "createdAt", id`);
const PRIVATE = [/CANARY/, new RegExp(CUSTOMER_CANARY), /fixture:\/\//, /tok-/, ...Object.values(tokens).map(t => new RegExp(t.replace(/[^A-Za-z0-9]/g, '.'))),
  ...Object.values(tokens).map(t => new RegExp(hashToken(t)))];
const assertPublic = (value: unknown, label: string) => { const text = JSON.stringify(value); for (const p of PRIVATE) assert.doesNotMatch(text, p, label); };

test('preview → request: exact private preview, its hash stores one immutable request; summaries and audit stay private; a reader exports the identical stored preview', async () => {
  const input = await intent(1);
  const previewFile = next();
  const preview = await previewAction(db, MOCK, as('requester'), CA, input, previewFile);
  assert.deepEqual(Object.keys(preview).sort(), ['idempotent', 'inputHash', 'requestId', 'synthetic', 'validity']);
  assert.deepEqual([preview.idempotent, preview.validity, preview.synthetic], [false, 'CURRENT', true]);
  assert.equal((await stat(previewFile)).mode & 0o777, 0o600);
  const doc = JSON.parse(await readFile(previewFile, 'utf8'));
  assert.deepEqual(Object.keys(doc).sort(), [...PREVIEW_FIELDS].sort(), 'exact whitelist: no customer key, secret reference or token');
  assert.deepEqual(doc, { kind: 'ACTION_INPUT_PREVIEW', dto: 'atlas-action-preview/1', requestId: preview.requestId, workspaceId: WA, clientId: CA,
    connectionId: 'atera-a', actionType: 'atera.create_ticket', actionVersion: 'atlas-ticket-port/1/mock', policyVersion: 'atlas-action-policy/1',
    portVersion: 'atlas-synthetic-ticket-port/1', mode: 'MOCK', title: `CANARY-title printer [Atlas:${preview.requestId}]`,
    description: 'CANARY-body\nsecond line', marker: `[Atlas:${preview.requestId}]`, inputHash: preview.inputHash });
  assert.equal((await requestRows()).length, 0, 'a preview persists nothing');
  const stored = await requestAction(db, MOCK, as('requester'), CA, input, preview.inputHash);
  assert.deepEqual([stored.requestId, stored.inputHash, stored.state, stored.idempotent, stored.validity, stored.synthetic],
    [preview.requestId, preview.inputHash, 'AWAITING_APPROVAL', false, 'CURRENT', true]);
  assertPublic([preview, stored], 'public results');
  const [row] = await requestRows();
  assert.equal(row!.requesterTokenId, 'tok-requester', 'the verified current token ROW ID');
  assert.equal(row!.requesterTokenExpiresAt, null, 'its exact (null) expiry');
  assert.equal(row!.authorityEpoch, await fenceVersion(runtime, WA));
  assert.ok(!JSON.stringify(row).includes(hashToken(tokens.requester!)), 'no token digest anywhere in the request');
  const exported = next();
  const read = await exportStoredPreview(db, MOCK, as('reader'), CA, stored.requestId, exported);
  assert.deepEqual(JSON.parse(await readFile(exported, 'utf8')), { ...doc, kind: 'STORED_ACTION_PREVIEW' }, 'read + context only, no request grant');
  assert.deepEqual({ ...read }, { ...(await getAction(db, MOCK, as('reader'), CA, stored.requestId)) });
  const audit = await auditRows(CA);
  assert.deepEqual(audit.map(a => [a.eventType, a.metadata]), [['action.requested',
    { actionRequestId: stored.requestId, actionType: 'atera.create_ticket', requestState: 'AWAITING_APPROVAL', connectionId: 'atera-a' }]]);
  await assert.rejects(getAction(db, MOCK, as('reader'), CB, stored.requestId), fails('SCOPE_DENIED'), 'the reader is no member of client B');
  await assert.rejects(getAction(db, MOCK, as('requester'), CB, stored.requestId), fails('ACTION_NOT_FOUND'), 'another client never sees it');
});

test('drift before the request: a binding/epoch change makes the old preview hash stale; a new preview gives a new hash', async () => {
  const input = await intent(2);
  const first = await previewAction(db, MOCK, as('requester'), CA, input, next());
  await owner.query(`UPDATE "Connection" SET "lifecycleVersion" = "lifecycleVersion" + 1 WHERE id = 'atera-a'`);
  await assert.rejects(requestAction(db, MOCK, as('requester'), CA, input, first.inputHash), fails('ACTION_PREVIEW_STALE'));
  const second = await previewAction(db, MOCK, as('requester'), CA, input, next());
  assert.equal(second.requestId, first.requestId, 'same scope tuple, same derived ID');
  assert.notEqual(second.inputHash, first.inputHash);
  const stored = await requestAction(db, MOCK, as('requester'), CA, input, second.inputHash);
  assert.equal(stored.inputHash, second.inputHash);
  const refusals = (await auditRows(CA)).filter(a => a.eventType === 'action.request_refused');
  assert.deepEqual(refusals.map(a => a.metadata), [{ connectionId: 'atera-a', safeErrorCode: 'ACTION_PREVIEW_STALE' }]);
});

test('idempotent retrieval: the original request despite stale hash, token rotation and epoch drift, never renewed; another intent conflicts', async () => {
  const input = await intent(3);
  const p = await previewAction(db, MOCK, as('requester2'), CA, input, next());
  const original = await requestAction(db, MOCK, as('requester2'), CA, input, p.inputHash);
  // Rotation: revoke the signing token row, issue a new one (both owner mutations move the epoch)
  const rotated = generateToken();
  await owner.query(`UPDATE "ApiToken" SET "revokedAt" = now() WHERE id = 'tok-requester2'`);
  await owner.query(`INSERT INTO "ApiToken" ("workspaceId", id, "actorId", "tokenHash") VALUES ($1, 'tok-requester2-b', 'requester2', $2)`, [WA, hashToken(rotated)]);
  const again = await requestAction(db, MOCK, actionCredential(rotated), CA, input, 'f'.repeat(64));
  assert.deepEqual({ ...again, idempotent: false, validity: 'CURRENT', updatedAt: '' }, { ...original, updatedAt: '' }, 'the original immutable request');
  assert.deepEqual([again.idempotent, again.validity], [true, 'AUTHORITY_CHANGED']);
  const [row] = (await requestRows()).filter(r => r.id === original.requestId);
  assert.deepEqual([row!.requesterTokenId, row!.authorityEpoch], ['tok-requester2', original.authorityEpoch], 'no rebinding or renewal');
  const exported = next();
  const stale = await previewAction(db, MOCK, actionCredential(rotated), CA, input, exported);
  assert.deepEqual([stale.requestId, stale.inputHash, stale.idempotent], [original.requestId, original.inputHash, true]);
  assert.equal(JSON.parse(await readFile(exported, 'utf8')).kind, 'STORED_ACTION_PREVIEW', 'the stored body, not a new snapshot');
  await assert.rejects(requestAction(db, MOCK, actionCredential(rotated), CA, await intent(3, { title: 'CANARY other title' }), 'f'.repeat(64)),
    fails('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(previewAction(db, MOCK, actionCredential(rotated), CA, await intent(3, { connectionId: 'atera-disabled' }), next()), fails('IDEMPOTENCY_CONFLICT'));
  const security = (await securityRows(WA)).length;
  await assert.rejects(requestAction(db, MOCK, as('requester2'), CA, input, p.inputHash), fails('ACTION_AUTHENTICATION_FAILED'), 'the revoked token');
  assert.equal((await securityRows(WA)).length, security, 'no actor is invented for an audit');
  await owner.query(`UPDATE "ActionRequest" SET state = 'CANCELLED', "terminalAt" = now() WHERE id = $1`, [original.requestId]);
  const terminal = await requestAction(db, MOCK, actionCredential(rotated), CA, input, p.inputHash);
  assert.deepEqual([terminal.state, terminal.validity, terminal.idempotent], ['CANCELLED', 'NOT_PENDING', true], 'terminal outcomes are retrieved, not revived');
  assert.equal((await requestRows()).filter(r => r.idempotencyKey === key(3)).length, 1);
});

test('concurrent admissions of one key serialize on the fence: one request, the rest idempotent retrievals, no unique violation', async () => {
  const input = await intent(4);
  const p = await previewAction(db, MOCK, as('requester'), CA, input, next());
  const results = await Promise.all(Array.from({ length: 6 }, () => requestAction(db, MOCK, as('requester'), CA, input, p.inputHash)));
  assert.deepEqual(results.map(r => r.idempotent).sort(), [false, true, true, true, true, true]);
  assert.equal(new Set(results.map(r => `${r.requestId}:${r.inputHash}:${r.createdAt}`)).size, 1);
  assert.equal((await requestRows()).filter(r => r.idempotencyKey === key(4)).length, 1);
  const other = await intent(5);
  const q = await previewAction(db, MOCK, as('requester'), CB, await files.input({ connectionId: 'atera-b', title: 'B', description: 'B', idempotencyKey: key(5) }), next());
  const both = await Promise.all([requestAction(db, MOCK, as('requester'), CA, other, (await previewAction(db, MOCK, as('requester'), CA, other, next())).inputHash),
    requestAction(db, MOCK, as('requester'), CB, await files.input({ connectionId: 'atera-b', title: 'B', description: 'B', idempotencyKey: key(5) }), q.inputHash)]);
  assert.deepEqual(both.map(b => b.idempotent), [false, false]);
});

test('audit failure rolls the request back: nothing stored, fixed ACTION_AUDIT_FAILED; it succeeds once the audit works', async () => {
  await owner.query(`CREATE FUNCTION test_refuse_action_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW."eventType" = 'action.requested' THEN RAISE EXCEPTION 'CANARY audit store down'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER test_refuse_action_audit BEFORE INSERT ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION test_refuse_action_audit();
    REVOKE ALL ON FUNCTION test_refuse_action_audit() FROM PUBLIC;`); // no new PUBLIC routine (fence definer readiness)
  const input = await intent(6);
  const p = await previewAction(db, MOCK, as('requester'), CA, input, next());
  try {
    await assert.rejects(requestAction(db, MOCK, as('requester'), CA, input, p.inputHash), fails('ACTION_AUDIT_FAILED'));
    assert.equal((await requestRows()).filter(r => r.idempotencyKey === key(6)).length, 0);
  } finally { await owner.query(`DROP TRIGGER test_refuse_action_audit ON "AuditEvent"; DROP FUNCTION test_refuse_action_audit();`); }
  assert.equal((await requestAction(db, MOCK, as('requester'), CA, input, p.inputHash)).idempotent, false);
});

test('authority: each scope/permission denial is one workspace audit row; bad credentials invent no actor; memberships never merge; connection policy', async () => {
  const input = await intent(7);
  const wa = (await securityRows(WA)).length; const wb = (await securityRows(WB)).length;
  await assert.rejects(previewAction(db, MOCK, as('outsider'), CA, input, next()), fails('SCOPE_DENIED'));
  await assert.rejects(previewAction(db, MOCK, as('contextOnly'), CA, input, next()), fails('PERMISSION_DENIED'));
  await assert.rejects(previewAction(db, MOCK, as('reader'), CA, input, next()), fails('PERMISSION_DENIED'), 'read is not request');
  await assert.rejects(previewAction(db, MOCK, as('split'), CA, input, next()), fails('PERMISSION_DENIED'), 'request on client B does not merge into A');
  await assert.rejects(previewAction(db, MOCK, as('split'), CB, input, next()), fails('PERMISSION_DENIED'), 'nor read from A into B');
  const denialsA = (await securityRows(WA)).slice(wa);
  assert.deepEqual(denialsA.map(d => [d.actorId, d.eventType, d.reasonCode, d.requestedClientId]), [
    ['contextOnly', 'action.preview_denied', 'PERMISSION_DENIED', CA], ['reader', 'action.preview_denied', 'PERMISSION_DENIED', CA],
    ['split', 'action.preview_denied', 'PERMISSION_DENIED', CA], ['split', 'action.preview_denied', 'PERMISSION_DENIED', CB]]);
  assert.deepEqual((await securityRows(WB)).slice(wb).map(d => [d.actorId, d.reasonCode, d.requestedClientId]), [['outsider', 'SCOPE_DENIED', CA]]);
  const total = (await securityRows(WA)).length;
  await assert.rejects(previewAction(db, MOCK, actionCredential(generateToken()), CA, input, next()), fails('ACTION_AUTHENTICATION_FAILED'));
  assert.throws(() => actionCredential('short'), fails('ACTION_AUTHENTICATION_FAILED'));
  await owner.query(`UPDATE "ApiToken" SET "expiresAt" = "createdAt" + interval '1 millisecond' WHERE id = 'tok-approver'`);
  await assert.rejects(getAction(db, MOCK, as('approver'), CA, key(7)), fails('ACTION_AUTHENTICATION_FAILED'), 'expired by the DB clock');
  await owner.query(`UPDATE "ApiToken" SET "expiresAt" = NULL WHERE id = 'tok-approver'`);
  await owner.query(`UPDATE "Actor" SET status = 'DISABLED' WHERE "workspaceId" = $1 AND id = 'approver'`, [WA]);
  await assert.rejects(getAction(db, MOCK, as('approver'), CA, key(7)), fails('ACTION_AUTHENTICATION_FAILED'), 'disabled actor');
  await owner.query(`UPDATE "Actor" SET status = 'ACTIVE' WHERE "workspaceId" = $1 AND id = 'approver'`, [WA]);
  assert.equal((await securityRows(WA)).length, total, 'no denial rows for unauthenticated calls');
  for (const connectionId of ['huntress-a', 'atera-disabled', 'atera-b', 'no-such-connection']) {
    await assert.rejects(previewAction(db, MOCK, as('requester'), CA, await intent(8, { connectionId }), next()), fails('ACTION_CONNECTION_REFUSED'), connectionId);
  }
  assert.deepEqual((await auditRows(CA)).filter(a => a.eventType === 'action.preview_refused').slice(-4).map(a => a.metadata.safeErrorCode),
    ['ACTION_CONNECTION_REFUSED', 'ACTION_CONNECTION_REFUSED', 'ACTION_CONNECTION_REFUSED', 'ACTION_CONNECTION_REFUSED']);
  const live = { ...MOCK, mode: 'LIVE' } as unknown as ActionComposition;
  await assert.rejects(getAction(db, live, as('reader'), CA, key(7)), fails('ACTION_MODE_REFUSED'));
  assertPublic([await securityRows(WA), await auditRows(CA)], 'audit rows');
});
